# MSG91 Webhook Test Examples

Local development:

```bash
curl -i -X POST http://127.0.0.1:3099/webhook/msg91 \
  -H "Content-Type: application/json" \
  --data-binary @backend/tests/mock-msg91-payload.json
```

Production:

```bash
curl -i -X POST https://crm.ipkwealth.com/webhook/msg91 \
  -H "Content-Type: application/json" \
  --data-binary @backend/tests/mock-msg91-payload.json
```

With optional shared secret:

```bash
curl -i -X POST https://crm.ipkwealth.com/webhook/msg91/callback \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: <WEBHOOK_SECRET>" \
  --data-binary @backend/tests/mock-msg91-payload.json
```

Expected accepted response:

```json
{
  "received": true
}
```

Explicit authentication failure, only when a webhook secret, signature secret,
or IP whitelist is configured:

```json
{
  "success": false,
  "error": "Webhook authentication failed"
}
```
