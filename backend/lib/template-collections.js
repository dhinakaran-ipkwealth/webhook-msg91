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

function sanitizeSenderNumber(value) {
  const digits = String(value || "").replace(/\D+/g, "");
  return digits || null;
}

function getEventSenderNumber(event = {}) {
  return (
    event.senderNumber ||
    event.sender_number ||
    event.integratedNumber ||
    event.integrated_number ||
    event.rawPayload?.senderNumber ||
    event.rawPayload?.sender_number ||
    event.rawPayload?.integratedNumber ||
    event.rawPayload?.integrated_number ||
    event.rawPayload?.["Whatsapp Number"] ||
    event.rawPayload?.["Integrated Number"] ||
    event.from ||
    ""
  );
}

async function isTemplateSharedBySenders(mongoDb, templateName) {
  const template = sanitizeTemplateName(templateName);
  if (!template || !mongoDb) return false;
  try {
    const escaped = String(templateName || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rows = await mongoDb
      .collection("whatsapp_uploads")
      .find(
        {
          $or: [
            { templateName: new RegExp(`^${escaped}$`, "i") },
            { templateLabel: new RegExp(`^${escaped}$`, "i") },
          ],
        },
        { projection: { senderId: 1, senderNumber: 1 } },
      )
      .limit(1000)
      .toArray();
    const senders = new Set(
      rows
        .map((row) => sanitizeSenderNumber(row.senderNumber || row.senderId))
        .filter(Boolean),
    );
    return senders.size > 1;
  } catch (error) {
    console.warn(
      `[template-collections] failed to inspect sender usage for ${templateName}:`,
      error.message,
    );
    return false;
  }
}

async function webhookLogCollectionName(mongoDb, templateName, senderNumber = "") {
  const template = sanitizeTemplateName(templateName);
  if (!template) return "whatsapp_webhook_events";
  const sender = sanitizeSenderNumber(senderNumber);
  const shared = await isTemplateSharedBySenders(mongoDb, templateName);
  return shared && sender ? `${sender}_${template}` : template;
}

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
  sanitizeSenderNumber,
  getEventSenderNumber,
  templateCollectionName,
  webhookLogCollectionName,
  getKnownCollectionNames,
  ensureIndexesOnce,
};
