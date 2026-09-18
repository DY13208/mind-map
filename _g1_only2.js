const fs = require('fs');
const { spawnSync } = require('child_process');
const log = (m) => { const line = new Date().toISOString() + ' ' + m; console.log(line); fs.appendFileSync('D:/mind-map/_g1_only2.log', line + '\n'); };
function dockerCompose(args, extra) {
  log('docker ' + args.join(' ') + ' ' + JSON.stringify(extra||{}));
  const r = spawnSync('docker', ['compose', ...args], {
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    env: Object.assign({}, process.env, extra || {}, { COMPOSE_INTERACTIVE_NO_CLI: '1', DOCKER_CLI_HINTS: 'false' }),
  });
  log('docker status=' + r.status + ' err=' + String(r.stderr||'').slice(-200));
  if (r.status) throw new Error(String(r.stderr||r.stdout||'docker fail').slice(0,400));
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
      log('ready not ok yet');
    } catch (e) { log('ready err'); }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('ready timeout');
}
(async () => {
  log('start');
  try {
    dockerCompose(['up','-d','--force-recreate','knowledge-mcp'], { PGHOST: '203.0.113.1' });
    await waitHealth(120000);
    log('after health blackhole');
  } finally {
    log('finally');
    dockerCompose(['up','-d','--force-recreate','knowledge-mcp'], { PGHOST: 'postgres', KNOWLEDGE_ROOT: '/data/knowledge' });
    await waitHealth(120000);
    await waitReady(120000);
    log('finally done');
  }
  log('all done');
})().catch((e)=>{ log('ERR '+e); process.exit(1); });