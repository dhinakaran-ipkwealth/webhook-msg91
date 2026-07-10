require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const { MongoClient } = require("mongodb");

// ── middleware ──────────────────────────────────────────────────────────────
// All three modules are optional-load safe: if node_modules is missing a dep
// (e.g. ioredis not yet installed) the middleware falls back gracefully.
const requestLogger = require("./middleware/request-logger");
const { webhookLimiter, apiLimiter, rateLimitStatus } = require("./middleware/rate-limit");
const { webhookDedupMiddleware, ensureDedupIndexes } = require("./middleware/webhook-dedup");
const { webhookAuthMiddleware } = require("./middleware/webhook-auth");
const { createWebhookAuditLogger } = require("./middleware/webhook-audit");
const { getMetricsSnapshot } = require("./middleware/request-logger");
const {
  templateCollectionName,
  getEventSenderNumber,
  webhookLogCollectionName,
  ensureIndexesOnce,
} = require("./lib/template-collections");

const PORT = Number(process.env.PORT || process.env.WEBHOOK_PORT || 3002);
const HOST = process.env.WEBHOOK_HOST || "0.0.0.0";
const MONGODB_URI = process.env.DATABASE_URL || process.env.MONGODB_URI;
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || "";
const MONGODB_WEBHOOK_DB_NAME =
  process.env.MONGODB_WEBHOOK_DB_NAME || "msg91_webhooks";
const SERVICE_NAME = "crm-msg91-webhook";

if (!MONGODB_URI) {
  console.error("DATABASE_URL or MONGODB_URI is required.");
  process.exit(1);
}

let mongoClient;
let mongoDb;
let webhookEventsDb;

function captureRawBody(req, _res, buffer) {
  req.rawBody = buffer ? buffer.toString("utf8") : "";
}

function parseMaybeJson(value) {
  if (value === undefined || value === null || value === "") return value;
  if (typeof value !== "string") return value;

  const trimmed = value.trim();
  if (!trimmed) return value;

  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }

  return value;
}

function stableStringify(value) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${key}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function formatPhoneForCall(input) {
  if (!input) return "";
  const cleaned = String(input).replace(/\D+/g, "");
  if (cleaned.length === 10) return `91${cleaned}`;
  if (cleaned.length === 11 && cleaned.startsWith("0"))
    return `91${cleaned.slice(1)}`;
  return cleaned;
}

function createStatusLabel(statusText) {
  if (!statusText) return "reporting";
  const normalized = String(statusText).toLowerCase();
  // MSG91 explicit codes
  if (normalized === "deny" || normalized === "denied") return "failed";
  if (normalized === "read") return "delivered";
  if (normalized.includes("read")) return "delivered";
  if (normalized.includes("deliver")) return "delivered";
  if (
    normalized.includes("fail") ||
    normalized.includes("undel") ||
    normalized.includes("reject")
  )
    return "failed";
  if (normalized.includes("sent") || normalized.includes("submit"))
    return "sent";
  return "reporting";
}

function getPayloadItems(body) {
  const parsedBody = parseMaybeJson(body);
  if (Array.isArray(parsedBody)) return parsedBody;

  const data = parseMaybeJson(parsedBody?.data);
  if (Array.isArray(parsedBody?.reports)) return parsedBody.reports;
  if (Array.isArray(data)) return data;
  if (Array.isArray(parsedBody?.payload)) return parsedBody.payload;
  if (Array.isArray(parsedBody?.entry)) return parsedBody.entry;

  // Do NOT split MSG91 inbound `messages`, because it is usually a stringified
  // array and the wrapper contains customerNumber/integratedNumber used for matching.
  return parsedBody && typeof parsedBody === "object" ? [parsedBody] : [];
}

function inferEventType(item, context = {}) {
  const direction = String(item.direction || item.direction_type || "").trim();
  if (direction === "0") return "inbound";
  if (direction === "1") return "outbound";

  const payloadWebhookType = String(
    item.webhookType ||
      item.webhook_type ||
      item.eventType ||
      item.event_type ||
      "",
  ).toLowerCase();
  const contextWebhookType = String(context.webhookType || "").toLowerCase();
  const webhookType = payloadWebhookType || contextWebhookType;

  if (
    payloadWebhookType.includes("inbound") ||
    payloadWebhookType.includes("incoming")
  )
    return "inbound";
  if (
    payloadWebhookType.includes("outbound") ||
    payloadWebhookType.includes("report")
  )
    return "outbound";

  const contentType = String(
    item.contentType || item.content_type || "",
  ).toLowerCase();
  const messageType = String(
    item.messageType || item.message_type || "",
  ).toLowerCase();

  if (
    item.replyMsgId ||
    item.reply_msg_id ||
    item.customerName ||
    item.customer_name ||
    item.text ||
    item.button ||
    item.interactive ||
    item.reaction ||
    item.contacts ||
    item.messages ||
    item.caption ||
    item.url ||
    item.clickedUrl ||
    item.clicked_url ||
    webhookType.includes("url") ||
    webhookType.includes("click") ||
    contentType ||
    [
      "text",
      "button",
      "interactive",
      "reaction",
      "image",
      "document",
      "audio",
      "video",
      "url",
      "url_click",
      "flow",
      "nfm_reply",
    ].includes(messageType)
  ) {
    return "inbound";
  }

  if (
    contextWebhookType.includes("inbound") ||
    contextWebhookType.includes("incoming")
  )
    return "inbound";
  if (
    contextWebhookType.includes("outbound") ||
    contextWebhookType.includes("report")
  )
    return "outbound";

  return "outbound";
}

function extractButtonText(button) {
  const parsed = parseMaybeJson(button);
  if (!parsed) return "";
  if (typeof parsed === "string") return parsed;
  return (
    parsed.text ||
    parsed.title ||
    parsed.payload ||
    parsed.button?.text ||
    parsed.button?.payload ||
    ""
  );
}

function extractInteractiveText(interactive) {
  const parsed = parseMaybeJson(interactive);
  if (!parsed) return "";
  if (typeof parsed === "string") return parsed;
  return (
    parsed.button_reply?.title ||
    parsed.button_reply?.id ||
    parsed.list_reply?.title ||
    parsed.list_reply?.id ||
    parsed.nfm_reply?.body ||
    parsed.nfm_reply?.name ||
    parsed.flow_reply?.body ||
    parsed.flow_reply?.name ||
    parsed.type ||
    ""
  );
}

function extractMessagesText(messages) {
  const parsed = parseMaybeJson(messages);
  const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];

  return list
    .map((message) => {
      if (!message || typeof message !== "object") return String(message || "");
      return (
        message.text?.body ||
        message.button?.text ||
        message.button?.payload ||
        message.interactive?.button_reply?.title ||
        message.interactive?.button_reply?.id ||
        message.interactive?.list_reply?.title ||
        message.interactive?.list_reply?.id ||
        message.interactive?.nfm_reply?.body ||
        message.interactive?.flow_reply?.body ||
        message.image?.caption ||
        message.video?.caption ||
        message.document?.caption ||
        message.reaction?.emoji ||
        message.url ||
        ""
      );
    })
    .filter(Boolean)
    .join(" | ");
}

function extractMessageContextId(messages) {
  const parsed = parseMaybeJson(messages);
  const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  for (const message of list) {
    const contextId = message?.context?.id || message?.reply_context?.id || "";
    if (contextId) return contextId;
  }
  return "";
}

function getMsg91CorrelationId(item, eventType) {
  if (eventType === "inbound") {
    return (
      item.replyMsgId ||
      item.reply_msg_id ||
      extractMessageContextId(item.messages) ||
      item.message_id ||
      item.messageId ||
      item.message_uuid ||
      item.uuid ||
      item.id ||
      item.requestId ||
      item.request_id ||
      item.oneApiRequestId ||
      item.one_api_request_id ||
      null
    );
  }

  return (
    item.uuid ||
    item.message_uuid ||
    item.message_id ||
    item.messageId ||
    item.id ||
    item.requestId ||
    item.request_id ||
    item.oneApiRequestId ||
    item.one_api_request_id ||
    null
  );
}

function extractReactionText(reaction) {
  const parsed = parseMaybeJson(reaction);
  if (!parsed) return "";
  if (typeof parsed === "string") return parsed;
  return (
    parsed.emoji || parsed.text || parsed.reaction || JSON.stringify(parsed)
  );
}

function extractContentText(content) {
  const parsed = parseMaybeJson(content);
  if (!parsed) return "";
  if (typeof parsed === "string") return parsed;

  return (
    parsed.text?.body ||
    parsed.text ||
    parsed.button?.text ||
    parsed.button?.payload ||
    parsed.interactive?.button_reply?.title ||
    parsed.interactive?.list_reply?.title ||
    parsed.caption ||
    ""
  );
}

function extractMessageText(item) {
  return String(
    item.text ||
      extractContentText(item.content) ||
      extractButtonText(item.button) ||
      extractInteractiveText(item.interactive) ||
      extractMessagesText(item.messages) ||
      item.caption ||
      extractReactionText(item.reaction) ||
      item.clickedUrl ||
      item.clicked_url ||
      item.url ||
      "",
  ).trim();
}

function getCustomerNumber(item) {
  // IMPORTANT:
  // customerNumber is the real customer/user number.
  // integratedNumber is your sender/WhatsApp business number.
  // Do not use integratedNumber as a fallback for normalizedMobile, otherwise
  // all inbound rows appear under your sender number.
  return (
    item.customerNumber ||
    item.customer_number ||
    item.from ||
    item.wa_id ||
    parseMaybeJson(item.contacts)?.[0]?.wa_id ||
    parseMaybeJson(item.messages)?.[0]?.from ||
    item.mobile ||
    item.to ||
    item.number ||
    item.phone ||
    item.recipient ||
    ""
  );
}

function normalizeWebhookItem(item, context = {}) {
  const eventType = inferEventType(item, context);
  const normalizedMobile = formatPhoneForCall(getCustomerNumber(item));

  const statusSource =
    item.eventName ||
    item.event_name ||
    item.statusCode ||
    item.status_code ||
    item.reason ||
    item.status ||
    item.delivery_status ||
    item.messageType ||
    item.message_type ||
    item.webhookType ||
    context.webhookType;

  const text = extractMessageText(item) || null;
  const requestId = getMsg91CorrelationId(item, eventType);

  const receivedAt =
    item.ts ||
    item.statusUpdatedAt ||
    item.requestedAt ||
    new Date().toISOString();

  const eventKey = sha256(
    [
      "msg91",
      eventType,
      normalizedMobile,
      item.integratedNumber || item.integrated_number || "",
      requestId || "",
      item.uuid || "",
      item.replyMsgId || item.reply_msg_id || "",
      item.eventName || item.event_name || "",
      text || "",
    ].join("|") || stableStringify(item),
  );

  // stableKey omits uuid/timestamp so the same logical event (same mobile,
  // same reply text, same replyMsgId) produces the same key even when MSG91
  // retries the webhook with a fresh uuid.  Used as a secondary dedup guard.
  const stableKey =
    eventType === "inbound" && requestId
      ? sha256(
          [
            "msg91-stable",
            "inbound",
            normalizedMobile,
            item.integratedNumber || item.integrated_number || "",
            requestId || "",
            text || "",
          ].join("|"),
        )
      : null;

  return {
    source: "crm-webhook",
    service: SERVICE_NAME,
    eventKey,
    stableKey,
    eventType,
    normalizedStatus:
      eventType === "inbound" ? "inbound" : createStatusLabel(statusSource),
    normalizedMobile: normalizedMobile || null,
    text,
    requestId,
    templateName:
      item.templateName || item.template_name || context.templateName || null,
    uploadId: item.uploadId || item.upload_id || context.uploadId || null,
    webhookType:
      item.webhookType || item.webhook_type || context.webhookType || "msg91",
    customerNumber:
      item.customerNumber || item.customer_number || normalizedMobile || null,
    integratedNumber:
      item.integratedNumber ||
      item.integrated_number ||
      item.senderNumber ||
      item.sender_number ||
      item["Whatsapp Number"] ||
      item.from ||
      item["Integrated Number"] ||
      null,
    senderNumber:
      item.senderNumber ||
      item.sender_number ||
      item.integratedNumber ||
      item.integrated_number ||
      item["Whatsapp Number"] ||
      item.from ||
      item["Integrated Number"] ||
      null,
    contentType: item.contentType || item.content_type || null,
    button: item.button || null,
    interactive: item.interactive || null,
    reaction: item.reaction || null,
    messages: item.messages || null,
    eventName: item.eventName || item.event_name || null,
    reason: item.reason || null,
    statusCode: item.statusCode || item.status_code || null,
    statusUpdatedAt: item.statusUpdatedAt || null,
    price: item.price || null,
    rawPayload: item,
    receivedAt,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function shouldIgnoreItem(item) {
  const text = extractMessageText(item).toLowerCase();
  const customer = formatPhoneForCall(getCustomerNumber(item));
  const testTexts = new Set(["test reply", "test", "curl test"]);
  return (
    process.env.IGNORE_TEST_WEBHOOKS !== "false" &&
    testTexts.has(text) &&
    customer === "919363406313"
  );
}

async function safeCreateIndex(collection, key, options = {}) {
  try {
    await collection.createIndex(key, options);
  } catch (error) {
    if (
      error.codeName === "IndexKeySpecsConflict" ||
      error.code === 86 ||
      error.code === 11000
    ) {
      console.warn(
        `Index already exists with different options, skipping: ${collection.collectionName} ${JSON.stringify(key)}`,
      );
      return;
    }
    throw error;
  }
}

const WEBHOOK_EVENTS_INDEX_DEFS = [
  { key: { receivedAt: -1 } },
  { key: { source: 1, receivedAt: -1 } },
  { key: { source: 1, sourceEventId: 1 } },
  { key: { normalizedMobile: 1, receivedAt: -1 } },
  { key: { eventType: 1, normalizedStatus: 1, receivedAt: -1 } },
  { key: { eventKey: 1 }, options: { unique: true } },
  { key: { stableKey: 1 }, options: { sparse: true } },
  {
    key: { source: 1, stableKey: 1 },
    options: {
      unique: true,
      partialFilterExpression: { stableKey: { $type: "string" } },
    },
  },
  { key: { modifiedAt: -1 } },
];

const SENDER_REPORTS_INDEX_DEFS = [
  { key: { mobile: 1, sentAt: -1 } },
  { key: { responseId: 1 } },
  { key: { messageId: 1 } },
];

// Raw webhook logs live in msg91_webhooks collections named by template, or
// sendernumber_template when the same template is used by multiple senders.
async function getWebhookEventsCollection(templateName, senderNumber = "") {
  const name = await webhookLogCollectionName(mongoDb, templateName, senderNumber);
  const collection = webhookEventsDb.collection(name);
  await ensureIndexesOnce(collection, WEBHOOK_EVENTS_INDEX_DEFS, safeCreateIndex);
  return collection;
}

async function getSenderReportsCollection(templateName) {
  const name = templateCollectionName("whatsapp_sender_reports", templateName);
  const collection = mongoDb.collection(name);
  await ensureIndexesOnce(collection, SENDER_REPORTS_INDEX_DEFS, safeCreateIndex);
  return collection;
}

async function initMongo() {
  mongoClient = new MongoClient(MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
  });
  await mongoClient.connect();
  mongoDb = MONGODB_DB_NAME
    ? mongoClient.db(MONGODB_DB_NAME)
    : mongoClient.db();
  webhookEventsDb = MONGODB_WEBHOOK_DB_NAME
    ? mongoClient.db(MONGODB_WEBHOOK_DB_NAME)
    : mongoDb;
  console.log(`[mongo] connected — main: ${MONGODB_DB_NAME || "(default)"}, webhook: ${MONGODB_WEBHOOK_DB_NAME}`);

  // Bootstrap dedup collection indexes (TTL + unique eventId)
  await ensureDedupIndexes(webhookEventsDb);

  const webhookEvents = webhookEventsDb.collection("whatsapp_webhook_events");
  await safeCreateIndex(webhookEvents, { receivedAt: -1 });
  await safeCreateIndex(webhookEvents, { source: 1, receivedAt: -1 });
  await safeCreateIndex(webhookEvents, { source: 1, sourceEventId: 1 });
  await safeCreateIndex(webhookEvents, { normalizedMobile: 1, receivedAt: -1 });
  await safeCreateIndex(webhookEvents, {
    eventType: 1,
    normalizedStatus: 1,
    receivedAt: -1,
  });
  await safeCreateIndex(webhookEvents, { eventKey: 1 }, { unique: true });
  await safeCreateIndex(webhookEvents, { stableKey: 1 }, { sparse: true });
  await safeCreateIndex(
    webhookEvents,
    { source: 1, stableKey: 1 },
    {
      unique: true,
      partialFilterExpression: { stableKey: { $type: "string" } },
    },
  );
  await safeCreateIndex(webhookEvents, { modifiedAt: -1 });

  const webhookLogs = mongoDb.collection("webhook_logs");
  await safeCreateIndex(webhookLogs, { receivedAt: -1 });
  await safeCreateIndex(webhookLogs, { method: 1, url: 1, receivedAt: -1 });
  await safeCreateIndex(webhookLogs, { statusCode: 1, receivedAt: -1 });

  const senderReports = mongoDb.collection("whatsapp_sender_reports");
  await safeCreateIndex(senderReports, { mobile: 1, sentAt: -1 });
  await safeCreateIndex(senderReports, { responseId: 1 });
  await safeCreateIndex(senderReports, { messageId: 1 });
  // DO NOT create { uploadId: 1, numberId: 1 } here. Your DB already has this index as unique.

  const numbers = mongoDb.collection("whatsapp_numbers");
  await safeCreateIndex(numbers, { cleaned: 1, lastUpdated: -1 });
  await safeCreateIndex(
    numbers,
    { uploadId: 1, numberId: 1 },
    { unique: true },
  );

  // Pre-warm the priority audited template so its collections/indexes exist
  // from process start rather than being created lazily on first webhook.
  await getWebhookEventsCollection("trading_confirmation");
  await getSenderReportsCollection("trading_confirmation");
}

function buildReplyHistoryItem(event) {
  return {
    text: event.text,
    receivedAt: event.receivedAt || new Date().toISOString(),
    customerNumber: event.customerNumber || event.normalizedMobile || null,
    requestId: event.requestId || null,
    eventKey: event.eventKey || null,
    webhookType: event.webhookType || null,
    rawPayload: event.rawPayload || null,
  };
}

function extractWebhookContentValues(item = {}) {
  const content = parseMaybeJson(item.content);
  if (!content || typeof content !== "object") return [];

  return Object.values(content)
    .map((entry) => {
      if (entry && typeof entry === "object")
        return entry.text || entry.value || "";
      return entry;
    })
    .map((value) => String(value || "").trim())
    .filter((value) => value && value.length > 1);
}

function scoreSenderReportMatch(report, values) {
  if (!values.length) return 0;
  const reportText = [
    report.sentMessage,
    report.mobile,
    typeof report.csvRowData === "string"
      ? report.csvRowData
      : JSON.stringify(report.csvRowData || {}),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return values.reduce((score, value) => {
    return reportText.includes(value.toLowerCase()) ? score + 1 : score;
  }, 0);
}

async function findSenderReportByWebhookContent(event) {
  if (event.eventType !== "outbound" || !event.normalizedMobile) return null;

  const values = extractWebhookContentValues(event.rawPayload);
  if (!values.length) return null;

  const query = { mobile: event.normalizedMobile };
  if (event.uploadId) query.uploadId = Number(event.uploadId);
  if (event.templateName) query.templateName = event.templateName;

  const candidates = await (await getSenderReportsCollection(event.templateName))
    .find(query)
    .sort({ sentAt: -1, updatedAt: -1, _id: -1 })
    .limit(50)
    .toArray();

  let best = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const score = scoreSenderReportMatch(candidate, values);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best && bestScore >= 2 ? best : null;
}

async function applyInboundReplyToReports(event) {
  if (event.eventType !== "inbound")
    return { applied: false, reason: "not_inbound" };

  const mobile = event.normalizedMobile;
  if (!mobile) return { applied: false, reason: "missing_mobile" };
  const replyText = event.text;
  // For non-text inbound messages (image, document, audio, etc.) text is null.
  // Still apply so the report is marked replied; use contentType as a label.
  const replyLabel =
    replyText || (event.contentType ? `[${event.contentType}]` : "[message]");

  const senderReports = await getSenderReportsCollection(event.templateName);
  const numbers = mongoDb.collection("whatsapp_numbers");
  const replyAt = event.receivedAt || new Date().toISOString();
  const now = new Date().toISOString();
  const historyItem = buildReplyHistoryItem(event);

  // Step 1: try an exclusive match on the original message_id (replyMsgId).
  // This is the only reliable way to pin a reply to the correct sent row when
  // the same mobile number received several different messages in one upload.
  let latestReport = null;

  // Step 1: match exclusively by replyMsgId → responseId/messageId.
  // Sort newest-first so that today's campaign row is preferred when the same
  // wamid (responseId) appears across multiple uploads (rare but happens when
  // MSG91 reuses request IDs across retries or bulk batches).
  if (event.requestId) {
    const msgIdQuery = {
      $or: [{ responseId: event.requestId }, { messageId: event.requestId }],
    };
    if (event.uploadId) msgIdQuery.uploadId = Number(event.uploadId);

    const candidates = await senderReports
      .find(msgIdQuery)
      .sort({ sentAt: -1 }) // newest first — reply goes to most-recent campaign
      .toArray();

    latestReport =
      candidates.find((c) => !c.customReply && !c.lastReplyAt) ||
      candidates[0] ||
      null;
    console.log(`[inbound] requestId match — candidates: ${candidates.length}, matched: ${Boolean(latestReport)}`, { requestId: event.requestId, mobile });
  }

  // Step 2: mobile fallback — used when no requestId is present.
  // Sort newest-first so the most-recent send campaign gets credit for the
  // reply.  The old sentAt:1 (oldest-first) caused today's replies to be
  // attributed to uploads from weeks/months ago that shared the same mobile.
  if (!latestReport) {
    const mobileQuery = { mobile };
    if (event.uploadId) mobileQuery.uploadId = Number(event.uploadId);
    if (event.templateName) mobileQuery.templateName = event.templateName;

    const mobileCandidates = await senderReports
      .find(mobileQuery)
      .sort({ sentAt: -1 }) // newest first — today's campaign gets the reply
      .toArray();

    latestReport =
      mobileCandidates.find((c) => !c.customReply && !c.lastReplyAt) ||
      mobileCandidates[0] ||
      null;
    console.log(`[inbound] mobile fallback — candidates: ${mobileCandidates.length}, matched: ${Boolean(latestReport)}`, { mobile, uploadId: event.uploadId });
  }

  if (!latestReport) {
    console.log("Inbound reply received but no matching sender report found", {
      mobile,
      replyText,
    });
    return { applied: false, reason: "no_sender_report" };
  }

  // Update sender report: set the reply status fields only.
  // Each inbound event is already stored as its own document in
  // whatsapp_webhook_events (unique eventKey index). We do NOT append to
  // replyHistory here — that caused all customer messages to accumulate
  // indefinitely in a single document (29+ replies in one record).
  await senderReports.updateOne(
    { _id: latestReport._id },
    {
      $set: {
        currentStatus: "replied",
        customReply: replyLabel,
        lastReplyAt: replyAt,
        replyWebhook: event,
        updatedAt: now,
      },
    },
  );

  const numberFilter =
    latestReport.uploadId && latestReport.numberId
      ? { uploadId: latestReport.uploadId, numberId: latestReport.numberId }
      : { cleaned: mobile };

  await numbers.updateOne(
    { ...numberFilter },
    {
      $set: {
        currentStatus: "replied",
        customReply: replyLabel,
        lastReplyAt: replyAt,
        responseDetails: event,
        lastUpdated: now,
      },
    },
  );

  console.log("Inbound reply applied", {
    mobile,
    replyText: replyLabel,
    uploadId: latestReport.uploadId,
    numberId: latestReport.numberId,
  });

  // Write the matched row IDs back to whatsapp_webhook_events so the Electron
  // app can build per-row reply history using byNumberId (exact match).
  // Without this, matchedNumberId is always null and byMobile shows ALL
  // historical replies for a customer across every upload.
  if (event.eventKey && latestReport.uploadId && latestReport.numberId) {
    webhookEventsDb
      .collection(
        await webhookLogCollectionName(
          mongoDb,
          event.templateName,
          getEventSenderNumber(event),
        ),
      )
      .updateOne(
        { eventKey: event.eventKey },
        {
          $set: {
            matchedUploadId: Number(latestReport.uploadId),
            matchedNumberId: Number(latestReport.numberId),
            modifiedAt: now,
          },
        },
      )
      .catch((err) =>
        console.warn("[inbound] matchedIds write-back failed:", err.message),
      );
  }

  return {
    applied: true,
    uploadId: latestReport.uploadId || null,
    numberId: latestReport.numberId || null,
  };
}

async function applyOutboundStatusToReports(event) {
  if (event.eventType !== "outbound")
    return { applied: false, reason: "not_outbound" };

  const mobile = event.normalizedMobile;
  const status = event.normalizedStatus || "reporting";
  const now = new Date().toISOString();

  const requestId = event.requestId;
  const senderReports = await getSenderReportsCollection(event.templateName);
  const numbers = mongoDb.collection("whatsapp_numbers");

  let latestReport = null;
  let matchedBy = null;
  if (requestId) {
    latestReport = await senderReports.findOne(
      { $or: [{ responseId: requestId }, { messageId: requestId }] },
      { sort: { sentAt: -1, updatedAt: -1, _id: -1 } },
    );
    if (latestReport) matchedBy = "requestId";
  }

  if (!latestReport) {
    latestReport = await findSenderReportByWebhookContent(event);
    if (latestReport) matchedBy = "content";
  }

  if (!latestReport && mobile) {
    latestReport = await senderReports.findOne(
      { mobile },
      { sort: { sentAt: -1, updatedAt: -1, _id: -1 } },
    );
    if (latestReport) matchedBy = "mobile";
  }

  if (!requestId && !mobile) {
    console.log("[outbound] no match key available — skipping", { status });
    return { applied: false, reason: "no_match_key" };
  }

  if (!latestReport) {
    console.log("[outbound] no sender report found", { mobile, requestId, status });
    return { applied: false, reason: "no_sender_report" };
  }

  console.log(`[outbound] status → ${status} (matched by ${matchedBy})`, { mobile, requestId, uploadId: latestReport.uploadId, numberId: latestReport.numberId });

  await senderReports.updateOne(
    { _id: latestReport._id },
    {
      $set: {
        currentStatus: status,
        deliveryStatus: status,
        reportWebhook: event,
        responseId: requestId || latestReport.responseId || null,
        messageId: requestId || latestReport.messageId || null,
        updatedAt: now,
      },
    },
  );

  if (latestReport.uploadId && latestReport.numberId) {
    await numbers.updateOne(
      { uploadId: latestReport.uploadId, numberId: latestReport.numberId },
      {
        $set: {
          currentStatus: status,
          deliveryStatus: status,
          responseId: requestId || null,
          messageId: requestId || null,
          responseDetails: event,
          lastUpdated: now,
        },
      },
    );
  }

  return {
    applied: true,
    uploadId: latestReport.uploadId,
    numberId: latestReport.numberId,
  };
}

async function storeWebhook(body, context = {}) {
  const rawItems = getPayloadItems(body).filter(
    (item) => item && typeof item === "object",
  );
  const items = rawItems
    .filter((item) => !shouldIgnoreItem(item))
    .map((item) => normalizeWebhookItem(item, context));

  if (!items.length) {
    console.log(`[store] all ${rawItems.length} item(s) ignored (test filter)`);
    return { insertedCount: 0, matchedCount: 0, ignoredCount: rawItems.length };
  }
  const ignoredCount = rawItems.length - items.length;
  if (ignoredCount > 0) {
    console.log(`[store] ${ignoredCount} item(s) ignored (test filter), ${items.length} to process`);
  }

  // Raw webhook logs go into msg91_webhooks collections named by template, or
  // sendernumber_template when the same template is used by multiple senders.
  const groups = new Map(); // collectionName -> items[]
  for (const item of items) {
    const collectionName = await webhookLogCollectionName(
      mongoDb,
      item.templateName,
      getEventSenderNumber(item),
    );
    if (!groups.has(collectionName)) groups.set(collectionName, []);
    groups.get(collectionName).push(item);
  }

  let insertedCount = 0;
  let matchedCount = 0;
  let modifiedCount = 0;
  const applyResultsByItem = new Map();
  const now = new Date().toISOString();

  for (const [collectionName, groupItems] of groups) {
    const webhookEvents = webhookEventsDb.collection(collectionName);
    await ensureIndexesOnce(webhookEvents, WEBHOOK_EVENTS_INDEX_DEFS, safeCreateIndex);

    // Primary dedup: eventKey (SHA256 of all identifying fields including uuid).
    // Secondary dedup: stableKey for inbound events — catches MSG91 webhook
    // retries where the uuid changes but the mobile+text+replyMsgId are the same.
    const inboundStableKeys = groupItems
      .filter((i) => i.stableKey)
      .map((i) => i.stableKey);

    const [existingByEventKey, existingByStableKey] = await Promise.all([
      webhookEvents
        .find(
          { eventKey: { $in: groupItems.map((i) => i.eventKey) } },
          { projection: { eventKey: 1 } },
        )
        .toArray(),
      inboundStableKeys.length
        ? webhookEvents
            .find(
              { stableKey: { $in: inboundStableKeys } },
              { projection: { stableKey: 1 } },
            )
            .toArray()
        : Promise.resolve([]),
    ]);

    const existingEventKeys = new Set(existingByEventKey.map((e) => e.eventKey));
    const existingStableKeys = new Set(
      existingByStableKey.map((e) => e.stableKey).filter(Boolean),
    );

    const operations = groupItems.map((item) => {
      const insertDoc = { ...item };
      delete insertDoc.updatedAt;
      delete insertDoc.modifiedAt;
      // These fields are also written via $set below — Mongo rejects an update
      // that targets the same path from both $setOnInsert and $set.
      delete insertDoc.eventKey;
      delete insertDoc.stableKey;
      delete insertDoc.rawPayload;
      const dedupeFilter = existingEventKeys.has(item.eventKey)
        ? { eventKey: item.eventKey }
        : item.stableKey
          ? { stableKey: item.stableKey }
          : { eventKey: item.eventKey };
      return {
        updateOne: {
          filter: dedupeFilter,
          update: {
            $setOnInsert: { ...insertDoc, createdAt: insertDoc.createdAt || now },
            $set: {
              eventKey: item.eventKey,
              stableKey: item.stableKey || null,
              rawPayload: item.rawPayload,
              updatedAt: now,
              modifiedAt: now,
              lastSeenAt: now,
            },
            $inc: { seenCount: 1 },
          },
          upsert: true,
        },
      };
    });

    const result = await webhookEvents.bulkWrite(operations, {
      ordered: false,
    });
    insertedCount += result.upsertedCount || 0;
    matchedCount += result.matchedCount || 0;
    modifiedCount += result.modifiedCount || 0;

    const insertedOperationIndexes = new Set(
      Object.keys(result.upsertedIds || {}).map((value) => Number(value)),
    );
    const seenInRequest = new Set();
    for (const [index, item] of groupItems.entries()) {
      const requestDedupeKey = item.stableKey || item.eventKey;
      if (seenInRequest.has(requestDedupeKey)) {
        console.log(`[store] skip duplicate_in_request`, { mobile: item.normalizedMobile, type: item.eventType });
        applyResultsByItem.set(item, { applied: false, reason: "duplicate_in_request" });
        continue;
      }
      seenInRequest.add(requestDedupeKey);

      // Skip if already stored (primary or stable key match).
      if (existingEventKeys.has(item.eventKey)) {
        console.log(`[store] skip duplicate_event`, { mobile: item.normalizedMobile, type: item.eventType, eventKey: item.eventKey });
        applyResultsByItem.set(item, { applied: false, reason: "duplicate_event" });
        continue;
      }
      if (item.stableKey && existingStableKeys.has(item.stableKey)) {
        console.log(`[store] skip duplicate_stable_key`, { mobile: item.normalizedMobile, type: item.eventType });
        applyResultsByItem.set(item, { applied: false, reason: "duplicate_stable_key" });
        continue;
      }
      if (!insertedOperationIndexes.has(index)) {
        console.log(`[store] skip duplicate_upsert_match`, { mobile: item.normalizedMobile, type: item.eventType });
        applyResultsByItem.set(item, { applied: false, reason: "duplicate_upsert_match" });
        continue;
      }
      if (item.eventType === "inbound") {
        applyResultsByItem.set(item, await applyInboundReplyToReports(item));
      } else {
        applyResultsByItem.set(item, await applyOutboundStatusToReports(item));
      }
    }
  }

  const applyResults = items.map((item) => applyResultsByItem.get(item));

  return {
    insertedCount,
    matchedCount,
    modifiedCount,
    ignoredCount: rawItems.length - items.length,
    appliedCount: applyResults.filter((item) => item.applied).length,
    applyResults,
    events: items.map((item) => ({
      type: item.eventType,
      status: item.normalizedStatus,
      mobile: item.normalizedMobile,
      customerNumber: item.customerNumber,
      integratedNumber: item.integratedNumber,
      text: item.text,
      eventKey: item.eventKey,
    })),
  };
}

// Notify the local Electron app (if running) that new webhook data arrived.
// Runs fire-and-forget; failures are logged but never re-thrown.
const ELECTRON_NOTIFY_URL =
  process.env.ELECTRON_NOTIFY_URL || "http://127.0.0.1:3001/notify";

async function notifyElectronApp(payload = {}) {
  try {
    const http = require("http");
    const body = JSON.stringify(payload);
    await new Promise((resolve) => {
      const req = http.request(
        ELECTRON_NOTIFY_URL,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
          timeout: 1500,
        },
        (res) => {
          res.resume();
          resolve();
        },
      );
      req.on("error", resolve);
      req.on("timeout", () => {
        req.destroy();
        resolve();
      });
      req.write(body);
      req.end();
    });
  } catch {}
}

function getRequestIp(req) {
  return (
    req.headers["x-real-ip"] ||
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.ip ||
    "unknown"
  );
}

// Structured, greppable confirmation that MSG91 received a 200. Every ack
// point (normal, duplicate, throttled, or error-forced) logs through here so
// the PM2 log file can be audited for "did we ALWAYS return 200" across all
// inbound and outbound webhook traffic.
function logMsg91Ack(req, res, context = {}, outcome = "ok") {
  console.log(
    JSON.stringify({
      tag: "msg91-ack",
      ts: new Date().toISOString(),
      status: res.statusCode,
      direction: context.webhookType || "unknown",
      outcome,
      route: req.originalUrl || req.path,
      ip: getRequestIp(req),
      templateName: context.templateName || null,
      uploadId: context.uploadId || null,
    }),
  );
}

function ackMsg91Webhook(req, res, context = {}, extra = {}) {
  if (res.headersSent) {
    console.warn("[webhook] ackMsg91Webhook called but headers already sent");
    return;
  }
  res.status(200).json({ success: true, received: true, ...extra });
  logMsg91Ack(req, res, context, extra.fallback ? "fallback" : "ok");
}

function processWebhookAfterAck(body, context, notifyPayload, label) {
  storeWebhook(body, context)
    .then((result) => {
      notifyElectronApp({
        ...notifyPayload,
        insertedCount: result.insertedCount,
        appliedCount: result.appliedCount,
      });
      console.log(`${label} processed`, {
        insertedCount: result.insertedCount,
        matchedCount: result.matchedCount,
        appliedCount: result.appliedCount,
      });
    })
    .catch((error) => {
      console.error(`${label} processing failed:`, error);
    });
}

async function main() {
  await initMongo();

  const app = express();

  // ── global middleware (applied to every request) ──────────────────────────
  // 1. Structured JSON request logger (must be first to capture all requests)
  app.use(requestLogger);

  // 2. Body parsers
  app.use(express.json({ limit: "10mb", verify: captureRawBody }));
  app.use(express.urlencoded({ extended: true, limit: "10mb", verify: captureRawBody }));

  const webhookAuditLogger = createWebhookAuditLogger({ getDb: () => mongoDb });
  app.use(/^\/webhook(?:\/.*)?$/, webhookAuditLogger);

  // ── health & metrics (NO rate limiting) ───────────────────────────────────
  app.get("/health", (req, res) => {
    const rateLimit = rateLimitStatus();
    const memory = process.memoryUsage();
    res.status(200).json({
      ok: true,
      service: SERVICE_NAME,
      status: Boolean(mongoDb) ? "healthy" : "degraded",
      mongo: {
        connected: Boolean(mongoDb),
        database: MONGODB_DB_NAME || "(default)",
        webhookDatabase: MONGODB_WEBHOOK_DB_NAME || MONGODB_DB_NAME || "(default)",
      },
      redis: {
        connected: Boolean(rateLimit.redisConnected),
        store: rateLimit.store,
      },
      node: {
        version: process.version,
        env: process.env.NODE_ENV || "development",
        pid: process.pid,
      },
      memory: {
        rssMb: Math.round(memory.rss / 1024 / 1024),
        heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
        heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
      },
      uptimeSeconds: Math.floor(process.uptime()),
      webhook: {
        status: "ready",
        routes: [
          "POST /webhook",
          "POST /webhook/msg91",
          "POST /webhook/msg91/callback",
          "POST /webhook/msg91/:sender",
        ],
        auth: {
          secretHeaderConfigured: Boolean(process.env.WEBHOOK_SECRET || process.env.MSG91_WEBHOOK_SECRET),
          signatureConfigured: Boolean(process.env.MSG91_SIGNATURE_SECRET || process.env.MSG91_WEBHOOK_SIGNATURE_SECRET),
          ipWhitelistConfigured: Boolean(process.env.MSG91_IP_WHITELIST || process.env.WEBHOOK_TRUSTED_IPS),
        },
      },
      rateLimit,
    });
  });

  // Monitoring metrics endpoint — exposes request counts, blocked requests,
  // duplicate webhook count, memory usage, and per-endpoint hit counts.
  // Restrict to localhost in nginx or add auth header check for production.
  app.get("/metrics", (req, res) => {
    res.status(200).json(getMetricsSnapshot());
  });

  // ── webhook GET ping (no rate limit needed — MSG91 uses this to verify) ──
  app.get("/webhook", (req, res) => {
    res.status(200).json({
      ok: true,
      service: SERVICE_NAME,
      message: "MSG91 must call this endpoint using POST.",
    });
  });

  // ── shared webhook middleware stack ────────────────────────────────────────
  // Build the dedup middleware once, closed over the live `webhookEventsDb`.
  const dedupWebhook = webhookDedupMiddleware(() => webhookEventsDb, {
    returnDuplicatesAs200: true, // MSG91 must never see non-2xx
  });

  // Composed middleware for every MSG91 webhook POST:
  //   1. webhookLimiter  — rate-limit (returns 200 + throttled:true if exceeded)
  //   2. dedupWebhook    — duplicate check (returns 200 + duplicate:true if seen)
  //   3. route handler   — normal processing
  const webhookMiddleware = [webhookAuthMiddleware, webhookLimiter, dedupWebhook];

  // ── debug endpoint (public API rate limit, no dedup) ──────────────────────
  // Echo endpoint — POST any payload here to see exactly what arrives and how
  // it is normalised. Safe to use for MSG91 test deliveries.
  // Example: curl -X POST https://crm.ipkwealth.com/debug-webhook -H "Content-Type: application/json" -d '{"test":1}'
  app.post("/debug-webhook", apiLimiter, (req, res) => {
    const body = req.body || {};
    const items = getPayloadItems(body);
    const normalised = items.map((item) =>
      normalizeWebhookItem(item, { webhookType: "debug" }),
    );
    console.log("[debug-webhook] raw body:", JSON.stringify(body, null, 2));
    console.log(
      "[debug-webhook] normalised items:",
      JSON.stringify(
        normalised.map(
          ({
            eventType,
            normalizedStatus,
            normalizedMobile,
            requestId,
            text,
          }) => ({
            eventType,
            normalizedStatus,
            normalizedMobile,
            requestId,
            text,
          }),
        ),
        null,
        2,
      ),
    );
    res
      .status(200)
      .json({
        received: true,
        itemCount: items.length,
        normalised: normalised.map(
          ({
            eventType,
            normalizedStatus,
            normalizedMobile,
            requestId,
            text,
          }) => ({
            eventType,
            normalizedStatus,
            normalizedMobile,
            requestId,
            text,
          }),
        ),
      });
  });

  app.post("/webhook", webhookMiddleware, async (req, res) => {
    console.log(
      `[webhook] POST /webhook from ${req.ip} — body keys: ${Object.keys(req.body || {}).join(", ")}`,
    );
    ackMsg91Webhook(req, res, { webhookType: "msg91" });
    processWebhookAfterAck(
      req.body,
      { webhookType: "msg91" },
      { uploadId: null },
      "Webhook",
    );
  });

  app.post("/webhook/msg91", webhookMiddleware, async (req, res) => {
    console.log(
      `[webhook] POST /webhook/msg91 from ${req.ip} — body keys: ${Object.keys(req.body || {}).join(", ")}`,
    );
    ackMsg91Webhook(req, res, { webhookType: "msg91" });
    processWebhookAfterAck(
      req.body,
      { webhookType: "msg91" },
      { uploadId: null },
      "MSG91 webhook",
    );
  });

  app.post("/webhook/msg91/callback", webhookMiddleware, async (req, res) => {
    console.log(
      `[webhook] POST /webhook/msg91/callback from ${req.ip} — body keys: ${Object.keys(req.body || {}).join(", ")}`,
    );
    ackMsg91Webhook(req, res, { webhookType: "msg91_callback" });
    processWebhookAfterAck(
      req.body,
      { webhookType: "msg91_callback" },
      { uploadId: null },
      "MSG91 callback webhook",
    );
  });

  app.post("/webhook/msg91/inbound", webhookMiddleware, async (req, res) => {
    console.log(
      `[webhook] POST /webhook/msg91/inbound from ${req.ip} — body keys: ${Object.keys(req.body || {}).join(", ")}`,
    );
    ackMsg91Webhook(req, res, { webhookType: "inbound" });
    processWebhookAfterAck(
      req.body,
      { webhookType: "inbound" },
      { uploadId: null },
      "Inbound webhook",
    );
  });

  app.post("/webhook/msg91/outbound", webhookMiddleware, async (req, res) => {
    console.log(
      `[webhook] POST /webhook/msg91/outbound from ${req.ip} — body keys: ${Object.keys(req.body || {}).join(", ")}`,
    );
    ackMsg91Webhook(req, res, { webhookType: "outbound_report" });
    processWebhookAfterAck(
      req.body,
      { webhookType: "outbound_report" },
      { uploadId: null },
      "Outbound webhook",
    );
  });

  app.post("/webhook/msg91/:templateName/:uploadId", webhookMiddleware, async (req, res) => {
    const ctx = {
      templateName: req.params.templateName,
      uploadId: Number(req.params.uploadId) || null,
      webhookType: "outbound_report",
    };
    console.log(
      `[webhook] POST /webhook/msg91/${req.params.templateName}/${req.params.uploadId} from ${req.ip}`,
    );
    ackMsg91Webhook(req, res, ctx);
    processWebhookAfterAck(
      req.body,
      ctx,
      { uploadId: ctx.uploadId },
      "Template upload webhook",
    );
  });

  app.post("/webhook/msg91/:templateName", webhookMiddleware, async (req, res) => {
    const ctx = {
      templateName: req.params.templateName,
      webhookType: "outbound_report",
    };
    console.log(
      `[webhook] POST /webhook/msg91/${req.params.templateName} from ${req.ip}`,
    );
    ackMsg91Webhook(req, res, ctx);
    processWebhookAfterAck(
      req.body,
      ctx,
      { uploadId: null },
      "Template webhook",
    );
  });

  // Fallback — catches any /webhook/* pattern not matched above.
  // Apply webhook rate-limit + dedup here too.
  app.all(/^\/webhook(?:\/.*)?$/, webhookAuthMiddleware, webhookLimiter, dedupWebhook, (req, res) => {
    console.log(
      `[webhook] ${req.method} ${req.originalUrl} from ${req.ip} matched fallback`,
    );
    ackMsg91Webhook(req, res, { webhookType: "msg91" }, { fallback: true });
    if (req.method === "POST") {
      processWebhookAfterAck(
        req.body,
        { webhookType: "msg91" },
        { uploadId: null },
        "Fallback webhook",
      );
    }
  });

  // MSG91 auto-pauses webhooks on non-2XX, so always return 200 for any error.
  // Placed after routes so it catches both body-parser errors and route-level errors.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    console.error("Request error:", err && err.message);
    res
      .status(200)
      .json({ received: true, error: (err && err.message) || String(err) });
    if (req.path.startsWith("/webhook")) {
      logMsg91Ack(req, res, {}, "error-forced-200");
    }
  });

  app.listen(PORT, HOST, () => {
    console.log(`${SERVICE_NAME} listening on http://${HOST}:${PORT}/webhook`);
  });
}

main().catch((error) => {
  console.error("Webhook server failed:", error);
  process.exit(1);
});

async function shutdown() {
  await mongoClient?.close().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
