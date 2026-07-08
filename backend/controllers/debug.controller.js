"use strict";

const msg91Service = require("../services/msg91.service");

/**
 * Echo endpoint — POST any payload here to see exactly what arrives and how
 * it is normalised. Safe to use for MSG91 test deliveries.
 * Example: curl -X POST https://crm.ipkwealth.com/debug-webhook -H "Content-Type: application/json" -d '{"test":1}'
 */
function debugWebhookController(req, res) {
  const body = req.body || {};
  const items = msg91Service.getPayloadItems(body);
  const normalised = items.map((item) => msg91Service.normalizeWebhookItem(item, { webhookType: "debug" }));

  const summary = normalised.map(({ eventType, normalizedStatus, normalizedMobile, requestId, text }) => ({
    eventType,
    normalizedStatus,
    normalizedMobile,
    requestId,
    text,
  }));

  console.log("[debug-webhook] raw body:", JSON.stringify(body, null, 2));
  console.log("[debug-webhook] normalised items:", JSON.stringify(summary, null, 2));

  res.status(200).json({ received: true, itemCount: items.length, normalised: summary });
}

module.exports = { debugWebhookController };
