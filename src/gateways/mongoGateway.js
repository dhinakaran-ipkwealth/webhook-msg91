const { MongoClient } = require('mongodb');

let mongoClient = null;
let mongoDb = null;

async function init(mongoUri, dbName) {
  if (!mongoUri) {
    console.warn('MONGODB_URI not provided; mongoGateway will be inactive.');
    return { connected: false };
  }
  mongoClient = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 10000 });
  await mongoClient.connect();
  mongoDb = dbName ? mongoClient.db(dbName) : mongoClient.db();

  return { connected: true, db: mongoDb };
}

function getDb() {
  if (!mongoDb) throw new Error('MongoDB not initialised. Call init() first.');
  return mongoDb;
}

async function safeCreateIndex(collection, key, options = {}) {
  try {
    await collection.createIndex(key, options);
  } catch (error) {
    if (
      error.codeName === 'IndexKeySpecsConflict' ||
      error.code === 86 ||
      error.code === 11000
    ) {
      console.warn(`Index exists with different options, skipping: ${collection.collectionName} ${JSON.stringify(key)}`);
      return;
    }
    throw error;
  }
}

async function ensureIndexes() {
  const db = getDb();
  const webhookEvents = db.collection('whatsapp_webhook_events');
  await safeCreateIndex(webhookEvents, { receivedAt: -1 });
  await safeCreateIndex(webhookEvents, { source: 1, receivedAt: -1 });
  await safeCreateIndex(webhookEvents, { source: 1, sourceEventId: 1 });
  await safeCreateIndex(webhookEvents, { normalizedMobile: 1, receivedAt: -1 });
  await safeCreateIndex(webhookEvents, { eventType: 1, normalizedStatus: 1, receivedAt: -1 });
  await safeCreateIndex(webhookEvents, { eventKey: 1 }, { unique: true });
  await safeCreateIndex(webhookEvents, { stableKey: 1 }, { sparse: true });
  await safeCreateIndex(webhookEvents, { source: 1, stableKey: 1 }, { unique: true, partialFilterExpression: { stableKey: { $type: 'string' } } });
  await safeCreateIndex(webhookEvents, { modifiedAt: -1 });

  const senderReports = db.collection('whatsapp_sender_reports');
  await safeCreateIndex(senderReports, { mobile: 1, sentAt: -1 });
  await safeCreateIndex(senderReports, { responseId: 1 });
  await safeCreateIndex(senderReports, { messageId: 1 });

  const numbers = db.collection('whatsapp_numbers');
  await safeCreateIndex(numbers, { cleaned: 1, lastUpdated: -1 });
  await safeCreateIndex(numbers, { uploadId: 1, numberId: 1 }, { unique: true });
  await safeCreateIndex(numbers, { updatedAt: -1 });
}

async function bulkWriteWebhookEvents(operations, options = { ordered: false }) {
  const db = getDb();
  const webhookEvents = db.collection('whatsapp_webhook_events');
  return webhookEvents.bulkWrite(operations, options);
}

async function findWebhookEventsByEventKeys(keys) {
  if (!keys || !keys.length) return [];
  const db = getDb();
  return db.collection('whatsapp_webhook_events').find({ eventKey: { $in: keys } }, { projection: { eventKey: 1 } }).toArray();
}

async function findWebhookEventsByStableKeys(keys) {
  if (!keys || !keys.length) return [];
  const db = getDb();
  return db.collection('whatsapp_webhook_events').find({ stableKey: { $in: keys } }, { projection: { stableKey: 1 } }).toArray();
}

async function findWebhookEvents(query = {}, opts = {}) {
  const db = getDb();
  let cursor = db.collection('whatsapp_webhook_events').find(query || {});
  if (opts.sort) cursor = cursor.sort(opts.sort);
  if (opts.limit) cursor = cursor.limit(opts.limit);
  return cursor.toArray();
}

async function findUploadsByDateRange(startIso, endIso) {
  const db = getDb();
  const query = { createdAt: { $gte: startIso, $lt: endIso } };
  return db.collection('whatsapp_uploads').find(query).sort({ createdAt: -1 }).toArray();
}

async function findNumbersByUpload(uploadId, projection = null, sort = null) {
  const db = getDb();
  const q = { uploadId: Number(uploadId) };
  const opts = projection ? { projection } : {};
  let cursor = db.collection('whatsapp_numbers').find(q, opts);
  if (sort) cursor = cursor.sort(sort);
  return cursor.toArray();
}

async function findNumbersByIds(ids) {
  if (!ids || !ids.length) return [];
  const db = getDb();
  return db.collection('whatsapp_numbers').find({ id: { $in: ids.map(Number) } }).toArray();
}

async function findNumbersByMobiles(mobiles) {
  if (!mobiles || !mobiles.length) return [];
  const db = getDb();
  return db.collection('whatsapp_numbers').find({ cleaned: { $in: mobiles } }).sort({ lastUpdated: -1, id: -1 }).toArray();
}

async function findUploadById(id) {
  const db = getDb();
  return db.collection('whatsapp_uploads').findOne({ id: Number(id) });
}

async function updateUpload(filter, update, opts = {}) {
  const db = getDb();
  return db.collection('whatsapp_uploads').updateOne(filter, update, opts);
}

async function findSenderReports(query = {}, opts = {}) {
  const db = getDb();
  const coll = db.collection('whatsapp_sender_reports');
  let cursor = coll.find(query);
  if (opts.sort) cursor = cursor.sort(opts.sort);
  if (opts.limit) cursor = cursor.limit(opts.limit);
  return cursor.toArray();
}

async function findOneSenderReport(filter = {}, opts = {}) {
  const db = getDb();
  return db.collection('whatsapp_sender_reports').findOne(filter, opts);
}

async function updateSenderReport(filter, update) {
  const db = getDb();
  return db.collection('whatsapp_sender_reports').updateOne(filter, update);
}

async function updateNumber(filter, update, opts = {}) {
  const db = getDb();
  return db.collection('whatsapp_numbers').updateOne(filter, update, opts);
}

async function close() {
  try {
    await mongoClient?.close();
  } catch (e) {}
}

module.exports = {
  init,
  ensureIndexes,
  getDb,
  bulkWriteWebhookEvents,
  findWebhookEventsByEventKeys,
  findWebhookEventsByStableKeys,
  findWebhookEvents,
  findUploadsByDateRange,
  findNumbersByUpload,
  findNumbersByIds,
  findNumbersByMobiles,
  findUploadById,
  updateUpload,
  findSenderReports,
  findOneSenderReport,
  updateSenderReport,
  updateNumber,
  close,
};
