// Phone-related entity helpers
function formatPhoneForCall(input) {
  if (!input) return "";
  const raw = String(input).trim();
  let cleaned = raw.replace(/\D+/g, "");

  if (raw.startsWith("+")) return cleaned;

  if (cleaned.startsWith("00") && cleaned.length > 10) {
    cleaned = cleaned.slice(2);
  }

  if (cleaned.length === 10 && cleaned.startsWith("65")) {
    return cleaned;
  }

  if (cleaned.length === 10 && /^[6-9]/.test(cleaned)) {
    return `91${cleaned}`;
  }

  if (cleaned.length === 11 && cleaned.startsWith("0")) {
    return `91${cleaned.slice(1)}`;
  }

  if (cleaned.length === 12) return cleaned;

  return cleaned;
}

function isValidWhatsappNumber(cleaned) {
  if (!cleaned) return false;
  if (/^91[6-9]\d{9}$/.test(cleaned)) return true; // Indian mobile
  if (/^91\d{10}$/.test(cleaned)) return false; // Indian non-mobile
  if (/^65[89]\d{7}$/.test(cleaned)) return true; // Singapore mobile
  if (/^65\d{8}$/.test(cleaned)) return false; // Singapore landline
  return /^[1-9]\d{7,14}$/.test(cleaned);
}

function findMobileField(headers) {
  const normalized = headers.map((h) => String(h || "").toLowerCase().trim());
  const mobileHeader = normalized.find((header) => /mobile|phone|number/.test(header));
  if (!mobileHeader) return headers[0] || "";
  return headers[normalized.indexOf(mobileHeader)];
}

module.exports = {
  formatPhoneForCall,
  isValidWhatsappNumber,
  findMobileField,
};
