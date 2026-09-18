const fs = require('fs');
const { spawnSync } = require('child_process');
const log = (m) => { const line = new Date().toISOString() + ' ' + m; console.log(line); fs.appendFileSync('D:/mind-map/_g1_only.log', line + '\n'); };
const SECRET = process.env.KNOWLEDGE_MCP_JWT_SECRET;
const { signToken } = require('./integrations/knowledge-mcp/src/auth/jwt');
function shEnv(cmd, extra) {
  log('shEnv start ' + JSON.stringify(extra));
  const r = spawnSync(cmd, { shell: true, encoding: 'utf8', env: Object.assign({}, process.env, extra || {}) });
  log('shEnv done status=' + r.status);
  if (r.status) throw new Error((r.stderr || r.stdout || '').slice(0, 400));
}
async function waitHealth(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const res = await fetch('http://127.0.0.1:18792/health', { signal: AbortSignal.timeout(3000) });
      if (res.ok) { const j = await res.json(); if (j && j.ok) { log('health ok'); return; } }
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('health timeout');
}
async function waitReady(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const j = await (await fetch('http://127.0.0.1:18792/ready')).json();
      if (j && j.ok) { log('ready ok'); return; }
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('ready timeout');
}
async function callTool(token, name, args) {
  const res = await fetch('http://127.0.0.1:18792/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json();
  log('callTool ' + JSON.stringify(json).slice(0, 300));
  return json;
}
(async () => {
  log('start secret=' + !!SECRET);
  try {
    shEnv('docker compose up -d --force-recreate knowledge-mcp', { PGHOST: '203.0.113.1' });
    await waitHealth(120000);
    const token = signToken({ userId: 'phase3-user-a', secret: SECRET, ttlSec: 600, iss: 'openclaw-liangce', aud: 'knowledge-mcp', actorType: 'user' }).token;
    await callTool(token, 'canonical_list', { roomId: 'room-2yaz570x' });
    log('try ok');
  } finally {
    log('finally restore');
    shEnv('docker compose up -d --force-recreate knowledge-mcp', { PGHOST: 'postgres', KNOWLEDGE_ROOT: '/data/knowledge' });
    await waitHealth(120000);
    await waitReady(120000);
    log('finally done');
  }
  log('all done');
})().catch((e) => { log('ERR ' + e); process.exit(1); });