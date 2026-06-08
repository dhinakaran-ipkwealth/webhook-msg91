const crypto = require('crypto');
const { formatPhoneForCall } = require('../entities/phone');

function parseMaybeJson(value) {
  if (value === undefined || value === null || value === "") return value;
  if (typeof value !== "string") return value;

  const trimmed = value.trim();
  if (!trimmed) return value;

  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }

  return value;
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

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function extractButtonText(button) {
  const parsed = parseMaybeJson(button);
  if (!parsed) return "";
  if (typeof parsed === "string") return parsed;
  return (
    parsed.text ||
    parsed.title ||
    parsed.payload ||
    parsed.button?.text ||
    parsed.button?.payload ||
    ""
  );
}

function extractInteractiveText(interactive) {
  const parsed = parseMaybeJson(interactive);
  if (!parsed) return "";
  if (typeof parsed === "string") return parsed;
  return (
    parsed.button_reply?.title ||
    parsed.button_reply?.id ||
    parsed.list_reply?.title ||
    parsed.list_reply?.id ||
    parsed.nfm_reply?.body ||
    parsed.nfm_reply?.name ||
    parsed.flow_reply?.body ||
    parsed.flow_reply?.name ||
    parsed.type ||
    ""
  );
}

function extractMessagesText(messages) {
  const parsed = parseMaybeJson(messages);
  const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];

  return list
    .map((message) => {
      if (!message || typeof message !== 'object') return String(message || '');
      return (
        message.text?.body ||
        message.button?.text ||
        message.button?.payload ||
        message.interactive?.button_reply?.title ||
        message.interactive?.button_reply?.id ||
        message.interactive?.list_reply?.title ||
        message.interactive?.list_reply?.id ||
        message.interactive?.nfm_reply?.body ||
        message.interactive?.flow_reply?.body ||
        message.image?.caption ||
        message.video?.caption ||
        message.document?.caption ||
        message.reaction?.emoji ||
        message.url ||
        ''
      );
    })
    .filter(Boolean)
    .join(' | ');
}

function extractMessageContextId(messages) {
  const parsed = parseMaybeJson(messages);
  const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  for (const message of list) {
    const contextId = message?.context?.id || message?.reply_context?.id || '';
    if (contextId) return contextId;
  }
  return '';
}

function getMsg91CorrelationId(item, eventType) {
  if (eventType === 'inbound') {
    return (
      item.replyMsgId ||
      item.reply_msg_id ||
      extractMessageContextId(item.messages) ||
      item.message_id ||
      item.messageId ||
      item.message_uuid ||
      item.uuid ||
      item.id ||
      item.requestId ||
      item.request_id ||
      item.oneApiRequestId ||
      item.one_api_request_id ||
      null
    );
  }

  return (
    item.uuid ||
    item.message_uuid ||
    item.message_id ||
    item.messageId ||
    item.id ||
    item.requestId ||
    item.request_id ||
    item.oneApiRequestId ||
    item.one_api_request_id ||
    null
  );
}

function extractReactionText(reaction) {
  const parsed = parseMaybeJson(reaction);
  if (!parsed) return '';
  if (typeof parsed === 'string') return parsed;
  return parsed.emoji || parsed.text || parsed.reaction || JSON.stringify(parsed);
}

function extractContentText(content) {
  const parsed = parseMaybeJson(content);
  if (!parsed) return '';
  if (typeof parsed === 'string') return parsed;

  return (
    parsed.text?.body ||
    parsed.text ||
    parsed.button?.text ||
    parsed.button?.payload ||
    parsed.interactive?.button_reply?.title ||
    parsed.interactive?.list_reply?.title ||
    parsed.caption ||
    ''
  );
}

function extractMessageText(item) {
  return String(
    item.text ||
      extractContentText(item.content) ||
      extractButtonText(item.button) ||
      extractInteractiveText(item.interactive) ||
      extractMessagesText(item.messages) ||
      item.caption ||
      extractReactionText(item.reaction) ||
      item.clickedUrl ||
      item.clicked_url ||
      item.url ||
      ''
  ).trim();
}

function getCustomerNumber(item) {
  return (
    item.customerNumber ||
    item.customer_number ||
    item.from ||
    item.wa_id ||
    parseMaybeJson(item.contacts)?.[0]?.wa_id ||
    parseMaybeJson(item.messages)?.[0]?.from ||
    item.mobile ||
    item.to ||
    item.number ||
    item.phone ||
    item.recipient ||
    ''
  );
}

function inferEventType(item, context = {}) {
  const direction = String(item.direction || item.direction_type || '').trim();
  if (direction === '0') return 'inbound';
  if (direction === '1') return 'outbound';

  const webhookType = String(
    item.webhookType ||
      item.webhook_type ||
      item.eventType ||
      item.event_type ||
      context.webhookType ||
      ''
  ).toLowerCase();

  if (webhookType.includes('inbound') || webhookType.includes('incoming')) return 'inbound';
  if (webhookType.includes('outbound') || webhookType.includes('report')) return 'outbound';

  const contentType = String(item.contentType || item.content_type || '').toLowerCase();
  const messageType = String(item.messageType || item.message_type || '').toLowerCase();

  if (
    item.replyMsgId ||
    item.reply_msg_id ||
    item.customerName ||
    item.customer_name ||
    item.text ||
    item.button ||
    item.interactive ||
    item.reaction ||
    item.contacts ||
    item.caption ||
    item.url ||
    item.clickedUrl ||
    item.clicked_url ||
    webhookType.includes('url') ||
    webhookType.includes('click') ||
    contentType ||
    [
      'text',
      'button',
      'interactive',
      'reaction',
      'image',
      'document',
      'audio',
      'video',
      'url',
      'url_click',
      'flow',
      'nfm_reply',
    ].includes(messageType)
  ) {
    return 'inbound';
  }

  return 'outbound';
}

function createStatusLabel(statusText) {
  if (!statusText) return 'reporting';
  const normalized = String(statusText).toLowerCase();
  if (normalized === 'deny' || normalized === 'denied') return 'failed';
  if (normalized === 'read') return 'delivered';
  if (normalized.includes('read')) return 'delivered';
  if (normalized.includes('deliver')) return 'delivered';
  if (normalized.includes('fail') || normalized.includes('undel') || normalized.includes('reject')) return 'failed';
  if (normalized.includes('sent') || normalized.includes('submit')) return 'sent';
  return 'reporting';
}

function normalizeWebhookItem(item, context = {}) {
  const eventType = inferEventType(item, context);
  const normalizedMobile = formatPhoneForCall(getCustomerNumber(item));

  const statusSource =
    item.eventName ||
    item.event_name ||
    item.statusCode ||
    item.status_code ||
    item.reason ||
    item.status ||
    item.delivery_status ||
    item.messageType ||
    item.message_type ||
    item.webhookType ||
    context.webhookType;

  const text = extractMessageText(item) || null;
  const requestId = getMsg91CorrelationId(item, eventType);

  const receivedAt = item.ts || item.statusUpdatedAt || item.requestedAt || new Date().toISOString();

  const eventKey = sha256(
    [
      'msg91',
      eventType,
      normalizedMobile,
      item.integratedNumber || item.integrated_number || '',
      requestId || '',
      item.uuid || '',
      item.replyMsgId || item.reply_msg_id || '',
      item.eventName || item.event_name || '',
      text || '',
    ].join('|') || stableStringify(item),
  );

  const stableKey = eventType === 'inbound' && requestId
    ? sha256([
        'msg91-stable',
        'inbound',
        normalizedMobile,
        item.integratedNumber || item.integrated_number || '',
        requestId || '',
        text || '',
      ].join('|'))
    : null;

  return {
    source: 'crm-webhook',
    service: 'crm-msg91-webhook',
    eventKey,
    stableKey,
    eventType,
    normalizedStatus: eventType === 'inbound' ? 'inbound' : createStatusLabel(statusSource),
    normalizedMobile: normalizedMobile || null,
    text,
    requestId,
    templateName: item.templateName || item.template_name || context.templateName || null,
    uploadId: item.uploadId || item.upload_id || context.uploadId || null,
    webhookType: item.webhookType || item.webhook_type || context.webhookType || 'msg91',
    customerNumber: item.customerNumber || item.customer_number || normalizedMobile || null,
    integratedNumber: item.integratedNumber || item.integrated_number || null,
    contentType: item.contentType || item.content_type || null,
    button: item.button || null,
    interactive: item.interactive || null,
    reaction: item.reaction || null,
    messages: item.messages || null,
    eventName: item.eventName || item.event_name || null,
    reason: item.reason || null,
    statusCode: item.statusCode || item.status_code || null,
    statusUpdatedAt: item.statusUpdatedAt || null,
    price: item.price || null,
    rawPayload: item,
    receivedAt,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function getPayloadItems(body) {
  const parsedBody = parseMaybeJson(body);
  if (Array.isArray(parsedBody)) return parsedBody;

  const data = parseMaybeJson(parsedBody?.data);
  if (Array.isArray(parsedBody?.reports)) return parsedBody.reports;
  if (Array.isArray(data)) return data;
  if (Array.isArray(parsedBody?.payload)) return parsedBody.payload;
  if (Array.isArray(parsedBody?.entry)) return parsedBody.entry;

  return parsedBody && typeof parsedBody === 'object' ? [parsedBody] : [];
}

module.exports = {
  normalizeWebhookItem,
  getPayloadItems,
  extractMessageText,
  getCustomerNumber,
  formatPhoneForCall,
};
