const { createApp } = require('./expressApp');
const mongoGateway = require('../gateways/mongoGateway');

const PORT = Number(process.env.PORT || process.env.WEBHOOK_PORT || 3002);
const HOST = process.env.WEBHOOK_HOST || '0.0.0.0';

async function main() {
  const MONGODB_URI = process.env.DATABASE_URL || process.env.MONGODB_URI;
  const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || '';
  try {
    await mongoGateway.init(MONGODB_URI, MONGODB_DB_NAME);
    if (MONGODB_URI) await mongoGateway.ensureIndexes();
  } catch (err) {
    console.warn('Mongo init failed:', err.message || err);
  }

  const app = createApp();
  app.listen(PORT, HOST, () => {
    console.log(`crm-msg91-webhook listening on http://${HOST}:${PORT}/webhook`);
  });
}

main().catch((err) => {
  console.error('Server failed:', err);
  process.exit(1);
});

process.on('SIGINT', async () => { await mongoGateway.close().catch(() => {}); process.exit(0); });
process.on('SIGTERM', async () => { await mongoGateway.close().catch(() => {}); process.exit(0); });
