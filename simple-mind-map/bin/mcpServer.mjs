#!/usr/bin/env node

import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

const API = (process.env.MIND_MAP_API || 'http://127.0.0.1:1234').replace(/\/$/, '')
const MCP_PORT = Number(process.env.MCP_PORT || 3847)
const MCP_HOST = process.env.MCP_HOST || '0.0.0.0'
const MCP_TOKEN = process.env.MCP_TOKEN || ''

function ok(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }]
  }
}

function fail(err) {
  return {
    isError: true,
    content: [{ type: 'text', text: err.message || String(err) }]
  }
}

async function api(path, options = {}) {
  const { timeoutMs = 25000, headers, ...rest } = options
  const res = await fetch(`${API}${path}`, {
    ...rest,
    headers: {
      'Content-Type': 'application/json',
      ...(MCP_TOKEN ? { Authorization: `Bearer ${MCP_TOKEN}` } : {}),
      ...(headers || {})
    },
    signal: AbortSignal.timeout(timeoutMs)
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || res.statusText || `HTTP ${res.status}`)
  }
  return data
}

function createServer() {
  const server = new McpServer(
    {
      name: 'mind-map',
      version: '1.0.0'
    },
    {
      instructions:
        '这是局域网思维导图的 MCP。工具写入的房间与网页协同是同一份 Yjs 文档：人在浏览器打开 share_url，WorkBuddy/AI 用这些工具改节点，双方实时看到。先 get_map 看 outline，优先用节点后面的 [uid] 再增删改。node 也可用完整标题或能唯一命中的部分文字（例如「蔡徐坤」可命中「分支主题蔡徐坤」）。工具返回 isError 或「找不到节点」表示没有写入，禁止声称已改好。'
    }
  )

  server.tool(
    'list_maps',
    '列出全部思维导图房间，含标题和给人类打开的 share_url',
    {},
    async () => {
      try {
        return ok(await api('/api/files'))
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.tool(
    'create_map',
    '新建一张导图并返回房间号、分享链接。人类用 share_url 即可加入同一房间协同。',
    {
      title: z.string().describe('根节点标题').optional(),
      room_key: z.string().describe('可选自定义房间号').optional()
    },
    async ({ title, room_key }) => {
      try {
        return ok(
          await api('/api/files', {
            method: 'POST',
            body: JSON.stringify({ title, room_key })
          })
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.tool(
    'get_map',
    '读取一张导图。format=outline（默认）只返回大纲（每行带 uid，默认最多 800 个节点，超出请 search_nodes）；format=full 只返回完整树。两种格式不会叠在一起。日常先 outline，需要整图结构时再 full。',
    {
      room_key: z.string().describe('房间号'),
      format: z
        .enum(['outline', 'full'])
        .describe('outline=只返回大纲；full=只返回完整树')
        .optional(),
      max_nodes: z
        .number()
        .int()
        .min(1)
        .max(5000)
        .describe('outline 最大节点数，默认 800')
        .optional()
    },
    async ({ room_key, format, max_nodes }) => {
      try {
        const mode = format === 'full' ? 'full' : 'outline'
        const qs =
          mode === 'outline'
            ? `?format=outline&max_nodes=${max_nodes || 800}`
            : '?format=full'
        return ok(
          await api(`/api/files/${encodeURIComponent(room_key)}${qs}`, {
            timeoutMs: mode === 'full' ? 45000 : 25000
          })
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.tool(
    'search_nodes',
    '在指定导图里按文字搜索节点',
    {
      room_key: z.string().describe('房间号'),
      query: z.string().describe('搜索关键词')
    },
    async ({ room_key, query }) => {
      try {
        return ok(
          await api(
            `/api/files/${encodeURIComponent(room_key)}/search?q=${encodeURIComponent(query)}`
          )
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.tool(
    'add_node',
    '在指定节点下新增子节点。parent 可以是 uid、root，或路径如「根节点/产品」。成功只返回 uid，不返回整图。',
    {
      room_key: z.string().describe('房间号'),
      text: z.string().describe('节点文字'),
      parent: z
        .string()
        .describe('父节点 uid / root / 文字路径，默认加到根下')
        .optional(),
      note: z.string().describe('可选备注').optional()
    },
    async ({ room_key, text, parent, note }) => {
      try {
        return ok(
          await api(`/api/files/${encodeURIComponent(room_key)}/nodes`, {
            method: 'POST',
            body: JSON.stringify({ text, parent: parent || 'root', note })
          })
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.tool(
    'update_node',
    '修改节点文字或备注。node 优先用 get_map outline 里的 uid；也可用完整标题、部分文字或 根/父/子 路径。成功只返回 uid。工具报错即未写入。',
    {
      room_key: z.string().describe('房间号'),
      node: z.string().describe('节点 uid 或文字路径'),
      text: z.string().describe('新文字').optional(),
      note: z.string().describe('新备注').optional()
    },
    async ({ room_key, node, text, note }) => {
      try {
        return ok(
          await api(
            `/api/files/${encodeURIComponent(room_key)}/nodes/${encodeURIComponent(node)}`,
            {
              method: 'PATCH',
              body: JSON.stringify({ text, note })
            }
          )
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.tool(
    'delete_node',
    '删除节点及其全部子节点。不能删根节点。成功只返回 uid，不返回整图。',
    {
      room_key: z.string().describe('房间号'),
      node: z.string().describe('节点 uid 或文字路径')
    },
    async ({ room_key, node }) => {
      try {
        return ok(
          await api(
            `/api/files/${encodeURIComponent(room_key)}/nodes/${encodeURIComponent(node)}`,
            { method: 'DELETE' }
          )
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.tool(
    'replace_tree',
    '用完整树一次性覆盖整张导图。适合 AI 生成整图。tree 格式：{ data: { text }, children: [...] }',
    {
      room_key: z.string().describe('房间号'),
      title: z.string().describe('可选标题').optional(),
      tree: z
        .any()
        .describe('思维导图树，{ data: { text }, children: [] }')
    },
    async ({ room_key, title, tree }) => {
      try {
        return ok(
          await api(`/api/files/${encodeURIComponent(room_key)}/replace`, {
            method: 'POST',
            body: JSON.stringify({ title, tree })
          })
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.tool(
    'rename_map',
    '重命名导图房间标题',
    {
      room_key: z.string().describe('房间号'),
      title: z.string().describe('新标题')
    },
    async ({ room_key, title }) => {
      try {
        return ok(
          await api(`/api/files/${encodeURIComponent(room_key)}`, {
            method: 'PATCH',
            body: JSON.stringify({ title })
          })
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.tool(
    'delete_map',
    '删除整张导图（房间、存储都会删）',
    {
      room_key: z.string().describe('房间号')
    },
    async ({ room_key }) => {
      try {
        return ok(
          await api(`/api/files/${encodeURIComponent(room_key)}`, {
            method: 'DELETE'
          })
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.tool(
    'get_share_link',
    '生成给人类打开的网页协同链接，打开后自动加入同一房间',
    {
      room_key: z.string().describe('房间号')
    },
    async ({ room_key }) => {
      try {
        const data = await api(
          `/api/files/${encodeURIComponent(room_key)}?format=meta`
        )
        return ok({
          room_key,
          title: data.title,
          share_url: data.share_url
        })
      } catch (err) {
        return fail(err)
      }
    }
  )

  return server
}

function authorized(req) {
  if (!MCP_TOKEN) return true
  const header = String(req.headers.authorization || '')
  return header === `Bearer ${MCP_TOKEN}`
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, mcp-session-id, MCP-Protocol-Version'
  )
  res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id')
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve(undefined)
      try {
        resolve(JSON.parse(raw))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

async function startHttp() {
  const transports = new Map()

  const httpServer = http.createServer(async (req, res) => {
    setCors(res)
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true, api: API }))
      return
    }

    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'not found' }))
      return
    }

    if (!authorized(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }

    try {
      const sessionId = req.headers['mcp-session-id']
      if (req.method === 'POST') {
        const body = await readJson(req)
        let transport = sessionId ? transports.get(sessionId) : undefined
        if (!transport && isInitializeRequest(body)) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: id => {
              transports.set(id, transport)
            }
          })
          transport.onclose = () => {
            if (transport.sessionId) transports.delete(transport.sessionId)
          }
          const server = createServer()
          await server.connect(transport)
        }
        if (!transport) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: {
                code: -32001,
                message: 'Session expired, please reinitialize'
              },
              id: body && body.id != null ? body.id : null
            })
          )
          return
        }
        await transport.handleRequest(req, res, body)
        return
      }

      const transport = sessionId ? transports.get(sessionId) : undefined
      if (!transport) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'invalid session' }))
        return
      }
      await transport.handleRequest(req, res)
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: err.message || 'mcp error' }))
      }
    }
  })

  httpServer.listen(MCP_PORT, MCP_HOST, () => {
    console.error(`Mind-map MCP HTTP: http://${MCP_HOST}:${MCP_PORT}/mcp`)
    console.error(`Collab API: ${API}`)
  })
}

async function startStdio() {
  const server = createServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

const httpMode = process.argv.includes('--http')
if (httpMode) {
  startHttp().catch(err => {
    console.error(err)
    process.exit(1)
  })
} else {
  startStdio().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
