const { spawnSync } = require('child_process');
const fs = require('fs');
const log = (m) => { const l = new Date().toISOString() + ' ' + m; console.log(l); fs.appendFileSync('D:/mind-map/_g1_fetch.log', l + '\n'); };
function shEnv(cmd, extra) {
  log('RUN');
  const r = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', cmd], {
    windowsHide: true,
    encoding: 'utf8',
    env: Object.assign({}, process.env, extra || {}),
  });
  log('DONE ' + r.status);
}
(async () => {
  log('enter');
  shEnv('docker compose up -d --force-recreate knowledge-mcp', { PGHOST: '203.0.113.1' });
  log('before-fetch');
  try {
    const res = await fetch('http://127.0.0.1:18792/health', { signal: AbortSignal.timeout(5000) });
    const j = await res.json();
    log('fetch ok ' + JSON.stringify(j));
  } catch (e) {
    log('fetch err ' + e);
  }
  log('done');
})().catch((e) => log('top ' + e));
