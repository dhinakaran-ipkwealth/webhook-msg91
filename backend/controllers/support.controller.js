"use strict";

const { handleDepartmentWebhook } = require("./webhookBase.controller");

// POST /webhook/msg91/support
module.exports = handleDepartmentWebhook("support");
