"use strict";

/**
 * Core MSG91 webhook business logic: normalizing incoming payload items,
 * persisting them (with dedup), and reconciling delivery status / inbound
 * replies against `whatsapp_sender_reports` / `whatsapp_numbers` so the CRM's
 * campaign dashboard stays in sync.
 *
 * This is a direct extraction of the logic that has been running in
 * production (previously inlined in webhook-server.js) — behavior is
 * unchanged. The only addition is an optional, additive write into a
 * department-level `<department>_logs` collection (see senderResolver
 * .service.js) so unlimited sender numbers can be onboarded via the
 * `sender_numbers` collection without touching this file.
 */

const env = require("../config/env");
const mongoService = require("./mongo.service");
const {
  templateCollectionName,
  getEventSenderNumber,
  webhookLogCollectionName,
  ensureIndexesOnce: ensureTemplateIndexesOnce,
} = require("../lib/template-collections");
const { sha256, stableStringify } = require("../utils/hash");
const { formatPhoneForCall } = require("../utils/phone");
const {
  parseMaybeJson,
  createStatusLabel,
  getPayloadItems,
  inferEventType,
  extractButtonText,
  extractInteractiveText,
  extractMessagesText,
  getMsg91CorrelationId,
  extractReactionText,
  extractContentText,
  extractMessageText,
  getCustomerNumber,
  extractWebhookContentValues,
} = require("../utils/payload");

const SERVICE_NAME = env.SERVICE_NAME;

function shouldIgnoreItem(item) {
  const text = extractMessageText(item).toLowerCase();
  const customer = formatPhoneForCall(getCustomerNumber(item));
  const testTexts = new Set(["test reply", "test", "curl test"]);
  return env.IGNORE_TEST_WEBHOOKS && testTexts.has(text) && customer === "919363406313";
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
    item.ts || item.statusUpdatedAt || item.requestedAt || new Date().toISOString();

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
  // retries the webhook with a fresh uuid. Used as a secondary dedup guard.
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
    normalizedStatus: eventType === "inbound" ? "inbound" : createStatusLabel(statusSource),
    normalizedMobile: normalizedMobile || null,
    text,
    requestId,
    templateName: item.templateName || item.template_name || context.templateName || null,
    uploadId: item.uploadId || item.upload_id || context.uploadId || null,
    webhookType: item.webhookType || item.webhook_type || context.webhookType || "msg91",
    department: context.department || null,
    customerNumber: item.customerNumber || item.customer_number || normalizedMobile || null,
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
    options: { unique: true, partialFilterExpression: { stableKey: { $type: "string" } } },
  },
  { key: { modifiedAt: -1 } },
];

const SENDER_REPORTS_INDEX_DEFS = [
  { key: { mobile: 1, sentAt: -1 } },
  { key: { responseId: 1 } },
  { key: { messageId: 1 } },
];

async function getWebhookEventsCollection(templateName, senderNumber = "") {
  const mongoDb = mongoService.getDb();
  const webhookEventsDb = mongoService.getWebhookEventsDb();
  const name = await webhookLogCollectionName(mongoDb, templateName, senderNumber);
  const collection = webhookEventsDb.collection(name);
  await ensureTemplateIndexesOnce(collection, WEBHOOK_EVENTS_INDEX_DEFS, mongoService.safeCreateIndex);
  return collection;
}

async function getSenderReportsCollection(templateName) {
  const mongoDb = mongoService.getDb();
  const name = templateCollectionName("whatsapp_sender_reports", templateName);
  const collection = mongoDb.collection(name);
  await ensureTemplateIndexesOnce(collection, SENDER_REPORTS_INDEX_DEFS, mongoService.safeCreateIndex);
  return collection;
}

async function ensureCoreIndexes() {
  const mongoDb = mongoService.getDb();
  const webhookEventsDb = mongoService.getWebhookEventsDb();

  const webhookEvents = webhookEventsDb.collection("whatsapp_webhook_events");
  for (const { key, options } of WEBHOOK_EVENTS_INDEX_DEFS) {
    await mongoService.safeCreateIndex(webhookEvents, key, options || {});
  }

  const senderReports = mongoDb.collection("whatsapp_sender_reports");
  for (const { key, options } of SENDER_REPORTS_INDEX_DEFS) {
    await mongoService.safeCreateIndex(senderReports, key, options || {});
  }
  // DO NOT create { uploadId: 1, numberId: 1 } here — the DB already has this
  // index as unique on whatsapp_numbers, created below.

  const numbers = mongoDb.collection("whatsapp_numbers");
  await mongoService.safeCreateIndex(numbers, { cleaned: 1, lastUpdated: -1 });
  await mongoService.safeCreateIndex(numbers, { uploadId: 1, numberId: 1 }, { unique: true });

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

function scoreSenderReportMatch(report, values) {
  if (!values.length) return 0;
  const reportText = [
    report.sentMessage,
    report.mobile,
    typeof report.csvRowData === "string" ? report.csvRowData : JSON.stringify(report.csvRowData || {}),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return values.reduce((score, value) => (reportText.includes(value.toLowerCase()) ? score + 1 : score), 0);
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
  if (event.eventType !== "inbound") return { applied: false, reason: "not_inbound" };

  const mongoDb = mongoService.getDb();
  const webhookEventsDb = mongoService.getWebhookEventsDb();

  const mobile = event.normalizedMobile;
  if (!mobile) return { applied: false, reason: "missing_mobile" };
  const replyText = event.text;
  // For non-text inbound messages (image, document, audio, etc.) text is null.
  // Still apply so the report is marked replied; use contentType as a label.
  const replyLabel = replyText || (event.contentType ? `[${event.contentType}]` : "[message]");

  const senderReports = await getSenderReportsCollection(event.templateName);
  const numbers = mongoDb.collection("whatsapp_numbers");
  const replyAt = event.receivedAt || new Date().toISOString();
  const now = new Date().toISOString();

  let latestReport = null;

  // Step 1: match exclusively by replyMsgId → responseId/messageId.
  // Sort newest-first so that today's campaign row is preferred when the same
  // wamid (responseId) appears across multiple uploads.
  if (event.requestId) {
    const msgIdQuery = { $or: [{ responseId: event.requestId }, { messageId: event.requestId }] };
    if (event.uploadId) msgIdQuery.uploadId = Number(event.uploadId);

    const candidates = await senderReports.find(msgIdQuery).sort({ sentAt: -1 }).toArray();

    latestReport = candidates.find((c) => !c.customReply && !c.lastReplyAt) || candidates[0] || null;
    console.log(`[inbound] requestId match — candidates: ${candidates.length}, matched: ${Boolean(latestReport)}`, {
      requestId: event.requestId,
      mobile,
    });
  }

  // Step 2: mobile fallback — used when no requestId is present.
  // Sort newest-first so the most-recent send campaign gets credit for the reply.
  if (!latestReport) {
    const mobileQuery = { mobile };
    if (event.uploadId) mobileQuery.uploadId = Number(event.uploadId);
    if (event.templateName) mobileQuery.templateName = event.templateName;

    const mobileCandidates = await senderReports.find(mobileQuery).sort({ sentAt: -1 }).toArray();

    latestReport = mobileCandidates.find((c) => !c.customReply && !c.lastReplyAt) || mobileCandidates[0] || null;
    console.log(`[inbound] mobile fallback — candidates: ${mobileCandidates.length}, matched: ${Boolean(latestReport)}`, {
      mobile,
      uploadId: event.uploadId,
    });
  }

  if (!latestReport) {
    console.log("Inbound reply received but no matching sender report found", { mobile, replyText });
    return { applied: false, reason: "no_sender_report" };
  }

  // Update sender report: set the reply status fields only. Each inbound
  // event is already stored as its own document in whatsapp_webhook_events
  // (unique eventKey index) — we do NOT append to replyHistory here.
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
  if (event.eventKey && latestReport.uploadId && latestReport.numberId) {
    webhookEventsDb
      .collection(await webhookLogCollectionName(mongoDb, event.templateName, getEventSenderNumber(event)))
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
      .catch((err) => console.warn("[inbound] matchedIds write-back failed:", err.message));
  }

  return { applied: true, uploadId: latestReport.uploadId || null, numberId: latestReport.numberId || null };
}

async function applyOutboundStatusToReports(event) {
  if (event.eventType !== "outbound") return { applied: false, reason: "not_outbound" };

  const mongoDb = mongoService.getDb();
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
    latestReport = await senderReports.findOne({ mobile }, { sort: { sentAt: -1, updatedAt: -1, _id: -1 } });
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

  console.log(`[outbound] status → ${status} (matched by ${matchedBy})`, {
    mobile,
    requestId,
    uploadId: latestReport.uploadId,
    numberId: latestReport.numberId,
  });

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

const DEPARTMENT_LOG_INDEX_DEFS = [
  { key: { receivedAt: -1 } },
  { key: { normalizedMobile: 1, receivedAt: -1 } },
  { key: { eventType: 1, normalizedStatus: 1, receivedAt: -1 } },
];

/**
 * Ensure a department-level log collection exists with sensible indexes.
 * MongoDB auto-creates a collection on first insert regardless, but calling
 * this up front (e.g. from scripts/seed-sender-numbers.js when a sender is
 * onboarded with a custom collectionName) guarantees the collection and its
 * indexes exist before any real traffic arrives, rather than being created
 * lazily — and unindexed — on the very first webhook.
 */
async function ensureDepartmentCollectionIndexes(collectionName) {
  if (!collectionName) return;
  const mongoDb = mongoService.getDb();
  const collection = mongoDb.collection(collectionName);
  await ensureTemplateIndexesOnce(collection, DEPARTMENT_LOG_INDEX_DEFS, mongoService.safeCreateIndex);
}

/**
 * Additive, append-only write into the department-level log collection named
 * by `sender_numbers.collectionName` (e.g. marketing_logs, rm_general_logs).
 * Purely additional — never blocks or alters the primary
 * whatsapp_webhook_events pipeline above.
 */
async function logToDepartmentCollection(collectionName, items) {
  if (!collectionName || !items.length) return;
  const mongoDb = mongoService.getDb();
  try {
    await ensureDepartmentCollectionIndexes(collectionName);
    await mongoDb.collection(collectionName).insertMany(
      items.map((item) => ({ ...item })),
      { ordered: false },
    );
  } catch (error) {
    // Duplicate key errors (unlikely — no unique index on this collection) or
    // partial batch failures should never fail the webhook response.
    console.warn(`[msg91] department log write failed for ${collectionName}:`, error.message);
  }
}

async function storeWebhook(body, context = {}) {
  const rawItems = getPayloadItems(body).filter((item) => item && typeof item === "object");
  const items = rawItems.filter((item) => !shouldIgnoreItem(item)).map((item) => normalizeWebhookItem(item, context));

  if (!items.length) {
    console.log(`[store] all ${rawItems.length} item(s) ignored (test filter)`);
    return { insertedCount: 0, matchedCount: 0, ignoredCount: rawItems.length, appliedCount: 0, applyResults: [], events: [] };
  }
  const ignoredCount = rawItems.length - items.length;
  if (ignoredCount > 0) {
    console.log(`[store] ${ignoredCount} item(s) ignored (test filter), ${items.length} to process`);
  }

  const webhookEventsDb = mongoService.getWebhookEventsDb();
  const mongoDb = mongoService.getDb();

  // Raw webhook logs go into msg91_webhooks collections named by template, or
  // sendernumber_template when the same template is used by multiple senders.
  const groups = new Map(); // collectionName -> items[]
  for (const item of items) {
    const collectionName = await webhookLogCollectionName(mongoDb, item.templateName, getEventSenderNumber(item));
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
    await ensureTemplateIndexesOnce(webhookEvents, WEBHOOK_EVENTS_INDEX_DEFS, mongoService.safeCreateIndex);

    // Primary dedup: eventKey (SHA256 of all identifying fields including uuid).
    // Secondary dedup: stableKey for inbound events — catches MSG91 webhook
    // retries where the uuid changes but the mobile+text+replyMsgId are the same.
    const inboundStableKeys = groupItems.filter((i) => i.stableKey).map((i) => i.stableKey);

    const [existingByEventKey, existingByStableKey] = await Promise.all([
      webhookEvents.find({ eventKey: { $in: groupItems.map((i) => i.eventKey) } }, { projection: { eventKey: 1 } }).toArray(),
      inboundStableKeys.length
        ? webhookEvents.find({ stableKey: { $in: inboundStableKeys } }, { projection: { stableKey: 1 } }).toArray()
        : Promise.resolve([]),
    ]);

    const existingEventKeys = new Set(existingByEventKey.map((e) => e.eventKey));
    const existingStableKeys = new Set(existingByStableKey.map((e) => e.stableKey).filter(Boolean));

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

    const result = await webhookEvents.bulkWrite(operations, { ordered: false });
    insertedCount += result.upsertedCount || 0;
    matchedCount += result.matchedCount || 0;
    modifiedCount += result.modifiedCount || 0;

    const insertedOperationIndexes = new Set(Object.keys(result.upsertedIds || {}).map((value) => Number(value)));
    const seenInRequest = new Set();
    const newlyInsertedItems = [];
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
      newlyInsertedItems.push(item);
      if (item.eventType === "inbound") {
        applyResultsByItem.set(item, await applyInboundReplyToReports(item));
      } else {
        applyResultsByItem.set(item, await applyOutboundStatusToReports(item));
      }
    }

    // Additive department-level log (only for genuinely new events).
    if (context.departmentCollectionName && newlyInsertedItems.length) {
      await logToDepartmentCollection(context.departmentCollectionName, newlyInsertedItems);
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
async function notifyElectronApp(payload = {}) {
  try {
    const http = require("http");
    const body = JSON.stringify(payload);
    await new Promise((resolve) => {
      const req = http.request(
        env.ELECTRON_NOTIFY_URL,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
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
  } catch {
    // best-effort only
  }
}

/**
 * Fire the storeWebhook pipeline in the background — the caller has already
 * responded 200 to MSG91 by the time this runs. Never throws.
 */
function processWebhookAfterAck(body, context, notifyPayload, label) {
  storeWebhook(body, context)
    .then((result) => {
      notifyElectronApp({ ...notifyPayload, insertedCount: result.insertedCount, appliedCount: result.appliedCount });
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

module.exports = {
  shouldIgnoreItem,
  normalizeWebhookItem,
  getPayloadItems,
  storeWebhook,
  ensureCoreIndexes,
  ensureDepartmentCollectionIndexes,
  processWebhookAfterAck,
  notifyElectronApp,
};
