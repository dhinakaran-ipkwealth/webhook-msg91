const { storeWebhook } = require('../usecases/storeWebhook');
const { notifyElectronApp } = require('../gateways/electronNotifier');

async function handleWebhook(req, res, ctx = {}) {
  try {
    const result = await storeWebhook(req.body, ctx);
    // notify Electron but don't wait
    notifyElectronApp({ uploadId: ctx.uploadId || null, insertedCount: result.insertedCount });
    res.json({ received: true, ...result });
  } catch (error) {
    console.error('Webhook processing failed:', error);
    res.status(500).json({ received: false, error: error.message || String(error) });
  }
}

module.exports = { handleWebhook };
