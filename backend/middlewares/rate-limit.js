/**
 * rate-limit.js
 *
 * Production-grade rate limiting with Redis-backed distributed store.
 * Falls back to in-memory store when Redis is unavailable so the server
 * never fails to start just because Redis is down.
 *
 * Policies:
 *   Authentication endpoints  →  AUTH_RATE_LIMIT  (default 10)   req/min per IP
 *   Public API endpoints      →  API_RATE_LIMIT   (default 100)  req/min per IP
 *   GraphQL endpoint          →  GRAPHQL_RATE_LIMIT (default 500) req/min per IP
 *   MSG91 Webhook endpoints   →  WEBHOOK_RATE_LIMIT (default 5000) req/min per IP
 *
 * Skipped entirely:
 *   /health            (health-check probes must never be blocked)
 *   127.0.0.1 / ::1   (admin localhost requests)
 *   X-Internal-Cron header  (internal cron jobs)
 *
 * WEBHOOK POLICY — CRITICAL:
 *   When a webhook request exceeds the rate limit we still return HTTP 200.
 *   Returning 429 causes MSG91 to retry, which makes the storm worse.
 *   The response body includes { received: true, throttled: true } so you
 *   can distinguish throttled acks from real ones in logs.
 */

"use strict";

// Graceful load — server still starts even if express-rate-limit isn't installed yet.
let rateLimit;
try {
  rateLimit = require("express-rate-limit");
} catch {
  console.warn("[rate-limit] express-rate-limit not installed — all limiters are no-ops. Run: npm install express-rate-limit rate-limit-redis ioredis");
  rateLimit = null;
}

const { metrics } = require("./request-logger");
const env = require("../config/env");
const redisService = require("../services/redis.service");

const RATE_LIMIT_ENABLED = env.RATE_LIMIT_ENABLED;
const AUTH_RATE_LIMIT = env.AUTH_RATE_LIMIT;
const API_RATE_LIMIT = env.API_RATE_LIMIT;
const GRAPHQL_RATE_LIMIT = env.GRAPHQL_RATE_LIMIT;
const WEBHOOK_RATE_LIMIT = env.WEBHOOK_RATE_LIMIT;

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract real client IP from an Nginx-proxied request and normalise it.
 *
 * Nginx sets X-Real-IP to the original client IP before proxying.
 * We strip the IPv4-mapped IPv6 prefix (::ffff:) so that
 *   ::ffff:1.2.3.4  →  1.2.3.4
 * This prevents the same IPv4 address from being treated as two different
 * keys and satisfies express-rate-limit v7's ERR_ERL_KEY_GEN_IPV6 check.
 */
function getClientIp(req) {
  const raw =
    req.headers["x-real-ip"] ||
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.ip ||
    req.socket?.remoteAddress ||
    "unknown";
  return String(raw).replace(/^::ffff:/i, "");
}

/**
 * Routes / IPs that should never be rate-limited.
 */
function shouldSkip(req) {
  // Health-check probes
  if (req.path === "/health" || req.path === "/healthz") return true;

  // Internal cron jobs identified by a shared secret header
  if (env.INTERNAL_CRON_SECRET && req.headers["x-internal-cron"] === env.INTERNAL_CRON_SECRET) return true;

  // Admin requests from localhost.
  // getClientIp already strips ::ffff: so ::ffff:127.0.0.1 → 127.0.0.1.
  const ip = getClientIp(req);
  if (ip === "127.0.0.1" || ip === "::1" || ip === "localhost") return true;

  return false;
}

// ── store factory ─────────────────────────────────────────────────────────────

/**
 * Build a rate-limit store.
 * Uses Redis when the client is ready; otherwise uses the default in-memory
 * MemoryStore (safe for single-process, NOT safe across PM2 workers).
 */
function buildStore(prefix) {
  const redisClient = redisService.getClient();
  if (!redisClient) {
    // MemoryStore is the express-rate-limit default — no import needed.
    return undefined; // undefined → express-rate-limit uses MemoryStore
  }
  const { RedisStore } = require("rate-limit-redis");
  return new RedisStore({
    prefix: `rl:${prefix}:`,
    // ioredis v5 compatible sendCommand
    sendCommand: (...args) => redisClient.call(...args),
  });
}

// ── limiter factory ───────────────────────────────────────────────────────────

const noop = (_req, _res, next) => next();

function buildLimiter(opts) {
  if (!rateLimit) return noop; // package not installed — degrade gracefully

  const {
    name,
    windowMs = 60_000,
    limit,
    storePrefix,
    handler,
    skipSuccessfulRequests = false,
  } = opts;

  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7", // Sends RateLimit-* headers (RFC 6585 draft 7)
    legacyHeaders: false,
    keyGenerator: getClientIp,
    skip: shouldSkip,
    skipSuccessfulRequests,
    // Disable express-rate-limit's built-in validations.
    // We normalise IPv6 ourselves (::ffff: strip in getClientIp) so
    // ERR_ERL_KEY_GEN_IPV6 does not apply.  Using validate:false rather than
    // a named key (validate:{ip:false} / validate:{keyGeneratorIpFallback:false})
    // because the key name changed between minor versions and using false is the
    // only form that is stable across all v7.x releases.
    validate: false,
    store: buildStore(storePrefix || name),
    handler:
      handler ||
      function defaultHandler(req, res) {
        metrics.blockedRequests++;
        const ip = getClientIp(req);
        console.warn(
          `[rate-limit] 429 ${req.method} ${req.path} ip=${ip} limiter=${name}`
        );
        res.status(429).json({
          error: "Too many requests",
          retryAfter: Math.ceil(windowMs / 1000),
        });
      },
  });
}

// ── exported limiters ─────────────────────────────────────────────────────────

/**
 * Webhook limiter — used on all /webhook* routes.
 *
 * CRITICAL: handler returns HTTP 200 (not 429).
 * MSG91 pauses webhook delivery to any endpoint that returns non-2xx and will
 * retry later, which would amplify load rather than reduce it.
 */
const webhookLimiter = RATE_LIMIT_ENABLED
  ? buildLimiter({
      name: "webhook",
      limit: WEBHOOK_RATE_LIMIT,
      handler(req, res) {
        metrics.blockedRequests++;
        const ip = getClientIp(req);
        console.warn(
          `[rate-limit] WEBHOOK-THROTTLED ${req.method} ${req.path} ip=${ip}`
        );
        if (res.headersSent) return;
        res.status(200).json({ received: true, throttled: true });
        console.log(
          JSON.stringify({
            tag: "msg91-ack",
            ts: new Date().toISOString(),
            status: 200,
            outcome: "throttled",
            route: req.originalUrl || req.path,
            ip,
          })
        );
      },
    })
  : (_req, _res, next) => next();

/**
 * Public API limiter — /api/*, /debug-webhook, etc.
 */
const apiLimiter = RATE_LIMIT_ENABLED
  ? buildLimiter({ name: "api", limit: API_RATE_LIMIT })
  : (_req, _res, next) => next();

/**
 * Auth limiter — login, token refresh, etc. (none exist yet, wired for future).
 */
const authLimiter = RATE_LIMIT_ENABLED
  ? buildLimiter({ name: "auth", limit: AUTH_RATE_LIMIT })
  : (_req, _res, next) => next();

/**
 * GraphQL limiter — /graphql (none exists yet, wired for future).
 */
const graphqlLimiter = RATE_LIMIT_ENABLED
  ? buildLimiter({ name: "graphql", limit: GRAPHQL_RATE_LIMIT })
  : (_req, _res, next) => next();

// ── status endpoint helper ────────────────────────────────────────────────────

function rateLimitStatus() {
  return {
    enabled: RATE_LIMIT_ENABLED,
    redisConnected: redisService.isReady(),
    store: redisService.isReady() ? "redis" : "memory",
    limits: {
      webhook: WEBHOOK_RATE_LIMIT,
      api: API_RATE_LIMIT,
      auth: AUTH_RATE_LIMIT,
      graphql: GRAPHQL_RATE_LIMIT,
    },
    windowMs: 60_000,
  };
}

module.exports = {
  webhookLimiter,
  apiLimiter,
  authLimiter,
  graphqlLimiter,
  getClientIp,
  rateLimitStatus,
};
