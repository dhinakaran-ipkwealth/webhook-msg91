"use strict";

const os = require("os");
const env = require("../config/env");
const mongoService = require("../services/mongo.service");
const redisService = require("../services/redis.service");
const { rateLimitStatus } = require("../middlewares/rate-limit");
const { getMetricsSnapshot } = require("../middlewares/request-logger");

function cpuLoad() {
  const cpus = os.cpus() || [];
  const [load1, load5, load15] = os.loadavg();
  return {
    cores: cpus.length,
    model: cpus[0]?.model || null,
    loadavg: { "1m": load1, "5m": load5, "15m": load15 },
  };
}

function pm2Info() {
  // PM2 injects these env vars into every managed process.
  const managed = process.env.pm_id !== undefined;
  return {
    managed,
    pm_id: process.env.pm_id ?? null,
    instance: process.env.NODE_APP_INSTANCE ?? null,
    exec_mode: process.env.exec_mode || null,
  };
}

function healthController(req, res) {
  const mem = process.memoryUsage();

  res.status(200).json({
    ok: true,
    service: env.SERVICE_NAME,
    uptimeSeconds: Math.floor(process.uptime()),
    node: {
      version: process.version,
      pid: process.pid,
    },
    memory: {
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
      systemFreeMb: Math.round(os.freemem() / 1024 / 1024),
      systemTotalMb: Math.round(os.totalmem() / 1024 / 1024),
    },
    cpu: cpuLoad(),
    mongoConnected: mongoService.isConnected(),
    redisConnected: redisService.isReady(),
    pm2: pm2Info(),
    rateLimit: rateLimitStatus(),
  });
}

function metricsController(req, res) {
  res.status(200).json(getMetricsSnapshot());
}

module.exports = { healthController, metricsController };
