"use strict";

const { handleDepartmentWebhook } = require("./webhookBase.controller");

// POST /webhook/msg91/marketing
module.exports = handleDepartmentWebhook("marketing");
