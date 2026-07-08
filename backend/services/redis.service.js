"use strict";

/**
 * Centralised Redis client shared by rate limiting, webhook dedup, and the
 * sender-config cache. Connection is optional-load-safe: if `ioredis` isn't
 * installed or Redis is unreachable, `getClient()` returns null and callers
 * fall back to their own safe defaults (in-memory store, always-miss cache).
 */

const env = require("../config/env");

let client = null;
let ready = false;

function connect() {
  if (client) return client;
  if (!env.REDIS_HOST) return null;

  let Redis;
  try {
    Redis = require("ioredis");
  } catch {
    console.warn("[redis] ioredis not installed — Redis features disabled. Run: npm install ioredis");
    return null;
  }

  client = new Redis({
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    password: env.REDIS_PASSWORD,
    db: env.REDIS_DB,
    lazyConnect: true,
    enableOfflineQueue: false,
    connectTimeout: 3000,
    maxRetriesPerRequest: 1,
  });

  client.on("ready", () => {
    ready = true;
    console.log(`[redis] connected at ${env.REDIS_HOST}:${env.REDIS_PORT}`);
  });
  client.on("error", (err) => {
    if (ready) console.warn("[redis] error, falling back to memory:", err.message);
    ready = false;
  });
  client.on("close", () => {
    ready = false;
  });

  client.connect().catch(() => {
    console.warn("[redis] not reachable — dependent features degrade gracefully");
  });

  return client;
}

// Connect at module load; non-fatal if it fails.
connect();

function getClient() {
  return ready ? client : null;
}

function isReady() {
  return ready;
}

module.exports = { getClient, isReady };
