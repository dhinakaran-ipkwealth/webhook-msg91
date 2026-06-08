const assert = require('assert');

// Prepare a mocked mongoGateway by injecting into require.cache before requiring use-cases
function makeMockGateway() {
  const events = [];
  const reports = [];

  return {
    init: async () => {},
    ensureIndexes: async () => {},
    bulkWriteWebhookEvents: async (writes) => {
      // emulate insert of each write
      const inserted = writes.map((w, i) => ({ _id: `id${i}`, ...w }));
      events.push(...inserted);
      return { insertedCount: inserted.length, insertedIds: inserted.map(e=>e._id) };
    },
    findWebhookEventsByEventKeys: async () => [],
    findWebhookEventsByStableKeys: async () => [],

    findSenderReports: async () => [],
    findOneSenderReport: async () => null,
    updateSenderReport: async () => ({ matchedCount:0, modifiedCount:0 }),
    updateNumber: async () => ({ matchedCount:0, modifiedCount:0 }),
    // expose state for assertions
    __events: events,
    __reports: reports,
  };
}

function injectMockGateway(mockGateway) {
  const gatewayPath = require.resolve('../src/gateways/mongoGateway');
  require.cache[gatewayPath] = {
    id: gatewayPath,
    filename: gatewayPath,
    loaded: true,
    exports: mockGateway,
  };
}

async function testStoreWebhookSimple() {
  const mock = makeMockGateway();
  injectMockGateway(mock);

  const { storeWebhook } = require('../src/usecases/storeWebhook');

  const body = [ { text: 'hello', from: '+919876543210', uuid: 'u1' } ];
  const res = await storeWebhook({ body, headers: {}, ip: '127.0.0.1' });

  assert.ok(res && res.insertedCount >= 0);
}

async function testApplyRepliesNoReports() {
  const mock = makeMockGateway();
  injectMockGateway(mock);

  const { applyInboundReplyToReports } = require('../src/usecases/applyRepliesAndReports');

  const evt = { eventType: 'inbound', normalizedMobile: '919876543210', text: 'hi' };
  const result = await applyInboundReplyToReports(evt);

  assert.strictEqual(result.applied, false);
  assert.ok(result.reason && typeof result.reason === 'string');
}

module.exports = async function run() {
  await testStoreWebhookSimple();
  await testApplyRepliesNoReports();
  return { name: 'store_apply', ok: true };
};
