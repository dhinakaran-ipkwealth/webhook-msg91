const pngToIco = require('png-to-ico');
const fs = require('fs');

(async () => {
  const buf = await pngToIco('logo512.png');
  fs.writeFileSync('webhook_msg91.ico', buf);
})();