'use strict';
const fs = require('fs');
const { execSync } = require('child_process');

function write(p, s) {
  fs.writeFileSync(p, s.replace(/\r\n/g, '\n'), 'utf8');
  console.log('wrote', p);
}

// compose: PGHOST overridable for knowledge-mcp only (line context)
{
  let s = fs.readFileSync('docker-compose.yml', 'utf8');
  // Replace only within knowledge-mcp block: find knowledge-mcp: then first PGHOST: postgres
  const idx = s.indexOf('  knowledge-mcp:');
  if (idx < 0) throw new Error('knowledge-mcp service missing');
  const after = s.slice(idx);
  const replaced = after.replace(/PGHOST:\s*postgres/, 'PGHOST: ${PGHOST:-postgres}');
  if (replaced === after && !after.includes('PGHOST: ${PGHOST:-postgres}')) {
    throw new Error('knowledge-mcp PGHOST replace failed');
  }
  s = s.slice(0, idx) + replaced;
  write('docker-compose.yml', s);
}

{
  const p = 'integrations/openclaw/phase4/run_final_gate.js';
  let s = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

  // Improve callTool with timeout
  if (!s.includes('AbortSignal.timeout')) {
    s = s.replace(
      /async function callTool\([\s\S]*?\n\}/,
      `async function callTool(token, name, args) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  let res;
  try {
    res = await fetch(BASE + '/mcp', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name: name, arguments: args || {} } }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    return { httpStatus: 0, isError: true, parsed: { error: 'fetch_failed', message: String(e && e.message || e) }, json: null };
  }
  const json = await res.json();
  const text = json && json.result && json.result.content && json.result.content[0] && json.result.content[0].text;
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : (json.error || json.result || json); } catch (e) { parsed = { raw: text, json: json }; }
  const isError = !!(json && ((json.result && json.result.isError) || json.error));
  return { httpStatus: res.status, isError: isError, parsed: parsed, json: json };
}`
    );
    console.log('callTool timeout patched');
  }

  // Add waitHealth after waitReady
  if (!s.includes('async function waitHealth')) {
    s = s.replace(
      /async function waitReady\([\s\S]*?\n\}/,
      `async function waitReady(ms) {
  const end = Date.now() + (ms || 60000);
  while (Date.now() < end) {
    try { const j = await (await fetch(BASE + '/ready')).json(); if (j && j.ok) return j; } catch (e) {}
    await new Promise(function(r){ setTimeout(r, 1000); });
  }
  throw new Error('ready timeout');
}
async function waitHealth(ms) {
  const end = Date.now() + (ms || 60000);
  while (Date.now() < end) {
    try {
      const res = await fetch(BASE + '/health', { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const j = await res.json();
        if (j && (j.ok === true || j.status === 'ok' || j.service)) return j;
      }
    } catch (e) {}
    await new Promise(function(r){ setTimeout(r, 1000); });
  }
  throw new Error('health timeout');
}`
    );
    console.log('waitHealth added');
  }

  function sliceGate(s, n, nextN) {
    const start = s.indexOf('await gate(' + n + ',');
    const end = s.indexOf('await gate(' + nextN + ',', start + 1);
    if (start < 0 || end < 0) throw new Error('gate slice ' + n);
    return { start, end };
  }

  const g1 = sliceGate(s, 1, 2);
  const g2 = sliceGate(s, 2, 3);

  const newG1 = `await gate(1, 'ACL DB unavailable fail-closed', true, async function() {
  // Recreate with blackhole PGHOST so pool fails fast (3s) → acl_unavailable; HTTP stays up.
  const restoreHost = process.env.PGHOST || 'postgres';
  try {
    shEnv('docker compose up -d --force-recreate knowledge-mcp', { PGHOST: '203.0.113.1' });
    await waitHealth(120000);
    await new Promise(function(r){ setTimeout(r, 1500); });
    const r = await callTool(mint(USER_A), 'canonical_list', { roomId: ROOM_A });
    const body = JSON.stringify(r.parsed);
    const denied = r.isError || /acl_unavailable|unavailable|fetch_failed/i.test(body);
    const fakeAllow = Array.isArray(r.parsed) && !r.isError;
    ok(denied && !fakeAllow, 'expected fail-closed, got ' + body.slice(0, 400));
    return { denied: true, mode: 'PGHOST_blackhole' };
  } finally {
    shAllowEnv('docker compose up -d --force-recreate knowledge-mcp', { PGHOST: restoreHost });
    await waitReady(120000);
  }
});

`;

  const newG2 = `await gate(2, 'Single-source fault degraded (not fake empty)', true, async function() {
  // :ro bind + read_only — override KNOWLEDGE_ROOT. Use /health (ready still needs DB only).
  const missing = '/data/knowledge.__fg_missing';
  const restore = process.env.KNOWLEDGE_ROOT || '/data/knowledge';
  try {
    shEnv('docker compose up -d --force-recreate knowledge-mcp', { KNOWLEDGE_ROOT: missing, PGHOST: process.env.PGHOST || 'postgres' });
    await waitHealth(120000);
    await waitReady(120000);
    const r = await callTool(mint(USER_A), 'canonical_list', { roomId: ROOM_A });
    const body = JSON.stringify(r.parsed);
    const errish = r.isError || /source_unavailable|unavailable/i.test(body);
    const fakeEmpty = Array.isArray(r.parsed) && r.parsed.length === 0 && !r.isError;
    ok(errish && !fakeEmpty, 'canonical must error not empty: ' + body.slice(0, 300));
    const d = await callTool(mint(USER_A), 'docmost_search', { roomId: ROOM_A, query: 'a' });
    ok(!d.isError || (d.parsed && d.parsed.code !== 'acl_unavailable'), 'docmost still callable');
    return { ok: true, mode: 'KNOWLEDGE_ROOT_override' };
  } finally {
    shAllowEnv('docker compose up -d --force-recreate knowledge-mcp', { KNOWLEDGE_ROOT: restore, PGHOST: process.env.PGHOST || 'postgres' });
    await waitReady(120000);
  }
});

`;

  s = s.slice(0, g2.start) + newG2 + s.slice(g2.end);
  s = s.slice(0, g1.start) + newG1 + s.slice(g1.end);
  write(p, s);
  execSync('node --check "' + p + '"', { stdio: 'inherit' });
  console.log('OK');
}
