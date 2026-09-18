const { spawnSync } = require('child_process');
const SECRET = process.env.KNOWLEDGE_MCP_JWT_SECRET;
console.log('secret', !!SECRET);
function shEnv(cmd, extra) {
  console.log('RUN', cmd, extra);
  const r = spawnSync(cmd, { shell: true, encoding: 'utf8', env: Object.assign({}, process.env, extra||{}) });
  console.log('status', r.status);
  console.log((r.stderr||'').slice(-300));
  return r;
}
shEnv('docker compose up -d --force-recreate knowledge-mcp', { PGHOST: '203.0.113.1' });
