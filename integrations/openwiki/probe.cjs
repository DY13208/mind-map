const fs = require('fs/promises')
const path = require('path')
async function main() {
  const home = process.env.OPENWIKI_CONFIG_DIR
  const state = path.join(home, 'runtime-check.json')
  await fs.writeFile(state, JSON.stringify({ checkedAt: new Date().toISOString() }), { mode: 0o600 })
  JSON.parse(await fs.readFile(state, 'utf8'))
  const knowledge = await fs.readdir('/knowledge')
  // Prove mounted knowledge is read-only; no persistent test artifact is left.
  let readOnly = false
  try { await fs.writeFile('/knowledge/.runtime-write-probe', 'probe'); await fs.unlink('/knowledge/.runtime-write-probe') }
  catch (err) { if (err.code === 'EROFS' || err.code === 'EACCES') readOnly = true; else throw err }
  if (!readOnly) throw new Error('Knowledge volume is writable')
  const reply = await fetch(process.env.OPENWIKI_MIND_MAP_MCP_URL, { method: 'POST', headers: {
    'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${process.env.MCP_TOKEN || ''}`
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'openwiki-runtime-check', version: '1' }
  } }) })
  if (!reply.ok) throw new Error(`Mind Map MCP initialize HTTP ${reply.status}`)
  const body = await reply.text()
  if (!body.includes('protocolVersion')) throw new Error('MCP did not initialize')
  const official = await import('/usr/local/lib/node_modules/openwiki/dist/connectors/mcp-client.js')
  const config = JSON.parse(await fs.readFile(path.join(home, 'connectors/custom-mcp/config.json'), 'utf8'))
  const tools = await official.listMcpTools(config)
  if (!tools.tools.some(tool => tool.name === 'query_nodes')) throw new Error('Official OpenWiki client did not discover Mind Map tools')
  const canonical = JSON.parse(await fs.readFile(path.join(home, 'canonical-mcp.json'), 'utf8'))
  const canonicalResult = await official.executeMcpReadOnlyOperations({ ...canonical,
    readOnlyOperations: [{ type: 'tool', name: 'list_knowledge', args: {} }] })
  console.log(JSON.stringify({ node: process.version, configWritable: true, knowledgeReadable: true,
    knowledgeReadOnly: readOnly, knowledgeRooms: knowledge.filter(x => !x.startsWith('.')).length, mcpInitialized: true,
    officialOpenWikiMcpTools: tools.tools.length, canonicalMcpOperations: canonicalResult.operations.length }))
}
main().catch(err => { console.error(err.message); process.exitCode = 1 })
