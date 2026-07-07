# Deploying the MSG91 Webhook Backend to EC2 (crm.ipkwealth.com)

This is the 24/7 Express receiver that MSG91 calls with delivery reports and
inbound WhatsApp replies. It runs under PM2 on an Ubuntu EC2 instance, behind
Nginx, on `https://crm.ipkwealth.com`.

PM2 process name: **`webhook-msg91-backend`** (see `ecosystem.config.js`).
Expected deploy path: **`/home/ubuntu/webhook-msg91/backend`** (must match
`ecosystem.config.js`'s `cwd` and the log paths below, or edit both to match
your actual path).

---

## 1. One-time EC2 setup

```bash
# Node.js 20.x (matches package.json engines / express 5 requirement)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Nginx (reverse proxy / TLS termination)
sudo apt-get install -y nginx

# Certbot (Let's Encrypt, if crm.ipkwealth.com doesn't have a cert yet)
sudo apt-get install -y certbot python3-certbot-nginx

# Optional but recommended: Redis, for shared rate-limit/dedup state.
# Without it the app falls back to safe in-memory stores automatically.
sudo apt-get install -y redis-server
sudo systemctl enable --now redis-server
```

PM2 itself does **not** need a separate global install — it's a listed
dependency in `package.json` and is installed locally via `npm ci` (step 2).
All `npm run pm2:*` scripts below resolve to that local binary.

Create the log directory PM2 writes to (path comes from
`ecosystem.config.js`'s `out_file`/`error_file`):

```bash
mkdir -p /home/ubuntu/logs
```

## 2. Get the code onto the box

```bash
mkdir -p /home/ubuntu/webhook-msg91
# from your machine:
scp -i <key.pem> -r backend/ <user>@<host>:/home/ubuntu/webhook-msg91/backend
```

(Or `git clone`/`git pull` the repo on the box and point `cwd` in
`ecosystem.config.js` at wherever it lands, if you'd rather not `scp`.)

```bash
cd /home/ubuntu/webhook-msg91/backend
npm ci --omit=dev
```

## 3. Configure environment

The server's `.env` lives **only on the box** — it is not committed and does
not sync from your local copy. Create/edit it directly:

```bash
nano /home/ubuntu/webhook-msg91/backend/.env
```

Required / relevant keys (values are secrets — pull them from your password
manager or the previous EC2 `.env`, don't copy from a local dev `.env`
blindly):

| Var | Purpose |
| --- | --- |
| `DATABASE_URL` / `MONGODB_URI` | MongoDB Atlas connection string (required) |
| `MONGODB_DB_NAME` | Main CRM database (default `ipkwealth_crm_test`) |
| `MONGODB_WEBHOOK_DB_NAME` | Raw webhook event log DB (default `msg91_webhooks`) |
| `WEBHOOK_PUBLIC_BASE_URL` | `https://crm.ipkwealth.com` |
| `WEBHOOK_PORT` / `PORT` | `3002` (must match the Nginx `proxy_pass` below) |
| `WEBHOOK_HOST` | `0.0.0.0` |
| `MSG91_AUTH_KEY`, `MSG91_BASE_URL`, `MSG91_NAMESPACE_AGREEMENT`, `MSG91_NAMESPACE_SIGNED` | MSG91 API credentials |
| `RATE_LIMIT_ENABLED`, `WEBHOOK_RATE_LIMIT`, `API_RATE_LIMIT`, `AUTH_RATE_LIMIT`, `GRAPHQL_RATE_LIMIT` | Rate limiting (safe defaults if unset) |
| `REDIS_HOST`, `REDIS_PORT` | Shared rate-limit/dedup store (falls back to in-memory if unreachable) |
| `DEDUP_TTL_HOURS` | Webhook dedup TTL (default 24h) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | Email reports |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `AWS_S3_BUCKET_NAME` | S3 export |

If a new env var was introduced in a code change, add it here too — nothing
propagates automatically from the repo's local `.env`.

## 4. Nginx reverse proxy

Add the routes from [`../nginx-msg91-webhook.conf`](../nginx-msg91-webhook.conf)
inside the existing `crm.ipkwealth.com` server block (or `include` the file):

```nginx
location = /webhook       { proxy_pass http://127.0.0.1:3002/webhook; proxy_http_version 1.1;
                             proxy_set_header Host $host;
                             proxy_set_header X-Real-IP $remote_addr;
                             proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
                             proxy_set_header X-Forwarded-Proto $scheme; }
location ^~ /webhook/     { proxy_pass http://127.0.0.1:3002; proxy_http_version 1.1;
                             proxy_set_header Host $host;
                             proxy_set_header X-Real-IP $remote_addr;
                             proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
                             proxy_set_header X-Forwarded-Proto $scheme; }
location = /debug-webhook { proxy_pass http://127.0.0.1:3002/debug-webhook; proxy_http_version 1.1;
                             proxy_set_header Host $host;
                             proxy_set_header X-Real-IP $remote_addr;
                             proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
                             proxy_set_header X-Forwarded-Proto $scheme; }
location = /health        { proxy_pass http://127.0.0.1:3002/health; proxy_http_version 1.1;
                             proxy_set_header Host $host;
                             proxy_set_header X-Real-IP $remote_addr;
                             proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
                             proxy_set_header X-Forwarded-Proto $scheme; }
```

```bash
sudo nginx -t && sudo systemctl reload nginx

# If crm.ipkwealth.com has no TLS cert yet:
sudo certbot --nginx -d crm.ipkwealth.com
```

## 5. Start the app under PM2

```bash
cd /home/ubuntu/webhook-msg91/backend
npm run pm2:start     # runs `npm run build` (syntax check) then `pm2 start ecosystem.config.js --env production`
```

Make it survive reboots:

```bash
npm run pm2:startup   # prints a `sudo env PATH=... pm2 startup ...` command — copy/paste and run it once
npm run pm2:save      # persists the current process list so it's restored on boot
```

## 6. Verify

```bash
curl -s https://crm.ipkwealth.com/health
curl -s -X POST https://crm.ipkwealth.com/webhook \
  -H "Content-Type: application/json" \
  -d '{"customerNumber":"919363406313","integratedNumber":"919363406313","contentType":"text","text":"Hi test","messages":"[{\"text\":{\"body\":\"Hi test\"},\"type\":\"text\"}]","ts":"2026-05-29T10:00:00+05:30"}'
```

Expect `{"ok":true, "mongoConnected":true, ...}` from `/health` and
`{"received":true}` from `/webhook`. Then confirm the event landed in
`msg91_webhooks.whatsapp_webhook_events` (Compass), and check
`out_file`/`error_file` for a matching `"tag":"msg91-ack"` log line
confirming a 200 was actually returned to MSG91.

MSG91 dashboard webhook config (URL + event types + custom parameters) is
documented in [`../WEBHOOK_URLS_AND_SETUP.txt`](../WEBHOOK_URLS_AND_SETUP.txt) —
point it at `https://crm.ipkwealth.com/webhook`.

## 7. Day-to-day operations

```bash
npm run pm2:status    # is it up?
npm run pm2:logs      # tail stdout/stderr (also written to /home/ubuntu/logs/msg91-webhook-*.log)
npm run pm2:restart   # syntax-check + hard restart (brief downtime)
npm run pm2:reload    # syntax-check + zero-downtime reload (fork mode: acts like restart, still fast)
npm run pm2:stop      # stop without removing from PM2's process list
npm run pm2:delete    # remove entirely from PM2 (use before re-adding with a changed ecosystem.config.js)
```

## 8. Deploying a code update

```bash
# from your machine
scp -i <key.pem> webhook-server.js middleware/*.js lib/*.js \
  <user>@<host>:/home/ubuntu/webhook-msg91/backend/  # match subfolders as needed

# on the box
cd /home/ubuntu/webhook-msg91/backend
npm run pm2:restart   # build step catches syntax errors before PM2 (re)starts
```

If `package.json`/`package-lock.json` changed, run `npm ci --omit=dev` before
restarting. If new env vars were added, update `.env` first (step 3).

## 9. Troubleshooting

- `GET /health` fails or `mongoConnected: false` → check `DATABASE_URL`/`MONGODB_URI`
  in `.env` and Atlas IP allowlist (EC2's public IP must be allowed).
- MSG91 events aren't arriving → check the MSG91 dashboard webhook config
  (URL, enabled event types), not the app — the app itself always returns 200
  (see `msg91-ack` log lines) so a silent MSG91-side pause won't show as an
  app error.
- 502 from Nginx → the Node process is down; check `npm run pm2:status` and
  `npm run pm2:logs`.
- Duplicate/throttled webhooks → look for `"outcome":"duplicate"` or
  `"outcome":"throttled"` in the `msg91-ack` log lines; both are expected
  behavior (MSG91 retries), not bugs.
