# Webhook MSG91 CRM — Project Guide

This document is a reference for making future changes (UI or server-side) to this
project. Keep it updated whenever the architecture, databases, or deployment process
changes.

## 1. What this project is

An Electron desktop CRM app (used by IPK Wealth ops/sales) that:

- Uploads CSVs of clients/orders and sends WhatsApp template messages via **MSG91**.
- Tracks delivery status (sent / delivered / read / failed) and **customer replies**
  for each message.
- Displays everything in a "Delivery Report" UI inside the Electron app.

A small **always-on Node/Express webhook receiver** runs on an EC2 box (under PM2) to
receive MSG91 callbacks (delivery reports + inbound customer replies) even when the
Electron app/desktop is closed.

## 2. Repo layout (key files)

| File | Role |
| --- | --- |
| `main_mongodb_no_report_sync.js` | Electron **main process**. Mongo access, IPC handlers, MSG91 send logic, report queries. This is `package.json`'s `main`. |
| `renderer.js` | Electron **renderer**. Builds/refreshes the Delivery Report table, counters, reply column, etc. |
| `index_modern_saas_complete.html` | The UI markup/layout (Delivery Report screen, upload screen, etc.). |
| `preload.js` | contextBridge between renderer and main process (IPC channel whitelist). |
| `styles.css` | UI styling. |
| `webhook-server.js` | Source-of-truth for the **EC2 webhook receiver** (Express app). |
| `webhoo-server-ec2.js` | **Deployed copy** of `webhook-server.js` (yes, same content — typo'd filename, kept for historical/deploy reasons). Must be kept byte-identical to `webhook-server.js` whenever one changes. |
| `WEBHOOK_URLS_AND_SETUP.txt` | MSG91 dashboard webhook URL + required custom parameters. |
| `msg91.config.json` | MSG91 integrated numbers / template config used by the Electron app. |
| `.env` | Local secrets/config (gitignored). The EC2 server has its **own separate** `.env` — changes here do NOT auto-propagate. |

## 3. Databases & collections (MongoDB Atlas)

Cluster: `cluster0.12wsuda.mongodb.net` (Atlas). Two logical databases are used:

### `ipkwealth_crm_test` (`MONGODB_DB_NAME`, default)
Holds the CRM's working data — owned/written mainly by the Electron app:

- `whatsapp_uploads` — one doc per CSV upload batch.
- `whatsapp_numbers` — one doc per recipient row in an upload (status, replies, etc. — drives the UI table).
- `whatsapp_sender_reports` — one doc per sent WhatsApp message (status, `customReply`, `replyHistory`, matched via `responseId`/`messageId`).
- `whatsapp_counters` — sequence counters for `uploadId` / `numberId` / `eventId`.

### `msg91_webhooks` (`MONGODB_WEBHOOK_DB_NAME`, default `msg91_webhooks`)
**New as of 2026-06.** Holds the raw MSG91 webhook event log, separated for cleanliness:

- `whatsapp_webhook_events` — every inbound/outbound MSG91 webhook payload (raw + normalized), deduped via `eventKey` / `stableKey`.

> **Why split?** Keeps the high-volume raw webhook log out of the main CRM database
> (separate Compass connection: `msg91_webhooks` → `whatsapp_webhook_events`).
> Both `webhook-server.js`/`webhoo-server-ec2.js` (EC2) and
> `main_mongodb_no_report_sync.js` (Electron) connect to **both** databases:
> - `mongoDb` → `MONGODB_DB_NAME` (`ipkwealth_crm_test`) — sender reports, numbers, uploads, counters.
> - `webhookEventsDb` → `MONGODB_WEBHOOK_DB_NAME` (`msg91_webhooks`) — webhook event log only.
>
> **Important:** `whatsapp_sender_reports` / `whatsapp_numbers` updates (delivery
> status + `customReply`) still happen in `ipkwealth_crm_test` — that's what actually
> drives the Delivery Report counters and reply column. `whatsapp_webhook_events` is
> the raw audit trail used for the "Customer Reply" detail/history view and dedup.

## 4. Environment variables

Set in `.env` (local) **and** in the EC2 server's `.env` (separately, not version controlled):

| Var | Purpose | Default |
| --- | --- | --- |
| `MONGODB_URI` / `DATABASE_URL` | Atlas connection string | required |
| `MONGODB_DB_NAME` | Main CRM database | `ipkwealth_crm_test` |
| `MONGODB_WEBHOOK_DB_NAME` | Raw webhook event log database | `msg91_webhooks` |
| `WEBHOOK_PUBLIC_BASE_URL` | Public URL MSG91/Electron use for callbacks | `https://crm.ipkwealth.com` |
| `WEBHOOK_PORT` / `PORT` | Port for the Express webhook server | `3002` |
| `WEBHOOK_HOST` | Bind host | `0.0.0.0` |
| `MSG91_*` | MSG91 auth key / namespaces | — |
| `IGNORE_TEST_WEBHOOKS` | If `"false"`, disables the hardcoded test-reply ignore filter (`"test"`, `"test reply"`, `"curl test"` from `919363406313`) | unset (filter active) |
| `ELECTRON_NOTIFY_URL` | Where the EC2 server pings the Electron app after a new webhook event | `http://127.0.0.1:3002/notify` |
| AWS / SMTP / admin email vars | S3 export + email reports | — |

## 5. How a WhatsApp message round-trips

1. Electron app sends a template message via MSG91 API → writes a row to
   `ipkwealth_crm_test.whatsapp_sender_reports` and `whatsapp_numbers` with
   `responseId`/`messageId` = MSG91's request UUID, `currentStatus: "sent"`.
2. MSG91 dashboard is configured (see `WEBHOOK_URLS_AND_SETUP.txt`) to POST
   delivery/read/failed/inbound-reply events to
   `https://crm.ipkwealth.com/webhook` (handled by `webhook-server.js` on EC2, PM2
   service name **`crm-msg91-webhook`**).
3. `webhook-server.js`:
   - Normalizes the payload (`normalizeWebhookItem`).
   - Inserts/updates it in `msg91_webhooks.whatsapp_webhook_events` (dedup via
     `eventKey`/`stableKey`).
   - For **outbound** status events → updates `currentStatus`/`deliveryStatus` on the
     matching `whatsapp_sender_reports`/`whatsapp_numbers` doc (matched by
     `responseId`/`messageId`, in `ipkwealth_crm_test`).
   - For **inbound** replies → matches the reply to the right sent row (by
     `replyMsgId`/context id, falling back to oldest un-replied row for that mobile),
     sets `customReply`, `lastReplyAt`, `currentStatus: "replied"`, and pushes to
     `replyHistory` (in `ipkwealth_crm_test`).
   - Pings the local Electron app's `/notify` endpoint so the UI refreshes.
4. Electron app's Delivery Report (`renderer.js` + IPC handlers in
   `main_mongodb_no_report_sync.js`) reads `whatsapp_sender_reports` /
   `whatsapp_numbers` for status/reply, and `whatsapp_webhook_events`
   (`msg91_webhooks`) for raw reply text/history detail.

## 6. Making UI changes

- Layout/markup → `index_modern_saas_complete.html`
- Behavior/data binding/table rendering → `renderer.js`
- Styling → `styles.css`
- New IPC channels must be whitelisted in `preload.js` and handled in
  `main_mongodb_no_report_sync.js` (`ipcMain.handle(...)`).
- Test in the running Electron app (`npm run start`) — there's no separate web build.

## 7. Making server-side changes

Two different "servers" exist — know which one you're editing:

- **Electron main process** (`main_mongodb_no_report_sync.js`): runs locally on the
  user's machine. Handles CSV upload, MSG91 sending, Mongo reads for the UI, and runs
  a *local* webhook listener on `127.0.0.1:3002/webhook` (used as the `/notify`
  fire-and-forget callback target — see `notifyElectronApp`).
- **EC2 webhook receiver** (`webhook-server.js` / `webhoo-server-ec2.js`): runs
  24/7 on EC2 under PM2 as `crm-msg91-webhook`, listens on `0.0.0.0:3002`, and is the
  endpoint MSG91 actually calls (`https://crm.ipkwealth.com/webhook`).

**Rule:** any change to `webhook-server.js` must be mirrored into
`webhoo-server-ec2.js` (they should stay byte-identical) before deploying — see
`diff webhook-server.js webhoo-server-ec2.js` to confirm.

## 8. Deploying webhook-server changes to EC2

1. Edit `webhook-server.js`, mirror the diff into `webhoo-server-ec2.js`.
2. `node --check webhook-server.js && node --check webhoo-server-ec2.js` (syntax sanity check).
3. Copy the updated file to the EC2 server (replace `<host>`/`<user>`/`<key>` with
   real values once known):
   ```bash
   scp -i <key.pem> webhoo-server-ec2.js <user>@<host>:/path/to/app/webhoo-server-ec2.js
   ```
4. If new env vars were introduced (e.g. `MONGODB_WEBHOOK_DB_NAME`), add them to the
   server's `.env` too (it is **not** synced from the repo — edit it directly on the
   box, e.g. via `ssh ... "echo 'MONGODB_WEBHOOK_DB_NAME=msg91_webhooks' >> /path/to/app/.env"`).
5. Restart **only** the webhook PM2 service (do not touch other PM2 apps on the box):
   ```bash
   ssh -i <key.pem> <user>@<host> "pm2 restart crm-msg91-webhook"
   ```
6. Verify:
   ```bash
   curl -s https://crm.ipkwealth.com/health
   curl -s -X POST https://crm.ipkwealth.com/webhook -H "Content-Type: application/json" \
     -d '{"customerNumber":"919363406313","integratedNumber":"919363406313","contentType":"text","text":"Hi test","messages":"[{\"text\":{\"body\":\"Hi test\"},\"type\":\"text\"}]","ts":"<iso-ts>"}'
   ```
   Confirm the new event lands in `msg91_webhooks.whatsapp_webhook_events` (Compass).

> **EC2 access not yet on file** — host/user/key need to be confirmed before step 3-5
> can be automated. `~/.ssh/dhinadts.pem` exists locally and is a likely candidate key.

## 9. Diagnostics / troubleshooting tips

- `GET /health` on the webhook server → confirms it's up and Mongo-connected.
- `POST /debug-webhook` → echoes back how a payload normalizes (eventType, mobile,
  text, etc.) without applying it to reports. Safe for MSG91 test deliveries.
- If "Customer replies" / delivery counts are stuck at 0 for a recent upload, check
  `msg91_webhooks.whatsapp_webhook_events` sorted by `receivedAt desc` — if there's a
  gap since the upload's `sentAt`, MSG91 isn't calling the webhook (check the MSG91
  dashboard webhook config — URL, enabled event types — rather than the app code).
- Reply matching priority (`applyInboundReplyToReports`): `replyMsgId`/context id →
  `responseId`/`messageId` match → oldest un-replied row for that mobile (+ uploadId/
  templateName if present) → most recent row for that mobile.
- `IGNORE_TEST_WEBHOOKS` (default active) silently drops `"test"` / `"test reply"` /
  `"curl test"` replies from `919363406313` — don't be confused if test messages from
  that number don't show up.

## 10. Change log

- **2026-06-10**: Split `whatsapp_webhook_events` out of `ipkwealth_crm_test` into its
  own `msg91_webhooks` database (new `MONGODB_WEBHOOK_DB_NAME` env var, default
  `msg91_webhooks`). Updated `webhook-server.js`, `webhoo-server-ec2.js`, and
  `main_mongodb_no_report_sync.js`. **Pending**: deploy `webhoo-server-ec2.js` to EC2,
  update its `.env`, and `pm2 restart crm-msg91-webhook`.
