"use strict";

const fs = require("fs");
const path = require("path");
const { getClientIp } = require("./webhook-auth");

const REDACTED = "[redacted]";
const SENSITIVE_HEADER_PATTERNS = [
  /^authorization$/i,
  /^cookie$/i,
  /^x-api-key$/i,
  /^x-webhook-secret$/i,
  /^x-msg91-webhook-secret$/i,
  /^x-msg91-signature$/i,
];

function sanitizeHeaders(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => {
      const shouldRedact = SENSITIVE_HEADER_PATTERNS.some((pattern) => pattern.test(key));
      return [key, shouldRedact ? REDACTED : value];
    }),
  );
}

function createWebhookAuditLogger(options = {}) {
  const getDb = options.getDb || (() => null);
  const logDir = options.logDir || path.resolve(__dirname, "..", "logs");
  const logFile = options.logFile || path.join(logDir, "webhook.log");

  fs.mkdirSync(logDir, { recursive: true });

  return function webhookAuditLogger(req, res, next) {
    const startedAt = process.hrtime.bigint();
    const receivedAt = new Date();

    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const entry = {
        timestamp: receivedAt.toISOString(),
        method: req.method,
        url: req.originalUrl || req.url,
        headers: sanitizeHeaders(req.headers),
        body: req.body ?? null,
        remoteIp: getClientIp(req),
        processingTimeMs: Math.round(durationMs * 100) / 100,
        statusCode: res.statusCode,
        userAgent: req.headers["user-agent"] || "",
      };

      fs.promises
        .appendFile(logFile, JSON.stringify(entry) + "\n")
        .catch((error) => console.warn("[webhook-audit] file log failed:", error.message));

      const db = getDb();
      if (db) {
        db.collection("webhook_logs")
          .insertOne({
            ...entry,
            receivedAt,
          })
          .catch((error) => console.warn("[webhook-audit] Mongo log failed:", error.message));
      }
    });

    next();
  };
}

module.exports = {
  createWebhookAuditLogger,
  sanitizeHeaders,
};
