"use strict";

const express = require("express");
const asyncWrapper = require("../middlewares/asyncWrapper");
const { webhookLimiter, apiLimiter } = require("../middlewares/rate-limit");
const { webhookDedupMiddleware } = require("../middlewares/webhook-dedup");
const signatureVerification = require("../middlewares/signatureVerification");
const ipWhitelist = require("../middlewares/ipWhitelist");
const mongoService = require("../services/mongo.service");

const marketingController = require("../controllers/marketing.controller");
const crmController = require("../controllers/crm.controller");
const supportController = require("../controllers/support.controller");
const eventsController = require("../controllers/events.controller");
const rmController = require("../controllers/rm.controller");
const { handleLegacyContextWebhook } = require("../controllers/webhookBase.controller");
const { debugWebhookController } = require("../controllers/debug.controller");
const msg91Service = require("../services/msg91.service");

const router = express.Router();

// MSG91 dashboard uses this to verify the endpoint before enabling delivery.
router.get("/webhook", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "crm-msg91-webhook",
    message: "MSG91 must call this endpoint using POST.",
  });
});

// Dedup middleware is built once here, closed over the live webhookEventsDb
// getter (mongoService connects before the server starts listening).
const dedupWebhook = webhookDedupMiddleware(() => mongoService.getWebhookEventsDb(), {
  returnDuplicatesAs200: true, // MSG91 must never see a non-2xx response
});

// Composed middleware for every MSG91 webhook POST:
//   1. ipWhitelist          — opt-in IP allowlist (no-op unless configured)
//   2. signatureVerification — opt-in HMAC signature check (no-op unless configured)
//   3. webhookLimiter        — rate-limit (returns 200 + throttled:true if exceeded)
//   4. dedupWebhook          — duplicate check (returns 200 + duplicate:true if seen)
const webhookMiddleware = [ipWhitelist, signatureVerification, webhookLimiter, dedupWebhook];

// ── debug endpoint (public API rate limit, no dedup) ───────────────────────
router.post("/debug-webhook", apiLimiter, debugWebhookController);

// ── ROUTING MECHANISM 1 — POST /webhook/msg91, sender read from req.body ──
router.post("/webhook/msg91", webhookMiddleware, asyncWrapper(rmController.generic));

// ── ROUTING MECHANISM 3 — fixed department routes ──────────────────────────
// Registered BEFORE the generic "/webhook/msg91/:param" route below so these
// literal segments always win over the param route.
router.post("/webhook/msg91/marketing", webhookMiddleware, asyncWrapper(marketingController));
router.post("/webhook/msg91/crm", webhookMiddleware, asyncWrapper(crmController));
router.post("/webhook/msg91/support", webhookMiddleware, asyncWrapper(supportController));
router.post("/webhook/msg91/events", webhookMiddleware, asyncWrapper(eventsController));

// ── legacy explicit routes (kept for backward compatibility) ───────────────
router.post(
  "/webhook/msg91/inbound",
  webhookMiddleware,
  asyncWrapper((req, res) =>
    handleLegacyContextWebhook(req, res, { webhookType: "inbound", route: "/webhook/msg91/inbound" }),
  ),
);
router.post(
  "/webhook/msg91/outbound",
  webhookMiddleware,
  asyncWrapper((req, res) =>
    handleLegacyContextWebhook(req, res, { webhookType: "outbound_report", route: "/webhook/msg91/outbound" }),
  ),
);

// Legacy 2-segment template + uploadId callback URL (campaign sends).
router.post(
  "/webhook/msg91/:templateName/:uploadId",
  webhookMiddleware,
  asyncWrapper((req, res) =>
    handleLegacyContextWebhook(req, res, {
      webhookType: "outbound_report",
      templateName: req.params.templateName,
      uploadId: Number(req.params.uploadId) || null,
      route: `/webhook/msg91/${req.params.templateName}/${req.params.uploadId}`,
    }),
  ),
);

// ── ROUTING MECHANISM 2 — POST /webhook/msg91/:sender ──────────────────────
// Also the fallback for legacy /webhook/msg91/<templateName> URLs already
// configured in MSG91 (see rm.controller.js / handleSenderOrTemplateWebhook).
router.post("/webhook/msg91/:param", webhookMiddleware, asyncWrapper(rmController.bySenderOrTemplate));

// ── pre-existing root routes (kept — MSG91 dashboard may already point here) ──
router.post(
  "/webhook",
  webhookMiddleware,
  asyncWrapper((req, res) => handleLegacyContextWebhook(req, res, { webhookType: "msg91", route: "/webhook" })),
);

// Fallback — catches any other /webhook/* pattern not matched above.
router.all(/^\/webhook(?:\/.*)?$/, webhookLimiter, dedupWebhook, (req, res) => {
  console.log(`[webhook] ${req.method} ${req.originalUrl} from ${req.ip} matched fallback`);
  if (res.headersSent) return;
  res.status(200).json({ received: true, fallback: true });
  if (req.method === "POST") {
    msg91Service.processWebhookAfterAck(req.body, { webhookType: "msg91" }, { uploadId: null }, "[fallback]");
  }
});

module.exports = router;
