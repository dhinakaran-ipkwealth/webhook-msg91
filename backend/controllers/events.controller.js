"use strict";

const { handleDepartmentWebhook } = require("./webhookBase.controller");

// POST /webhook/msg91/events
module.exports = handleDepartmentWebhook("events");
