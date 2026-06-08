function buildReplyHistoryItem(event) {
  return {
    text: event.text,
    receivedAt: event.receivedAt || new Date().toISOString(),
    customerNumber: event.customerNumber || event.normalizedMobile || null,
    requestId: event.requestId || null,
    eventKey: event.eventKey || null,
    webhookType: event.webhookType || null,
    rawPayload: event.rawPayload || null,
  };
}

function extractWebhookContentValues(item = {}) {
  const content = (() => {
    try {
      const v = item.content;
      if (!v || typeof v !== 'object') return null;
      return v;
    } catch (e) {
      return null;
    }
  })();
  if (!content) return [];

  return Object.values(content)
    .map((entry) => {
      if (entry && typeof entry === 'object') return entry.text || entry.value || '';
      return entry;
    })
    .map((value) => String(value || '').trim())
    .filter((value) => value && value.length > 1);
}

module.exports = {
  buildReplyHistoryItem,
  extractWebhookContentValues,
};
