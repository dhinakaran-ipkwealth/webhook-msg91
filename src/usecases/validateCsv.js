const fs = require('fs');
const path = require('path');
const csvParser = require('csv-parser');
const { formatPhoneForCall, isValidWhatsappNumber, findMobileField } = require('../entities/phone');

function runValidation(csvFilePath) {
  return new Promise((resolve, reject) => {
    const csvPath = path.resolve(csvFilePath);

    if (!fs.existsSync(csvPath)) {
      return reject(new Error(`File not found: ${csvPath}`));
    }

    const rows = [];
    let rowNumber = 0;

    fs.createReadStream(csvPath)
      .pipe(csvParser({ mapHeaders: ({ header }) => header.trim() }))
      .on('data', (row) => {
        rowNumber++;
        const headers = Object.keys(row);
        const mobileKey = findMobileField(headers);
        const original = row[mobileKey] ? String(row[mobileKey]).trim() : "";
        const cleaned = formatPhoneForCall(original);
        const valid = isValidWhatsappNumber(cleaned);

        rows.push({ rowNumber, original, cleaned, valid, data: row });
      })
      .on('end', () => resolve(rows))
      .on('error', (err) => reject(err));
  });
}

async function runCli(csvFile) {
  try {
    const rows = await runValidation(csvFile);
    const validCount = rows.filter(r => r.valid).length;
    const invalidCount = rows.length - validCount;

    console.log("═".repeat(70));
    console.log("\n📊 SUMMARY");
    console.log("─".repeat(70));
    console.log(`Total rows:   ${rows.length}`);
    console.log(`✓ Valid:      ${validCount}`);
    console.log(`✗ Invalid:    ${invalidCount}`);
    console.log(`Success rate: ${rows.length > 0 ? ((validCount / rows.length) * 100).toFixed(1) : 0}%`);
    console.log("");

    if (invalidCount > 0) {
      console.log("❌ Invalid Numbers:");
      rows.filter(r => !r.valid).forEach(r => {
        console.log(`  Row ${r.rowNumber}: "${r.original}" → "${r.cleaned}"`);
      });
      console.log("");
    }

    if (validCount > 0) {
      console.log("✅ Result: This CSV file is ready to upload!");
    } else {
      console.log("❌ Result: No valid numbers found. Fix them and try again.");
    }
    console.log("");
    return { rows, validCount, invalidCount };
  } catch (err) {
    console.error('❌ Error parsing CSV:', err.message);
    throw err;
  }
}

module.exports = {
  runValidation,
  runCli,
};
