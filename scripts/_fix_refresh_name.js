const fs = require('fs');
const p = 'integrations/knowledge-mcp/src/server.js';
let s = fs.readFileSync(p, 'utf8');
s = s.replace(
  /const \{ openwikiRefresh, [^}]+ \} = require\('\.\/adapters\/openwikiRefresh'\);/,
  "const { openwikiRefresh, openwikiRefreshStatus } = require('./adapters/openwikiRefresh');"
);
s = s.replace(
  /case 'openwiki_refresh_status': return [A-Za-z0-9_]+\(/,
  "case 'openwiki_refresh_status': return openwikiRefreshStatus("
);
fs.writeFileSync(p, s);
console.log(Object.keys(require('./integrations/knowledge-mcp/src/adapters/openwikiRefresh.js')));
console.log(
  fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.includes('openwikiRefresh') || l.includes('openwiki_refresh'))
    .join('\n')
);
