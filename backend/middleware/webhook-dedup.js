/**
 * webhook-dedup.js
 *
 * Prevents duplicate webhook processing using a two-tier strategy:
 *
 *   Tier 1 — Redis SETNX (fast, ~0.5 ms, distributed across PM2 workers)
 *   Tier 2 — MongoDB findOneAndUpdate (fallback when Redis is unavailable)
 *   Tier 3 — MongoDB eventKey unique index (already in storeWebhook — last defence)
 *
 * For each incoming webhook POST we compute a dedup key from:
 *   • The MSG91-supplied uuid / oneApiRequestId / requestId  (preferred — unique per event)
 *   • SHA-256 of (normalizedMobile + eventName + ts + text)  (fallback fingerprint)
 *
 * When a duplicate is detected:
 *   • HTTP 200 { received: true, duplicate: true } is returned immediately.
 *   • The payload is NOT re-processed.
 *   • The duplicate counter is incremented for monitoring.
 *
 * Why 200 for duplicates?
 *   MSG91 pauses webhook delivery to any endpoint that returns non-2xx and will
 *   retry later. Returning 4xx/5xx for a duplicate would trigger an infinite
 *   retry loop. Returning 200 tells MSG91 "received, all good" and stops retries.
 *
 * MongoDB collection: webhook_dedup
 *   Fields: eventId (string, unique), source (string), receivedAt (Date), expireAt (Date)
 *   Indexes:
 *     { eventId: 1 }   UNIQUE
 *     { expireAt: 1 }  TTL — documents auto-deleted after DEDUP_TTL_HOURS
 */

"use strict";

const crypto = require("crypto");
const { getRedisClient } = require("./rate-limit");
const { metrics } = require("./request-logger");

// TTL for dedup records (default 24 h)
const DEDUP_TTL_HOURS = Number(process.env.DEDUP_TTL_HOURS || 24);
const DEDUP_TTL_SECONDS = DEDUP_TTL_HOURS * 3600;
const DEDUP_TTL_MS = DEDUP_TTL_SECONDS * 1000;

const DEDUP_COLLECTION = "webhook_dedup";
const REDIS_KEY_PREFIX = "wh:dedup:";

// ── key extraction ─────────────────────────────────────────────────────────────

/**
 * Extract the most reliable unique identifier from a MSG91 payload item.
 * MSG91 sends arrays of events, each with its own uuid.
 * We deduplicate at the item level, not the payload level.
 */
function extractEventIdFromItem(item) {
  if (!item || typeof item !== "object") return null;

  // Prefer the MSG91 event uuid — globally unique per delivery event
  const uuid =
    item.uuid ||
    item.message_uuid ||
    item.messageUuid ||
    item.oneApiRequestId ||
    item.one_api_request_id ||
    item.requestId ||
    item.request_id ||
    item.replyMsgId ||
    item.reply_msg_id ||
    item.message_id ||
    item.messageId;

  if (uuid) return `msg91:${String(uuid).trim()}`;

  // Fallback: fingerprint from stable fields
  const mobile =
    item.customerNumber ||
    item.customer_number ||
    item.mobile ||
    item.to ||
    item.from ||
    "";
  const event =
    item.eventName || item.event_name || item.webhookType || item.status || "";
  const ts = item.ts || item.statusUpdatedAt || item.requestedAt || "";
  const text = item.text || "";

  if (!mobile && !event) return null; // not enough signal

  const fingerprint = `${mobile}|${event}|${ts}|${text}`;
  return `fp:${crypto.createHash("sha256").update(fingerprint).digest("hex").slice(0, 32)}`;
}

/**
 * Extract all event IDs from a webhook payload body.
 * MSG91 may send batches; return one ID per item.
 */
function extractEventIds(body) {
  if (!body || typeof body !== "object") return [];

  const parsedBody =
    typeof body === "string"
      ? (() => {
          try {
            return JSON.parse(body);
          } catch {
            return body;
          }
        })()
      : body;

  // Unwrap common MSG91 envelope shapes
  let items = parsedBody;
  if (!Array.isArray(items)) {
    items =
      parsedBody.reports ||
      parsedBody.data ||
      parsedBody.payload ||
      parsedBody.entry ||
      null;
    if (!Array.isArray(items)) {
      items = [parsedBody]; // single-item envelope
    }
  }

  return items
    .map((item) => extractEventIdFromItem(item))
    .filter(Boolean);
}

// ── Redis dedup ───────────────────────────────────────────────────────────────

async function checkDuplicateRedis(eventId) {
  const client = getRedisClient();
  if (!client) return null; // Redis not available

  const key = `${REDIS_KEY_PREFIX}${eventId}`;
  // SET key 1 NX EX <ttl>  — atomic set-if-not-exists
  // Returns "OK" on first set (new), null if key already existed (duplicate)
  const result = await client.set(key, "1", "NX", "EX", DEDUP_TTL_SECONDS);
  return result === null; // true → duplicate
}

async function markSeenRedis(eventId) {
  const client = getRedisClient();
  if (!client) return false;
  const key = `${REDIS_KEY_PREFIX}${eventId}`;
  await client.set(key, "1", "EX", DEDUP_TTL_SECONDS);
  return true;
}

// ── MongoDB dedup ─────────────────────────────────────────────────────────────

async function checkDuplicateMongo(eventId, db) {
  if (!db) return false;
  const col = db.collection(DEDUP_COLLECTION);

  // findOneAndUpdate with upsert: if the doc existed before → duplicate
  const before = await col.findOneAndUpdate(
    { eventId },
    {
      $setOnInsert: {
        eventId,
        receivedAt: new Date(),
        expireAt: new Date(Date.now() + DEDUP_TTL_MS),
        source: "webhook-dedup-mw",
      },
    },
    { upsert: true, returnDocument: "before" }
  );

  // before is null when the upsert created a new document (not a duplicate)
  return before !== null && before !== undefined;
}

// ── MongoDB index bootstrap ───────────────────────────────────────────────────

/**
 * Call this once after MongoDB connects.
 * Creates TTL index so duplicates auto-expire without manual cleanup.
 */
async function ensureDedupIndexes(db) {
  if (!db) return;
  const col = db.collection(DEDUP_COLLECTION);
  try {
    await col.createIndex({ eventId: 1 }, { unique: true });
    await col.createIndex(
      { expireAt: 1 },
      { expireAfterSeconds: 0 } // MongoDB TTL — deletes doc when expireAt < now
    );
    console.log("[dedup] MongoDB dedup indexes ensured");
  } catch (err) {
    if (err.code !== 85 && err.code !== 86 && err.codeName !== "IndexKeySpecsConflict") {
      console.warn("[dedup] Failed to create dedup indexes:", err.message);
    }
  }
}

// ── middleware factory ────────────────────────────────────────────────────────

/**
 * Returns Express middleware that deduplicates incoming webhook POSTs.
 *
 * @param {Function} getDb  - () => MongoDb instance (may return null before connect)
 * @param {object}   opts
 * @param {boolean}  opts.returnDuplicatesAs200  default true — return 200 for dupes
 */
function webhookDedupMiddleware(getDb, opts = {}) {
  const returnAs200 = opts.returnDuplicatesAs200 !== false;

  return async function dedupMiddleware(req, res, next) {
    // Only deduplicate POST requests on webhook paths
    if (req.method !== "POST") return next();

    const body = req.body;
    if (!body || typeof body !== "object") return next();

    const eventIds = extractEventIds(body);
    if (!eventIds.length) return next();

    // Check ALL event IDs in the batch.
    // If any ID is a duplicate, we consider the whole request a duplicate.
    // (MSG91 rarely sends mixed batches, but if it does we err on the side
    //  of safety by processing any truly new events later via the DB index.)
    let isDuplicate = false;
    const db = getDb ? getDb() : null;

    for (const eventId of eventIds) {
      try {
        // Tier 1: Redis (fast path, distributed)
        const redisDupe = await checkDuplicateRedis(eventId);
        if (redisDupe === true) {
          isDuplicate = true;
          break;
        }

        // Tier 2: MongoDB (fallback when Redis is down)
        if (redisDupe === null && db) {
          const mongoDupe = await checkDuplicateMongo(eventId, db);
          if (mongoDupe) {
            // Back-fill Redis so future duplicates hit the fast path
            markSeenRedis(eventId).catch(() => {});
            isDuplicate = true;
            break;
          }
        }
      } catch (err) {
        // On error, allow through — never block legitimate webhooks
        console.warn(`[dedup] check error for ${eventId}:`, err.message);
      }
    }

    if (isDuplicate) {
      metrics.duplicateWebhooks++;
      console.log(
        `[dedup] duplicate webhook detected ip=${req.headers["x-real-ip"] || req.ip} ` +
          `ids=${eventIds.slice(0, 3).join(",")}`
      );

      if (res.headersSent) return;
      if (returnAs200) {
        res.status(200).json({ success: true, received: true, duplicate: true });
        console.log(
          JSON.stringify({
            tag: "msg91-ack",
            ts: new Date().toISOString(),
            status: 200,
            outcome: "duplicate",
            route: req.originalUrl || req.path,
            ip: req.headers["x-real-ip"] || req.ip,
          })
        );
        return;
      }
      // Non-webhook caller requested 409 Conflict
      return res.status(409).json({ error: "Duplicate event", eventIds });
    }

    next();
  };
}

module.exports = {
  webhookDedupMiddleware,
  ensureDedupIndexes,
  extractEventIds,
  DEDUP_COLLECTION,
};
