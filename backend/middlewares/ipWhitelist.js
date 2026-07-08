"use strict";

/**
 * MSG91 IP whitelist — OPT-IN.
 *
 * MSG91 does not publish a fixed, stable set of outbound webhook IPs, and
 * none is currently configured here. This check is a no-op until
 * MSG91_IP_WHITELIST (comma-separated) is set, so it cannot silently start
 * rejecting legitimate MSG91 traffic in production.
 */

const env = require("../config/env");

function getClientIp(req) {
  const raw =
    req.headers["x-real-ip"] ||
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.ip ||
    req.socket?.remoteAddress ||
    "unknown";
  return String(raw).replace(/^::ffff:/i, "");
}

let warnedOnce = false;

function ipWhitelist(req, res, next) {
  if (!env.MSG91_IP_WHITELIST.length) {
    if (!warnedOnce) {
      console.warn("[ip-whitelist] MSG91_IP_WHITELIST not set — IP whitelist disabled");
      warnedOnce = true;
    }
    return next();
  }

  const ip = getClientIp(req);
  if (!env.MSG91_IP_WHITELIST.includes(ip)) {
    console.warn(`[ip-whitelist] rejected ip=${ip} path=${req.path}`);
    return res.status(403).json({ error: "IP not allowed" });
  }

  next();
}

module.exports = ipWhitelist;
