# MSG91 Responses → UI: Complete Reference

This document explains, end to end, how a raw MSG91 webhook response becomes
something you see on screen in this app — what MSG91 actually sends, how the
code interprets it, which database fields it updates, and exactly what each
page/card/column in the UI shows and where its number comes from.

It is written to be readable by anyone (ops, compliance, a new developer) —
no prior familiarity with the codebase assumed. For deployment/ops procedures
(EC2, PM2, env vars), see [`PROJECT_GUIDE.md`](PROJECT_GUIDE.md) — this
document focuses on the **data**, not the infrastructure.

---

## 1. The big picture

```
MSG91 (WhatsApp Business API)
   │  POSTs a webhook every time something happens to a message:
   │  message sent / delivered / read / failed, or the customer replies
   ▼
EC2 webhook receiver  (webhook-server.js, PM2 service "crm-msg91-webhook")
   │  1. normalizeWebhookItem() — turns MSG91's raw JSON into a consistent shape
   │  2. storeWebhook()         — dedupes and saves it as an audit-trail event
   │  3. applyOutboundStatusToReports() / applyInboundReplyToReports()
   │       — finds the matching "sent message" row and updates its status/reply
   │  4. notifyElectronApp()    — pings the desktop app so the UI refreshes
   ▼
MongoDB Atlas (two databases)
   │  ipkwealth_crm_test   → whatsapp_sender_reports, whatsapp_numbers, whatsapp_uploads
   │  msg91_webhooks       → whatsapp_webhook_events (raw audit trail of every webhook)
   ▼
Electron app  (main_mongodb_no_report_sync.js = main process, renderer.js = UI logic)
   │  Reads the above collections via IPC handlers (fetch-custom-report, etc.)
   ▼
index_modern_saas_complete.html  — 4 pages: Dashboard, Upload & Send,
                                    Delivery Report, Webhook Report
```

Two independent things happen to every MSG91 webhook: it is (a) logged
verbatim as an audit-trail event, and (b) used to update the status of the
one "sent message" row it belongs to. The UI mostly reads from (b); the
Webhook Report page and "View JSON" buttons expose (a).

---

## 2. Part A — What MSG91 actually sends

MSG91 calls **one webhook URL** (`https://crm.ipkwealth.com/webhook`, handled
by `webhook-server.js`) for eight different event types, configured on the
MSG91 dashboard (see [`WEBHOOK_URLS_AND_SETUP.txt`](WEBHOOK_URLS_AND_SETUP.txt)):

| MSG91 event type | What triggered it |
| --- | --- |
| On Send Event | We successfully handed the message to MSG91 |
| On Outbound Report Received | Generic delivery-report callback |
| On Delivered Event | WhatsApp confirms the message reached the device |
| On Read Event | WhatsApp confirms the customer opened/read it (blue tick) |
| On Failed Event | Message could not be delivered |
| On Inbound Request Received / On Inbound Report Received | The customer sent a message/reply |
| On URL Click Event | The customer tapped a link inside the template |

All eight land as **JSON POST bodies** on the same endpoint. There is no
single fixed schema — MSG91 sends different fields depending on the event —
so the app treats every payload as "best effort" and pulls out whatever
fields are present. The fields MSG91 is configured to include (per
`WEBHOOK_URLS_AND_SETUP.txt`) are:

```
customerNumber, integratedNumber, direction, eventName, requestId, uuid,
replyMsgId, contentType, text, button, interactive, reaction, messages,
contacts, caption, filename, url, templateName, templateLanguage, reason,
ts, statusCode, statusUpdatedAt, price, webhookType
```

### Example — inbound customer reply (plain text)

```json
{
  "customerNumber": "919363406313",
  "integratedNumber": "919363406313",
  "contentType": "text",
  "text": "Hi test",
  "messages": "[{\"text\":{\"body\":\"Hi test\"},\"type\":\"text\"}]",
  "ts": "2026-05-29T10:00:00+05:30"
}
```

### Example shape — outbound delivery-status report

MSG91 sends a status word in one of several possible fields depending on the
event (`eventName`, `statusCode`, `reason`, `status`, or `delivery_status`) —
the app checks all of them (see §3.2):

```json
{
  "requestId": "b6b0...-uuid",
  "customerNumber": "919363406313",
  "integratedNumber": "919xxxxxxxxx",
  "eventName": "delivered",
  "statusUpdatedAt": "2026-05-29T10:01:12+05:30",
  "templateName": "order_alert",
  "price": "0.55"
}
```

**Key distinction used everywhere downstream:** every payload is either
**outbound** (a status update about a message *we* sent) or **inbound** (a
message the *customer* sent *to* us — a reply). The rest of this document
treats those as two separate tracks because the app processes and displays
them differently.

---

## 3. Part B — Normalizing the raw payload

Raw MSG91 payloads are inconsistent (different field names for the same
concept, sometimes stringified JSON inside JSON). `normalizeWebhookItem()`
in `webhook-server.js:362` converts every payload into one consistent shape
before anything else touches it.

### 3.1 Step 1 — Is this inbound or outbound? (`inferEventType`, `webhook-server.js:111`)

Checked in this order, first match wins:

1. `direction` field: `"0"` → inbound, `"1"` → outbound.
2. `webhookType`/`eventType` field containing "inbound"/"incoming" → inbound;
   containing "outbound"/"report" → outbound.
3. **Content heuristic** — if the payload has any of `replyMsgId`,
   `customerName`, `text`, `button`, `interactive`, `reaction`, `contacts`,
   `messages`, `caption`, `url`/`clickedUrl`, or a recognized `messageType`
   (text/button/interactive/reaction/image/document/audio/video/url/flow) →
   **inbound**. This is the main fallback, because MSG91 doesn't always send
   an explicit direction flag.
4. Otherwise → **outbound** (default).

### 3.2 Step 2 — What's the delivery status? (`createStatusLabel`, `webhook-server.js:77`)

The raw status text (from whichever field MSG91 populated) is lower-cased
and mapped:

| Raw text contains / equals | Normalized status |
| --- | --- |
| `"deny"` / `"denied"` | `failed` |
| `"read"` | `delivered` |
| contains `"deliver"` | `delivered` |
| contains `"fail"`, `"undel"`, or `"reject"` | `failed` |
| contains `"sent"` or `"submit"` | `sent` |
| anything else / blank | `reporting` (unrecognized — treated as still in-flight) |
| *(event is inbound)* | `inbound` — status labels above don't apply; a reply is a reply |

This mapping is intentionally forgiving (`.includes()`, not exact match)
because MSG91 doesn't use one fixed vocabulary across all event types.

### 3.3 Step 3 — Extracting message text (inbound only)

Customer replies can arrive as plain text, a button tap, an interactive
list/flow reply, a reaction emoji, or a media caption. `extractMessageText`
checks, in order: `text` → `content` → `button` → `interactive` →
`messages[]` → `caption` → `reaction` → clicked URL. Whichever is present
first becomes the reply's display text.

### 3.4 Step 4 — Correlation ID (`getMsg91CorrelationId`, `webhook-server.js:265`)

This is the ID used to match a webhook back to the specific message it's
about — critical because a customer might have received several different
messages, and a reply/status must attach to the *right* one, not just "the
latest message to this phone number." Checked in order: `replyMsgId` (for
inbound, this is the WhatsApp message ID being replied to) → message context
ID inside `messages[]` → `messageId`/`uuid`/`id` → `requestId`.

### 3.5 Step 5 — Dedup keys

MSG91 can call the same webhook more than once for the same event (retries).
Two keys prevent double-processing:

- **`eventKey`** — SHA-256 hash of event type + mobile + integrated number +
  correlation ID + reply ID + status text + message text. Exact-duplicate
  guard.
- **`stableKey`** (inbound only) — same idea but *excludes* MSG91's uuid/
  timestamp, so a retried webhook with a new uuid but identical content
  (same mobile, same reply text, same replyMsgId) is still recognized as the
  same event.

### 3.6 The normalized shape

After normalization, every event — regardless of what MSG91 originally sent —
looks like this (stored in `whatsapp_webhook_events`):

| Field | Meaning |
| --- | --- |
| `eventType` | `"inbound"` or `"outbound"` |
| `normalizedStatus` | `sent` / `delivered` / `failed` / `reporting` / `inbound` |
| `normalizedMobile` | Customer's phone number, cleaned to `91XXXXXXXXXX` format |
| `text` | Extracted reply text (inbound) or `null` |
| `requestId` | Correlation ID used for matching |
| `templateName`, `uploadId` | Which campaign/upload this belongs to, if known |
| `customerNumber`, `integratedNumber` | Raw customer / sender WhatsApp numbers |
| `eventKey`, `stableKey` | Dedup keys (§3.5) |
| `rawPayload` | The **original, untouched** MSG91 JSON — always kept for audit/debug |
| `receivedAt` | When this event arrived |

---

## 4. Part C — Updating the database

Once normalized, an event is applied to the one sent-message row it belongs
to. This is where the customer-facing "status" actually gets set.

### 4.1 Outbound status → `applyOutboundStatusToReports` (`webhook-server.js:757`)

Finds the matching row in `whatsapp_sender_reports`, tried **in this order**
until one matches:

1. **By correlation ID** — `responseId` or `messageId` equals the event's `requestId`. Most reliable.
2. **By content match** (`findSenderReportByWebhookContent`) — if MSG91 echoed
   back template content, score candidate rows by how many content values
   they share; only accept a match with score ≥ 2.
3. **By mobile number** — most recent sent row to that number, as a last resort.

On match, it sets `currentStatus` / `deliveryStatus` on that row (and the
mirrored row in `whatsapp_numbers`) to the normalized status
(`sent`/`delivered`/`failed`/`reporting`).

### 4.2 Inbound reply → `applyInboundReplyToReports` (`webhook-server.js:611`)

Finds the matching row, tried **in this order**:

1. **By `replyMsgId`** (the WhatsApp message the customer replied to) →
   matched against `responseId`/`messageId`. Preferred because it pins the
   reply to the *exact* message, even if the customer received several
   different messages.
2. **By mobile number fallback** — most recent un-replied sent row to that
   mobile (optionally narrowed by `uploadId`/`templateName` if known).

On match, it sets on that row: `currentStatus: "replied"`, `customReply`
(the extracted text), `lastReplyAt` (timestamp). **Note:** this does *not*
touch or require `deliveryStatus` — a reply can be recorded even if the
row's delivery status is still `sent`/unknown. (See §7 "Known gotchas" for
why this matters.)

### 4.3 Where each event type ends up

| Event | `msg91_webhooks.whatsapp_webhook_events` (raw audit log) | `ipkwealth_crm_test.whatsapp_sender_reports` / `whatsapp_numbers` (drives the UI) |
| --- | --- | --- |
| Outbound status | Always logged | `currentStatus`/`deliveryStatus` updated if a match is found |
| Inbound reply | Always logged | `customReply`/`lastReplyAt`/`currentStatus: "replied"` updated if a match is found |

If no matching sent row is found (e.g. a reply from a number that was never
sent a campaign message), the event is still logged in the raw audit trail
but nothing is updated in the CRM tables — it simply won't show up as a
"reply" anywhere in the UI counts.

---

## 5. Part D — The 4 UI pages

The app (`index_modern_saas_complete.html`, driven by `renderer.js`) has a
sidebar with four pages:

### 5.1 Dashboard (`tab-dashboard`)

**Purpose:** quick daily operational snapshot + the uploads log.

- **Top summary line** — "Today: N messages sent across M template(s).
  Responses received: R." Computed by an aggregation
  (`fetch-sender-stats` IPC, `main_mongodb_no_report_sync.js:4729`) over
  `whatsapp_sender_reports` for the current IST business day (10:00 AM to
  10:00 AM, matching how the scheduled report window works).
- **Uploads table** — one row per CSV upload batch: file name, total/valid/
  invalid counts, delivered/failed counts, template, sender, sent time, and
  actions (Select → jump to Delivery Report for that batch; Export PDF;
  Retry Failed for rows that failed).

### 5.2 Upload & Send (`tab-upload`)

**Purpose:** import a CSV/XLSX of recipients and send a WhatsApp template
campaign via MSG91.

- Import file → preview + validation (splits numbers into valid/invalid,
  and Indian vs foreign batches — kept separate because it makes tracing
  webhook replies by upload easier).
- Pick sender number + template, map template variables to CSV columns.
- **Send Messages** — calls the MSG91 API once per recipient, and writes a
  row per recipient to `whatsapp_sender_reports`/`whatsapp_numbers` with
  `currentStatus: "sent"` and the MSG91 request ID (`responseId`/
  `messageId`) that later webhooks will match against (§4.1–4.2).

### 5.3 Delivery Report (`tab-delivery`)

**Purpose:** delivery/reply status for **one selected upload batch** —
the "did this specific campaign land?" view.

Table columns and their source:

| Column | Source |
| --- | --- |
| Mobile | `row.cleaned` / `row.original` |
| Template | `getTemplateLabelForReport()` — template name, or campaign name, or "No Template" |
| Sent Message | `row.sentMessage`, or reconstructed from CSV fields (Stock Name, Client Name, Price, etc.) |
| Delivery | `row.deliveryStatus`/`currentStatus`, color-coded (green=delivered/read/success, red=failed/undelivered, blue=sent/submitted, grey=pending) |
| Customer Reply | `formatReplyHistoryHtml()` — the extracted reply text(s) for this row |
| Reply Time | `getReplyTime()` — `lastReplyAt`, or latest entry in `replyHistory` |
| Request ID | `row.responseId` — the MSG91 correlation ID (§3.4) |

Data is read from `whatsapp_sender_reports`/`whatsapp_numbers` for the
selected upload only — nothing here comes from the raw webhook audit log
directly.

### 5.4 Webhook Report (`tab-webhook`)

**Purpose:** the audit/compliance view — every tracked communication event
across *all* uploads (or a selected one), with filters, summary cards, and
full raw-payload drill-down. This is the page most relevant for SEBI /
management-style reporting.

**Filters available:** scope (all transactions vs. one selected upload),
sender number, template, date range (day/yesterday/week/month/custom),
event type (outbound/inbound), status, and free-text search across mobile/
request ID/reply text.

Rows come from `fetch-custom-report` (`main_mongodb_no_report_sync.js:4723`
→ `getCustomReportRows`), which reads `whatsapp_sender_reports` (all
transactions) or a per-upload view, decorated with `rawPayload`/`csvRowData`
for the JSON drill-down.

#### Summary cards

Computed client-side in `renderCustomSummary()` (`renderer.js:2207`) from
the currently filtered rows. **Inbound rows (customer replies) are excluded
from the outbound status buckets**, so the three status cards always add up
exactly to the total:

| Card | What it counts | Formula |
| --- | --- | --- |
| **Total Communication Events** | Every dispatched (outbound) message in the current filter/date view. Excludes inbound replies — they're a separate signal, not a delivery-status bucket. | `outboundRows.length` |
| **Investors Communicated To** | Distinct investor mobile numbers among the outbound rows above. | `unique(outboundRows.mobile)` |
| **Successfully Delivered to Investor** | Outbound rows MSG91 confirmed as delivered, read, or success. | `outboundRows` where status matches `deliver`/`read`/`success` |
| **Investor Acknowledgements** | Rows with inbound reply evidence — either the row itself is an inbound event, or a matched outbound row has `customReply`/`lastReplyAt` set. | `rows` where `eventType === "inbound"` OR `customReply`/`lastReplyAt` present |
| **Pending Delivery Confirmation** | Outbound rows not yet confirmed delivered or failed (covers `sent`, blank, or any other in-flight status). | `outboundRows.length − delivered − failed` |
| **Delivery Failed – Action Required** | Outbound rows MSG91 reported failed, rejected, denied, or undelivered. | `outboundRows` where status matches `fail`/`deny`/`rejected`/`undelivered`/`error` |

**Reconciliation guarantee:** Total Communication Events = Successfully
Delivered + Pending Delivery Confirmation + Delivery Failed, always — Pending
is computed as the remainder rather than matched against a fixed list of
status words, so no outbound row can silently fall outside all three
buckets. Investor Acknowledgements is a *separate* axis (customer
engagement, not delivery status) and is not part of that sum by design —
see §7 for why a reply can exist even when delivery isn't confirmed.

#### Table columns

| Column | Source function / field |
| --- | --- |
| Date & Time | `row.receivedAt` / `statusUpdatedAt` / `requestedAt` |
| Customer Name | `getCustomerName()` — `row.customerName` or a CSV column (Customer Name / Client Name / Name) |
| Customer Mobile | `row.normalizedMobile` / `customerNumber` |
| Sent From | `row.integratedNumber`, mapped to a friendly label via `msg91.config.json` |
| Delivery Status | `buildDeliveryStatusHtml()` — stacked "Sent at… / Delivered at… / Customer replied at…" lines |
| Message | `buildMessageSummaryHtml()` — "Sent: …" / "Received: …" pair |
| Type | `Sent record` (outbound) or `Reply event` (inbound), from `eventType` |
| Status | `getFriendlyStatus()` — badge: **Customer replied** > delivered/failed/sent priority (a reply outranks the raw delivery status in the badge shown) |
| Matched Status | `getMatchedMessageStatus()` — the raw matched `whatsapp_numbers` status, for cross-checking |
| Upload | `row.uploadFileName` |
| Reply Time | `getReplyTime()` |
| Template | `row.templateName` / `campaignName` |
| Dynamic Response | Flattened key/value dump of the raw MSG91 payload (`getDynamicResponse()`), or a "View JSON" button when the payload is complex |
| Reason | `row.reason` / `cleverTapErrorReason` — MSG91's failure/decline reason, if any |

The **View JSON** button (and the "Payload JSON" modal) shows `rawPayload`
verbatim — the *exact*, unmodified JSON MSG91 sent, for audit purposes.

---

## 6. Part E — Known edge cases worth understanding

**"Successfully Delivered" shows 0 but there's a reply — how?**
A WhatsApp delivery/read receipt (the `delivered`/`read` webhook) and an
inbound reply are two *independent* callbacks from MSG91. The reply is
reliably sent the moment the customer responds; the delivery/read receipt
is a separate, best-effort callback that can be delayed, skipped, or never
arrive (WhatsApp Business API does not guarantee DLR/read-receipt delivery
the way it guarantees the inbound message itself). So a row can sit at
`sent`/`Pending` indefinitely while still having a reply — the reply is, if
anything, *stronger* evidence of delivery than the missing receipt. See
`applyInboundReplyToReports` (§4.2): it records a reply with no check on the
row's current delivery status.

**Inbound and outbound rows can be filtered out of sync.**
Each row is date-filtered by its own timestamp — an outbound "sent" event's
timestamp vs. an inbound reply's `receivedAt` are different fields on
different documents. If a message was sent just outside the selected date
range but the reply landed inside it, you can see a reply with no matching
sent row in that specific filtered view (the sent row still exists in
Mongo, just outside the window).

**Test messages are silently dropped.**
`shouldIgnoreItem()` (`webhook-server.js:455`) drops the exact texts
`"test"`, `"test reply"`, `"curl test"` from number `919363406313` unless
`IGNORE_TEST_WEBHOOKS=false` is set — a deliberate filter to keep internal
test pings out of production reports.

**"Reporting" status.**
If MSG91 sends a status word the app doesn't recognize (§3.2), it's labeled
`reporting` rather than guessed into `sent`/`delivered`/`failed`. These rows
count toward **Pending Delivery Confirmation** (since Pending = total minus
confirmed-delivered minus confirmed-failed), not toward Delivered or Failed.

---

## 7. Quick file index

| Concern | File |
| --- | --- |
| MSG91 payload normalization, matching, dedup (EC2, source of truth) | `webhook-server.js` |
| Deployed copy of the above (must stay byte-identical) | `webhoo-server-ec2.js` |
| Electron main process: IPC handlers, Mongo queries, PDF/email export | `main_mongodb_no_report_sync.js` |
| UI rendering logic (tables, summary cards, filters) | `renderer.js` |
| Page markup/layout | `index_modern_saas_complete.html` |
| IPC channel whitelist | `preload.js` |
| MSG91 webhook URL + required custom parameters | `WEBHOOK_URLS_AND_SETUP.txt` |
| Sender numbers / template config | `msg91.config.json` |
| Architecture, databases, deployment procedures | `PROJECT_GUIDE.md` |
