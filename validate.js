#!/usr/bin/env node

const { runCli } = require('./src/usecases/validateCsv');

const csvFile = process.argv[2] || 'test.csv';

(async () => {
  try {
    console.log(`📋 Validating: ${csvFile}\n`);
    await runCli(csvFile);
  } catch (err) {
    console.error(err && err.message ? err.message : String(err));
    process.exit(1);
  }
})();
