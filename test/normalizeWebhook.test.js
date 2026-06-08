const assert = require('assert');
const { normalizeWebhookItem, getPayloadItems } = require('../src/usecases/normalizeWebhook');

function testNormalizeSimple() {
  const raw = { text: 'hello', from: '+919876543210', uuid: 'u1' };
  const norm = normalizeWebhookItem(raw, { webhookType: 'debug' });
  assert.strictEqual(norm.eventType, 'inbound');
  assert.strictEqual(norm.normalizedMobile && norm.normalizedMobile.endsWith('9876543210'), true);
  assert.strictEqual(typeof norm.eventKey, 'string');
}

function testGetPayloadItems() {
  assert.deepStrictEqual(getPayloadItems([1,2,3]), [1,2,3]);
  assert.deepStrictEqual(getPayloadItems({ data: [4,5] }), [4,5]);
}

module.exports = function run() {
  testNormalizeSimple();
  testGetPayloadItems();
  return { name: 'normalizeWebhook', ok: true };
};
