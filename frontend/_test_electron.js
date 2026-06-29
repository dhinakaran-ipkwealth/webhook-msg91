const e = require("electron"); console.log(typeof e, Object.keys(e).join(",").slice(0,100)); if(e.app) e.app.whenReady().then(()=>process.exit(0)); else process.exit(1);
