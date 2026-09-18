const fs = require('fs');
const { execSync } = require('child_process');
const lines = fs.readFileSync('docker-compose.yml','utf8').split(/\r?\n/);
const start = lines.findIndex(l => /^\s*knowledge-mcp:/.test(l));
console.log(lines.slice(start, start+55).join('\n'));
console.log('\n==== openwikiRefresh snippets ====');
const ow = fs.readFileSync('integrations/knowledge-mcp/src/adapters/openwikiRefresh.js','utf8');
for (const line of ow.split(/\n/)) {
  if (/jobsRoot|writeJson|Map\(|memory|postgres|advisory|STATUS/.test(line)) console.log(line.trim());
}
console.log('\n==== openclaw plugins ====');
try {
  const out = execSync('docker exec mind-map-openclaw-gateway-1 cat /home/node/.openclaw/openclaw.json', {encoding:'utf8', maxBuffer: 5*1024*1024});
  const j = JSON.parse(out);
  console.log(JSON.stringify({
    allow: j.plugins && j.plugins.allow,
    slots: j.plugins && j.plugins.slots,
    mcp: Object.keys((j.mcp && j.mcp.servers) || {})
  }, null, 2));
} catch (e) { console.error(String(e.message||e)); }
console.log('\n==== openclaw package version ====');
try {
  console.log(execSync('docker exec mind-map-openclaw-gateway-1 cat /app/package.json', {encoding:'utf8'}).split(/\n/).slice(0,8).join('\n'));
} catch (e) { console.error(String(e.message||e)); }
