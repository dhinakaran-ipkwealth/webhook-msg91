"use strict";

const { MongoClient } = require("mongodb");
const env = require("../config/env");

let mongoClient = null;
let mongoDb = null; // main CRM database (sender_numbers, webhook_logs, whatsapp_* collections)
let webhookEventsDb = null; // raw webhook event log database (may be same as mongoDb)

const indexedCollections = new Set();

async function safeCreateIndex(collection, key, options = {}) {
  try {
    await collection.createIndex(key, options);
  } catch (error) {
    if (
      error.codeName === "IndexKeySpecsConflict" ||
      error.code === 86 ||
      error.code === 11000
    ) {
      console.warn(
        `[mongo] index already exists with different options, skipping: ${collection.collectionName} ${JSON.stringify(key)}`,
      );
      return;
    }
    throw error;
  }
}

async function ensureIndexesOnce(collection, indexDefs) {
  const name = collection.collectionName;
  if (indexedCollections.has(name)) return;
  indexedCollections.add(name);
  for (const { key, options } of indexDefs) {
    await safeCreateIndex(collection, key, options || {});
  }
}

async function connect() {
  mongoClient = new MongoClient(env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
  });
  await mongoClient.connect();
  mongoDb = env.MONGODB_DB_NAME ? mongoClient.db(env.MONGODB_DB_NAME) : mongoClient.db();
  webhookEventsDb = env.MONGODB_WEBHOOK_DB_NAME
    ? mongoClient.db(env.MONGODB_WEBHOOK_DB_NAME)
    : mongoDb;

  console.log(
    `[mongo] connected — main: ${env.MONGODB_DB_NAME || "(default)"}, webhook: ${env.MONGODB_WEBHOOK_DB_NAME}`,
  );

  return { mongoClient, mongoDb, webhookEventsDb };
}

function getDb() {
  return mongoDb;
}

function getWebhookEventsDb() {
  return webhookEventsDb;
}

function isConnected() {
  return Boolean(mongoDb);
}

async function close() {
  await mongoClient?.close().catch(() => {});
}

module.exports = {
  connect,
  getDb,
  getWebhookEventsDb,
  isConnected,
  close,
  safeCreateIndex,
  ensureIndexesOnce,
};
