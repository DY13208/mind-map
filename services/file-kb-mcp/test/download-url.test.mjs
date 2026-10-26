import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createMcpHttpServer } from '../src/server.mjs'
import { createSessionAuth } from '../src/auth.mjs'

const require = createRequire(import.meta.url)
const { createApi } = require('../../file-kb/src/api')
const { createHandler } = require('../../file-kb/src/server')
const fileId = '51a08398-e1e6-4a77-bd0d-2c70a219cc87'

test('real MCP SDK discovers the tool, obtains a URL and downloads PDF bytes without authentication', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-mcp-download-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const bytes = Buffer.from('%PDF-1.7\noriginal document\n%%EOF')
  fs.writeFileSync(path.join(dir, 'original'), bytes)
  const bearer = 'a'.repeat(64)
  const sourceHash = crypto.createHash('sha256').update(bearer).digest('hex')
  const state = { role: 'viewer', revoked: false, link: null }
  const query = async (sql, p = []) => {
    if (sql.includes('from kb.direct_links')) return { rows: state.link && state.link.token_hash === p[0] && !state.revoked ? [state.link] : [] }
    if (sql.includes('from kb.mcp_tokens')) return { rows: p[0] === sourceHash ? [{ user_id: 'viewer', live_user_id: 'viewer', scopes: ['kb:read'], expires_at: new Date(Date.now() + 3600000), revoked_at: state.revoked ? new Date() : null }] : [] }
    if (sql.startsWith('update kb.mcp_tokens')) return { rows: [] }
    if (sql.includes('kb.effective_role')) return { rows: [{ role: state.role }] }
    if (sql.startsWith('select * from kb.files')) return { rows: [{ id: fileId, name: '营业执照.pdf', ext: 'pdf', mime: 'application/pdf', size: bytes.length, storage_key: 'original', sha256: 'b'.repeat(64) }] }
    if (sql.includes('insert into kb.direct_links')) {
      state.link = { id: 'link-1', file_id: p[0], created_by: p[1], token_hash: p[2], expires_at: p[3], scope_folder_ids: p[4], source_token_hash: p[5], created_at: new Date() }
      return { rows: [state.link] }
    }
    throw new Error(sql)
  }
  const auth = createSessionAuth(query)
  const pool = { query }
  const api = createApi({ pool, storage: { resolveKey: key => path.join(dir, key) }, config: {}, queue: {} })
  const fileServer = http.createServer(createHandler({ config: { enabled: true }, api, authenticator: auth }))
  await new Promise(resolve => fileServer.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { fileServer.close(resolve); fileServer.closeAllConnections() }))
  const origin = `http://127.0.0.1:${fileServer.address().port}`
  const mcp = createMcpHttpServer({ authenticate: req => auth.authenticate(req), query, publicBaseUrl: origin })
  await new Promise(resolve => mcp.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { mcp.close(resolve); mcp.closeAllConnections() }))
  const client = new Client({ name: 'download-test', version: '1.0' })
  t.after(() => client.close())
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcp.address().port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } }))
  const tools = await client.listTools()
  assert.ok(tools.tools.some(tool => tool.name === 'get_knowledge_download_url'))
  const result = await client.callTool({ name: 'get_knowledge_download_url', arguments: { fileId } })
  assert.ok(!result.isError)
  const body = result.structuredContent
  assert.equal(body.fileId, fileId)
  assert.equal(state.link.source_token_hash, sourceHash)
  assert.ok(!JSON.stringify(body).includes(sourceHash))
  assert.ok(new Date(body.expiresAt).getTime() <= Date.now() + 900000)
  const response = await fetch(body.downloadUrl)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/pdf')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
  state.role = null
  assert.equal((await fetch(body.downloadUrl)).status, 404)
  const denied = await client.callTool({ name: 'get_knowledge_download_url', arguments: { fileId } })
  assert.equal(denied.isError, true)
  assert.equal(denied.structuredContent.code, 'missing')
  state.role = 'viewer'; state.revoked = true
  assert.equal((await fetch(body.downloadUrl)).status, 404)
  await assert.rejects(client.listTools())
})
