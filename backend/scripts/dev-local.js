"use strict";

/**
 * Local development entrypoint.
 *
 * The production port (3002, from .env WEBHOOK_PORT) is also what the
 * frontend/ Electron app's own embedded test server binds to on this same
 * machine — they never coexist on EC2 (Electron runs on staff PCs, this
 * backend runs on the server), but running both locally at once needs a
 * different port. This defaults PORT to 3099 for local runs only; it never
 * touches .env or ecosystem.config.js, so EC2 deployment is unaffected.
 *
 * Usage:  npm run dev:local
 */

process.env.PORT = "3099";
process.env.WEBHOOK_HOST =  "127.0.0.1";

require("../webhook-server.js");
