#!/usr/bin/env node

const fs = require("fs");
const csvParser = require("csv-parser");

const csvFile = process.argv[2] || "test.csv";

function normalizeCellText(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/^\uFEFF/, "")
    .replace(/\u00a0/g, " ")
    .trim();
}

function expandScientificNumber(value) {
  const raw = normalizeCellText(value).replace(/,/g, "");
  if (!/^[+-]?\d+(?:\.\d+)?e[+-]?\d+$/i.test(raw)) return raw;
  const [coefficient, exponentText] = raw.toLowerCase().split("e");
  const exponent = Number(exponentText);
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 30) return raw;
  const negative = coefficient.startsWith("-");
  const unsigned = coefficient.replace(/^[+-]/, "");
  const [whole, decimal = ""] = unsigned.split(".");
  const digits = `${whole}${decimal}`;
  const decimalPlaces = decimal.length;
  const zeroCount = exponent - decimalPlaces;
  if (zeroCount >= 0) return `${negative ? "-" : ""}${digits}${"0".repeat(zeroCount)}`;
  const splitAt = digits.length + zeroCount;
  return `${negative ? "-" : ""}${digits.slice(0, splitAt)}.${digits.slice(splitAt)}`;
}

function formatPhoneForCall(input) {
  if (input === null || input === undefined) return "";
  const raw = expandScientificNumber(input).replace(/\.0+$/, "");
  let cleaned = raw.replace(/\D+/g, "");

  if (raw.startsWith("+")) return cleaned;

  if (cleaned.startsWith("00") && cleaned.length > 10) {
    cleaned = cleaned.slice(2);
  }

  if (cleaned.length === 10 && /^[6-9]/.test(cleaned)) {
    return `91${cleaned}`;
  }

  if (cleaned.length === 11 && cleaned.startsWith("0") && /^[6-9]/.test(cleaned.slice(1))) {
    return `91${cleaned.slice(1)}`;
  }

  if (cleaned.length === 12 && cleaned.startsWith("091")) {
    return cleaned.slice(1);
  }

  return cleaned;
}

function isValidWhatsappNumber(cleaned) {
  if (!cleaned) return false;
  if (/^91[6-9]\d{9}$/.test(cleaned)) return true;
  if (/^91\d{10}$/.test(cleaned)) return false;
  if (/^65[89]\d{7}$/.test(cleaned)) return true;
  if (/^65\d{8}$/.test(cleaned)) return false;
  return /^[1-9]\d{7,14}$/.test(cleaned);
}

function findMobileField(headers) {
  const normalized = headers.map((header) =>
    normalizeCellText(header).toLowerCase().replace(/[_-]+/g, " ").trim(),
  );
  const mobileHeader = normalized.find((header) =>
    /\b(mobile|phone|whatsapp|wa|contact|number)\b/.test(header),
  );
  if (!mobileHeader) return headers[0] || "";
  return headers[normalized.indexOf(mobileHeader)];
}

function readCsv(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const rows = [];
  return new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(csvParser({ mapHeaders: ({ header }) => normalizeCellText(header) }))
      .on("data", (row) => rows.push(row))
      .on("end", () => resolve(rows))
      .on("error", reject);
  });
}

(async () => {
  try {
    console.log(`Validating: ${csvFile}\n`);
    const rows = await readCsv(csvFile);
    const headers = Object.keys(rows[0] || {});
    const mobileKey = findMobileField(headers);

    const results = rows.map((row, index) => {
      const original = normalizeCellText(row[mobileKey]);
      const cleaned = formatPhoneForCall(original);
      const valid = isValidWhatsappNumber(cleaned);
      return { row: index + 1, original, cleaned, valid };
    });

    const validCount = results.filter((row) => row.valid).length;
    const invalidRows = results.filter((row) => !row.valid);

    results.forEach((row) => {
      const status = row.valid ? "valid" : "invalid";
      console.log(`Row ${row.row}: ${row.original || "(blank)"} -> ${row.cleaned || "(blank)"} [${status}]`);
    });

    console.log("");
    console.log(`Total rows: ${results.length}`);
    console.log(`Valid rows: ${validCount}`);
    console.log(`Invalid rows: ${invalidRows.length}`);
    console.log(`Success rate: ${results.length ? ((validCount / results.length) * 100).toFixed(1) : "0.0"}%`);

    if (invalidRows.length) process.exitCode = 1;
  } catch (err) {
    console.error(err && err.message ? err.message : String(err));
    process.exit(1);
  }
})();
