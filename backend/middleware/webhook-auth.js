"use strict";

const crypto = require("crypto");

function getClientIp(req) {
  return String(
    req.headers["x-real-ip"] ||
      (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
      req.ip ||
      req.socket?.remoteAddress ||
      "",
  ).replace(/^::ffff:/i, "");
}

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function getHeader(req, name) {
  return req.headers[String(name || "").toLowerCase()];
}

function normalizeSignature(value) {
  return String(value || "")
    .trim()
    .replace(/^sha256=/i, "");
}

function computeHmac(secret, rawBody) {
  return crypto
    .createHmac("sha256", secret)
    .update(rawBody || "")
    .digest("hex");
}

function isWebhookPayloadValid(body) {
  if (!body) return false;
  if (Array.isArray(body)) return body.length > 0;
  if (typeof body !== "object") return false;
  return Object.keys(body).length > 0;
}

function rejectUnauthorized(res, reason) {
  return res.status(401).json({
    success: false,
    error: "Webhook authentication failed",
    reason,
  });
}

function acknowledgeInvalidPayload(res, reason) {
  return res.status(200).json({
    success: false,
    accepted: false,
    reason,
  });
}

function webhookAuthMiddleware(req, res, next) {
  if (req.method !== "POST") return next();

  const trustedIps = parseCsv(process.env.MSG91_IP_WHITELIST || process.env.WEBHOOK_TRUSTED_IPS);
  if (trustedIps.length) {
    const ip = getClientIp(req);
    if (!trustedIps.includes(ip)) {
      return rejectUnauthorized(res, "ip_not_allowed");
    }
  }

  const webhookSecret = process.env.WEBHOOK_SECRET || process.env.MSG91_WEBHOOK_SECRET || "";
  if (webhookSecret) {
    const suppliedSecret = getHeader(req, "x-webhook-secret") || getHeader(req, "x-msg91-webhook-secret");
    if (!timingSafeEqualString(suppliedSecret, webhookSecret)) {
      return rejectUnauthorized(res, "secret_mismatch");
    }
  }

  const signatureSecret =
    process.env.MSG91_SIGNATURE_SECRET || process.env.MSG91_WEBHOOK_SIGNATURE_SECRET || "";
  if (signatureSecret) {
    const signatureHeaderName = process.env.MSG91_WEBHOOK_SIGNATURE_HEADER || "x-msg91-signature";
    const suppliedSignature = normalizeSignature(getHeader(req, signatureHeaderName));
    const expectedSignature = computeHmac(signatureSecret, req.rawBody || "");
    if (!timingSafeEqualString(suppliedSignature, expectedSignature)) {
      return rejectUnauthorized(res, "signature_mismatch");
    }
  }

  if (!isWebhookPayloadValid(req.body)) {
    return acknowledgeInvalidPayload(res, "invalid_or_empty_payload");
  }

  return next();
}

module.exports = {
  webhookAuthMiddleware,
  getClientIp,
  isWebhookPayloadValid,
};
