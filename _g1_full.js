const fs = require('fs');
const { spawnSync } = require('child_process');
const { signToken } = require('./integrations/knowledge-mcp/src/auth/jwt');
const log = (m) => { const line = new Date().toISOString() + ' ' + m; fs.appendFileSync('D:/mind-map/_g1_full.log', line + '\n'); console.log(line); };
function shEnv(cmd, extra) {
  log('RUN ' + cmd + ' ' + JSON.stringify(extra||{}));
  const r = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', cmd], {
    windowsHide: true,
    encoding: 'utf8',
    env: Object.assign({}, process.env, extra || {}),
  });
  log('DONE status=' + r.status);
  if (r.status) throw new Error(String(r.stderr || r.stdout || cmd).slice(0, 500));
  return String(r.stdout || '').trim();
}
async function waitHealth(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const res = await fetch('http://127.0.0.1:18792/health', { signal: AbortSignal.timeout(3000) });
      if (res.ok) { const j = await res.json(); if (j && (j.ok === true || j.service)) { log('health ok'); return j; } }
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
      if (j && j.ok) { log('ready ok'); return j; }
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('ready timeout');
}
async function callTool(token, name, args) {
  const res = await fetch('http://127.0.0.1:18792/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args || {} } }),
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json();
  const text = json && json.result && json.result.content && json.result.content[0] && json.result.content[0].text;
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : (json.error || json.result || json); } catch (e) { parsed = { raw: text }; }
  const isError = !!(json && ((json.result && json.result.isError) || json.error));
  log('callTool ' + name + ' isError=' + isError + ' body=' + JSON.stringify(parsed).slice(0, 200));
  return { isError, parsed };
}
(async () => {
  log('start');
  const token = signToken({ userId: 'phase3-user-a', secret: process.env.KNOWLEDGE_MCP_JWT_SECRET, ttlSec: 600, iss: 'openclaw-liangce', aud: 'knowledge-mcp', actorType: 'user' }).token;
  try {
    shEnv('docker compose up -d --force-recreate knowledge-mcp', { PGHOST: '203.0.113.1' });
    await waitHealth(180000);
    const r = await callTool(token, 'canonical_list', { roomId: 'room-2yaz570x' });
    const denied = r.isError || /acl_unavailable|unavailable/i.test(JSON.stringify(r.parsed));
    log('G1 denied=' + denied);
    if (!denied) throw new Error('expected deny');
  } finally {
    log('finally');
    shEnv('docker compose up -d --force-recreate knowledge-mcp', { PGHOST: 'postgres', KNOWLEDGE_ROOT: '/data/knowledge' });
    await waitHealth(180000);
    await waitReady(180000);
    log('finally done');
  }
  // quick G2
  try {
    shEnv('docker compose up -d --force-recreate knowledge-mcp', { KNOWLEDGE_ROOT: '/data/knowledge.__fg_missing', PGHOST: 'postgres' });
    await waitHealth(180000);
    await waitReady(180000);
    const r = await callTool(token, 'canonical_list', { roomId: 'room-2yaz570x' });
    const errish = r.isError || /source_unavailable|unavailable/i.test(JSON.stringify(r.parsed));
    const fakeEmpty = Array.isArray(r.parsed) && r.parsed.length === 0 && !r.isError;
    log('G2 errish=' + errish + ' fakeEmpty=' + fakeEmpty);
    if (!errish || fakeEmpty) throw new Error('G2 fail ' + JSON.stringify(r.parsed).slice(0,200));
  } finally {
    shEnv('docker compose up -d --force-recreate knowledge-mcp', { KNOWLEDGE_ROOT: '/data/knowledge', PGHOST: 'postgres' });
    await waitHealth(180000);
    await waitReady(180000);
  }
  log('ALL_PASS_G1_G2');
})().catch((e) => { log('ERR ' + e.stack || e); process.exit(1); });