"use strict";

/**
 * One-time / idempotent seed for the `sender_numbers` collection, from the
 * WhatsApp numbers already configured in frontend/msg91.config.json.
 *
 * Run with:  node scripts/seed-sender-numbers.js
 *
 * Adding a new sender after this point does NOT require running this script
 * or any code change — insert a document directly into `sender_numbers`
 * (see README.md "Onboarding a new sender number").
 */

const mongoService = require("../services/mongo.service");
const SenderNumber = require("../models/SenderNumber");
const msg91Service = require("../services/msg91.service");

// Seed data mirrors the existing frontend/msg91.config.json integratedNumbers.
// department drives which controller/collection a number's events land in —
// anything not literally "marketing" | "crm" | "support" | "events" falls
// back to the generic "rm" bucket (rm_logs collection).
const SEED_SENDERS = [
  {
    senderNumber: "919363406313",
    department: "RM-General",
    collectionName: "rm_general_logs",
    label: "919363406313-RM-General",
    ownerEmail: "prabhukumarasamy@ipkwealth.com",
    enabled: true,
  },
  {
    senderNumber: "919363406314",
    department: "Operations",
    collectionName: "operations_logs",
    label: "919363406314-OPERATIONS",
    ownerEmail: "prabhukumarasamy@ipkwealth.com",
    enabled: true,
  },
  {
    senderNumber: "919786200991",
    department: "RM-1",
    collectionName: "rm_1_logs",
    label: "919786200991-RamyaPriya",
    ownerEmail: "ramyapriya@ipkwealth.com",
    enabled: true,
  },
  {
    senderNumber: "919566467239",
    department: "RM-2",
    collectionName: "rm_2_logs",
    label: "919566467239-Bharath",
    ownerEmail: "bharath@ipkwealth.com",
    enabled: true,
  },
];

async function seed() {
  await mongoService.connect();
  const db = mongoService.getDb();
  await SenderNumber.ensureIndexes(db);

  for (const doc of SEED_SENDERS) {
    await SenderNumber.upsert(db, doc);
    console.log(`  ok  ${doc.senderNumber}  (${doc.department} → ${doc.collectionName})`);
  }

  // MongoDB auto-creates a collection on first insert either way, but doing
  // it here — with indexes — guarantees each collectionName referenced above
  // exists and is indexed before any real webhook traffic arrives.
  const uniqueCollectionNames = [...new Set(SEED_SENDERS.map((doc) => doc.collectionName).filter(Boolean))];
  for (const collectionName of uniqueCollectionNames) {
    await msg91Service.ensureDepartmentCollectionIndexes(collectionName);
    console.log(`  ok  collection ready: ${collectionName}`);
  }

  console.log(`\nseeded ${SEED_SENDERS.length} sender_numbers document(s) and ${uniqueCollectionNames.length} log collection(s)`);
  await mongoService.close();
}

seed().catch((error) => {
  console.error("seed failed:", error);
  process.exit(1);
});
