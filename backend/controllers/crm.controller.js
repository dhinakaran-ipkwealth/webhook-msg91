"use strict";

const { handleDepartmentWebhook } = require("./webhookBase.controller");

// POST /webhook/msg91/crm
module.exports = handleDepartmentWebhook("crm");
