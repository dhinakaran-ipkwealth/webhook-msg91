"use strict";

/**
 * Global Express error handler.
 *
 * CRITICAL: MSG91 auto-pauses webhook delivery on any non-2xx response and
 * retries later, which amplifies load instead of reducing it. So for any
 * /webhook* or /debug-webhook route we ALWAYS return HTTP 200 — even when an
 * unhandled exception occurred — and log the failure instead. Every other
 * route gets a normal error status.
 *
 * No webhook request should ever be able to crash the process: this handler
 * is the last line of defense, placed after all routes in app.js.
 */

function getRequestIp(req) {
  return (
    req.headers["x-real-ip"] ||
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.ip ||
    "unknown"
  );
}

function isWebhookPath(path) {
  return path.startsWith("/webhook") || path.startsWith("/debug-webhook");
}

function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  console.error("Request error:", err && err.stack ? err.stack : err && err.message);

  const message = (err && err.message) || String(err);

  if (isWebhookPath(req.path)) {
    res.status(200).json({ received: true, error: message });
    console.log(
      JSON.stringify({
        tag: "msg91-ack",
        ts: new Date().toISOString(),
        status: 200,
        outcome: "error-forced-200",
        route: req.originalUrl || req.path,
        ip: getRequestIp(req),
      }),
    );
    return;
  }

  res.status(err.status || 500).json({ error: message });
}

module.exports = errorHandler;
