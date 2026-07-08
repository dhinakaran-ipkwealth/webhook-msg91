"use strict";

const express = require("express");
const { healthController, metricsController } = require("../controllers/health.controller");

const router = express.Router();

// No rate limiting — health-check probes must never be blocked.
router.get("/health", healthController);
router.get("/metrics", metricsController);

module.exports = router;
