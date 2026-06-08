const express = require('express');
const bodyParser = require('express').json;
const webhookController = require('../controllers/webhookController');

function createApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  app.get('/health', (req, res) => res.json({ ok: true, service: 'crm-msg91-webhook' }));

  app.get('/webhook', (req, res) => res.json({ ok: true, service: 'crm-msg91-webhook', message: 'MSG91 must call this endpoint using POST.' }));

  app.post('/debug-webhook', (req, res) => {
    const body = req.body || {};
    res.json({ received: true, itemCount: (Array.isArray(body) ? body.length : 1) });
  });

  app.post('/webhook', (req, res) => webhookController.handleWebhook(req, res, { webhookType: 'msg91' }));

  app.post('/webhook/msg91/inbound', (req, res) => webhookController.handleWebhook(req, res, { webhookType: 'inbound' }));
  app.post('/webhook/msg91/outbound', (req, res) => webhookController.handleWebhook(req, res, { webhookType: 'outbound_report' }));

  app.post('/webhook/msg91/:templateName/:uploadId', (req, res) => {
    const ctx = { templateName: req.params.templateName, uploadId: Number(req.params.uploadId) || null, webhookType: 'outbound_report' };
    webhookController.handleWebhook(req, res, ctx);
  });

  app.post('/webhook/msg91/:templateName', (req, res) => {
    const ctx = { templateName: req.params.templateName, webhookType: 'outbound_report' };
    webhookController.handleWebhook(req, res, ctx);
  });

  return app;
}

module.exports = { createApp };
