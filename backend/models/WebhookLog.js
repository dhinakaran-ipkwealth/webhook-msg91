"use strict";

/**
 * webhook_logs collection — one document per inbound webhook HTTP request
 * (audit trail), independent of the per-department business-logic collections.
 *
 * Schema:
 *   timestamp        Date
 *   sender           string   sender/integrated WhatsApp number, digits only
 *   receiver         string   customer number the event concerns, if known
 *   event            string   webhook type / route matched (marketing, crm, msg91, ...)
 *   department       string?  resolved department label, if a sender config was found
 *   payload          object   raw request body
 *   headers          object   raw request headers
 *   response         object   what we sent back to MSG91
 *   status           number   HTTP status code returned
 *   processingTimeMs number   time spent handling the request
 */

const COLLECTION = "webhook_logs";

function collection(db) {
  return db.collection(COLLECTION);
}

async function ensureIndexes(db) {
  await collection(db).createIndex({ timestamp: -1 });
  await collection(db).createIndex({ sender: 1, timestamp: -1 });
  await collection(db).createIndex({ event: 1, timestamp: -1 });
}

async function record(db, entry) {
  try {
    await collection(db).insertOne({
      timestamp: new Date(),
      ...entry,
    });
  } catch (error) {
    console.warn("[webhook-log] failed to record audit log:", error.message);
  }
}

module.exports = { COLLECTION, ensureIndexes, record };
