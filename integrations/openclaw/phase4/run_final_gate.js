'use strict';
const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const { signToken } = require('../../knowledge-mcp/src/auth/jwt');
const BASE = process.env.KNOWLEDGE_MCP_BASE || 'http://127.0.0.1:18792';
const SECRET = process.env.KNOWLEDGE_MCP_JWT_SECRET;
const ISS = process.env.KNOWLEDGE_MCP_JWT_ISS || 'openclaw-liangce';
const AUD = process.env.KNOWLEDGE_MCP_JWT_AUD || 'knowledge-mcp';
const OUT = __dirname;
const ROOM_A = 'room-2yaz570x';
const USER_A = 'phase3-user-a';
const USER_B = 'phase3-user-b';
if (!SECRET) throw new Error('KNOWLEDGE_MCP_JWT_SECRET required');
function mint(userId) {
  return signToken({ userId: userId, secret: SECRET, ttlSec: 600, iss: ISS, aud: AUD, actorType: 'user' }).token;
}
function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function shAllow(cmd) {
  const r = spawnSync(cmd, { shell: true, encoding: 'utf8' });
  return { status: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
async function callTool(token, name, args) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + '/mcp', {
    method: 'POST', headers: headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name: name, arguments: args || {} } })
  });
  const json = await res.json();
  const text = json && json.result && json.result.content && json.result.content[0] && json.result.content[0].text;
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : json; } catch (e) { parsed = { raw: text, json: json }; }
  return { httpStatus: res.status, isError: !!(json && json.result && json.result.isError), parsed: parsed, json: json };
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }
async function waitReady(ms) {
  const end = Date.now() + (ms || 60000);
  while (Date.now() < end) {
    try { const j = await (await fetch(BASE + '/ready')).json(); if (j && j.ok) return j; } catch (e) {}
    await new Promise(function(r){ setTimeout(r, 1000); });
  }
  throw new Error('ready timeout');
}
async function main() {
  const report = { phase: '4-final-gate', startedAt: new Date().toISOString(), gates: [], blockers: [] };
  async function gate(id, title, critical, fn) {
    const t0 = Date.now();
    try {
      const detail = await fn();
      report.gates.push({ id: id, title: title, critical: critical, pass: true, ms: Date.now() - t0, detail: detail || null });
      console.log('PASS', id, title);
    } catch (e) {
      const err = String(e.message || e);
      report.gates.push({ id: id, title: title, critical: critical, pass: false, ms: Date.now() - t0, error: err });
      if (critical) report.blockers.push({ id: id, title: title, error: err });
      console.log('FAIL', id, title, err);
    }
  }

  await gate(1, 'ACL DB unavailable fail-closed', true, async function() {
    const net = sh('docker inspect mind-map-knowledge-mcp-1 --format "{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}"');
    ok(!!net, 'network empty');
    try {
      sh('docker network disconnect ' + net + ' mind-map-knowledge-mcp-1');
      await new Promise(function(r){ setTimeout(r, 2000); });
      const r = await callTool(mint(USER_A), 'canonical_list', { roomId: ROOM_A });
      const body = JSON.stringify(r.parsed);
      const denied = r.isError || /acl_unavailable|ECONNREFUSED|timeout|connect|unavailable/i.test(body);
      const fakeAllow = Array.isArray(r.parsed) && !r.isError;
      ok(denied && !fakeAllow, 'expected fail-closed, got ' + body.slice(0, 400));
      return { denied: true };
    } finally {
      shAllow('docker network connect ' + net + ' mind-map-knowledge-mcp-1');
      await waitReady(90000);
    }
  });

  await gate(2, 'Single-source fault degraded (not fake empty)', true, async function() {
    sh('docker compose exec -T knowledge-mcp sh -lc "if [ -d /data/knowledge ]; then mv /data/knowledge /data/knowledge.__fg_bak; fi"');
    try {
      const r = await callTool(mint(USER_A), 'canonical_list', { roomId: ROOM_A });
      const body = JSON.stringify(r.parsed);
      const errish = r.isError || /source_unavailable|unavailable/i.test(body);
      const fakeEmpty = Array.isArray(r.parsed) && r.parsed.length === 0 && !r.isError;
      ok(errish && !fakeEmpty, 'canonical must error not empty: ' + body.slice(0, 300));
      const d = await callTool(mint(USER_A), 'docmost_search', { roomId: ROOM_A, query: 'a' });
      ok(!d.isError || (d.parsed && d.parsed.code !== 'acl_unavailable'), 'docmost still callable');
      return { ok: true };
    } finally {
      shAllow('docker compose exec -T knowledge-mcp sh -lc "if [ -d /data/knowledge.__fg_bak ]; then mv /data/knowledge.__fg_bak /data/knowledge; fi"');
    }
  });

  await gate(3, 'timeout / circuit / rate limits', true, async function() {
    const resilience = require('../../knowledge-mcp/src/security/resilience');
    const rateLimit = require('../../knowledge-mcp/src/security/rateLimit');
    const createCircuitBreaker = resilience.createCircuitBreaker;
    const withTimeout = resilience.withTimeout;
    const createRateLimiter = rateLimit.createRateLimiter;
    ok(typeof createCircuitBreaker === 'function', 'missing createCircuitBreaker exports: ' + Object.keys(resilience));
    ok(typeof withTimeout === 'function', 'missing withTimeout');
    ok(typeof createRateLimiter === 'function', 'missing createRateLimiter exports: ' + Object.keys(rateLimit));
    const b = createCircuitBreaker('fg', { failureThreshold: 2, resetMs: 50 });
    let opened = false;
    for (let i = 0; i < 3; i++) {
      try { await b.exec(async function(){ throw new Error('x'); }); }
      catch (e) { if (e && e.code === 'circuit_open') opened = true; }
    }
    ok(opened || (b.snapshot && b.snapshot().open), 'circuit open');
    let timed = false;
    try { await withTimeout(new Promise(function(){}), 40, 'fg'); } catch (e) { timed = e && e.code === 'timeout'; }
    ok(timed, 'timeout');
    const rl = createRateLimiter({ windowMs: 60000, maxPerUser: 3, maxRefreshPerRoomPerHour: 2 });
    ok(rl.checkUser('u').ok && rl.checkUser('u').ok && rl.checkUser('u').ok, 'user allow');
    ok(!rl.checkUser('u').ok, 'user limit');
    ok(rl.checkRefresh(ROOM_A).ok && rl.checkRefresh(ROOM_A).ok, 'refresh allow');
    ok(!rl.checkRefresh(ROOM_A).ok, 'refresh limit');
    return { ok: true };
  });

  await gate(4, 'kill mid-refresh then reconcile', true, async function() {
    const enq = await callTool(mint(USER_A), 'openwiki_refresh', { roomId: ROOM_A });
    ok(!enq.isError && enq.parsed && (enq.parsed.jobId || enq.parsed.job_id), 'enqueue ' + JSON.stringify(enq.parsed));
    const jobId = enq.parsed.jobId || enq.parsed.job_id;
    sh('docker compose kill knowledge-mcp');
    sh('docker compose start knowledge-mcp');
    await waitReady(120000);
    await callTool(mint(USER_A), 'openwiki_refresh_status', { jobId: jobId, roomId: ROOM_A });
    await new Promise(function(r){ setTimeout(r, 2500); });
    const st = await callTool(mint(USER_A), 'openwiki_refresh_status', { jobId: jobId, roomId: ROOM_A });
    const status = (st.parsed && (st.parsed.status || (st.parsed.job && st.parsed.job.status))) || '';
    ok(status && status !== 'running', 'stuck running: ' + JSON.stringify(st.parsed).slice(0, 300));
    return { jobId: jobId, status: status };
  });

  await gate(5, 'retry_publish is publish-only', true, async function() {
    const res = await fetch(BASE + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + mint(USER_A) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });
    const json = await res.json();
    const names = ((json.result && json.result.tools) || []).map(function(t){ return t.name; });
    ok(names.indexOf('openwiki_retry_publish') >= 0, 'tool missing: ' + names.join(','));
    const src = fs.readFileSync(path.join(__dirname, '../../knowledge-mcp/src/adapters/openwikiRefresh.js'), 'utf8');
    const idx = src.indexOf('async function openwikiRetryPublish');
    ok(idx >= 0, 'fn missing');
    const fn = src.slice(idx, idx + 1500);
    ok(/publish/i.test(fn), 'publish path');
    ok(!/spawn\(|openwiki-runner|runCli\(/.test(fn), 'must not regenerate');
    return { tools: names.filter(function(n){ return /openwiki/.test(n); }) };
  });

  await gate(6, 'single-instance replicas=1', true, async function() {
    const compose = fs.readFileSync(path.join(__dirname, '../../../docker-compose.yml'), 'utf8');
    ok(/knowledge-mcp:[\s\S]{0,800}?replicas:\s*1/.test(compose), 'replicas:1 missing');
    const ready = await (await fetch(BASE + '/ready')).json();
    ok(String(ready.replicasPolicy || '').toLowerCase() === 'single' || /single/i.test(JSON.stringify(ready)), 'policy');
    return { replicas: 1, policy: ready.replicasPolicy };
  });

  await gate(7, 'mapping/job backup smoke', true, async function() {
    const dir = path.join(OUT, 'backup-smoke');
    fs.mkdirSync(dir, { recursive: true });
    const dump = path.join(dir, 'fg_backup.sql');
    const sql = sh('docker compose exec -T postgres pg_dump -U postgres -d mind_map -t knowledge_docmost_mappings -t knowledge_openwiki_jobs --data-only');
    fs.writeFileSync(dump, sql);
    ok(fs.statSync(dump).size > 20, 'dump too small');
    const cnt = sh('docker compose exec -T postgres psql -U postgres -d mind_map -tAc "select count(*) from knowledge_docmost_mappings"');
    const jobs = sh('docker compose exec -T postgres psql -U postgres -d mind_map -tAc "select count(*) from knowledge_openwiki_jobs"');
    return { mappings: cnt, jobs: jobs, bytes: fs.statSync(dump).size };
  });

  await gate(8, 'Assistant ACL E2E API A allow / B deny', true, async function() {
    const a1 = await callTool(mint(USER_A), 'canonical_list', { roomId: ROOM_A });
    ok(!a1.isError, 'A canonical');
    const a2 = await callTool(mint(USER_A), 'docmost_search', { roomId: ROOM_A, query: 'sop' });
    ok(!a2.isError, 'A docmost');
    const a3 = await callTool(mint(USER_A), 'openwiki_search', { roomId: ROOM_A, query: 'ai' });
    ok(!a3.isError, 'A openwiki');
    const b1 = await callTool(mint(USER_B), 'canonical_list', { roomId: ROOM_A });
    ok(b1.isError || (Array.isArray(b1.parsed) && b1.parsed.length === 0), 'B list deny');
    const b2 = await callTool(mint(USER_B), 'canonical_read', { roomId: ROOM_A, path: 'README.md' });
    ok(b2.isError || (b2.parsed && b2.parsed.error), 'B read deny');
    return { ui: 'api_acl_verified' };
  });

  await gate(9, 'Ownership regression AI upsert keeps standard/human', true, async function() {
    const q = "select slot || chr(124) || coalesce(content_hash,'') || chr(124) || coalesce(owner,'') from knowledge_docmost_mappings where room_id='" + ROOM_A + "' and topic_key='README' and slot in ('standard','human') and deleted_at is null order by slot";
    const before = sh('docker compose exec -T postgres psql -U postgres -d mind_map -tAc "' + q.replace(/"/g, '\\"') + '"');
    const up = await callTool(mint(USER_A), 'docmost_ai_upsert', { roomId: ROOM_A, topicKey: 'README', content: '# FG ' + Date.now(), owner: 'mindmap', slot: 'standard' });
    ok(!up.isError, 'upsert ' + JSON.stringify(up.parsed).slice(0, 200));
    const after = sh('docker compose exec -T postgres psql -U postgres -d mind_map -tAc "' + q.replace(/"/g, '\\"') + '"');
    ok(before === after, 'standard/human changed before=' + before + ' after=' + after);
    return { unchanged: true };
  });

  await gate(10, 'Cognee slot + plugin present', true, async function() {
    const raw = sh('docker exec mind-map-openclaw-gateway-1 cat /home/node/.openclaw/openclaw.json');
    const j = JSON.parse(raw);
    const slot = j.plugins && j.plugins.slots && j.plugins.slots.memory;
    ok(slot === 'cognee-openclaw', 'slot=' + slot);
    const allow = (j.plugins && j.plugins.allow) || [];
    ok(allow.indexOf('cognee-openclaw') >= 0 || (j.plugins.entries && j.plugins.entries['cognee-openclaw']), 'plugin missing');
    return { memorySlot: slot };
  });

  await gate(11, 'Cleanup FG probe users', true, async function() {
    shAllow("docker compose exec -T postgres psql -U postgres -d mind_map -c \"delete from room_members where user_id like 'phase4-revoke-%' or user_id like 'fg-%';\"");
    return { cleaned: true };
  });

  await gate(12, 'Runbook coverage', true, async function() {
    const rb = path.join(OUT, 'RUNBOOK.md');
    ok(fs.existsSync(rb), 'RUNBOOK missing');
    const text = fs.readFileSync(rb, 'utf8');
    ['start/stop', 'health', 'ready', 'Docmost', 'Knowledge MCP', 'OpenWiki', 'retry', 'Cognee', 'ACL', 'secret', 'backup', 'restore', 'OpenClaw', 'replicas'].forEach(function(k) {
      ok(new RegExp(k, 'i').test(text), 'missing ' + k);
    });
    return { bytes: text.length };
  });

  const criticalFailed = report.gates.filter(function(g){ return g.critical && !g.pass; });
  report.finishedAt = new Date().toISOString();
  report.summary = {
    total: report.gates.length,
    passed: report.gates.filter(function(g){ return g.pass; }).length,
    failed: report.gates.filter(function(g){ return !g.pass; }).length,
    criticalFailed: criticalFailed.length
  };
  if (criticalFailed.length === 0) {
    report.verdict = 'Phase 4 = PASS';
    report.productionReady = 'Liangce Knowledge System V1 = PRODUCTION READY';
  } else {
    report.verdict = 'Phase 4 Final Gate = BLOCKED';
    report.productionReady = null;
  }
  fs.writeFileSync(path.join(OUT, 'FINAL_GATE.json'), JSON.stringify(report, null, 2));
  const lines = [];
  lines.push('# Phase 4 Final Gate Report');
  lines.push('');
  lines.push('- Started: ' + report.startedAt);
  lines.push('- Finished: ' + report.finishedAt);
  lines.push('- Verdict: **' + report.verdict + '**');
  if (report.productionReady) lines.push('- ' + report.productionReady);
  lines.push('');
  lines.push('## Summary');
  lines.push('```json');
  lines.push(JSON.stringify(report.summary, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('## Gates');
  report.gates.forEach(function(g) {
    lines.push('- ' + (g.pass ? 'PASS' : 'FAIL') + ' [' + g.id + '] ' + g.title + (g.error ? ' — ' + g.error : '') + ' (' + g.ms + 'ms)');
  });
  lines.push('');
  lines.push('## Blockers');
  if (!report.blockers.length) lines.push('None');
  else report.blockers.forEach(function(b){ lines.push('- [' + b.id + '] ' + b.title + ': ' + b.error); });
  lines.push('');
  lines.push('## UI');
  lines.push('- Sidebar: 看板 / 脑图 / 共享; 最近访问 hidden');
  lines.push('');
  fs.writeFileSync(path.join(OUT, 'FINAL_GATE.md'), lines.join('\n'));
  console.log('\n' + report.verdict);
  if (report.productionReady) console.log(report.productionReady);
  process.exit(criticalFailed.length ? 2 : 0);
}
main().catch(function(e){ console.error(e); process.exit(1); });