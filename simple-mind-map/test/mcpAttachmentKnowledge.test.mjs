import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

test('real MCP registration, defaults, Wiki tool routing and validation', async t => {
  const requests = []
  let wikiStatus = 'ok'
  const backend = http.createServer(async (req, res) => {
    let text = ''
    for await (const chunk of req) text += chunk
    const body = JSON.parse(text || '{}')
    requests.push({ url: req.url, body, authorization: req.headers.authorization })
    res.setHeader('Content-Type', 'application/json')
    const attachment = { id: 'file', status: 'ready', fileName: '验收.txt', contentHash: 'hash-1' }
    if (req.url.endsWith('/nodes/query')) res.end(JSON.stringify({ items: [{ uid: 'node', data: { attachmentId: 'file' } }], has_more: false, version: 1 }))
    else if (req.url.includes('/attachments?')) res.end(JSON.stringify({ attachments: [attachment] }))
    else if (req.url.includes('/attachments/file/text')) res.end(JSON.stringify({ attachment, text: '原附件保底正文', offset: 0, has_more: true, next_offset: 9, total_chars: 100 }))
    else if (wikiStatus === 'forbidden') { res.writeHead(403); res.end(JSON.stringify({ error: 'forbidden' })) }
    else res.end(JSON.stringify({ status: wikiStatus, version: 1, items: [{ attachment_id: 'file', text: '验收片段', source: { version: 1 } }], text: '验收片段', complete: false, has_more: true, next_cursor: 'fixture-cursor' }))
  })
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve))
  t.after(() => { backend.closeAllConnections(); backend.close() })
  const client = new Client({ name: 'attachment-contract-test', version: '1' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../bin/mcpServer.mjs', import.meta.url))],
    env: { ...process.env, MIND_MAP_SKIP_ROOT_ENV: '1', MIND_MAP_API: `http://127.0.0.1:${backend.address().port}`, MCP_TOKEN: 'fixture-token' },
    stderr: 'pipe'
  })
  let stderr = ''
  transport.stderr?.on('data', data => { stderr += data })
  t.after(() => client.close())
  try { await client.connect(transport) } catch (error) { throw new Error(`${error.message}: ${stderr}`) }
  const listed = await client.listTools()
  for (const name of ['search_attachment_knowledge', 'read_attachment_knowledge', 'build_sop_context']) assert(listed.tools.some(tool => tool.name === name))
  const base = { room_key: 'room', node_uid: 'node' }
  await client.callTool({ name: 'query_nodes', arguments: { room_key: 'room', scope: 'self', selector: { type: 'uid', value: 'node' } } })
  assert.equal(requests.at(-1).body.attachment_content, 'metadata')
  await client.callTool({ name: 'query_nodes', arguments: { room_key: 'room', scope: 'self', selector: { type: 'uid', value: 'node' }, attachment_content: 'preview' } })
  assert.equal(requests.at(-1).body.attachment_content, 'preview')
  const search = await client.callTool({ name: 'search_attachment_knowledge', arguments: { ...base, query: '验收' } })
  assert.equal(search.isError, undefined)
  assert.equal(requests.at(-1).url, '/api/wiki-compiler/api/attachments/search')
  assert.equal(requests.at(-1).body.query, '验收')
  assert.equal(requests.at(-1).authorization, 'Bearer fixture-token')
  await client.callTool({ name: 'read_attachment_knowledge', arguments: { ...base, attachment_id: 'file', cursor: 'fixture-cursor', length: 123 } })
  assert.equal(requests.at(-1).url, '/api/wiki-compiler/api/attachments/read')
  assert.equal(requests.at(-1).body.cursor, 'fixture-cursor')
  assert.equal(requests.at(-1).body.length, 123)
  wikiStatus = 'not_synced'
  const degraded = await client.callTool({ name: 'read_attachment_knowledge', arguments: { ...base, attachment_id: 'file' } })
  const result = JSON.parse(degraded.content[0].text)
  assert.equal(result.source_backend, 'attachment')
  assert.equal(result.fallback_reason, 'not_synced')
  assert.equal(result.text, '原附件保底正文')
  assert.equal(result.complete, false)
  wikiStatus = 'forbidden'
  const deniedStart = requests.length
  const denied = await client.callTool({ name: 'read_attachment_knowledge', arguments: { ...base, attachment_id: 'file' } })
  assert.equal(denied.isError, true)
  assert(!requests.slice(deniedStart).some(request => request.url.includes('/attachments/file/text')))
  const prior = requests.length
  const invalid = await client.callTool({ name: 'search_attachment_knowledge', arguments: { ...base, query: '验收', top_k: 6 } })
  assert.equal(invalid.isError, true)
  assert.equal(requests.length, prior)
})
