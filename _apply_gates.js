'use strict';
const fs = require('fs');
const { execSync, spawnSync } = require('child_process');

function write(p, s) {
  fs.writeFileSync(p, s.replace(/\r\n/g, '\n'), 'utf8');
  console.log('wrote', p, s.length);
}
function sliceGate(s, n, nextN) {
  const start = s.indexOf('await gate(' + n + ',');
  if (start < 0) throw new Error('gate ' + n + ' start not found');
  const end = s.indexOf('await gate(' + nextN + ',', start + 1);
  if (end < 0) throw new Error('gate ' + nextN + ' not found after ' + n);
  return { start, end, body: s.slice(start, end) };
}

// jobStore
{
  const p = 'integrations/knowledge-mcp/src/jobs/jobStore.js';
  let s = fs.readFileSync(p, 'utf8');
  if (s.includes('secs === 0')) console.log('jobStore already');
  else {
    const start = s.indexOf('async function reclaimStaleRunning');
    const end = s.indexOf('\nfunction rowToJob', start);
    if (start < 0 || end < 0) throw new Error('reclaim markers ' + start + ' ' + end);
    const newFn = [
      "async function reclaimStaleRunning(maxAgeMs = 15 * 60 * 1000, env = process.env) {",
      "  const db = getPool(env);",
      "  const ageMs = Number(maxAgeMs);",
      "  const secs = Number.isFinite(ageMs) ? Math.max(0, Math.floor(ageMs / 1000)) : Math.floor((15 * 60 * 1000) / 1000);",
      "  const sql = secs === 0",
      "    ? `update knowledge_openwiki_jobs",
      "          set status='failed',",
      "              error=trim(both from coalesce(error,'') || ' | reclaimed_stale_running'),",
      "              finished_at=now(),",
      "              updated_at=now()",
      "        where status in ('running','publishing')",
      "        returning job_id, room_id`",
      "    : `update knowledge_openwiki_jobs",
      "          set status='failed',",
      "              error=trim(both from coalesce(error,'') || ' | reclaimed_stale_running'),",
      "              finished_at=now(),",
      "              updated_at=now()",
      "        where status in ('running','publishing')",
      "          and updated_at < now() - make_interval(secs => $1::int)",
      "        returning job_id, room_id`;",
      "  const { rows } = secs === 0 ? await db.query(sql) : await db.query(sql, [secs]);",
      "  return rows;",
      "}",
      ""
    ].join('\n');
    s = s.slice(0, start) + newFn + s.slice(end + 1);
    write(p, s);
  }
}

// server
{
  const p = 'integrations/knowledge-mcp/src/server.js';
  let s = fs.readFileSync(p, 'utf8');
  if (s.includes('reclaimStaleRunning(0)')) console.log('server already');
  else {
    const n = (s.match(/await jobStore\.reclaimStaleRunning\(\);/g) || []).length;
    if (n !== 1) throw new Error('server reclaim count ' + n);
    write(p, s.replace('await jobStore.reclaimStaleRunning();', 'await jobStore.reclaimStaleRunning(0);'));
  }
}

// compose
{
  const p = 'docker-compose.yml';
  let s = fs.readFileSync(p, 'utf8');
  if (s.includes('KNOWLEDGE_ROOT: ${KNOWLEDGE_ROOT:-/data/knowledge}')) console.log('compose already');
  else if (s.includes('KNOWLEDGE_ROOT: /data/knowledge')) {
    write(p, s.replace('KNOWLEDGE_ROOT: /data/knowledge', 'KNOWLEDGE_ROOT: ${KNOWLEDGE_ROOT:-/data/knowledge}'));
  } else throw new Error('compose KNOWLEDGE_ROOT missing');
}

// gate runner
{
  const p = 'integrations/openclaw/phase4/run_final_gate.js';
  let s = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
  const waitFn = s.includes('waitReady') ? 'waitReady' : 'waitReady';
  const callFn = s.includes('function callTool') || s.includes('async function callTool') || /await callTool\(/.test(s) ? 'callTool' : 'callTool';
  const mintFn = /mint\(/.test(s) ? 'mint' : 'mint';
  console.log({ waitFn, callFn, mintFn });

  if (!s.includes('function shEnv')) {
    const m = s.match(/function shAllow\([\s\S]*?\n\}/);
    if (!m) throw new Error('shAllow missing');
    const helpers = m[0] + '\n' + [
      'function shEnv(cmd, extraEnv) {',
      "  const r = spawnSync(cmd, { shell: true, encoding: 'utf8', env: Object.assign({}, process.env, extraEnv || {}) });",
      '  if (r.status) throw new Error((r.stderr || r.stdout || cmd).toString().slice(0, 500));',
      "  return String(r.stdout || '').trim();",
      '}',
      'function shAllowEnv(cmd, extraEnv) {',
      "  const r = spawnSync(cmd, { shell: true, encoding: 'utf8', env: Object.assign({}, process.env, extraEnv || {}) });",
      "  return { status: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };",
      '}'
    ].join('\n');
    s = s.replace(m[0], helpers);
    console.log('added shEnv');
  }

  const g1 = sliceGate(s, 1, 2);
  const g2 = sliceGate(s, 2, 3);
  const g4 = sliceGate(s, 4, 5);
  console.log('G1 head', g1.body.slice(0, 120).replace(/\n/g, ' | '));
  console.log('G2 head', g2.body.slice(0, 120).replace(/\n/g, ' | '));
  console.log('G4 head', g4.body.slice(0, 160).replace(/\n/g, ' | '));

  const mcp = (g1.body.match(/mind-map-[a-z0-9-]*knowledge-mcp-1/) || ['mind-map-knowledge-mcp-1'])[0];
  const pg = mcp.replace('knowledge-mcp', 'postgres');
  const listTool = (g1.body.match(/'canonical_[a-z_]+'/) || ["'canonical_list'"])[0];
  const docTool = (g2.body.match(/'docmost_[a-z_]+'/) || s.match(/'docmost_[a-z_]+'/) || ["'docmost_search'"])[0];
  const refreshTool = (g4.body.match(/'[a-z_]*refresh'/) || ["'openwiki_refresh'"])[0];
  const statusTool = (g4.body.match(/'[a-z_]*refresh_status'/) || ["'openwiki_refresh_status'"])[0];
  const enqVar = ((g4.body.match(/const (\w+) = await callTool/) || [])[1]) || 'enq';
  console.log({ mcp, pg, listTool, docTool, refreshTool, statusTool, enqVar });

  const newG1 = [
    "await gate(1, 'ACL DB unavailable fail-closed', true, async function() {",
    '  // Keep knowledge-mcp HTTP up; disconnect postgres only.',
    "  const net = sh('docker inspect " + pg + " --format \"{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}\"');",
    "  ok(!!net, 'postgres network empty');",
    '  try {',
    "    sh('docker network disconnect ' + net + ' " + pg + "');",
    '    await new Promise(function(r){ setTimeout(r, 2000); });',
    '    const r = await ' + callFn + '(' + mintFn + '(USER_A), ' + listTool + ', { roomId: ROOM_A });',
    '    const body = JSON.stringify(r.parsed);',
    "    const denied = r.isError || /acl_unavailable|unavailable/i.test(body);",
    '    const fakeAllow = Array.isArray(r.parsed) && !r.isError;',
    "    ok(denied && !fakeAllow, 'expected fail-closed, got ' + body.slice(0, 400));",
    "    return { denied: true, mode: 'postgres_network_disconnect' };",
    '  } finally {',
    "    shAllow('docker network connect ' + net + ' " + pg + "');",
    '    await ' + waitFn + '(90000);',
    '  }',
    '});',
    '',
    ''
  ].join('\n');

  const newG2 = [
    "await gate(2, 'Single-source fault degraded (not fake empty)', true, async function() {",
    '  // :ro bind + read_only container — override KNOWLEDGE_ROOT instead of mv.',
    "  const missing = '/data/knowledge.__fg_missing';",
    "  const restore = process.env.KNOWLEDGE_ROOT || '/data/knowledge';",
    '  try {',
    "    shEnv('docker compose up -d --force-recreate knowledge-mcp', { KNOWLEDGE_ROOT: missing });",
    '    await ' + waitFn + '(120000);',
    '    const r = await ' + callFn + '(' + mintFn + '(USER_A), ' + listTool + ', { roomId: ROOM_A });',
    '    const body = JSON.stringify(r.parsed);',
    "    const errish = r.isError || /source_unavailable|unavailable/i.test(body);",
    '    const fakeEmpty = Array.isArray(r.parsed) && r.parsed.length === 0 && !r.isError;',
    "    ok(errish && !fakeEmpty, 'canonical must error not empty: ' + body.slice(0, 300));",
    '    const d = await ' + callFn + '(' + mintFn + '(USER_A), ' + docTool + ', { roomId: ROOM_A, query: \'a\' });',
    "    ok(!d.isError || (d.parsed && d.parsed.code !== 'acl_unavailable'), 'docmost still callable');",
    "    return { ok: true, mode: 'KNOWLEDGE_ROOT_override' };",
    '  } finally {',
    "    shAllowEnv('docker compose up -d --force-recreate knowledge-mcp', { KNOWLEDGE_ROOT: restore });",
    '    await ' + waitFn + '(120000);',
    '  }',
    '});',
    '',
    ''
  ].join('\n');

  const newG4 = [
    "await gate(4, 'kill mid-refresh then reconcile', true, async function() {",
    '  shAllow("docker compose exec -T postgres psql -U postgres -d mind_map -c \\"update knowledge_openwiki_jobs set status=\'failed\', error=coalesce(error,\'\') || \' | fg_pretest_cleanup\', finished_at=now(), updated_at=now() where status in (\'running\',\'publishing\')\\"");',
    '  const ' + enqVar + ' = await ' + callFn + '(' + mintFn + '(USER_A), ' + refreshTool + ', { roomId: ROOM_A });',
    '  ok(!' + enqVar + '.isError && ' + enqVar + '.parsed && (' + enqVar + '.parsed.jobId || ' + enqVar + '.parsed.job_id), \'enqueue \' + JSON.stringify(' + enqVar + '.parsed));',
    '  const jobId = ' + enqVar + '.parsed.jobId || ' + enqVar + '.parsed.job_id;',
    "  sh('docker compose kill knowledge-mcp');",
    "  sh('docker compose start knowledge-mcp');",
    '  await ' + waitFn + '(120000);',
    '  await new Promise(function(r){ setTimeout(r, 2500); });',
    '  const st = await ' + callFn + '(' + mintFn + '(USER_A), ' + statusTool + ', { jobId: jobId, roomId: ROOM_A });',
    "  const status = (st.parsed && (st.parsed.status || (st.parsed.job && st.parsed.job.status))) || '';",
    "  ok(status && status !== 'running' && status !== 'publishing', 'stuck running: ' + JSON.stringify(st.parsed).slice(0, 300));",
    '  return { jobId: jobId, status: status };',
    '});',
    '',
    ''
  ].join('\n');

  // replace from back to front
  s = s.slice(0, g4.start) + newG4 + s.slice(g4.end);
  // re-slice g2/g1 on updated string? g2 indices still valid (before g4)
  s = s.slice(0, g2.start) + newG2 + s.slice(g2.end);
  s = s.slice(0, g1.start) + newG1 + s.slice(g1.end);

  write(p, s);
  execSync('node --check "' + p + '"', { stdio: 'inherit' });
  console.log('ALL_DONE');
}
