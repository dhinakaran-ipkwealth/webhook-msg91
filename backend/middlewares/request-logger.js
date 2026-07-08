/**
 * request-logger.js
 *
 * Structured request logging and in-process monitoring metrics.
 *
 * Logged fields (JSON per line to stdout):
 *   ts           ISO-8601 timestamp
 *   method       HTTP method
 *   url          full URL with query string
 *   status       HTTP status code
 *   duration_ms  response time in milliseconds
 *   ip           client IP (real IP from Nginx X-Real-IP header)
 *   rl_remaining RateLimit-Remaining header value (if present)
 *   rl_limit     RateLimit-Limit header value (if present)
 *   content_len  request Content-Length header
 *   ua           User-Agent (truncated to 80 chars)
 *
 * Metrics (in-process, shared across module):
 *   totalRequests      all requests received
 *   blockedRequests    requests that received 429 (rate-limited)
 *   duplicateWebhooks  webhook POSTs that were duplicates
 *   requestsPerMinute  rolling count for the last complete minute
 *
 * Metrics are exported as `metrics` and exposed via the /metrics endpoint
 * wired in app.js.
 */

"use strict";

// ── metrics object ─────────────────────────────────────────────────────────────
// Exported as a singleton; other middleware modules import it directly so they
// can increment counters (e.g. blockedRequests, duplicateWebhooks).

const metrics = {
  totalRequests: 0,
  blockedRequests: 0,
  duplicateWebhooks: 0,

  // Rolling-minute tracking
  _requestsThisMinute: 0,
  _minuteStart: Date.now(),
  requestsPerMinute: 0,         // snapshotted at end of each completed minute

  // Endpoint hit counts (object keyed by "METHOD /path")
  endpointCounts: Object.create(null),

  // Status code distribution
  statusCounts: Object.create(null),

  startedAt: new Date().toISOString(),
};

function tickMinute() {
  const now = Date.now();
  if (now - metrics._minuteStart >= 60_000) {
    metrics.requestsPerMinute = metrics._requestsThisMinute;
    metrics._requestsThisMinute = 0;
    metrics._minuteStart = now;
  }
  metrics._requestsThisMinute++;
  metrics.totalRequests++;
}

function recordEndpoint(method, path, status) {
  const key = `${method} ${path}`;
  metrics.endpointCounts[key] = (metrics.endpointCounts[key] || 0) + 1;
  const sc = String(status);
  metrics.statusCounts[sc] = (metrics.statusCounts[sc] || 0) + 1;
}

// ── skip rules ─────────────────────────────────────────────────────────────────
// Avoid logging extremely noisy health-check probes in production.
const SKIP_LOG_PATHS = new Set(["/health", "/healthz"]);
const SKIP_LOG_METHODS = new Set(["OPTIONS"]);

// ── middleware ─────────────────────────────────────────────────────────────────

function requestLoggerMiddleware(req, res, next) {
  const start = process.hrtime.bigint();
  tickMinute();

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    const status = res.statusCode;

    recordEndpoint(req.method, req.path, status);

    // Skip verbose logging for noisy, low-value paths
    if (
      SKIP_LOG_PATHS.has(req.path) ||
      SKIP_LOG_METHODS.has(req.method)
    ) {
      return;
    }

    const ip =
      req.headers["x-real-ip"] ||
      (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
      req.ip ||
      "unknown";

    const rlRemaining = res.getHeader("RateLimit-Remaining");
    const rlLimit = res.getHeader("RateLimit-Limit");

    const logEntry = {
      ts: new Date().toISOString(),
      method: req.method,
      url: req.originalUrl || req.url,
      status,
      duration_ms: Math.round(durationMs * 100) / 100,
      ip,
    };

    if (rlRemaining !== undefined) logEntry.rl_remaining = Number(rlRemaining);
    if (rlLimit !== undefined) logEntry.rl_limit = Number(rlLimit);
    if (status === 429) logEntry.rate_limit_hit = true;

    const contentLen = req.headers["content-length"];
    if (contentLen) logEntry.content_len = Number(contentLen);

    const ua = req.headers["user-agent"];
    if (ua) logEntry.ua = ua.slice(0, 80);

    // Write single JSON line to stdout — works with PM2 log aggregation,
    // CloudWatch Logs, and any structured logging pipeline.
    process.stdout.write(JSON.stringify(logEntry) + "\n");
  });

  next();
}

// ── public metrics snapshot ───────────────────────────────────────────────────

function getMetricsSnapshot() {
  return {
    uptime_seconds: Math.floor(process.uptime()),
    started_at: metrics.startedAt,
    total_requests: metrics.totalRequests,
    blocked_requests: metrics.blockedRequests,
    duplicate_webhooks: metrics.duplicateWebhooks,
    requests_per_minute: metrics.requestsPerMinute,
    requests_this_minute: metrics._requestsThisMinute,
    memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    pid: process.pid,
    node_version: process.version,
    endpoint_counts: metrics.endpointCounts,
    status_counts: metrics.statusCounts,
  };
}

module.exports = requestLoggerMiddleware;
module.exports.metrics = metrics;
module.exports.getMetricsSnapshot = getMetricsSnapshot;
