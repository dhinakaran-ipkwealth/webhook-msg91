/**
 * template-collections.js
 *
 * Each MSG91 template gets its own MongoDB collection for sender reports and
 * webhook events instead of pooling every template into one shared collection.
 * This keeps regulated templates (e.g. trading_confirmation, audited for SEBI)
 * isolated from marketing/KYC/etc. traffic.
 *
 * Naming: `${baseName}_${sanitizedTemplateName}`, e.g.
 *   whatsapp_sender_reports_trading_confirmation
 *   whatsapp_webhook_events_trading_confirmation
 *
 * When a template name can't be resolved, callers fall back to `baseName`
 * itself, which keeps acting as the shared/unclassified bucket it always was.
 */

"use strict";

function sanitizeTemplateName(name) {
  const cleaned = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || null;
}

function templateCollectionName(baseName, templateName) {
  const sanitized = sanitizeTemplateName(templateName);
  return sanitized ? `${baseName}_${sanitized}` : baseName;
}

/**
 * Every whatsapp_uploads doc already records templateName, so that collection
 * is the source of truth for "which templates exist" — no separate registry
 * needed. Always includes `baseName` itself for unclassified/legacy rows.
 */
async function getKnownCollectionNames(mongoDb, baseName) {
  const names = new Set([baseName]);
  try {
    const templateNames = await mongoDb
      .collection("whatsapp_uploads")
      .distinct("templateName");
    templateNames.forEach((name) => {
      names.add(templateCollectionName(baseName, name));
    });
  } catch (error) {
    console.warn(
      `[template-collections] failed to list known templates for ${baseName}:`,
      error.message,
    );
  }
  return [...names];
}

/**
 * Lazily create indexes on a collection the first time this process touches
 * it, so a brand-new template's collection gets indexed without a restart.
 * Memoized per collection name for the lifetime of the process.
 */
const indexedCollections = new Set();

async function ensureIndexesOnce(collection, indexDefs, safeCreateIndex) {
  const name = collection.collectionName;
  if (indexedCollections.has(name)) return;
  indexedCollections.add(name);
  for (const { key, options } of indexDefs) {
    await safeCreateIndex(collection, key, options || {});
  }
}

module.exports = {
  sanitizeTemplateName,
  templateCollectionName,
  getKnownCollectionNames,
  ensureIndexesOnce,
};
