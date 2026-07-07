"use strict";

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const { MongoClient } = require("mongodb");
const { sanitizeTemplateName, templateCollectionName } = require("../lib/template-collections");

function parseArgs(argv) {
  const args = { dryRun: false };
  for (const raw of argv) {
    if (raw === "--dry-run") {
      args.dryRun = true;
    } else if (raw.startsWith("--template=")) {
      args.template = raw.slice("--template=".length);
    }
  }
  return args;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildTemplateMatchQuery(template) {
  const sanitized = sanitizeTemplateName(template);
  const variants = new Set(
    [template, sanitized, sanitized && sanitized.replace(/_/g, " ")].filter(
      Boolean,
    ),
  );
  const conditions = [];
  variants.forEach((variant) => {
    conditions.push({ templateName: new RegExp(`^${escapeRegex(variant)}$`, "i") });
  });
  return { $or: conditions };
}

async function migrateCollection({
  db,
  baseName,
  template,
  uniqueKeyFields,
  dryRun,
}) {
  const sourceCollection = db.collection(baseName);
  const targetName = templateCollectionName(baseName, template);
  const targetCollection = db.collection(targetName);

  const query = buildTemplateMatchQuery(template);
  const docs = await sourceCollection.find(query).toArray();

  if (!docs.length) {
    console.log(`[${baseName}] no matching docs found for "${template}"`);
    return { matched: 0, copied: 0 };
  }

  console.log(
    `[${baseName}] found ${docs.length} doc(s) for "${template}" -> ${targetName}${dryRun ? " (dry run)" : ""}`,
  );

  if (dryRun) {
    return { matched: docs.length, copied: 0 };
  }

  const operations = docs
    .map((doc) => {
      const filter = {};
      for (const field of uniqueKeyFields) {
        if (doc[field] === undefined || doc[field] === null) return null;
        filter[field] = doc[field];
      }
      if (!Object.keys(filter).length) return null;
      const insertDoc = { ...doc };
      delete insertDoc._id;
      return {
        updateOne: {
          filter,
          update: { $setOnInsert: insertDoc },
          upsert: true,
        },
      };
    })
    .filter(Boolean);

  const skipped = docs.length - operations.length;
  if (skipped) {
    console.warn(
      `[${baseName}] skipped ${skipped} doc(s) missing unique key fields (${uniqueKeyFields.join(", ")})`,
    );
  }

  const result = await targetCollection.bulkWrite(operations, { ordered: false });
  console.log(
    `[${baseName}] upserted ${result.upsertedCount || 0}, matched-existing ${result.matchedCount || 0}`,
  );
  return { matched: docs.length, copied: result.upsertedCount || 0 };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.template) {
    console.error("Usage: node migrate-template-collections.js --template=<name> [--dry-run]");
    process.exit(1);
  }

  const uri = process.env.DATABASE_URL || process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB_NAME || "";
  const webhookDbName = process.env.MONGODB_WEBHOOK_DB_NAME || "msg91_webhooks";

  if (!uri) {
    console.error("DATABASE_URL or MONGODB_URI is required.");
    process.exit(1);
  }

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  await client.connect();

  try {
    const mongoDb = dbName ? client.db(dbName) : client.db();
    const webhookEventsDb = webhookDbName ? client.db(webhookDbName) : mongoDb;

    const senderReportsResult = await migrateCollection({
      db: mongoDb,
      baseName: "whatsapp_sender_reports",
      template: args.template,
      uniqueKeyFields: ["uploadId", "numberId"],
      dryRun: args.dryRun,
    });

    const webhookEventsResult = await migrateCollection({
      db: webhookEventsDb,
      baseName: "whatsapp_webhook_events",
      template: args.template,
      uniqueKeyFields: ["eventKey"],
      dryRun: args.dryRun,
    });

    console.log("\nSummary:");
    console.log(
      `  whatsapp_sender_reports: ${senderReportsResult.matched} matched, ${senderReportsResult.copied} copied`,
    );
    console.log(
      `  whatsapp_webhook_events: ${webhookEventsResult.matched} matched, ${webhookEventsResult.copied} copied`,
    );
    console.log(
      "\nOriginal documents were left in place in the shared collections.",
    );
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
