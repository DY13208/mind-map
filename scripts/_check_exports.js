const fs = require('fs');

function keysOf(rel) {
  try {
    return Object.keys(require('./' + rel));
  } catch (e) {
    return ['LOAD_ERROR:' + e.message];
  }
}

console.log('jwt', keysOf('integrations/knowledge-mcp/src/auth/jwt.js'));
console.log('audit', keysOf('integrations/knowledge-mcp/src/audit/log.js'));
console.log('docmostAi', keysOf('integrations/knowledge-mcp/src/adapters/docmostAi.js'));
console.log('openwikiRefresh', keysOf('integrations/knowledge-mcp/src/adapters/openwikiRefresh.js'));
console.log('rooms', keysOf('integrations/knowledge-mcp/src/acl/rooms.js'));
console.log('docmost', keysOf('integrations/knowledge-mcp/src/adapters/docmost.js'));
console.log('canonical', keysOf('integrations/knowledge-mcp/src/adapters/canonical.js'));
console.log('openwiki', keysOf('integrations/knowledge-mcp/src/adapters/openwiki.js'));

const server = fs.readFileSync('integrations/knowledge-mcp/src/server.js', 'utf8');
for (const name of [
  'verifyToken','extractBearer','writeAudit','docmostAiGet','docmostAiUpsert',
  'openwikiRefresh','openwikiRefreshStatus','canonicalList','docmostSearch'
]) {
  console.log('server has', name, server.includes(name));
}
