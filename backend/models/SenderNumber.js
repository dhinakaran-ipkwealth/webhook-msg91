"use strict";

/**
 * sender_numbers collection.
 *
 * This is the single source of truth for "which WhatsApp business number maps
 * to which department/controller/collection". Onboarding a new sender number
 * is a document insert — no code deploy required.
 *
 * Schema:
 *   senderNumber    string   MSG91 integrated/sender WhatsApp number, digits only (unique)
 *   department      string   Free-form label, e.g. "Marketing", "CRM", "Support",
 *                            "Events", "RM-General", "RM-1" ...
 *   collectionName  string   Mongo collection (in the main DB) department-level logs land in
 *   enabled         boolean  Set false to stop processing without deleting the config
 *   label           string?  Optional human-readable name (kept for parity with
 *                            the existing frontend msg91.config.json entries)
 *   ownerEmail      string?  Optional notification/owner email
 *   createdAt       Date
 *   updatedAt       Date
 */

const COLLECTION = "sender_numbers";

// Known literal route segments — anything else falls back to the RM controller,
// which is the generic per-relationship-manager handler.
const KNOWN_DEPARTMENT_CONTROLLERS = new Set([
  "marketing",
  "crm",
  "support",
  "events",
]);

function sanitizeNumber(value) {
  const digits = String(value || "").replace(/\D+/g, "");
  return digits || null;
}

function resolveControllerName(department) {
  const normalized = String(department || "").trim().toLowerCase();
  return KNOWN_DEPARTMENT_CONTROLLERS.has(normalized) ? normalized : "rm";
}

function collection(db) {
  return db.collection(COLLECTION);
}

async function ensureIndexes(db) {
  await collection(db).createIndex({ senderNumber: 1 }, { unique: true });
  await collection(db).createIndex({ enabled: 1 });
}

async function findByNumber(db, senderNumber) {
  const number = sanitizeNumber(senderNumber);
  if (!number) return null;
  return collection(db).findOne({ senderNumber: number });
}

async function listEnabled(db) {
  return collection(db).find({ enabled: true }).toArray();
}

async function upsert(db, doc) {
  const number = sanitizeNumber(doc.senderNumber);
  if (!number) throw new Error("senderNumber is required");
  const now = new Date();

  await collection(db).updateOne(
    { senderNumber: number },
    {
      $set: {
        senderNumber: number,
        department: doc.department,
        collectionName: doc.collectionName,
        enabled: doc.enabled !== false,
        label: doc.label || null,
        ownerEmail: doc.ownerEmail || null,
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );

  return findByNumber(db, number);
}

module.exports = {
  COLLECTION,
  sanitizeNumber,
  resolveControllerName,
  ensureIndexes,
  findByNumber,
  listEnabled,
  upsert,
};
