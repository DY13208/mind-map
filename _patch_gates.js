const fs = require('fs');
const p = 'integrations/openclaw/phase4/run_final_gate.js';
let s = fs.readFileSync(p, 'utf8');

function replaceGate(s, n, next, body) {
  const start = s.indexOf('await gate(' + n + ',');
  const end = s.indexOf('await gate(' + next + ',', start + 1);
  if (start < 0 || end < 0) throw new Error('gate ' + n);
  return s.slice(0, start) + body + '\n\n' + s.slice(end);
}

const g1 = `await gate(1, 'ACL DB unavailable fail-closed', true, async function() {
  try {
    shEnv('docker compose up -d --force-recreate knowledge-mcp', { PGHOST: '203.0.113.1' });
    await waitHealth(180000);
    await new Promise(function(r){ setTimeout(r, 1500); });
    const r = await callTool(mint(USER_A), 'canonical_list', { roomId: ROOM_A });
    const body = JSON.stringify(r.parsed);
    const denied = r.isError || /acl_unavailable|unavailable/i.test(body);
    const fakeAllow = Array.isArray(r.parsed) && !r.isError;
    ok(denied && !fakeAllow, 'expected fail-closed, got ' + body.slice(0, 400));
    return { denied: true, mode: 'PGHOST_blackhole' };
  } finally {
    shAllowEnv('docker compose up -d --force-recreate knowledge-mcp', { PGHOST: 'postgres', KNOWLEDGE_ROOT: '/data/knowledge' });
    await waitHealth(180000);
    await waitReady(180000);
  }
});`;

const g2 = `await gate(2, 'Single-source fault degraded (not fake empty)', true, async function() {
  try {
    shEnv('docker compose up -d --force-recreate knowledge-mcp', { KNOWLEDGE_ROOT: '/data/knowledge.__fg_missing', PGHOST: 'postgres' });
    await waitHealth(180000);
    // ready should still pass (DB up); canonical must error
    await waitReady(180000);
    const r = await callTool(mint(USER_A), 'canonical_list', { roomId: ROOM_A });
    const body = JSON.stringify(r.parsed);
    const errish = r.isError || /source_unavailable|unavailable/i.test(body);
    const fakeEmpty = Array.isArray(r.parsed) && r.parsed.length === 0 && !r.isError;
    ok(errish && !fakeEmpty, 'canonical must error not empty: ' + body.slice(0, 300));
    const d = await callTool(mint(USER_A), 'docmost_search', { roomId: ROOM_A, query: 'a' });
    ok(!d.isError || (d.parsed && d.parsed.code !== 'acl_unavailable'), 'docmost still callable');
    return { ok: true, mode: 'KNOWLEDGE_ROOT_override' };
  } finally {
    shAllowEnv('docker compose up -d --force-recreate knowledge-mcp', { KNOWLEDGE_ROOT: '/data/knowledge', PGHOST: 'postgres' });
    await waitHealth(180000);
    await waitReady(180000);
  }
});`;

s = replaceGate(s, 1, 2, g1);
s = replaceGate(s, 2, 3, g2);
fs.writeFileSync(p, s);
require('child_process').execSync('node --check "' + p + '"', { stdio: 'inherit' });
console.log('patched ok', fs.statSync(p).size);