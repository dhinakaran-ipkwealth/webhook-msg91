const http = require('http');

const ELECTRON_NOTIFY_URL = process.env.ELECTRON_NOTIFY_URL || 'http://127.0.0.1:3002/notify';

async function notifyElectronApp(payload = {}) {
  try {
    const body = JSON.stringify(payload);
    await new Promise((resolve) => {
      const req = http.request(ELECTRON_NOTIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 1500,
      }, (res) => { res.resume(); resolve(); });
      req.on('error', resolve);
      req.on('timeout', () => { req.destroy(); resolve(); });
      req.write(body);
      req.end();
    });
  } catch (e) { /* ignore */ }
}

module.exports = { notifyElectronApp };
