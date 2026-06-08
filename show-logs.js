#!/usr/bin/env node

/**
 * Display CSV validation logs
 * Run after using "npm run start" to see validation results
 */

const fs = require('fs');
const path = require('path');

const logFile = path.join(__dirname, 'validation.log');

if (!fs.existsSync(logFile)) {
  console.log('❌ No validation log found.');
  console.log('   Run "npm run start" first to generate logs.');
  process.exit(1);
}

const content = fs.readFileSync(logFile, 'utf8');
console.log('\n📋 CSV Validation Log\n');
console.log('═'.repeat(70));
console.log(content);
console.log('═'.repeat(70));
console.log(`\n📁 Log file: ${logFile}`);
console.log(`📅 Last modified: ${new Date(fs.statSync(logFile).mtime).toISOString()}\n`);
