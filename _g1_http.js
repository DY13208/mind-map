const { spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const log = (m) => { const l = new Date().toISOString() + ' ' + m; console.log(l); fs.appendFileSync('D:/mind-map/_g1_http.log', l + '\n'); };
function shEnv(cmd, extra) {
  log('RUN');
  const r = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', cmd], {
    windowsHide: true,
    encoding: 'utf8',
    env: Object.assign({}, process.env, extra || {}),
  });
  log('DONE ' + r.status);
}
function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: 18792, path, timeout: 5000 }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}
(async () => {
  log('enter');
  shEnv('docker compose up -d --force-recreate knowledge-mcp', { PGHOST: '203.0.113.1' });
  log('before-http');
  // small delay for port bind
  await new Promise((r) => setTimeout(r, 2000));
  log('after-delay');
  try {
    const r = await get('/health');
    log('http ok ' + r.status + ' ' + r.body.slice(0, 120));
  } catch (e) {
    log('http err ' + e);
  }
  log('done');
})().catch((e) => log('top ' + e));
