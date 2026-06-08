const path = require('path');
const tests = [
  './phone.test.js',
  './normalizeWebhook.test.js',
];

let failed = 0;
for (const t of tests) {
  try {
    const fn = require(path.join(__dirname, t));
    const res = fn();
    console.log(`ok: ${res.name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL: ${t}`);
    console.error(e && e.stack ? e.stack : e);
  }
}

if (failed) {
  console.error(`${failed} test(s) failed`);
  process.exit(2);
}
console.log('All tests passed');
