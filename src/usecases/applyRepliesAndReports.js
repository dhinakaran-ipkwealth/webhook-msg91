const mongoGateway = require('../gateways/mongoGateway');
const { buildReplyHistoryItem, extractWebhookContentValues } = require('../entities/webhookEvent');

function scoreSenderReportMatch(report, values) {
  if (!values.length) return 0;
  const reportText = [
    report.sentMessage,
    report.mobile,
    typeof report.csvRowData === 'string' ? report.csvRowData : JSON.stringify(report.csvRowData || {}),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return values.reduce((score, value) => (reportText.includes(value.toLowerCase()) ? score + 1 : score), 0);
}

async function findSenderReportByWebhookContent(event) {
  if (event.eventType !== 'outbound' || !event.normalizedMobile) return null;
  const values = extractWebhookContentValues(event.rawPayload);
  if (!values.length) return null;

  const query = { mobile: event.normalizedMobile };
  if (event.uploadId) query.uploadId = Number(event.uploadId);
  if (event.templateName) query.templateName = event.templateName;

  const candidates = await mongoGateway.findSenderReports(query, { sort: { sentAt: -1, updatedAt: -1, _id: -1 }, limit: 50 });
  let best = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const score = scoreSenderReportMatch(candidate, values);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best && bestScore >= 2 ? best : null;
}

async function applyInboundReplyToReports(event) {
  if (event.eventType !== 'inbound') return { applied: false, reason: 'not_inbound' };

  const mobile = event.normalizedMobile;
  const replyText = event.text;
  if (!mobile || !replyText) return { applied: false, reason: 'missing_mobile_or_text' };

  const senderReportsColl = mongoGateway; // use gateway methods
  const numbersColl = mongoGateway;
  const replyAt = event.receivedAt || new Date().toISOString();
  const now = new Date().toISOString();
  const historyItem = buildReplyHistoryItem(event);

  let latestReport = null;

  if (event.requestId) {
    const msgIdQuery = { $or: [{ responseId: event.requestId }, { messageId: event.requestId }] };
    if (event.uploadId) msgIdQuery.uploadId = Number(event.uploadId);
    const candidates = await senderReportsColl.findSenderReports(msgIdQuery, { sort: { sentAt: 1 } });
    latestReport = (candidates.find((c) => !c.customReply && !c.lastReplyAt) || candidates[0]) || null;
  }

  if (!latestReport) {
    const mobileQuery = { mobile };
    if (event.uploadId) mobileQuery.uploadId = Number(event.uploadId);
    if (event.templateName) mobileQuery.templateName = event.templateName;
    const mobileCandidates = await senderReportsColl.findSenderReports(mobileQuery, { sort: { sentAt: 1 } });
    latestReport = (mobileCandidates.find((c) => !c.customReply && !c.lastReplyAt) || mobileCandidates[0]) || null;
  }

  if (!latestReport) {
    console.log('Inbound reply received but no matching sender report found', { mobile, replyText });
    return { applied: false, reason: 'no_sender_report' };
  }

  await mongoGateway.updateSenderReport(
    { _id: latestReport._id, 'replyHistory.eventKey': { $ne: event.eventKey } },
    {
      $set: {
        currentStatus: 'replied',
        customReply: replyText,
        lastReplyAt: replyAt,
        replyWebhook: event,
        updatedAt: now,
      },
      $push: { replyHistory: { $each: [historyItem], $slice: -50 } },
    },
  );

  const numberFilter = latestReport.uploadId && latestReport.numberId ? { uploadId: latestReport.uploadId, numberId: latestReport.numberId } : { cleaned: mobile };

  await mongoGateway.updateNumber(
    { ...numberFilter, 'replyHistory.eventKey': { $ne: event.eventKey } },
    {
      $set: {
        currentStatus: 'replied',
        customReply: replyText,
        lastReplyAt: replyAt,
        responseDetails: event,
        lastUpdated: now,
        updatedAt: now,
      },
      $push: { replyHistory: { $each: [historyItem], $slice: -50 } },
    },
  );

  console.log('Inbound reply applied', {
    mobile,
    replyText,
    uploadId: latestReport.uploadId,
    numberId: latestReport.numberId,
  });

  return { applied: true, uploadId: latestReport.uploadId || null, numberId: latestReport.numberId || null };
}

async function applyOutboundStatusToReports(event) {
  if (event.eventType !== 'outbound') return { applied: false, reason: 'not_outbound' };

  const mobile = event.normalizedMobile;
  const status = event.normalizedStatus || 'reporting';
  const now = new Date().toISOString();

  const requestId = event.requestId;

  let latestReport = null;
  if (requestId) {
    latestReport = await mongoGateway.findOneSenderReport({ $or: [{ responseId: requestId }, { messageId: requestId }] }, { sort: { sentAt: -1, updatedAt: -1, _id: -1 } });
  }

  if (!latestReport) {
    latestReport = await findSenderReportByWebhookContent(event);
  }

  if (!latestReport && mobile) {
    latestReport = await mongoGateway.findOneSenderReport({ mobile }, { sort: { sentAt: -1, updatedAt: -1, _id: -1 } });
  }

  if (!requestId && !mobile) return { applied: false, reason: 'no_match_key' };
  if (!latestReport) return { applied: false, reason: 'no_sender_report' };

  await mongoGateway.updateSenderReport(
    { _id: latestReport._id },
    {
      $set: {
        currentStatus: status,
        deliveryStatus: status,
        reportWebhook: event,
        responseId: requestId || latestReport.responseId || null,
        messageId: requestId || latestReport.messageId || null,
        updatedAt: now,
      },
    },
  );

  if (latestReport.uploadId && latestReport.numberId) {
    await mongoGateway.updateNumber(
      { uploadId: latestReport.uploadId, numberId: latestReport.numberId },
      {
        $set: {
          currentStatus: status,
          deliveryStatus: status,
          responseId: requestId || null,
          messageId: requestId || null,
          responseDetails: event,
          lastUpdated: now,
          updatedAt: now,
        },
      },
    );
  }

  return { applied: true, uploadId: latestReport.uploadId, numberId: latestReport.numberId };
}

module.exports = {
  applyInboundReplyToReports,
  applyOutboundStatusToReports,
};
