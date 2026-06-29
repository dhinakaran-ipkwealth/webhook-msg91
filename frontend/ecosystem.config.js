/**
 * ecosystem.config.js  —  PM2 cluster configuration
 *
 * Run with:
 *   pm2 start ecosystem.config.js
 *   pm2 start ecosystem.config.js --env production
 *   pm2 logs webhook-server
 *   pm2 monit
 *
 * WHY REDIS IS REQUIRED FOR CLUSTER MODE:
 *   PM2 cluster mode forks N worker processes (one per CPU core). Each process
 *   has its own in-memory rate-limit store, so a client could send N*limit
 *   requests before being blocked. Redis provides a single shared counter that
 *   all workers read/write atomically, enforcing the limit correctly.
 *
 * SAFE WITHOUT REDIS:
 *   If Redis is unavailable the middleware falls back to per-process in-memory
 *   stores. Rate limits are still enforced within each worker; they are just
 *   not shared across workers. For a single-worker deployment this is identical
 *   to Redis-backed limiting.
 */

"use strict";

module.exports = {
  apps: [
    {
      // ── EC2 webhook server (primary production entry point) ────────────────
      name: "webhook-server",
      script: "./webhook-server.js",

      // Cluster mode: one worker per CPU core.
      // PM2 load-balances incoming connections across workers via Node.js
      // cluster module (shared port, round-robin dispatch).
      instances: "max",   // use all available CPU cores; set to 1 for single-process
      exec_mode: "cluster",

      // Auto-restart on crash
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,      // ms between restarts
      min_uptime: "5s",         // must stay up 5 s to count as "started successfully"

      // Memory ceiling — restart worker if RSS exceeds this
      max_memory_restart: "512M",

      // Watch (disabled in production — use pm2 reload for zero-downtime deploys)
      watch: false,

      // Graceful shutdown: allow in-flight requests to complete
      kill_timeout: 5000,       // ms to wait before SIGKILL after SIGTERM
      listen_timeout: 8000,     // ms for the app to be "online" after start

      // Environment variables — development
      env: {
        NODE_ENV: "development",
        PORT: 3002,
        RATE_LIMIT_ENABLED: "true",

        // Redis — leave empty to use in-memory store
        REDIS_HOST: "127.0.0.1",
        REDIS_PORT: 6379,

        // Rate limits (requests per minute per IP)
        WEBHOOK_RATE_LIMIT: 5000,
        API_RATE_LIMIT: 100,
        AUTH_RATE_LIMIT: 10,
        GRAPHQL_RATE_LIMIT: 500,

        // Dedup TTL
        DEDUP_TTL_HOURS: 24,
      },

      // Environment variables — production (override with --env production)
      env_production: {
        NODE_ENV: "production",
        PORT: 3002,
        RATE_LIMIT_ENABLED: "true",

        REDIS_HOST: "127.0.0.1",
        REDIS_PORT: 6379,

        WEBHOOK_RATE_LIMIT: 5000,
        API_RATE_LIMIT: 100,
        AUTH_RATE_LIMIT: 10,
        GRAPHQL_RATE_LIMIT: 500,

        DEDUP_TTL_HOURS: 24,
      },

      // PM2 log settings
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file: "./logs/webhook-server-error.log",
      out_file: "./logs/webhook-server-out.log",
      merge_logs: true,   // merge worker logs into a single file

      // Source-map support for readable stack traces
      source_map_support: false,
    },

    // ── EC2 variant (webhoo-server-ec2.js) ───────────────────────────────────
    // Uncomment if you use the ec2 variant instead of webhook-server.js
    // {
    //   name: "webhook-server-ec2",
    //   script: "./webhoo-server-ec2.js",
    //   instances: "max",
    //   exec_mode: "cluster",
    //   autorestart: true,
    //   max_memory_restart: "512M",
    //   watch: false,
    //   env: {
    //     NODE_ENV: "production",
    //     PORT: 3002,
    //     RATE_LIMIT_ENABLED: "true",
    //     REDIS_HOST: "127.0.0.1",
    //     REDIS_PORT: 6379,
    //     WEBHOOK_RATE_LIMIT: 5000,
    //     API_RATE_LIMIT: 100,
    //   },
    //   log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    //   error_file: "./logs/ec2-error.log",
    //   out_file: "./logs/ec2-out.log",
    //   merge_logs: true,
    // },
  ],
};
