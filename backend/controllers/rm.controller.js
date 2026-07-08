"use strict";

/**
 * Generic relationship-manager / catch-all controller.
 *
 * Handles the sender-driven routing mechanisms:
 *   - POST /webhook/msg91          (sender read from req.body.sender)
 *   - POST /webhook/msg91/:param   (sender number, OR — for backward
 *     compatibility — a legacy templateName if :param isn't a known sender)
 *
 * Any sender number whose `sender_numbers` department does not match one of
 * the fixed department segments (marketing/crm/support/events) lands here —
 * this is the bucket for RM-GENERAL, Operation, RM-1, RM-2, and every future
 * relationship-manager number added purely via a MongoDB document.
 */

const {
  handleGenericWebhook,
  handleSenderOrTemplateWebhook,
} = require("./webhookBase.controller");

module.exports = {
  generic: handleGenericWebhook,
  bySenderOrTemplate: handleSenderOrTemplateWebhook,
};
