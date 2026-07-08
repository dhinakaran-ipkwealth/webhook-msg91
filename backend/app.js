"use strict";

const express = require("express");
const requestLogger = require("./middlewares/request-logger");
const errorHandler = require("./middlewares/errorHandler");
const healthRoutes = require("./routes/health.routes");
const webhookRoutes = require("./routes/webhook.routes");

function createApp() {
  const app = express();

  // 1. Structured JSON request logger — first, so it captures every request.
  app.use(requestLogger);

  // 2. Body parsers. `verify` stashes the raw body on req.rawBody so
  // middlewares/signatureVerification.js can HMAC it (JSON.stringify(req.body)
  // is not guaranteed to reproduce the exact bytes MSG91 signed).
  const captureRawBody = (req, _res, buf) => {
    req.rawBody = buf.toString("utf8");
  };
  app.use(express.json({ limit: "10mb", verify: captureRawBody }));
  app.use(express.urlencoded({ extended: true, limit: "10mb", verify: captureRawBody }));

  // 3. Health & metrics (no rate limiting, no auth).
  app.use(healthRoutes);

  // 4. Webhook routes (all three routing mechanisms + legacy compatibility).
  app.use(webhookRoutes);

  // 5. Global error handler — always last. MSG91 routes always get a 200
  // even on failure; every other route gets a normal error status.
  app.use(errorHandler);

  return app;
}

module.exports = createApp;
