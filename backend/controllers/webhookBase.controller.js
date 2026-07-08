"use strict";

/**
 * Shared logic behind every department controller (marketing/crm/support/
 * events/rm) and the generic /webhook/msg91 and /webhook/msg91/:sender
 * routes. Keeping this in one place means each department controller file is
 * a one-line binding — all the actual behavior (ack-then-process, sender
 * resolution, audit logging) lives here exactly once.
 */

const msg91Service = require("../services/msg91.service");
const senderResolver = require("../services/senderResolver.service");
const loggerService = require("../services/logger.service");

function getRequestIp(req) {
  return (
    req.headers["x-real-ip"] ||
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.ip ||
    "unknown"
  );
}

function extractSenderNumberFromBody(body) {
  const item = Array.isArray(body) ? body[0] : body;
  if (!item || typeof item !== "object") return null;
  return (
    item.sender ||
    item.senderNumber ||
    item.sender_number ||
    item.integratedNumber ||
    item.integrated_number ||
    item["Integrated Number"] ||
    item["Whatsapp Number"] ||
    null
  );
}

function extractReceiverFromBody(body) {
  const item = Array.isArray(body) ? body[0] : body;
  if (!item || typeof item !== "object") return null;
  return item.customerNumber || item.customer_number || item.from || item.mobile || null;
}

function ackMsg91Webhook(req, res, extra = {}) {
  if (res.headersSent) {
    console.warn("[webhook] ack called but headers already sent");
    return;
  }
  res.status(200).json({ received: true, ...extra });
}

/**
 * Core handler: resolve the sender config (DB-driven, never hardcoded),
 * ACK MSG91 immediately with HTTP 200, then process the payload
 * asynchronously. Every code path writes a `webhook_logs` audit entry.
 */
async function handleWebhook(req, res, { department, senderNumber, route }) {
  const start = process.hrtime.bigint();

  let senderConfig = null;
  if (senderNumber) {
    senderConfig = await senderResolver.resolveBySenderNumber(senderNumber);
  }
  if (!senderConfig && department) {
    senderConfig = senderResolver.resolveByDepartmentSegment(department);
  }

  if (senderConfig && senderConfig.enabled === false) {
    // Known sender, explicitly disabled — ack normally (never break MSG91's
    // retry logic) but skip all processing.
    ackMsg91Webhook(req, res, { skipped: true, reason: "sender_disabled" });
    await loggerService.logWebhookRequest({
      sender: senderConfig.senderNumber || senderNumber || null,
      receiver: null,
      event: route,
      department: senderConfig.department || null,
      payload: req.body,
      headers: req.headers,
      response: { received: true, skipped: true },
      status: res.statusCode,
      processingTimeMs: Number(process.hrtime.bigint() - start) / 1_000_000,
    });
    return;
  }

  const context = {
    webhookType: department ? `${department}_report` : "msg91",
    department: senderConfig?.department || department || null,
    departmentCollectionName: senderConfig?.collectionName || null,
  };

  ackMsg91Webhook(req, res);
  console.log(
    JSON.stringify({
      tag: "msg91-ack",
      ts: new Date().toISOString(),
      status: 200,
      route,
      ip: getRequestIp(req),
      department: context.department,
    }),
  );

  const processingTimeMs = Number(process.hrtime.bigint() - start) / 1_000_000;
  loggerService
    .logWebhookRequest({
      sender: senderConfig?.senderNumber || senderNumber || null,
      receiver: extractReceiverFromBody(req.body),
      event: route,
      department: context.department,
      payload: req.body,
      headers: req.headers,
      response: { received: true },
      status: 200,
      processingTimeMs,
    })
    .catch(() => {});

  msg91Service.processWebhookAfterAck(req.body, context, { uploadId: context.uploadId || null }, `[${route}]`);
}

/**
 * Handler factory for a fixed department route
 * (/webhook/msg91/marketing|crm|support|events).
 */
function handleDepartmentWebhook(department) {
  return async function departmentHandler(req, res) {
    const senderNumber = extractSenderNumberFromBody(req.body);
    await handleWebhook(req, res, { department, senderNumber, route: `/webhook/msg91/${department}` });
  };
}

/**
 * Handler for /webhook/msg91/:sender — sender resolved purely from the
 * MongoDB-backed sender_numbers collection, never hardcoded.
 */
async function handleSenderWebhook(req, res) {
  const senderNumber = req.params.sender;
  await handleWebhook(req, res, { department: null, senderNumber, route: `/webhook/msg91/${req.params.sender}` });
}

/**
 * Handler for POST /webhook/msg91 — sender read from req.body.sender (or the
 * common MSG91 field aliases).
 */
async function handleGenericWebhook(req, res) {
  const senderNumber = extractSenderNumberFromBody(req.body);
  await handleWebhook(req, res, { department: null, senderNumber, route: "/webhook/msg91" });
}

/**
 * Legacy, pre-existing routing context (no sender_numbers lookup): ack then
 * process with a fixed webhookType/templateName/uploadId. This is exactly
 * what ran in production before this refactor, preserved verbatim so MSG91
 * dashboard configs already pointed at these URLs keep working unchanged.
 */
async function handleLegacyContextWebhook(req, res, { webhookType, templateName = null, uploadId = null, route }) {
  const start = process.hrtime.bigint();
  const context = { webhookType, templateName, uploadId };

  ackMsg91Webhook(req, res);
  console.log(
    JSON.stringify({
      tag: "msg91-ack",
      ts: new Date().toISOString(),
      status: 200,
      route,
      ip: getRequestIp(req),
      templateName,
      uploadId,
    }),
  );

  loggerService
    .logWebhookRequest({
      sender: extractSenderNumberFromBody(req.body),
      receiver: extractReceiverFromBody(req.body),
      event: route,
      department: null,
      payload: req.body,
      headers: req.headers,
      response: { received: true },
      status: 200,
      processingTimeMs: Number(process.hrtime.bigint() - start) / 1_000_000,
    })
    .catch(() => {});

  msg91Service.processWebhookAfterAck(req.body, context, { uploadId }, `[${route}]`);
}

/**
 * Handler for POST /webhook/msg91/:param — the single-segment slot is shared
 * between the NEW sender-number routing mechanism and the OLD
 * templateName-based routing mechanism it replaces. To stay backward
 * compatible with MSG91 dashboard configs already pointed at
 * /webhook/msg91/<templateName>, we check `sender_numbers` first:
 *   - a match  → route by sender/department (new behavior)
 *   - no match → fall back to the legacy templateName-based context (old behavior)
 */
async function handleSenderOrTemplateWebhook(req, res) {
  const param = req.params.param;
  const senderConfig = await senderResolver.resolveBySenderNumber(param);

  if (senderConfig) {
    await handleWebhook(req, res, { department: null, senderNumber: param, route: `/webhook/msg91/${param}` });
    return;
  }

  await handleLegacyContextWebhook(req, res, {
    webhookType: "outbound_report",
    templateName: param,
    route: `/webhook/msg91/${param}`,
  });
}

module.exports = {
  handleDepartmentWebhook,
  handleSenderWebhook,
  handleGenericWebhook,
  handleLegacyContextWebhook,
  handleSenderOrTemplateWebhook,
};
