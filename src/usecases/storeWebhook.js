const normalize = require('./normalizeWebhook');
const mongoGateway = require('../gateways/mongoGateway');
const { applyInboundReplyToReports, applyOutboundStatusToReports } = require('./applyRepliesAndReports');

function shouldIgnoreItem(item) {
  const text = (normalize.extractMessageText ? normalize.extractMessageText(item) : (item.text || '')).toLowerCase();
  const customer = normalize.formatPhoneForCall ? normalize.formatPhoneForCall(normalize.getCustomerNumber ? normalize.getCustomerNumber(item) : '') : '';
  const testTexts = new Set(['test reply', 'test', 'curl test']);
  return (process.env.IGNORE_TEST_WEBHOOKS !== 'false' && testTexts.has(text) && customer === '919363406313');
}

async function storeWebhook(body, context = {}) {
  const rawItems = normalize.getPayloadItems(body).filter((item) => item && typeof item === 'object');
  const items = rawItems.filter((item) => !shouldIgnoreItem(item)).map((item) => normalize.normalizeWebhookItem(item, context));

  if (!items.length) return { insertedCount: 0, matchedCount: 0, ignoredCount: rawItems.length };

  // check existing eventKeys and stableKeys
  const inboundStableKeys = items.filter(i => i.stableKey).map(i => i.stableKey);
  const [existingByEventKey, existingByStableKey] = await Promise.all([
    mongoGateway.findWebhookEventsByEventKeys(items.map(i => i.eventKey)),
    inboundStableKeys.length ? mongoGateway.findWebhookEventsByStableKeys(inboundStableKeys) : Promise.resolve([]),
  ]);

  const existingEventKeys = new Set(existingByEventKey.map(e => e.eventKey));
  const existingStableKeys = new Set(existingByStableKey.map(e => e.stableKey).filter(Boolean));

  const now = new Date().toISOString();
  const operations = items.map((item) => {
    const insertDoc = { ...item };
    delete insertDoc.updatedAt;
    delete insertDoc.modifiedAt;
    const dedupeFilter = existingEventKeys.has(item.eventKey) ? { eventKey: item.eventKey } : item.stableKey ? { stableKey: item.stableKey } : { eventKey: item.eventKey };
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

  const result = await mongoGateway.bulkWriteWebhookEvents(operations, { ordered: false });

  const insertedOperationIndexes = new Set(Object.keys(result.upsertedIds || {}).map(v => Number(v)));
  const applyResults = [];
  const seenInRequest = new Set();
  for (const [index, item] of items.entries()) {
    const requestDedupeKey = item.stableKey || item.eventKey;
    if (seenInRequest.has(requestDedupeKey)) { applyResults.push({ applied: false, reason: 'duplicate_in_request' }); continue; }
    seenInRequest.add(requestDedupeKey);
    if (existingEventKeys.has(item.eventKey)) { applyResults.push({ applied: false, reason: 'duplicate_event' }); continue; }
    if (item.stableKey && existingStableKeys.has(item.stableKey)) { applyResults.push({ applied: false, reason: 'duplicate_stable_key' }); continue; }
    if (!insertedOperationIndexes.has(index)) { applyResults.push({ applied: false, reason: 'duplicate_upsert_match' }); continue; }
    if (item.eventType === 'inbound') { applyResults.push(await applyInboundReplyToReports(item)); } else { applyResults.push(await applyOutboundStatusToReports(item)); }
  }

  return {
    insertedCount: result.upsertedCount || 0,
    matchedCount: result.matchedCount || 0,
    modifiedCount: result.modifiedCount || 0,
    ignoredCount: rawItems.length - items.length,
    appliedCount: applyResults.filter((i) => i.applied).length,
    applyResults,
    events: items.map((i) => ({ type: i.eventType, status: i.normalizedStatus, mobile: i.normalizedMobile, customerNumber: i.customerNumber, integratedNumber: i.integratedNumber, text: i.text, eventKey: i.eventKey })),
  };
}

module.exports = { storeWebhook };
