const fs = require('fs');
const { execSync } = require('child_process');
try {
  const out = execSync('docker exec mind-map-openclaw-gateway-1 cat /home/node/.openclaw/openclaw.json', { encoding: 'utf8', maxBuffer: 10*1024*1024 });
  const j = JSON.parse(out);
  const slots = (j.plugins && j.plugins.slots) || null;
  const allow = (j.plugins && j.plugins.allow) || null;
  const mcp = Object.keys(((j.mcp && j.mcp.servers) || {}));
  console.log(JSON.stringify({ slots, allow, mcpServers: mcp }, null, 2));
} catch (e) {
  console.error('cognee_check_failed', String(e.message || e));
}
