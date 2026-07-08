"use strict";

function formatPhoneForCall(input) {
  if (!input) return "";
  const cleaned = String(input).replace(/\D+/g, "");
  if (cleaned.length === 10) return `91${cleaned}`;
  if (cleaned.length === 11 && cleaned.startsWith("0"))
    return `91${cleaned.slice(1)}`;
  return cleaned;
}

function sanitizeSenderNumber(value) {
  const digits = String(value || "").replace(/\D+/g, "");
  return digits || null;
}

module.exports = { formatPhoneForCall, sanitizeSenderNumber };
