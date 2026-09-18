const fs = require('fs');
const path = 'integrations/openclaw/phase4/run_final_gate.js';
let s = fs.readFileSync(path, 'utf8');
s = s.replace(/^console\.log\('FG_BOOT'.*\r?\n/gm, '');
s = s.replace(/console\.log\('BEFORE_GATE', \d+\);\s*/g, '');

const helpers = `
const http = require('http');
const { URL } = require('url');

function shEnv(cmd, extraEnv) {
  const r = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', cmd], {
    windowsHide: true,
    encoding: 'utf8',
    env: Object.assign({}, process.env, extraEnv || {}),
  });
  if (r.status) throw new Error((r.stderr || r.stdout || cmd).toString().slice(0, 500));
  return String(r.stdout || '').trim();
}
function shAllowEnv(cmd, extraEnv) {
  return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', cmd], {
    windowsHide: true,
    encoding: 'utf8',
    env: Object.assign({}, process.env, extraEnv || {}),
  });
}
function httpJson(method, urlPath, opts) {
  opts = opts || {};
  return new Promise(function(resolve, reject) {
    const u = new URL(urlPath, BASE);
    const payload = opts.body ? JSON.stringify(opts.body) : null;
    const headers = { Accept: 'application/json' };
    if (opts.token) headers.Authorization = 'Bearer ' + opts.token;
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: method || 'GET',
      headers: headers,
      timeout: opts.timeoutMs || 20000,
    }, function(res) {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', function(c){ buf += c; });
      res.on('end', function() {
        let json = null;
        try { json = buf ? JSON.parse(buf) : null; } catch (e) { json = { raw: buf }; }
        resolve({ status: res.statusCode, json: json });
      });
    });
    req.on('error', reject);
    req.on('timeout', function(){ req.destroy(); reject(new Error('http timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}
async function waitHealth(ms) {
  const end = Date.now() + (ms || 60000);
  while (Date.now() < end) {
    try {
      const r = await httpJson('GET', '/health', { timeoutMs: 3000 });
      if (r.status === 200 && r.json && (r.json.ok === true || r.json.service)) return r.json;
    } catch (e) {}
    await new Promise(function(r){ setTimeout(r, 1000); });
  }
  throw new Error('health timeout');
}
async function waitReady(ms) {
  const end = Date.now() + (ms || 60000);
  while (Date.now() < end) {
    try {
      const r = await httpJson('GET', '/ready', { timeoutMs: 3000 });
      if (r.status === 200 && r.json && r.json.ok) return r.json;
    } catch (e) {}
    await new Promise(function(r){ setTimeout(r, 1000); });
  }
  throw new Error('ready timeout');
}
async function callTool(token, name, args) {
  try {
    const r = await httpJson('POST', '/mcp', {
      token: token,
      timeoutMs: 20000,
      body: { jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name: name, arguments: args || {} } },
    });
    const json = r.json;
    const text = json && json.result && json.result.content && json.result.content[0] && json.result.content[0].text;
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : (json && (json.error || json.result || json)); } catch (e) { parsed = { raw: text, json: json }; }
    const isError = !!(json && ((json.result && json.result.isError) || json.error));
    return { httpStatus: r.status, isError: isError, parsed: parsed, json: json };
  } catch (e) {
    return { httpStatus: 0, isError: true, parsed: { error: 'fetch_failed', message: String(e && e.message || e) }, json: null };
  }
}
`;

if (!s.includes('function httpJson(')) {
  const anchor = s.indexOf('\nif (!SECRET)');
  if (anchor < 0) throw new Error('SECRET anchor missing');
  s = s.slice(0, anchor) + '\n' + helpers + '\n' + s.slice(anchor);
}

function replaceGate(src, n, next, body) {
  const start = src.indexOf('await gate(' + n + ',');
  const end = src.indexOf('await gate(' + next + ',', start + 1);
  if (start < 0 || end < 0) throw new Error('gate ' + n);
  return src.slice(0, start) + body + '\n\n' + src.slice(end);
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
fs.writeFileSync(path, s);
require('child_process').execSync('node --check "' + path + '"', { stdio: 'inherit' });
console.log('OK', fs.statSync(path).size);
