const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
function walk(dir, base = dir, out = {}) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const rel = path.relative(base, p).replace(/\\/g, '/');
    if (e.isDirectory()) walk(p, base, out);
    else {
      const buf = fs.readFileSync(p);
      out[rel] = crypto.createHash('sha256').update(buf).digest('hex');
    }
  }
  return out;
}
const rooms = ['ow-p2a-room-a', 'ow-p2a-room-b'];
const result = {};
for (const r of rooms) {
  result[r] = walk(path.join('knowledge', r));
}
fs.mkdirSync('integrations/openwiki/phase2a/artifacts', { recursive: true });
fs.writeFileSync('integrations/openwiki/phase2a/artifacts/canonical-hash-pre-ingest.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
