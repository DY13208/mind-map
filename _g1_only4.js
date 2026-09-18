const fs = require('fs');
const { spawnSync } = require('child_process');
const log = (m) => { const line = new Date().toISOString() + ' ' + m; fs.appendFileSync('D:/mind-map/_g1_only4.log', line + '\n'); console.log(line); };
function dockerCompose(args, extra) {
  log('docker begin');
  const r = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'docker compose ' + args.join(' ')], {
    windowsHide: true,
    encoding: 'utf8',
    env: Object.assign({}, process.env, extra || {}),
  });
  log('docker end status=' + r.status + ' signal=' + r.signal + ' error=' + r.error);
  return r;
}
log('boot');
const r = dockerCompose(['up', '-d', '--force-recreate', 'knowledge-mcp'], { PGHOST: '203.0.113.1' });
log('after dockerCompose sync line');
setTimeout(() => log('timeout 1s fired'), 1000);
setTimeout(() => log('timeout 3s fired'), 3000);
Promise.resolve().then(() => log('microtask'));
(async () => {
  log('async start');
  await new Promise((r) => setTimeout(r, 2000));
  log('async after 2s');
})();
log('sync end of file');