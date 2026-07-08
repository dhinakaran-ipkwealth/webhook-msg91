"use strict";

const fs = require("fs");
const path = require("path");
const env = require("../config/env");
const mongoService = require("./mongo.service");
const WebhookLog = require("../models/WebhookLog");

const LOG_DIR = path.isAbsolute(env.LOG_DIR)
  ? env.LOG_DIR
  : path.join(__dirname, "..", env.LOG_DIR);

fs.mkdirSync(LOG_DIR, { recursive: true });

function todayLogFile() {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(LOG_DIR, `${date}.log`);
}

function writeFileLog(entry) {
  try {
    fs.appendFile(todayLogFile(), `${JSON.stringify(entry)}\n`, () => {});
  } catch (error) {
    console.warn("[logger] failed to write file log:", error.message);
  }
}

function info(message, meta = {}) {
  process.stdout.write(`${JSON.stringify({ level: "info", ts: new Date().toISOString(), message, ...meta })}\n`);
}

function warn(message, meta = {}) {
  process.stdout.write(`${JSON.stringify({ level: "warn", ts: new Date().toISOString(), message, ...meta })}\n`);
}

function error(message, meta = {}) {
  process.stderr.write(`${JSON.stringify({ level: "error", ts: new Date().toISOString(), message, ...meta })}\n`);
}

/**
 * Full webhook-request audit entry — written to both `logs/YYYY-MM-DD.log`
 * (file, for tailing/grepping on the box) and the `webhook_logs` Mongo
 * collection (for querying/reporting). Never throws — logging must not be
 * able to break a webhook response.
 */
async function logWebhookRequest(entry) {
  writeFileLog(entry);

  const db = mongoService.getDb();
  if (db) {
    await WebhookLog.record(db, entry);
  }
}

module.exports = { info, warn, error, logWebhookRequest, LOG_DIR };
