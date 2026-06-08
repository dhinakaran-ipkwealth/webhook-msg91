const assert = require('assert');
const { formatPhoneForCall, isValidWhatsappNumber, findMobileField } = require('../src/entities/phone');

function testFormat() {
  assert.strictEqual(formatPhoneForCall('+919876543210'), '919876543210');
  assert.strictEqual(formatPhoneForCall('00919876543210'), '919876543210');
  assert.strictEqual(formatPhoneForCall('9876543210'), '919876543210');
  assert.strictEqual(formatPhoneForCall('0651234567'), '0651234567');
}

function testValid() {
  assert.strictEqual(isValidWhatsappNumber('919876543210'), true);
  assert.strictEqual(isValidWhatsappNumber('911234567890'), false);
  assert.strictEqual(isValidWhatsappNumber('6591234567'), true);
  assert.strictEqual(isValidWhatsappNumber('6512345678'), false);
}

function testFindMobileField() {
  const headers = ['Name', 'Phone', 'Email'];
  assert.strictEqual(findMobileField(headers), 'Phone');
  assert.strictEqual(findMobileField(['a','b']), 'a');
}

module.exports = function run() {
  testFormat();
  testValid();
  testFindMobileField();
  return { name: 'phone', ok: true };
};
