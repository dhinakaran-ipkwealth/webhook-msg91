require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const { MongoClient } = require("mongodb");

const PORT = Number(process.env.PORT || process.env.WEBHOOK_PORT || 3002);
const HOST = process.env.WEBHOOK_HOST || "0.0.0.0";
const MONGODB_URI = process.env.DATABASE_URL || process.env.MONGODB_URI;
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || "";
const SERVICE_NAME = "crm-msg91-webhook";

if (!MONGODB_URI) {
  console.error("DATABASE_URL or MONGODB_URI is required.");
  process.exit(1);
}

let mongoClient;
let mongoDb;

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
  if (cleaned.length === 11 && cleaned.startsWith("0")) return `91${cleaned.slice(1)}`;
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
  if (normalized.includes("fail") || normalized.includes("undel") || normalized.includes("reject")) return "failed";
  if (normalized.includes("sent") || normalized.includes("submit")) return "sent";
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

  const webhookType = String(
    item.webhookType ||
      item.webhook_type ||
      item.eventType ||
      item.event_type ||
      context.webhookType ||
      "",
  ).toLowerCase();

  if (webhookType.includes("inbound") || webhookType.includes("incoming")) return "inbound";
  if (webhookType.includes("outbound") || webhookType.includes("report")) return "outbound";

  const contentType = String(item.contentType || item.content_type || "").toLowerCase();
  const messageType = String(item.messageType || item.message_type || "").toLowerCase();

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
  return parsed.emoji || parsed.text || parsed.reaction || JSON.stringify(parsed);
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

  const receivedAt = item.ts || item.statusUpdatedAt || item.requestedAt || new Date().toISOString();

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
  const stableKey = eventType === "inbound" && requestId
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
    normalizedStatus: eventType === "inbound" ? "inbound" : createStatusLabel(statusSource),
    normalizedMobile: normalizedMobile || null,
    text,
    requestId,
    templateName: item.templateName || item.template_name || context.templateName || null,
    uploadId: item.uploadId || item.upload_id || context.uploadId || null,
    webhookType: item.webhookType || item.webhook_type || context.webhookType || "msg91",
    customerNumber: item.customerNumber || item.customer_number || normalizedMobile || null,
    integratedNumber: item.integratedNumber || item.integrated_number || null,
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

async function initMongo() {
  mongoClient = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  await mongoClient.connect();
  mongoDb = MONGODB_DB_NAME ? mongoClient.db(MONGODB_DB_NAME) : mongoClient.db();

  const webhookEvents = mongoDb.collection("whatsapp_webhook_events");
  await safeCreateIndex(webhookEvents, { receivedAt: -1 });
  await safeCreateIndex(webhookEvents, { source: 1, receivedAt: -1 });
  await safeCreateIndex(webhookEvents, { source: 1, sourceEventId: 1 });
  await safeCreateIndex(webhookEvents, { normalizedMobile: 1, receivedAt: -1 });
  await safeCreateIndex(webhookEvents, { eventType: 1, normalizedStatus: 1, receivedAt: -1 });
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

  const senderReports = mongoDb.collection("whatsapp_sender_reports");
  await safeCreateIndex(senderReports, { mobile: 1, sentAt: -1 });
  await safeCreateIndex(senderReports, { responseId: 1 });
  await safeCreateIndex(senderReports, { messageId: 1 });
  // DO NOT create { uploadId: 1, numberId: 1 } here. Your DB already has this index as unique.

  const numbers = mongoDb.collection("whatsapp_numbers");
  await safeCreateIndex(numbers, { cleaned: 1, lastUpdated: -1 });
  await safeCreateIndex(numbers, { uploadId: 1, numberId: 1 }, { unique: true });
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
      if (entry && typeof entry === "object") return entry.text || entry.value || "";
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

  const candidates = await mongoDb
    .collection("whatsapp_sender_reports")
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
  if (event.eventType !== "inbound") return { applied: false, reason: "not_inbound" };

  const mobile = event.normalizedMobile;
  const replyText = event.text;
  if (!mobile || !replyText) return { applied: false, reason: "missing_mobile_or_text" };

  const senderReports = mongoDb.collection("whatsapp_sender_reports");
  const numbers = mongoDb.collection("whatsapp_numbers");
  const replyAt = event.receivedAt || new Date().toISOString();
  const now = new Date().toISOString();
  const historyItem = buildReplyHistoryItem(event);

  // Step 1: try an exclusive match on the original message_id (replyMsgId).
  // This is the only reliable way to pin a reply to the correct sent row when
  // the same mobile number received several different messages in one upload.
  let latestReport = null;

  // Step 1: match exclusively by replyMsgId → responseId/messageId.
  // When multiple orders were sent to the same phone in one batch, they can
  // share the same wamid (pre-fix data) or have unique wamids (post-fix).
  // Either way, prefer the oldest row that hasn't received a reply yet so
  // each order gets its own reply rather than everything piling onto row 1.
  if (event.requestId) {
    const msgIdQuery = { $or: [{ responseId: event.requestId }, { messageId: event.requestId }] };
    if (event.uploadId) msgIdQuery.uploadId = Number(event.uploadId);

    const candidates = await senderReports
      .find(msgIdQuery)
      .sort({ sentAt: 1 })   // oldest first
      .toArray();

    latestReport =
      candidates.find((c) => !c.customReply && !c.lastReplyAt) ||
      candidates[0] ||
      null;
  }

  // Step 2: fall back to most-recent record for this mobile only when there
  // is no requestId to match on at all.
  if (!latestReport) {
    const mobileQuery = { mobile };
    if (event.uploadId) mobileQuery.uploadId = Number(event.uploadId);
    if (event.templateName) mobileQuery.templateName = event.templateName;

    const mobileCandidates = await senderReports
      .find(mobileQuery)
      .sort({ sentAt: 1 })
      .toArray();

    latestReport =
      mobileCandidates.find((c) => !c.customReply && !c.lastReplyAt) ||
      mobileCandidates[0] ||
      null;
  }

  if (!latestReport) {
    console.log("Inbound reply received but no matching sender report found", {
      mobile,
      replyText,
    });
    return { applied: false, reason: "no_sender_report" };
  }

  await senderReports.updateOne(
    {
      _id: latestReport._id,
      "replyHistory.eventKey": { $ne: event.eventKey },
    },
    {
      $set: {
        currentStatus: "replied",
        customReply: replyText,
        lastReplyAt: replyAt,
        replyWebhook: event,
        updatedAt: now,
      },
      $push: {
        replyHistory: {
          $each: [historyItem],
          $slice: -50,
        },
      },
    },
  );

  const numberFilter =
    latestReport.uploadId && latestReport.numberId
      ? { uploadId: latestReport.uploadId, numberId: latestReport.numberId }
      : { cleaned: mobile };

  await numbers.updateOne(
    {
      ...numberFilter,
      "replyHistory.eventKey": { $ne: event.eventKey },
    },
    {
      $set: {
        currentStatus: "replied",
        customReply: replyText,
        lastReplyAt: replyAt,
        responseDetails: event,
        lastUpdated: now,
      },
      $push: {
        replyHistory: {
          $each: [historyItem],
          $slice: -50,
        },
      },
    },
  );

  console.log("Inbound reply applied", {
    mobile,
    replyText,
    uploadId: latestReport.uploadId,
    numberId: latestReport.numberId,
  });

  return {
    applied: true,
    uploadId: latestReport.uploadId || null,
    numberId: latestReport.numberId || null,
  };
}

async function applyOutboundStatusToReports(event) {
  if (event.eventType !== "outbound") return { applied: false, reason: "not_outbound" };

  const mobile = event.normalizedMobile;
  const status = event.normalizedStatus || "reporting";
  const now = new Date().toISOString();

  const requestId = event.requestId;
  const senderReports = mongoDb.collection("whatsapp_sender_reports");
  const numbers = mongoDb.collection("whatsapp_numbers");

  let latestReport = null;
  if (requestId) {
    latestReport = await senderReports.findOne(
      { $or: [{ responseId: requestId }, { messageId: requestId }] },
      { sort: { sentAt: -1, updatedAt: -1, _id: -1 } },
    );
  }

  if (!latestReport) {
    latestReport = await findSenderReportByWebhookContent(event);
  }

  if (!latestReport && mobile) {
    latestReport = await senderReports.findOne(
      { mobile },
      { sort: { sentAt: -1, updatedAt: -1, _id: -1 } },
    );
  }

  if (!requestId && !mobile) return { applied: false, reason: "no_match_key" };

  if (!latestReport) return { applied: false, reason: "no_sender_report" };

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

  return { applied: true, uploadId: latestReport.uploadId, numberId: latestReport.numberId };
}

async function storeWebhook(body, context = {}) {
  const rawItems = getPayloadItems(body).filter((item) => item && typeof item === "object");
  const items = rawItems
    .filter((item) => !shouldIgnoreItem(item))
    .map((item) => normalizeWebhookItem(item, context));

  if (!items.length) {
    return { insertedCount: 0, matchedCount: 0, ignoredCount: rawItems.length };
  }

  const webhookEvents = mongoDb.collection("whatsapp_webhook_events");

  // Primary dedup: eventKey (SHA256 of all identifying fields including uuid).
  // Secondary dedup: stableKey for inbound events — catches MSG91 webhook
  // retries where the uuid changes but the mobile+text+replyMsgId are the same.
  const inboundStableKeys = items
    .filter((i) => i.stableKey)
    .map((i) => i.stableKey);

  const [existingByEventKey, existingByStableKey] = await Promise.all([
    webhookEvents
      .find({ eventKey: { $in: items.map((i) => i.eventKey) } }, { projection: { eventKey: 1 } })
      .toArray(),
    inboundStableKeys.length
      ? webhookEvents
          .find({ stableKey: { $in: inboundStableKeys } }, { projection: { stableKey: 1 } })
          .toArray()
      : Promise.resolve([]),
  ]);

  const existingEventKeys = new Set(existingByEventKey.map((e) => e.eventKey));
  const existingStableKeys = new Set(existingByStableKey.map((e) => e.stableKey).filter(Boolean));

  const now = new Date().toISOString();
  const operations = items.map((item) => {
    const insertDoc = { ...item };
    delete insertDoc.updatedAt;
    delete insertDoc.modifiedAt;
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

  const insertedOperationIndexes = new Set(
    Object.keys(result.upsertedIds || {}).map((value) => Number(value)),
  );
  const applyResults = [];
  const seenInRequest = new Set();
  for (const [index, item] of items.entries()) {
    const requestDedupeKey = item.stableKey || item.eventKey;
    if (seenInRequest.has(requestDedupeKey)) {
      applyResults.push({ applied: false, reason: "duplicate_in_request" });
      continue;
    }
    seenInRequest.add(requestDedupeKey);

    // Skip if already stored (primary or stable key match).
    if (existingEventKeys.has(item.eventKey)) {
      applyResults.push({ applied: false, reason: "duplicate_event" });
      continue;
    }
    if (item.stableKey && existingStableKeys.has(item.stableKey)) {
      applyResults.push({ applied: false, reason: "duplicate_stable_key" });
      continue;
    }
    if (!insertedOperationIndexes.has(index)) {
      applyResults.push({ applied: false, reason: "duplicate_upsert_match" });
      continue;
    }
    if (item.eventType === "inbound") {
      applyResults.push(await applyInboundReplyToReports(item));
    } else {
      applyResults.push(await applyOutboundStatusToReports(item));
    }
  }

  return {
    insertedCount: result.upsertedCount || 0,
    matchedCount: result.matchedCount || 0,
    modifiedCount: result.modifiedCount || 0,
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
const ELECTRON_NOTIFY_URL = process.env.ELECTRON_NOTIFY_URL || "http://127.0.0.1:3002/notify";

async function notifyElectronApp(payload = {}) {
  try {
    const http = require("http");
    const body = JSON.stringify(payload);
    await new Promise((resolve) => {
      const req = http.request(ELECTRON_NOTIFY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        timeout: 1500,
      }, (res) => { res.resume(); resolve(); });
      req.on("error", resolve);
      req.on("timeout", () => { req.destroy(); resolve(); });
      req.write(body);
      req.end();
    });
  } catch {}
}

async function main() {
  await initMongo();

  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true, limit: "10mb" }));

  app.get("/health", (req, res) => {
    res.json({ ok: true, service: SERVICE_NAME, mongoConnected: Boolean(mongoDb) });
  });

  app.get("/webhook", (req, res) => {
    res.json({
      ok: true,
      service: SERVICE_NAME,
      message: "MSG91 must call this endpoint using POST.",
    });
  });

  // Echo endpoint — POST any payload here to see exactly what arrives and how
  // it is normalised. Safe to use for MSG91 test deliveries.
  // Example: curl -X POST https://crm.ipkwealth.com/debug-webhook -H "Content-Type: application/json" -d '{"test":1}'
  app.post("/debug-webhook", (req, res) => {
    const body = req.body || {};
    const items = getPayloadItems(body);
    const normalised = items.map((item) => normalizeWebhookItem(item, { webhookType: "debug" }));
    console.log("[debug-webhook] raw body:", JSON.stringify(body, null, 2));
    console.log("[debug-webhook] normalised items:", JSON.stringify(normalised.map(({ eventType, normalizedStatus, normalizedMobile, requestId, text }) => ({ eventType, normalizedStatus, normalizedMobile, requestId, text })), null, 2));
    res.json({ received: true, itemCount: items.length, normalised: normalised.map(({ eventType, normalizedStatus, normalizedMobile, requestId, text }) => ({ eventType, normalizedStatus, normalizedMobile, requestId, text })) });
  });

  app.post("/webhook", async (req, res) => {
    console.log(`[webhook] POST /webhook from ${req.ip} — body keys: ${Object.keys(req.body || {}).join(", ")}`);
    try {
      const result = await storeWebhook(req.body, { webhookType: "msg91" });
      notifyElectronApp({ uploadId: null, insertedCount: result.insertedCount });
      res.json({ received: true, ...result });
    } catch (error) {
      console.error("Webhook processing failed:", error);
      res.status(500).json({ received: false, error: error.message || String(error) });
    }
  });

  app.post("/webhook/msg91/inbound", async (req, res) => {
    console.log(`[webhook] POST /webhook/msg91/inbound from ${req.ip} — body keys: ${Object.keys(req.body || {}).join(", ")}`);
    try {
      const result = await storeWebhook(req.body, { webhookType: "inbound" });
      notifyElectronApp({ uploadId: null, insertedCount: result.insertedCount });
      res.json({ received: true, ...result });
    } catch (error) {
      console.error("Inbound webhook processing failed:", error);
      res.status(500).json({ received: false, error: error.message || String(error) });
    }
  });

  app.post("/webhook/msg91/outbound", async (req, res) => {
    console.log(`[webhook] POST /webhook/msg91/outbound from ${req.ip} — body keys: ${Object.keys(req.body || {}).join(", ")}`);
    try {
      const result = await storeWebhook(req.body, { webhookType: "outbound_report" });
      notifyElectronApp({ uploadId: null, insertedCount: result.insertedCount });
      res.json({ received: true, ...result });
    } catch (error) {
      console.error("Outbound webhook processing failed:", error);
      res.status(500).json({ received: false, error: error.message || String(error) });
    }
  });

  app.post("/webhook/msg91/:templateName/:uploadId", async (req, res) => {
    const ctx = {
      templateName: req.params.templateName,
      uploadId: Number(req.params.uploadId) || null,
      webhookType: "outbound_report",
    };
    console.log(`[webhook] POST /webhook/msg91/${req.params.templateName}/${req.params.uploadId} from ${req.ip}`);
    try {
      const result = await storeWebhook(req.body, ctx);
      notifyElectronApp({ uploadId: ctx.uploadId, insertedCount: result.insertedCount });
      res.json({ received: true, ...result });
    } catch (error) {
      console.error("Template upload webhook processing failed:", error);
      res.status(500).json({ received: false, error: error.message || String(error) });
    }
  });

  app.post("/webhook/msg91/:templateName", async (req, res) => {
    const ctx = { templateName: req.params.templateName, webhookType: "outbound_report" };
    console.log(`[webhook] POST /webhook/msg91/${req.params.templateName} from ${req.ip}`);
    try {
      const result = await storeWebhook(req.body, ctx);
      notifyElectronApp({ uploadId: null, insertedCount: result.insertedCount });
      res.json({ received: true, ...result });
    } catch (error) {
      console.error("Template webhook processing failed:", error);
      res.status(500).json({ received: false, error: error.message || String(error) });
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