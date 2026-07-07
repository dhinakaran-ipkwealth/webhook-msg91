"use strict";

/**
 * Plain Node.js/Express backend — nothing to transpile or bundle.
 * "build" instead means: verify every source file is syntactically valid
 * and that ecosystem.config.js loads, so a bad deploy is caught before
 * `pm2 start` ever runs.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SKIP_DIRS = new Set(["node_modules", ".git"]);

function collectJsFiles(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsFiles(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(fullPath);
    }
  }
  return files;
}

const files = collectJsFiles(ROOT);
let failed = false;

for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    console.log(`  ok  ${path.relative(ROOT, file)}`);
  } catch (error) {
    failed = true;
    console.error(`FAIL  ${path.relative(ROOT, file)}`);
    console.error(error.stderr?.toString() || error.message);
  }
}

if (failed) {
  console.error(`\nbuild failed — ${files.length} file(s) checked`);
  process.exit(1);
}

console.log(`\nbuild ok — ${files.length} file(s) checked`);
