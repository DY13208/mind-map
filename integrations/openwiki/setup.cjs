const fs = require('fs')
const path = require('path')
const home = process.env.OPENWIKI_CONFIG_DIR || '/data/openwiki'
const dir = path.join(home, 'connectors/custom-mcp')
fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
const config = path.join(dir, 'config.json')
if (!fs.existsSync(config)) fs.writeFileSync(config, JSON.stringify({
  enabled: true,
  transport: { type: 'http', url: 'http://127.0.0.1:3848/mcp',
    headers: { Authorization: 'Bearer ${MCP_TOKEN}' } },
  allowedTools: ['list_maps', 'get_map', 'search_nodes', 'query_nodes'],
  readOnlyOperations: []
}, null, 2), { mode: 0o600 })
// Canonical files are available as read-only MCP tools too. This is a separate
// transport template; selecting it never scans the mind-map source repository.
const canonical = path.join(home, 'canonical-mcp.json')
if (!fs.existsSync(canonical)) fs.writeFileSync(canonical, JSON.stringify({ enabled: true,
  transport: { type: 'stdio', command: 'node', args: ['/runtime/canonical-mcp.cjs'] },
  allowedTools: ['list_knowledge', 'read_knowledge'], readOnlyOperations: []
}, null, 2), { mode: 0o600 })
