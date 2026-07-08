"use strict";

const crypto = require("crypto");

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function stableStringify(value) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${key}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

module.exports = { sha256, stableStringify };
