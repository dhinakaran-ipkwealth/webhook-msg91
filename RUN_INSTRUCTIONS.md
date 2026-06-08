# Running the webhook-server and Electron application

## Prerequisites
- Node.js (recommend v16+ / v18+)
- MongoDB instance (connection URI)
- Clone repository and install deps:

```bash
git clone <repo-url>
cd webhook-msg91
npm install
```

## Environment
Create a `.env` file at the project root (or export env vars) with at least:

```
DATABASE_URL=mongodb://localhost:27017
MONGODB_DB_NAME=your_db_name
WEBHOOK_PORT=3002
```

Optional environment vars used by Electron (email/sftp/export):
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`
- `ADMIN_EMAILS_TO`, `EXPORT_FOLDER`, `DISABLE_EMAIL_DELIVERY`

The Electron main process will read `.env` (if present) on startup.

## Run the webhook server (development)
This starts the Express webhook service (main entry: `src/framework/server.js`).

```bash
# ensure env is set
npm start
# or explicitly
node src/framework/server.js
```

The server listens on `http://${WEBHOOK_HOST || 0.0.0.0}:${WEBHOOK_PORT || 3002}/webhook`.

## Run the Electron application (development)
You can run the Electron app using `npx` (no global install):

```bash
npx electron .
```

If you prefer an npm script, add to `package.json`:

```json
"scripts": {
  "start": "node src/framework/server.js",
  "electron": "electron .",
  "test": "node test/run-tests.js"
}
```

Then run:

```bash
npm run electron
```

Notes:
- Electron `main_mongodb_no_report_sync.js` loads `.env` (if found) and will fall back when `MONGODB_URI` is not provided, but many features (DB reads/writes, report exports) require a working MongoDB connection.
- The repo contains both a server entrypoint (`src/framework/server.js`) and an Electron main (`main_mongodb_no_report_sync.js`). Use whichever matches your deployment.
- Logs are printed to the console; enable/inspect `.env` values when troubleshooting connectivity issues.

## Quick troubleshooting
- If the server fails to connect to MongoDB, verify `DATABASE_URL` or `MONGODB_URI` and `MONGODB_DB_NAME`.
- Use `npm run test` to run the lightweight unit tests: `node test/run-tests.js`.
