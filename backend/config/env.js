"use strict";

const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });
dotenv.config({ path: path.resolve(__dirname, "..", "..", ".env") });

function bool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value).toLowerCase() !== "false";
}

const nodeEnv = process.env.NODE_ENV || "development";
const isProduction = nodeEnv === "production";
const defaultWebhookPort = isProduction ? 3002 : 3099;
const resolvedWebhookPort = isProduction
  ? Number(process.env.PORT || defaultWebhookPort)
  : Number(process.env.PORT || process.env.WEBHOOK_PORT || defaultWebhookPort);
const configuredPublicBaseUrl = process.env.WEBHOOK_PUBLIC_BASE_URL || "";
const isLocalPublicBaseUrl = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(
  configuredPublicBaseUrl,
);
const configuredHost = process.env.WEBHOOK_HOST || "";

const env = {
  NODE_ENV: nodeEnv,
  SERVICE_NAME: "crm-msg91-webhook",

  PORT: resolvedWebhookPort,
  HOST:
    isProduction && (!configuredHost || configuredHost === "127.0.0.1")
      ? "0.0.0.0"
      : configuredHost || "127.0.0.1",
  PUBLIC_BASE_URL:
    isProduction && (!configuredPublicBaseUrl || isLocalPublicBaseUrl)
      ? "https://crm.ipkwealth.com"
      : configuredPublicBaseUrl || `http://localhost:${defaultWebhookPort}`,

  // MongoDB
  MONGODB_URI: process.env.MONGODB_URI || process.env.DATABASE_URL,
  MONGODB_DB_NAME: process.env.MONGODB_DB_NAME || "",
  MONGODB_WEBHOOK_DB_NAME: process.env.MONGODB_WEBHOOK_DB_NAME || "msg91_webhooks",

  // Redis
  REDIS_HOST: process.env.REDIS_HOST || "127.0.0.1",
  REDIS_PORT: Number(process.env.REDIS_PORT || 6379),
  REDIS_PASSWORD: process.env.REDIS_PASSWORD || undefined,
  REDIS_DB: Number(process.env.REDIS_DB || 0),

  // Rate limiting
  RATE_LIMIT_ENABLED: bool(process.env.RATE_LIMIT_ENABLED, true),
  WEBHOOK_RATE_LIMIT: Number(process.env.WEBHOOK_RATE_LIMIT || 5000),
  API_RATE_LIMIT: Number(process.env.API_RATE_LIMIT || 100),
  AUTH_RATE_LIMIT: Number(process.env.AUTH_RATE_LIMIT || 10),
  GRAPHQL_RATE_LIMIT: Number(process.env.GRAPHQL_RATE_LIMIT || 500),

  // Dedup
  DEDUP_TTL_HOURS: Number(process.env.DEDUP_TTL_HOURS || 24),

  // Internal cron bypass
  INTERNAL_CRON_SECRET: process.env.INTERNAL_CRON_SECRET || "",

  // ── Security (opt-in — only enforced when configured) ──────────────────────
  // MSG91 does not publish a fixed signing scheme or static IP range for
  // webhook delivery. Both checks below are OFF by default and only start
  // enforcing once you provide the corresponding value, so nothing breaks in
  // production until you deliberately turn it on.
  MSG91_WEBHOOK_SECRET: process.env.MSG91_WEBHOOK_SECRET || "",
  MSG91_WEBHOOK_SIGNATURE_HEADER:
    process.env.MSG91_WEBHOOK_SIGNATURE_HEADER || "x-msg91-signature",
  MSG91_IP_WHITELIST: (process.env.MSG91_IP_WHITELIST || "")
    .split(",")
    .map((ip) => ip.trim())
    .filter(Boolean),

  IGNORE_TEST_WEBHOOKS: bool(process.env.IGNORE_TEST_WEBHOOKS, true),

  // MSG91 API (outbound)
  MSG91_BASE_URL: process.env.MSG91_BASE_URL || "",
  MSG91_AUTH_KEY: process.env.MSG91_AUTH_KEY || process.env.MSG91_AUTHKEY || "",
  MSG91_NAMESPACE_SIGNED: process.env.MSG91_NAMESPACE_SIGNED || "",
  MSG91_NAMESPACE_AGREEMENT: process.env.MSG91_NAMESPACE_AGREEMENT || "",

  ELECTRON_NOTIFY_URL: process.env.ELECTRON_NOTIFY_URL || "http://127.0.0.1:3001/notify",

  LOG_LEVEL: process.env.LOG_LEVEL || "info",
  LOG_DIR: process.env.LOG_DIR || "logs",
};

if (!env.MONGODB_URI) {
  console.error("MONGODB_URI or DATABASE_URL is required.");
  process.exit(1);
}

module.exports = env;
