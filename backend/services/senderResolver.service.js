"use strict";

/**
 * Resolves an inbound MSG91 webhook to a department/controller/collection
 * using the `sender_numbers` Mongo collection — the single place a new
 * WhatsApp business number is onboarded. No code changes are needed to add
 * a sender: insert a document and it is picked up on the next lookup (cache
 * TTL below).
 */

const mongoService = require("./mongo.service");
const SenderNumber = require("../models/SenderNumber");
const { sanitizeSenderNumber } = require("../utils/phone");

const CACHE_TTL_MS = 30_000;
const cache = new Map(); // senderNumber -> { value, expiresAt }

const DEPARTMENT_COLLECTION_MAP = {
  marketing: "marketing_logs",
  crm: "crm_logs",
  support: "support_logs",
  events: "events_logs",
  rm: "rm_logs",
};

function collectionNameForController(controllerName) {
  return DEPARTMENT_COLLECTION_MAP[controllerName] || DEPARTMENT_COLLECTION_MAP.rm;
}

/**
 * Look up a sender's config by WhatsApp number (from payload, :sender param,
 * or integratedNumber on a report event). Returns null if unknown.
 */
async function resolveBySenderNumber(rawSenderNumber) {
  const senderNumber = sanitizeSenderNumber(rawSenderNumber);
  if (!senderNumber) return null;

  const cached = cache.get(senderNumber);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const db = mongoService.getDb();
  if (!db) return null;

  const doc = await SenderNumber.findByNumber(db, senderNumber);
  const value = doc
    ? {
        senderNumber: doc.senderNumber,
        department: doc.department,
        collectionName:
          doc.collectionName || collectionNameForController(SenderNumber.resolveControllerName(doc.department)),
        controllerName: SenderNumber.resolveControllerName(doc.department),
        enabled: doc.enabled !== false,
      }
    : null;

  cache.set(senderNumber, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/**
 * Resolve one of the fixed department route segments
 * (/webhook/msg91/marketing|crm|support|events). Always resolves — unknown
 * segments fall back to the generic "rm" bucket/collection.
 */
function resolveByDepartmentSegment(segment) {
  const controllerName = SenderNumber.resolveControllerName(segment);
  return {
    senderNumber: null,
    department: segment,
    collectionName: collectionNameForController(controllerName),
    controllerName,
    enabled: true,
  };
}

function invalidate(senderNumber) {
  const number = sanitizeSenderNumber(senderNumber);
  if (number) cache.delete(number);
  else cache.clear();
}

module.exports = {
  resolveBySenderNumber,
  resolveByDepartmentSegment,
  collectionNameForController,
  invalidate,
  DEPARTMENT_COLLECTION_MAP,
};
