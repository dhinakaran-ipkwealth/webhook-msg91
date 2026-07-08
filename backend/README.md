# MSG91 Webhook Processing Service

Single Express app that receives MSG91 WhatsApp Business API webhooks
(delivery reports + inbound replies) for **unlimited sender numbers**, running
on AWS EC2 under PM2, behind Nginx, at `https://crm.ipkwealth.com`.

Onboarding a new WhatsApp business number is a MongoDB document insert into
`sender_numbers` — **no code change, no redeploy.**

---

## Architecture

```
Internet
   │
   ▼
crm.ipkwealth.com
   │
   ▼
Nginx  (reverse proxy, TLS termination)
   │
   ▼
Express App (app.js)  — ONE process, ONE port (3002)
   │
   ▼
Router (routes/webhook.routes.js)
   │
   ▼
Sender Number Resolver (services/senderResolver.service.js)
   │  looks up sender_numbers collection — no sender ever hardcoded
   ▼
Department Controller (controllers/*.controller.js)
   │
   ▼
Core processing (services/msg91.service.js)
   │
   ├──▶ MongoDB   (whatsapp_webhook_events / *_logs / webhook_logs / sender reports)
   ├──▶ Redis     (rate limiting + dedup, optional — degrades to in-memory)
   └──▶ logs/YYYY-MM-DD.log  (file audit trail)
```

Only one Express server/process is ever started (`webhook-server.js` →
`app.js`). PM2 runs it in `fork` mode with a single instance (see
`ecosystem.config.js`).

---

## Folder structure

```
backend/
├── app.js                     Express app wiring (middleware + route mounting)
├── webhook-server.js          Process entrypoint: connects Mongo, ensures indexes, starts app.js
├── config/
│   └── env.js                 Centralised environment configuration
├── models/
│   ├── SenderNumber.js         sender_numbers collection (schema + queries)
│   └── WebhookLog.js           webhook_logs collection (audit trail)
├── services/
│   ├── mongo.service.js        MongoDB connection + collection/index helpers
│   ├── redis.service.js        Shared ioredis client (optional-load-safe)
│   ├── logger.service.js       File logs (logs/YYYY-MM-DD.log) + webhook_logs writes
│   ├── senderResolver.service.js  Resolves sender number → department/collection (cached)
│   └── msg91.service.js        Core normalize/store/dedup/reply-matching business logic
├── middlewares/
│   ├── request-logger.js       Structured request logging + in-process metrics
│   ├── rate-limit.js           Redis-backed rate limiting (per route category)
│   ├── webhook-dedup.js        Two-tier (Redis + Mongo) webhook deduplication
│   ├── signatureVerification.js  Opt-in MSG91 HMAC signature check
│   ├── ipWhitelist.js          Opt-in MSG91 IP allowlist
│   ├── errorHandler.js         Global error handler (always 200 on /webhook* routes)
│   └── asyncWrapper.js         Wraps async route handlers for the error handler
├── controllers/
│   ├── webhookBase.controller.js  Shared logic behind every controller below
│   ├── marketing.controller.js
│   ├── crm.controller.js
│   ├── support.controller.js
│   ├── events.controller.js
│   ├── rm.controller.js        Generic/catch-all controller (sender- or template-driven)
│   ├── health.controller.js
│   └── debug.controller.js
├── routes/
│   ├── webhook.routes.js       All three routing mechanisms + legacy compatibility
│   └── health.routes.js
├── utils/
│   ├── phone.js, hash.js, payload.js   Pure helpers (no I/O)
├── lib/
│   └── template-collections.js Per-template/sender collection naming (pre-existing, unchanged)
├── scripts/
│   ├── seed-sender-numbers.js  One-time seed of sender_numbers from known numbers
│   └── build.js                Syntax-checks every file before PM2 (re)starts
├── logs/                       logs/YYYY-MM-DD.log (JSON lines, one per webhook request)
└── ecosystem.config.js         PM2 process configuration
```

---

## Routing

All three routing mechanisms are supported simultaneously:

1. **`POST /webhook/msg91`** — sender read from `req.body.sender` (or the
   common MSG91 field aliases: `senderNumber`, `integratedNumber`, ...).
2. **`POST /webhook/msg91/:sender`** — sender read from the URL. If `:sender`
   isn't a number known to `sender_numbers`, it's treated as a legacy
   `templateName` (see "Backward compatibility" below) so existing MSG91
   dashboard configs keep working unchanged.
3. **Fixed department routes** — `POST /webhook/msg91/marketing`,
   `/crm`, `/support`, `/events`. Any `sender_numbers.department` value that
   isn't literally one of these four falls back to the generic `rm` bucket
   (`rm.controller.js`, `rm_logs` collection) — this is where RM-GENERAL,
   Operations, RM-1, RM-2, and every future relationship-manager number lands.

### Backward compatibility (pre-existing production routes — unchanged)

These routes existed before this refactor and are preserved exactly so
nothing already configured in the MSG91 dashboard breaks:

- `GET  /webhook` — MSG91's endpoint verification ping
- `POST /webhook` — original catch-all (if this is what MSG91 is currently
  configured to call, it keeps working)
- `POST /webhook/msg91/inbound`, `POST /webhook/msg91/outbound`
- `POST /webhook/msg91/:templateName/:uploadId` — campaign upload callback URL
- `POST /debug-webhook` — echoes the normalized view of any payload (testing aid)
- `GET /health`, `GET /metrics`

---

## `sender_numbers` collection

The single source of truth for onboarding a WhatsApp business number:

```js
{
  senderNumber:   "919566467239",   // digits only, unique
  department:     "RM-2",           // free-form label
  collectionName: "rm_logs",        // department-level log collection
  enabled:        true,
  label:          "919566467239-Bharath",   // optional, for humans
  ownerEmail:     "bharath@ipkwealth.com",  // optional
  createdAt:      ISODate(...),
  updatedAt:      ISODate(...),
}
```

**To add a new sender number: insert one document. No code change, no
redeploy.** `department` values of `marketing`/`crm`/`support`/`events`
(case-insensitive) route to that dedicated controller; anything else routes
to the generic `rm` controller/collection.

Seed the four numbers currently in `frontend/msg91.config.json`:

```bash
npm run seed:senders
```

Lookups are cached in-process for 30 seconds (`services/senderResolver.service.js`)
so high-volume traffic doesn't hit MongoDB on every request.

---

## MongoDB collections

| Collection | Purpose |
| --- | --- |
| `sender_numbers` | Sender → department/collection routing config (see above) |
| `webhook_logs` | One audit document per inbound HTTP request: timestamp, sender, receiver, event, payload, headers, response, status, processingTimeMs |
| `<collectionName>_logs` (e.g. `marketing_logs`, `rm_general_logs`, `operations_logs`) | Department-level, append-only copies of newly-processed events, one collection per distinct `sender_numbers.collectionName` (additive — does not replace the pipeline below). Each sender can share a collection with others in the same department or have its own; `scripts/seed-sender-numbers.js` creates and indexes every `collectionName` it references, and MongoDB auto-creates any new one lazily on first write regardless. |
| `whatsapp_webhook_events` (in `msg91_webhooks` DB, or per-template/sender collections) | The pre-existing, primary event store with dedup (`eventKey`/`stableKey` unique indexes) — this is what the reply-tracking dashboard reads |
| `whatsapp_sender_reports`, `whatsapp_numbers` | Pre-existing campaign send/report tracking, updated by inbound-reply and outbound-status reconciliation |
| `webhook_dedup` | TTL-expiring dedup markers (fallback tier when Redis is unavailable) |

The department-level `*_logs` collections are **additive** — introduced by
this refactor purely for the new department view — and never replace or
alter the existing `whatsapp_webhook_events` / sender-report-matching
pipeline that the CRM's campaign/reply dashboard depends on.

---

## Security

- **Rate limiting** (`middlewares/rate-limit.js`) — Redis-backed (falls back
  to in-memory), generous webhook limit (default 5000/min/IP) so MSG91 is
  never accidentally throttled into a retry storm; throttled webhook requests
  still get HTTP 200 (`{ received: true, throttled: true }`).
- **Deduplication** (`middlewares/webhook-dedup.js`) — two-tier (Redis, then
  Mongo), plus a third tier via the `eventKey` unique index in
  `whatsapp_webhook_events`.
- **Signature verification** (`middlewares/signatureVerification.js`) —
  **opt-in**, off by default. MSG91 does not currently have a signing secret
  configured for this deployment; set `MSG91_WEBHOOK_SECRET` (HMAC-SHA256
  over the raw body, header name configurable via
  `MSG91_WEBHOOK_SIGNATURE_HEADER`, default `x-msg91-signature`) to enable.
  **Do not enable this without confirming MSG91's actual signing scheme and
  secret** — an incorrect signature check will reject real MSG91 traffic,
  and MSG91 auto-pauses webhooks that return non-2xx.
- **IP whitelist** (`middlewares/ipWhitelist.js`) — **opt-in**, off by
  default. Set `MSG91_IP_WHITELIST` (comma-separated IPs) to enable. Same
  caveat as above: MSG91 doesn't publish a fixed IP range, so only enable
  this once you've confirmed the actual source IPs in your own traffic logs.
- **Body validation** — Content-Type is enforced by `express.json()`
  (malformed bodies are caught by `errorHandler.js`, which still returns 200
  on `/webhook*` routes so MSG91 never retries into a storm).
- **Error handling** — `middlewares/errorHandler.js` guarantees `/webhook*`
  and `/debug-webhook` routes always return HTTP 200, even on an unhandled
  exception, per MSG91's auto-pause-on-non-2xx behavior. Every other route
  returns a normal status code.

---

## Async processing

Every webhook handler acknowledges MSG91 with HTTP 200 **immediately**, then
processes the payload in the background
(`services/msg91.service.js#processWebhookAfterAck`, fire-and-forget with
its own error handling — a processing failure is logged, never thrown back
into the request). No external queue (e.g. BullMQ) is used: this pattern was
already running in production and needs no new infrastructure to operate.

---

## Health check

`GET /health` returns:

```json
{
  "ok": true,
  "service": "crm-msg91-webhook",
  "uptimeSeconds": 1234,
  "node": { "version": "v20.x.x", "pid": 1234 },
  "memory": { "rssMb": 53, "heapUsedMb": 15, "heapTotalMb": 17, "systemFreeMb": 6273, "systemTotalMb": 15984 },
  "cpu": { "cores": 8, "model": "...", "loadavg": { "1m": 0, "5m": 0, "15m": 0 } },
  "mongoConnected": true,
  "redisConnected": true,
  "pm2": { "managed": true, "pm_id": 0, "instance": "0", "exec_mode": "fork_mode" },
  "rateLimit": { "enabled": true, "redisConnected": true, "store": "redis", "limits": { ... } }
}
```

`GET /metrics` returns request/endpoint/status counters from
`middlewares/request-logger.js`.

---

## Running locally before deploying to EC2

```bash
npm install
npm run dev:local     # http://127.0.0.1:3099, auto-restarts on file changes
```

`dev:local` (`scripts/dev-local.js`) defaults `PORT` to `3099` — it doesn't
touch `.env`, `ecosystem.config.js`, or `webhook-server.js`. This matters on
a dev machine that also runs the `frontend/` Electron app: that app's own
embedded test server also binds to port 3002 (`frontend/.env`'s
`WEBHOOK_PORT`), so running the backend locally on the *same* port would
conflict with it. On EC2 they never collide (Electron runs on staff PCs,
this backend runs on the server), so production still uses `PORT=3002` via
`ecosystem.config.js` / `.env` unchanged.

`npm run dev` (no `:local`) still runs on the real `.env` port (3002) — use
that instead if the Electron app isn't running locally, e.g. to test the
exact prod-like configuration before deploying.

Smoke test once it's up:

```bash
curl http://127.0.0.1:3099/health
curl http://127.0.0.1:3099/webhook
curl -X POST http://127.0.0.1:3099/webhook/msg91/marketing -H "Content-Type: application/json" -d '{"sender":"919363406313","customerNumber":"919000000000","text":"test"}'
```

Once verified, deploy per [`DEPLOY.md`](./DEPLOY.md).

## Deployment / PM2 / Nginx

No changes needed beyond what's already documented in
[`DEPLOY.md`](./DEPLOY.md) and [`../nginx-msg91-webhook.conf`](../nginx-msg91-webhook.conf) —
the app still listens on port 3002, PM2 process name and entrypoint
(`webhook-server.js`) are unchanged, and Nginx's existing
`location ^~ /webhook/` catch-all already forwards every new route.

`ecosystem.config.js` already sets `watch: false`, `autorestart: true`,
`max_memory_restart`, `time: true`, `merge_logs: true`, `log_date_format`,
and explicit `error_file`/`out_file` paths.

## Environment variables

See `config/env.js` for the full list with defaults. New in this refactor:

| Var | Default | Purpose |
| --- | --- | --- |
| `MSG91_WEBHOOK_SECRET` | unset (disabled) | Enable HMAC signature verification |
| `MSG91_WEBHOOK_SIGNATURE_HEADER` | `x-msg91-signature` | Header name carrying the signature |
| `MSG91_IP_WHITELIST` | unset (disabled) | Comma-separated allowed source IPs |
| `LOG_DIR` | `logs` | Directory for `logs/YYYY-MM-DD.log` |

All previously-existing variables (`DATABASE_URL`, `MONGODB_DB_NAME`,
`REDIS_HOST`, `WEBHOOK_RATE_LIMIT`, etc.) are unchanged.
