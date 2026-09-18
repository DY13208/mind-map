const { spawnSync } = require('child_process');
const fs = require('fs');
const log = (m) => { const l = new Date().toISOString() + ' ' + m; console.log(l); fs.appendFileSync('D:/mind-map/_g1_sleep.log', l + '\n'); };
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
  log('async-enter');
  shEnv('docker compose up -d --force-recreate knowledge-mcp', { PGHOST: '203.0.113.1' });
  log('before-sleep');
  await new Promise((r) => setTimeout(r, 5000));
  log('after-sleep');
})().then(() => log('promise-done')).catch((e) => log('err ' + e));
