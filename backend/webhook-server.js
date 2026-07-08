"use strict";

/**
 * Process entrypoint. Kept at this path/name because ecosystem.config.js and
 * package.json scripts reference it directly — all actual logic lives in
 * app.js (Express wiring) and services/ (business logic).
 */

const env = require("./config/env");
const mongoService = require("./services/mongo.service");
const { ensureDedupIndexes } = require("./middlewares/webhook-dedup");
const msg91Service = require("./services/msg91.service");
const SenderNumber = require("./models/SenderNumber");
const WebhookLog = require("./models/WebhookLog");
const createApp = require("./app");

async function main() {
  await mongoService.connect();

  const db = mongoService.getDb();
  const webhookEventsDb = mongoService.getWebhookEventsDb();

  await ensureDedupIndexes(webhookEventsDb);
  await SenderNumber.ensureIndexes(db);
  await WebhookLog.ensureIndexes(db);
  await msg91Service.ensureCoreIndexes();

  const app = createApp();
  app.listen(env.PORT, env.HOST, () => {
    console.log(`${env.SERVICE_NAME} listening on http://${env.HOST}:${env.PORT}/webhook`);
  });
}

main().catch((error) => {
  console.error("Webhook server failed:", error);
  process.exit(1);
});

async function shutdown() {
  await mongoService.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
