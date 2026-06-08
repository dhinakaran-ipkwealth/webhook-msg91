const mongoGateway = require('../gateways/mongoGateway');

function normalizeMongoDoc(doc) {
  if (!doc) return doc;
  const clone = { ...doc };
  delete clone._id;
  return clone;
}

function toRegexSearch(value) {
  return new RegExp(
    String(value || "")
      .replace(/^%|%$/g, "")
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "i",
  );
}

function addReportOrCondition(query, orConditions) {
  if (!orConditions.length) return;
  if (query.$and) {
    query.$and.push({ $or: orConditions });
  } else if (query.$or) {
    query.$and = [{ $or: query.$or }, { $or: orConditions }];
    delete query.$or;
  } else {
    query.$or = orConditions;
  }
}

function normalizeSenderFilterValue(value) {
  const raw = String(value || "").trim();
  const digits = raw.replace(/\D+/g, "");
  return digits.length >= 10 ? digits : raw;
}

function getTemplateFilterCandidates(value) {
  const raw = String(value || "").trim();
  if (!raw || raw === "all") return [];
  const withoutLanguage = raw.replace(/\s*\([^)]*\)\s*$/g, "").trim();
  const beforeColon = raw.split(":")[0].trim();
  const normalized = withoutLanguage
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return [...new Set([raw, beforeColon, withoutLanguage, normalized].filter(Boolean))];
}

async function getCustomReportRows(filters = {}) {
  // This function mirrors the previous logic in main_mongodb_no_report_sync.js
  // and centralises it here so it can be tested and refactored further.
  const db = mongoGateway.getDb();

  // 1. build query
  const query = {};
  const todayOnly = filters.todayOnly === true;
  if (todayOnly) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    query.receivedAt = { $gte: start.toISOString(), $lt: end.toISOString() };
  }

  if (filters.uploadId) {
    const uid = Number(filters.uploadId);
    query.$and = query.$and || [];
    query.$and.push({ $or: [{ matchedUploadId: uid }, { uploadId: uid }] });
  }

  if (filters.eventType && filters.eventType !== "all") {
    query.eventType = String(filters.eventType);
  }

  if (filters.status && filters.status !== "all") {
    if (filters.status === "inbound") {
      const inboundOr = [
        { eventType: "inbound" },
        { normalizedStatus: "inbound" },
        { text: { $nin: [null, ""] } },
      ];
      if (query.$and) {
        query.$and.push({ $or: inboundOr });
      } else {
        query.$or = inboundOr;
      }
    } else {
      query.normalizedStatus = String(filters.status);
    }
  }

  if (filters.filteredNumberId && filters.filteredNumberId !== "all") {
    const num = normalizeSenderFilterValue(filters.filteredNumberId);
    addReportOrCondition(query, [{ integratedNumber: num }, { integrated_number: num }]);
  }

  if (filters.templateName && filters.templateName !== "all") {
    const templateCandidates = getTemplateFilterCandidates(filters.templateName);
    addReportOrCondition(query, [{ templateName: { $in: templateCandidates } }]);
  }

  if (filters.startDateTime || filters.endDateTime) {
    const start = filters.startDateTime ? new Date(filters.startDateTime) : null;
    const end = filters.endDateTime ? new Date(filters.endDateTime) : null;
    const hasStart = start && !Number.isNaN(start.getTime());
    const hasEnd = end && !Number.isNaN(end.getTime());
    if (hasStart || hasEnd) {
      const rangeFilter = {};
      if (hasStart) rangeFilter.$gte = start.toISOString();
      if (hasEnd) rangeFilter.$lt = end.toISOString();
      query.receivedAt = rangeFilter;
    }
  }

  if (filters.search) {
    const rx = toRegexSearch(filters.search);
    const searchOr = [
      { normalizedMobile: rx },
      { customerNumber: rx },
      { requestId: rx },
      { replyMsgId: rx },
      { uuid: rx },
      { templateName: rx },
      { campaignName: rx },
      { text: rx },
      { reason: rx },
    ];
    if (query.$and) {
      query.$and.push({ $or: searchOr });
    } else if (query.$or) {
      query.$and = [{ $or: query.$or }, { $or: searchOr }];
      delete query.$or;
    } else {
      query.$or = searchOr;
    }
  }

  // 2. fetch webhook events
  const webhooks = db.collection('whatsapp_webhook_events');
  const rawEvents = await webhooks
    .find(query)
    .sort({ receivedAt: -1, id: -1, eventId: -1 })
    .limit(1000)
    .toArray();

  const events = rawEvents.filter((e) => !e.sourceEventId);

  // 3. batch fetch related uploads & numbers
  const uploadIdsNeeded = new Set();
  const numberIdsNeeded = new Set();
  const mobilesNeeded = new Set();

  for (const e of events) {
    const uid = e.matchedUploadId || e.uploadId || e.rawPayload?.uploadId;
    if (uid) uploadIdsNeeded.add(Number(uid));
    const nid = e.matchedNumberId || e.numberId;
    if (nid) numberIdsNeeded.add(Number(nid));
    else if (e.normalizedMobile) mobilesNeeded.add(e.normalizedMobile);
  }

  const [uploadDocs, numberByIdDocs, numberByMobileDocs] = await Promise.all([
    uploadIdsNeeded.size ? db.collection('whatsapp_uploads').find({ id: { $in: [...uploadIdsNeeded] } }).toArray() : [],
    numberIdsNeeded.size ? db.collection('whatsapp_numbers').find({ id: { $in: [...numberIdsNeeded] } }).toArray() : [],
    mobilesNeeded.size ? db.collection('whatsapp_numbers').find({ cleaned: { $in: [...mobilesNeeded] } }).sort({ lastUpdated: -1, id: -1 }).toArray() : [],
  ]);

  const uploadsMap = new Map(uploadDocs.map((u) => [u.id, u]));
  const numbersById = new Map(numberByIdDocs.map((n) => [n.id, n]));
  const numbersByMobile = new Map();
  for (const n of numberByMobileDocs) {
    if (!numbersByMobile.has(n.cleaned)) numbersByMobile.set(n.cleaned, n);
  }

  const result = [];
  const webhookRequestIds = new Set();

  for (const event of events) {
    const ev = normalizeMongoDoc(event);
    const matchedUploadId = Number(ev.matchedUploadId || ev.uploadId || ev.rawPayload?.uploadId || 0) || null;
    const matchedNumberId = Number(ev.matchedNumberId || ev.numberId || 0) || null;

    const upload = matchedUploadId ? uploadsMap.get(matchedUploadId) : null;
    const number = matchedNumberId ? numbersById.get(matchedNumberId) : (ev.normalizedMobile ? numbersByMobile.get(ev.normalizedMobile) : null);

    const reqId = ev.requestId || ev.replyMsgId || ev.uuid || "";
    if (reqId) webhookRequestIds.add(String(reqId));

    result.push({
      ...ev,
      id: ev.id || ev.eventId || String(event._id),
      matchedUploadId,
      matchedNumberId,
      uploadFileName: upload?.fileName || "",
      uploadTemplateLabel: upload?.templateLabel || "",
      numberCurrentStatus: number?.currentStatus || "",
      numberDeliveryStatus: number?.deliveryStatus || "",
      numberRetryCount: number?.retryCount || 0,
      sentMessage: number?.sentMessage || ev.sentMessage || "",
      customReply: number?.customReply || ev.text || "",
      lastReplyAt: number?.lastReplyAt || "",
      csvRowData: number?.data || {},
      rawPayload: ev.rawPayload || ev,
    });
  }

  const includeSenderReports = !filters.eventType || filters.eventType === "all" || filters.eventType === "outbound";
  const includeSenderStatus = !filters.status || filters.status === "all" || filters.status !== "inbound";

  if (includeSenderReports && includeSenderStatus) {
    const senderQuery = {};
    if (filters.uploadId) senderQuery.uploadId = Number(filters.uploadId);
    if (filters.filteredNumberId && filters.filteredNumberId !== "all") {
      senderQuery.senderNumber = normalizeSenderFilterValue(filters.filteredNumberId);
    }
    if (filters.templateName && filters.templateName !== "all") {
      const templateCandidates = getTemplateFilterCandidates(filters.templateName);
      senderQuery.$or = [ { templateName: { $in: templateCandidates } }, { templateLabel: String(filters.templateName) } ];
    }
    if (filters.status && filters.status !== "all") {
      senderQuery.$or = [ { currentStatus: String(filters.status) }, { deliveryStatus: String(filters.status) } ];
    }
    if (filters.startDateTime || filters.endDateTime) {
      const start = filters.startDateTime ? new Date(filters.startDateTime) : null;
      const end = filters.endDateTime ? new Date(filters.endDateTime) : null;
      const hasStart = start && !Number.isNaN(start.getTime());
      const hasEnd = end && !Number.isNaN(end.getTime());
      if (hasStart || hasEnd) {
        senderQuery.sentAt = {};
        if (hasStart) senderQuery.sentAt.$gte = start.toISOString();
        if (hasEnd) senderQuery.sentAt.$lt = end.toISOString();
      }
    }
    if (filters.search) {
      const rx = toRegexSearch(filters.search);
      const senderSearch = [ { mobile: rx }, { responseId: rx }, { messageId: rx }, { templateName: rx }, { templateLabel: rx }, { sentMessage: rx } ];
      if (senderQuery.$or) {
        senderQuery.$and = [{ $or: senderQuery.$or }, { $or: senderSearch }];
        delete senderQuery.$or;
      } else {
        senderQuery.$or = senderSearch;
      }
    }

    const senderRows = await db.collection('whatsapp_sender_reports').find(senderQuery).sort({ sentAt: -1, updatedAt: -1, _id: -1 }).limit(1000).toArray();

    const senderUploadIds = new Set(senderRows.map((r) => Number(r.uploadId)).filter(Boolean));
    const senderNumberIds = new Set(senderRows.map((r) => Number(r.numberId)).filter(Boolean));

    const [senderUploadDocs, senderNumberDocs] = await Promise.all([
      senderUploadIds.size ? db.collection('whatsapp_uploads').find({ id: { $in: [...senderUploadIds] } }).toArray() : [],
      senderNumberIds.size ? db.collection('whatsapp_numbers').find({ id: { $in: [...senderNumberIds] } }).toArray() : [],
    ]);

    senderUploadDocs.forEach((u) => uploadsMap.set(u.id, u));
    senderNumberDocs.forEach((n) => numbersById.set(n.id, n));

    const senderSeenKeys = new Set();

    for (const report of senderRows) {
      const rr = normalizeMongoDoc(report);
      const rrReqId = rr.responseId || rr.messageId || "";
      if (rrReqId && webhookRequestIds.has(String(rrReqId))) continue;
      const dedupeKey = `${rr.uploadId || ""}-${rr.numberId || String(report._id)}`;
      if (senderSeenKeys.has(dedupeKey)) continue;
      senderSeenKeys.add(dedupeKey);

      const upload = rr.uploadId ? uploadsMap.get(Number(rr.uploadId)) : null;
      const number = rr.numberId ? numbersById.get(Number(rr.numberId)) : null;

      result.push({
        id: `sender-${rr.uploadId || "na"}-${rr.numberId || String(report._id)}`,
        eventType: "outbound",
        normalizedStatus: rr.deliveryStatus || rr.currentStatus || "sent",
        normalizedMobile: rr.mobile || number?.cleaned || "",
        customerNumber: rr.mobile || number?.cleaned || "",
        integratedNumber: rr.senderNumber || "",
        templateName: rr.templateName || "",
        campaignName: "",
        receivedAt: rr.sentAt || rr.updatedAt || rr.createdAt || "",
        requestedAt: rr.sentAt || "",
        requestId: rr.responseId || rr.messageId || "",
        matchedUploadId: rr.uploadId || null,
        matchedNumberId: rr.numberId || null,
        uploadFileName: upload?.fileName || "",
        uploadTemplateLabel: upload?.templateLabel || rr.templateLabel || "",
        numberCurrentStatus: number?.currentStatus || rr.currentStatus || "",
        numberDeliveryStatus: number?.deliveryStatus || rr.deliveryStatus || "",
        numberRetryCount: number?.retryCount || 0,
        sentMessage: rr.sentMessage || number?.sentMessage || "",
        text: rr.sentMessage || "",
        customReply: rr.customReply || number?.customReply || "",
        lastReplyAt: rr.lastReplyAt || number?.lastReplyAt || "",
        csvRowData: rr.csvRowData || number?.data || {},
        rawPayload: rr.responseDetails || rr.report || {},
        reason: "",
        updatedAt: rr.updatedAt || "",
      });
    }
  }

  return result.sort((a, b) => {
    const aTime = new Date(a.receivedAt || a.statusUpdatedAt || a.requestedAt || 0).getTime();
    const bTime = new Date(b.receivedAt || b.statusUpdatedAt || b.requestedAt || 0).getTime();
    return bTime - aTime;
  });
}

module.exports = { getCustomReportRows };
