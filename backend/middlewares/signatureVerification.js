"use strict";

/**
 * MSG91 webhook signature verification — OPT-IN.
 *
 * MSG91 does not publish a single fixed signing scheme, and this deployment
 * does not currently have a signing secret configured. Enforcing this check
 * unconditionally would risk silently rejecting real MSG91 traffic (which
 * causes MSG91 to auto-pause the webhook), so verification is a no-op until
 * MSG91_WEBHOOK_SECRET is set in the environment.
 *
 * Once configured, verifies an HMAC-SHA256 signature (hex) of the raw request
 * body against MSG91_WEBHOOK_SECRET, read from the header named by
 * MSG91_WEBHOOK_SIGNATURE_HEADER (default: x-msg91-signature).
 *
 * Requires `req.rawBody` — populated by the express.json() verify hook in
 * app.js.
 */

const crypto = require("crypto");
const env = require("../config/env");

let warnedOnce = false;

function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

function signatureVerification(req, res, next) {
  if (!env.MSG91_WEBHOOK_SECRET) {
    if (!warnedOnce) {
      console.warn("[signature] MSG91_WEBHOOK_SECRET not set — signature verification disabled");
      warnedOnce = true;
    }
    return next();
  }

  const header = req.headers[env.MSG91_WEBHOOK_SIGNATURE_HEADER];
  const rawBody = req.rawBody || "";

  if (!header) {
    console.warn(`[signature] missing ${env.MSG91_WEBHOOK_SIGNATURE_HEADER} header — rejecting`, { path: req.path });
    return res.status(401).json({ error: "Missing webhook signature" });
  }

  const expected = crypto.createHmac("sha256", env.MSG91_WEBHOOK_SECRET).update(rawBody).digest("hex");

  if (!timingSafeEqualHex(String(header), expected)) {
    console.warn("[signature] signature mismatch — rejecting", { path: req.path });
    return res.status(401).json({ error: "Invalid webhook signature" });
  }

  next();
}

module.exports = signatureVerification;
