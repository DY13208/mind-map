// File KB MCP. Same Streamable HTTP shape as simple-mind-map/bin/mcpServer.mjs:
// POST /mcp, Bearer auth, SDK session, tools return JSON text.
// Every request re-reads the token row. Revocation applies on the next call.
import http from 'node:http'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { createSessionAuth } from './auth.mjs'

const require = createRequire(import.meta.url)
const { TOOLS, callTool: callToolImpl } = require('../../file-kb/src/read.js')
const { smartQuery: smartQueryImpl, SMART_TOOL } = require('../../file-kb/src/geekcloud/smart.js')
const { createGeekcloud } = require('../../file-kb/src/geekcloud/index.js')

const requestUser = new AsyncLocalStorage()
const enabledFlag = v => /^(1|true|yes|on)$/i.test(String(v ?? '').trim())

const TOOL_FIELDS = {
  list_knowledge_files: {
    folderId: z.string().optional(),
    q: z.string().optional(),
    page: z.number().int().optional(),
    pageSize: z.number().int().optional()
  },
  search_knowledge: {
    q: z.string(),
    mode: z.string().optional(),
    limit: z.number().int().optional()
  },
  query_knowledge_records: {
    fileId: z.string().optional(),
    cursor: z.string().optional(),
    sheet: z.string().optional(),
    tableIndex: z.number().int().optional(),
    filters: z.array(z.object({
      field: z.string(),
      op: z.string(),
      value: z.any().optional(),
      min: z.any().optional(),
      max: z.any().optional(),
      type: z.string().optional(),
      column: z.string().optional()
    })).optional(),
    page: z.number().int().optional(),
    pageSize: z.number().int().optional()
  },
  get_knowledge_document: { fileId: z.string() },
  get_knowledge_download_url: { fileId: z.string().uuid() },
  read_knowledge_document: {
    fileId: z.string(),
    cursor: z.string().optional(),
    length: z.number().int().min(1).max(20000).optional()
  },
  get_knowledge_block: { blockId: z.string() },
  get_knowledge_source: {
    blockId: z.string().optional(),
    fileId: z.string().optional(),
    sheet: z.string().optional(),
    row: z.number().int().optional(),
    rowIndex: z.number().int().optional(),
    field: z.string().optional()
  },
  get_knowledge_import_status: { fileId: z.string() }
}

const SMART_FIELDS = {
  query: z.string().max(500),
  mode: z.enum(['auto', 'file_only', 'geekcloud_only', 'combined']).optional(),
  include_file_context: z.boolean().optional(),
  limit: z.number().int().optional()
}

function toolOk(data) {
  const text = JSON.stringify(data)
  return { content: [{ type: 'text', text }], structuredContent: JSON.parse(text) }
}

function toolFail(err) {
  const body = { error: err.message || 'tool failed', code: err.code || 'error' }
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body }
}

export function createFileKbMcpServer({ query, callTool = callToolImpl, geekcloud = null, smartQuery = smartQueryImpl, publicBaseUrl = process.env.FILE_KB_PUBLIC_BASE_URL } = {}) {
  const server = new McpServer({ name: 'file-kb', version: '0.1.0' })
  for (const tool of TOOLS) {
    const shape = TOOL_FIELDS[tool.name]
    if (!shape) continue
    server.tool(tool.name, tool.description, shape, async args => {
      const user = requestUser.getStore()
      if (!user) return toolFail(Object.assign(new Error('unauthorized'), { code: 'unauthorized' }))
      try {
        return toolOk(await callTool({ query }, user, tool.name, args || {}, { publicBaseUrl }))
      } catch (err) {
        return toolFail(err)
      }
    })
  }
  server.tool(SMART_TOOL.name, SMART_TOOL.description, SMART_FIELDS, async args => {
    const user = requestUser.getStore()
    if (!user) return toolFail(Object.assign(new Error('unauthorized'), { code: 'unauthorized' }))
    try {
      return toolOk(await smartQuery({ db: { query }, geekcloud, via: 'mcp' }, user, args || {}))
    } catch (err) {
      return toolFail(err)
    }
  })
  return server
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id, MCP-Protocol-Version, x-mcp-request-id')
  res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id')
}

function sendJson(res, status, body) {
  if (res.headersSent) return
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload)
  })
  res.end(payload)
}

function readJson(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { status: 413, code: 'body_too_large' }))
        req.destroy()
      } else chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve(undefined)
      try { resolve(JSON.parse(raw)) } catch (_) {
        reject(Object.assign(new Error('bad json'), { status: 400, code: 'bad_json' }))
      }
    })
    req.on('error', reject)
  })
}

export function createMcpHttpServer({ enabled = true, authenticate, query, callTool, geekcloud = null, smartQuery, publicBaseUrl = process.env.FILE_KB_PUBLIC_BASE_URL } = {}) {
  const sessions = new Map()
  return http.createServer(async (req, res) => {
    setCors(res)
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }
    if (url.pathname === '/health') {
      return sendJson(res, 200, { ok: true, enabled, transport: 'streamable-http', tools: [...TOOLS.map(t => t.name), SMART_TOOL.name] })
    }
    if (url.pathname !== '/mcp') return sendJson(res, 404, { error: 'not found', code: 'not_found' })
    if (!enabled) return sendJson(res, 404, { error: 'not found', code: 'kb_disabled' })
    if (!authenticate) return sendJson(res, 503, { error: 'auth unavailable', code: 'auth_unavailable' })
    let user
    try {
      user = await authenticate(req)
    } catch (err) {
      const sessionId = req.headers['mcp-session-id']
      const stale = sessionId && sessions.get(String(sessionId))
      if (stale) {
        sessions.delete(String(sessionId))
        stale.transport.close().catch(() => {})
      }
      return sendJson(res, err.status || 503, { error: err.message || 'unauthorized', code: err.code || 'unauthorized' })
    }
    try {
      const sessionId = req.headers['mcp-session-id'] ? String(req.headers['mcp-session-id']) : ''
      if (req.method === 'POST') {
        const body = await readJson(req)
        let entry = sessionId ? sessions.get(sessionId) : undefined
        if (entry && entry.userId !== user.id) {
          sessions.delete(sessionId)
          entry.transport.close().catch(() => {})
          return sendJson(res, 401, { error: 'unauthorized', code: 'unauthorized' })
        }
        if (!entry && isInitializeRequest(body)) {
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            enableJsonResponse: true,
            onsessioninitialized: id => {
              sessions.set(id, entry)
            }
          })
          entry = { transport, userId: user.id }
          transport.onclose = () => {
            if (transport.sessionId) sessions.delete(transport.sessionId)
          }
          const server = createFileKbMcpServer({ query, callTool, geekcloud, smartQuery, publicBaseUrl })
          await server.connect(transport)
        }
        if (!entry) {
          return sendJson(res, 404, {
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Session expired, please reinitialize' },
            id: body && body.id != null ? body.id : null
          })
        }
        await requestUser.run(user, () => entry.transport.handleRequest(req, res, body))
        return
      }
      const entry = sessionId ? sessions.get(sessionId) : undefined
      if (!entry || entry.userId !== user.id) {
        return sendJson(res, 400, { error: 'invalid session', code: 'invalid_session' })
      }
      await requestUser.run(user, () => entry.transport.handleRequest(req, res))
    } catch (err) {
      if (!res.headersSent) sendJson(res, err.status || 500, { error: err.message || 'mcp error', code: err.code || 'mcp_error' })
    }
  })
}

async function main() {
  const enabled = enabledFlag(process.env.FILE_KB_ENABLED)
  const port = Number(process.env.FILE_KB_MCP_PORT || 18801)
  let authenticate = null
  let query = null
  let pool = null
  if (enabled && process.env.PGHOST && process.env.PGUSER) {
    const pgMod = await import('pg')
    const Pool = pgMod.Pool || pgMod.default.Pool
    pool = new Pool({
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT || 5432),
      database: process.env.PGDATABASE || 'mind_map',
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD || '',
      max: 4,
      application_name: 'file-kb-mcp',
      statement_timeout: 15000
    })
    const auth = createSessionAuth(pool)
    authenticate = req => auth.authenticate(req)
    query = (text, params) => pool.query(text, params)
  }
  const geekcloud = enabled
    ? createGeekcloud({ query, sdk: { Client, StreamableHTTPClientTransport }, log: m => console.log(m.replace('[file-kb]', '[file-kb-mcp]')) }).adapter
    : null
  const server = createMcpHttpServer({ enabled, authenticate, query, geekcloud })
  server.listen(port, process.env.FILE_KB_MCP_HOST || '0.0.0.0', () =>
    console.log(`[file-kb-mcp] listening on ${port} enabled=${enabled} transport=streamable-http auth=${authenticate ? 'fresh' : 'off'}`))
  const stop = () => server.close(() => { if (pool) pool.end().finally(() => process.exit(0)); else process.exit(0) })
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main()
