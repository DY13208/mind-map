'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { signToken } = require('../../knowledge-mcp/src/auth/jwt');

const BASE = 'http://127.0.0.1:18792';
const SECRET = process.env.KNOWLEDGE_MCP_JWT_SECRET;
if (!SECRET) throw new Error('KNOWLEDGE_MCP_JWT_SECRET required');

function mint(userId) {
  return signToken({ userId, secret: SECRET, ttlSec: 600 }).token;
}

async function callTool(token, name, args) {
  const res = await fetch(BASE + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args || {} } }),
  });
  const json = await res.json();
  const text = json && json.result && json.result.content && json.result.content[0] && json.result.content[0].text;
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : json; } catch { parsed = { raw: text, json }; }
  return { isError: !!(json && json.result && json.result.isError), parsed, json };
}

function ok(cond, msg) { if (!cond) throw new Error(msg); }

async function main() {
  const report = { cases: [], startedAt: new Date().toISOString(), refreshJobId: null, refreshFinal: null };
  const tokenA = mint('phase3-user-a');
  const tokenB = mint('phase3-user-b');
  const tokenV = mint('phase3-viewer');

  async function caseRun(name, fn) {
    const t0 = Date.now();
    try {
      await fn();
      report.cases.push({ name, pass: true, ms: Date.now() - t0 });
      console.log('PASS', name);
    } catch (e) {
      report.cases.push({ name, pass: false, error: String(e.message || e), ms: Date.now() - t0 });
      console.log('FAIL', name, e.message || e);
    }
  }

  await caseRun('tools_list_includes_phase3', async () => {
    const res = await fetch(BASE + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokenA },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const json = await res.json();
    const names = ((json.result && json.result.tools) || []).map((t) => t.name);
    for (const n of ['docmost_ai_get', 'docmost_ai_upsert', 'openwiki_refresh', 'openwiki_refresh_status']) {
      ok(names.includes(n), 'missing ' + n + ' in ' + names.join(','));
    }
  });

  await caseRun('A_upsert_roomA_PASS', async () => {
    const r = await callTool(tokenA, 'docmost_ai_upsert', {
      roomId: 'room-2yaz570x', topicKey: 'phase3-ai-topic', content: '# A\n' + Date.now(), optionalTitle: 'Phase3 AI',
    });
    ok(!r.isError && r.parsed && r.parsed.status === 'ok', JSON.stringify(r.parsed));
  });

  await caseRun('A_upsert_roomB_DENY', async () => {
    const r = await callTool(tokenA, 'docmost_ai_upsert', { roomId: 'room-6b5wc9z3', topicKey: 'phase3-ai-topic', content: 'deny' });
    ok(r.isError || (r.parsed && r.parsed.error), JSON.stringify(r.parsed));
  });

  await caseRun('B_upsert_roomB_PASS', async () => {
    const r = await callTool(tokenB, 'docmost_ai_upsert', { roomId: 'room-6b5wc9z3', topicKey: 'phase3-ai-topic', content: '# B\n' + Date.now() });
    ok(!r.isError && r.parsed && r.parsed.status === 'ok', JSON.stringify(r.parsed));
  });

  await caseRun('B_upsert_roomA_DENY', async () => {
    const r = await callTool(tokenB, 'docmost_ai_upsert', { roomId: 'room-2yaz570x', topicKey: 'phase3-ai-topic', content: 'deny' });
    ok(r.isError || (r.parsed && r.parsed.error), JSON.stringify(r.parsed));
  });

  await caseRun('viewer_upsert_DENY', async () => {
    const r = await callTool(tokenV, 'docmost_ai_upsert', { roomId: 'room-2yaz570x', topicKey: 'phase3-ai-topic', content: 'deny' });
    ok(r.isError || (r.parsed && r.parsed.error), JSON.stringify(r.parsed));
  });

  await caseRun('fake_owner_ignored', async () => {
    const r = await callTool(tokenA, 'docmost_ai_upsert', {
      roomId: 'room-2yaz570x', topicKey: 'phase3-ai-topic', content: 'x-' + Date.now(),
      owner: 'mindmap', slot: 'standard', pageId: '00000000-0000-0000-0000-000000000000',
    });
    ok(!r.isError && r.parsed && r.parsed.status === 'ok', JSON.stringify(r.parsed));
    ok(r.parsed.result && r.parsed.result.owner === 'ai', 'owner=' + (r.parsed.result && r.parsed.result.owner));
  });

  await caseRun('no_token_DENY', async () => {
    const res = await fetch(BASE + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'docmost_ai_upsert', arguments: { roomId: 'room-2yaz570x', topicKey: 'x', content: 'y' } } }),
    });
    const json = await res.json();
    ok(json.result && json.result.isError, JSON.stringify(json));
  });

  await caseRun('viewer_refresh_DENY', async () => {
    const r = await callTool(tokenV, 'openwiki_refresh', { roomId: 'room-2yaz570x' });
    ok(r.isError || (r.parsed && r.parsed.error), JSON.stringify(r.parsed));
  });

  await caseRun('editor_refresh_PASS', async () => {
    const r = await callTool(tokenA, 'openwiki_refresh', { roomId: 'room-2yaz570x' });
    ok(!r.isError && r.parsed && r.parsed.jobId, JSON.stringify(r.parsed));
    report.refreshJobId = r.parsed.jobId;
  });

  await caseRun('refresh_coalesce', async () => {
    const results = await Promise.all([0, 1, 2, 3, 4].map(() => callTool(tokenA, 'openwiki_refresh', { roomId: 'room-2yaz570x' })));
    const ids = new Set(results.map((r) => r.parsed && r.parsed.jobId).filter(Boolean));
    ok(ids.size === 1, 'ids=' + [...ids].join(','));
  });

  await caseRun('poll_refresh_status', async () => {
    ok(report.refreshJobId, 'no job');
    let final = null;
    for (let i = 0; i < 90; i++) {
      const r = await callTool(tokenA, 'openwiki_refresh_status', { jobId: report.refreshJobId });
      final = r.parsed;
      if (final && ['succeeded', 'failed', 'partial', 'ok'].includes(final.status)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    ok(final && ['succeeded', 'partial', 'failed', 'ok', 'completed'].includes(final.status), JSON.stringify(final));
    report.refreshFinal = final;
  });

  await caseRun('polluted_mapping_DENY', async () => {
    execSync('docker exec mind-map-postgres-1 psql -U postgres -d mind_map -c "update knowledge_docmost_mappings set owner=\'human\' where room_id=\'room-2yaz570x\' and topic_key=\'phase3-ai-topic\' and slot=\'ai\';"', { stdio: 'pipe' });
    const r = await callTool(tokenA, 'docmost_ai_upsert', { roomId: 'room-2yaz570x', topicKey: 'phase3-ai-topic', content: 'nope' });
    ok(r.isError || (r.parsed && r.parsed.error), JSON.stringify(r.parsed));
    execSync('docker exec mind-map-postgres-1 psql -U postgres -d mind_map -c "update knowledge_docmost_mappings set owner=\'ai\' where room_id=\'room-2yaz570x\' and topic_key=\'phase3-ai-topic\' and slot=\'ai\';"', { stdio: 'pipe' });
  });

  // standard/human anti-write: ensure hashes unchanged when attempting via AI tool with those topic keys that have standard/human pages
  await caseRun('standard_human_untouched', async () => {
    const before = execSync('docker exec mind-map-postgres-1 psql -U postgres -d mind_map -t -A -c "select slot, content_hash from knowledge_docmost_mappings where room_id=\'room-2yaz570x\' and topic_key=\'README\' and slot in (\'standard\',\'human\') order by slot;"', { encoding: 'utf8' });
    await callTool(tokenA, 'docmost_ai_upsert', { roomId: 'room-2yaz570x', topicKey: 'README', content: 'ai-should-create-ai-slot-only-' + Date.now() });
    const after = execSync('docker exec mind-map-postgres-1 psql -U postgres -d mind_map -t -A -c "select slot, content_hash from knowledge_docmost_mappings where room_id=\'room-2yaz570x\' and topic_key=\'README\' and slot in (\'standard\',\'human\') order by slot;"', { encoding: 'utf8' });
    ok(before === after, 'standard/human hashes changed\nbefore=' + before + '\nafter=' + after);
    const ai = execSync('docker exec mind-map-postgres-1 psql -U postgres -d mind_map -t -A -c "select owner, slot from knowledge_docmost_mappings where room_id=\'room-2yaz570x\' and topic_key=\'README\' and slot=\'ai\' and deleted_at is null;"', { encoding: 'utf8' }).trim();
    ok(ai.startsWith('ai|ai'), 'ai slot not created: ' + ai);
  });

  report.finishedAt = new Date().toISOString();
  report.passed = report.cases.filter((c) => c.pass).length;
  report.failed = report.cases.filter((c) => !c.pass).length;
  report.verdict = report.failed === 0 ? 'PASS' : 'BLOCKED';
  fs.writeFileSync(path.join(__dirname, 'PHASE3_ACCEPTANCE.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ verdict: report.verdict, passed: report.passed, failed: report.failed }, null, 2));
  process.exit(report.failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
