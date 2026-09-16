// Minimal, read-only stdio MCP surface over compiler-owned output.
const fs = require('fs/promises')
const path = require('path')
const readline = require('readline')
const crypto = require('crypto')
const root = '/knowledge'
async function roomManifest(roomId) {
  if (!/^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,79}$/.test(roomId)) throw new Error('Invalid roomId')
  const dir = path.join(root, roomId)
  try { await fs.access(path.join(dir, '.transaction')); throw new Error('Knowledge publication pending; retry') }
  catch (err) { if (err.code !== 'ENOENT') throw err }
  return { dir, manifest: JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')) }
}
async function call(name, args) {
  if (name === 'list_knowledge') {
    const result = []
    for (const room of await fs.readdir(root, { withFileTypes: true })) {
      if (!room.isDirectory() || room.name.startsWith('.')) continue
      const { manifest } = await roomManifest(room.name)
      result.push({ roomId: room.name, version: manifest.lastCompiledVersion, files: Object.keys(manifest.documents) })
    }
    return result
  }
  if (name !== 'read_knowledge') throw new Error('Unsupported read-only tool')
  const { dir, manifest } = await roomManifest(args.roomId)
  if (!Object.hasOwn(manifest.documents, args.file) || (args.file !== 'README.md' && !/^branches\/[a-zA-Z0-9_-][a-zA-Z0-9._-]*\.md$/.test(args.file))) throw new Error('Unknown canonical document')
  const file = path.join(dir, args.file)
  if ((await fs.stat(file)).size > 2 * 1024 * 1024) throw new Error('Document exceeds 2 MiB read limit')
  const text = await fs.readFile(file, 'utf8')
  const checksum = crypto.createHash('sha256').update(text).digest('hex')
  const again = await roomManifest(args.roomId)
  if (again.manifest.publicationId !== manifest.publicationId || again.manifest.lastSourceRevision !== manifest.lastSourceRevision || again.manifest.lastCompiledVersion !== manifest.lastCompiledVersion || checksum !== manifest.documents[args.file].fileHash) throw new Error('Knowledge changed during read; retry')
  return { roomId: args.roomId, file: args.file, version: manifest.lastCompiledVersion, text }
}
async function rpc(req) {
  if (req.method === 'initialize') return { protocolVersion: req.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'canonical-knowledge', version: '1.0.0' } }
  if (req.method === 'ping') return {}
  if (req.method === 'tools/list') return { tools: [
    { name: 'list_knowledge', description: 'List available canonical Mind Map Markdown documents', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: {} } },
    { name: 'read_knowledge', description: 'Read a versioned canonical Markdown document', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { roomId: { type: 'string' }, file: { type: 'string' } }, required: ['roomId', 'file'] } }
  ] }
  if (req.method === 'tools/call') {
    try { return { content: [{ type: 'text', text: JSON.stringify(await call(req.params.name, req.params.arguments || {})) }] } }
    catch (err) { return { isError: true, content: [{ type: 'text', text: err.message }] } }
  }
  throw new Error('Method not found')
}
const lines = readline.createInterface({ input: process.stdin })
let chain = Promise.resolve()
lines.on('line', line => {
  chain = chain.then(async () => {
    let req
    try { req = JSON.parse(line) } catch (_) { return }
    if (req.id === undefined) return
    let result
    try { result = { jsonrpc: '2.0', id: req.id, result: await rpc(req) } }
    catch (err) { result = { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: err.message } } }
    process.stdout.write(JSON.stringify(result) + '\n')
  }).catch(err => { process.stderr.write(err.message + '\n') })
})
