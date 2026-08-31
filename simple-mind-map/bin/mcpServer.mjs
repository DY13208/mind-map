#!/usr/bin/env node

import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

const API = (process.env.MIND_MAP_API || 'http://127.0.0.1:1234').replace(
  /\/$/,
  ''
)
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
      version: '1.1.0'
    },
    {
      instructions:
        '这是局域网思维导图的 MCP。除通用节点协同外，它按 CPDA 处理业务：SOP 的 C 是检查/验收标准，P 是执行计划；用户输入待办是 D，AI/WorkBuddy 负责 A。未提供房间号时先 list_maps，只有一张图可直接使用，多张图必须让用户确认。处理任务时先 prepare_todo，按 P 执行并在对话中展示缺失信息、进度、错误和人工事项；只有全部 C 通过后才能 complete_todo。未完成的任务始终留在「待办」，完成后才移入「已完成」。不得把过程日志写入导图。AI 可以 propose_sop_improvement，但未经用户明确确认不得 apply，也不得借通用节点工具绕过确认修改 SOP。工具返回 isError 表示没有写入，禁止声称已完成。'
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
            `/api/files/${encodeURIComponent(
              room_key
            )}/search?q=${encodeURIComponent(query)}`
          )
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.tool(
    'list_todos',
    '列出导图「待办」分支中的任务。默认不返回已完成任务；这不是执行工具，不会修改导图。',
    {
      room_key: z.string().describe('房间号'),
      include_completed: z
        .boolean()
        .describe('是否同时返回已完成任务，默认false')
        .optional()
    },
    async ({ room_key, include_completed }) => {
      try {
        const qs = include_completed ? '?include_completed=true' : ''
        return ok(
          await api(`/api/files/${encodeURIComponent(room_key)}/todos${qs}`)
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.tool(
    'prepare_todo',
    '处理任何业务待办前必须先调用。读取任务子树，匹配任意SOP目标，并返回其C检查项、P计划、版本和候选项。若match_status=needs_confirmation，先在对话中请用户选择候选SOP；若not_found，任务留在待办。该工具不会执行业务，也不会修改导图。',
    {
      room_key: z.string().describe('房间号'),
      task: z.string().describe('待办任务uid或任务标题'),
      sop: z
        .string()
        .describe('可选，用户确认后的SOP目标uid、标题或完整路径')
        .optional()
    },
    async ({ room_key, task, sop }) => {
      try {
        return ok(
          await api(
            `/api/files/${encodeURIComponent(room_key)}/todos/prepare`,
            {
              method: 'POST',
              body: JSON.stringify({ task, sop })
            }
          )
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.tool(
    'complete_todo',
    'AI完成P后调用。必须逐项提交prepare_todo返回的全部C叶子检查结果；仅当全部passed=true且SOP版本未变化时，才把整棵任务从「待办」移动到「已完成」。执行过程和错误不要写进导图。',
    {
      room_key: z.string().describe('房间号'),
      task: z.string().describe('待办任务uid或任务标题'),
      sop_uid: z.string().describe('prepare_todo返回的matched_sop.uid'),
      sop_version: z.string().describe('prepare_todo返回的matched_sop.version'),
      check_results: z
        .array(
          z.object({
            check_uid: z.string().describe('C叶子检查项uid'),
            passed: z.boolean().describe('该检查项是否已经通过'),
            evidence: z
              .string()
              .describe('可选验收依据，仅用于本次校验，不写入思维导图')
              .optional()
          })
        )
        .describe('全部C叶子检查项的结果'),
      summary: z
        .string()
        .describe('可选精简完成结果；保存为任务元数据，不新增过程节点')
        .optional()
    },
    async ({ room_key, ...body }) => {
      try {
        return ok(
          await api(
            `/api/files/${encodeURIComponent(room_key)}/todos/complete`,
            {
              method: 'POST',
              body: JSON.stringify(body)
            }
          )
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.tool(
    'propose_sop_improvement',
    '发现任意业务SOP的C或P存在缺失时生成结构化建议。此工具只返回建议和proposal_id，不修改思维导图；必须先把建议展示给用户确认。',
    {
      room_key: z.string().describe('房间号'),
      sop_uid: z.string().describe('要完善的SOP目标uid'),
      section: z.enum(['C', 'P']).describe('修改C检查规则或P执行计划'),
      action: z.enum(['add', 'update', 'delete']).describe('建议的修改动作'),
      node_uid: z
        .string()
        .describe('update/delete时必填，必须是对应C/P下的内容节点uid')
        .optional(),
      content: z.string().describe('add/update时的新节点内容').optional(),
      reason: z.string().describe('提出修改的业务原因')
    },
    async ({ room_key, ...body }) => {
      try {
        return ok(
          await api(
            `/api/files/${encodeURIComponent(room_key)}/sop/proposals`,
            {
              method: 'POST',
              body: JSON.stringify(body)
            }
          )
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.tool(
    'apply_sop_improvement',
    '仅在用户已经明确同意propose_sop_improvement展示的建议后调用。建议内容、proposal_id和SOP版本必须一致，否则拒绝写入。',
    {
      room_key: z.string().describe('房间号'),
      proposal_id: z
        .string()
        .describe('propose_sop_improvement返回的proposal_id'),
      sop_uid: z.string().describe('建议中的sop_uid'),
      sop_version: z.string().describe('建议中的sop_version'),
      section: z.enum(['C', 'P']).describe('建议中的section'),
      action: z.enum(['add', 'update', 'delete']).describe('建议中的action'),
      node_uid: z.string().describe('建议中的node_uid').optional(),
      content: z.string().describe('建议中的content').optional(),
      reason: z.string().describe('建议中的reason'),
      user_confirmed: z
        .boolean()
        .describe('只有用户在当前对话明确同意后才能传true')
    },
    async ({ room_key, ...body }) => {
      try {
        return ok(
          await api(
            `/api/files/${encodeURIComponent(room_key)}/sop/proposals/apply`,
            {
              method: 'POST',
              body: JSON.stringify(body)
            }
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
      note: z.string().describe('可选备注').optional(),
      confirm_sop_change: z
        .boolean()
        .describe('父节点属于SOP时，必须先获得用户确认并传true')
        .optional()
    },
    async ({ room_key, text, parent, note, confirm_sop_change }) => {
      try {
        return ok(
          await api(`/api/files/${encodeURIComponent(room_key)}/nodes`, {
            method: 'POST',
            body: JSON.stringify({
              text,
              parent: parent || 'root',
              note,
              confirm_sop_change
            })
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
      note: z.string().describe('新备注').optional(),
      confirm_sop_change: z
        .boolean()
        .describe('节点属于SOP时，必须先获得用户确认并传true')
        .optional()
    },
    async ({ room_key, node, text, note, confirm_sop_change }) => {
      try {
        return ok(
          await api(
            `/api/files/${encodeURIComponent(
              room_key
            )}/nodes/${encodeURIComponent(node)}`,
            {
              method: 'PATCH',
              body: JSON.stringify({ text, note, confirm_sop_change })
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
      node: z.string().describe('节点 uid 或文字路径'),
      confirm_sop_change: z
        .boolean()
        .describe('节点属于SOP时，必须先获得用户确认并传true')
        .optional()
    },
    async ({ room_key, node, confirm_sop_change }) => {
      try {
        return ok(
          await api(
            `/api/files/${encodeURIComponent(
              room_key
            )}/nodes/${encodeURIComponent(node)}`,
            {
              method: 'DELETE',
              body: JSON.stringify({ confirm_sop_change })
            }
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
      tree: z.any().describe('思维导图树，{ data: { text }, children: [] }'),
      confirm_sop_change: z
        .boolean()
        .describe('覆盖含SOP的导图前，必须先获得用户确认并传true')
        .optional()
    },
    async ({ room_key, title, tree, confirm_sop_change }) => {
      try {
        return ok(
          await api(`/api/files/${encodeURIComponent(room_key)}/replace`, {
            method: 'POST',
            body: JSON.stringify({ title, tree, confirm_sop_change })
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
    const url = new URL(
      req.url || '/',
      `http://${req.headers.host || 'localhost'}`
    )

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
          res.writeHead(404, {
            'Content-Type': 'application/json; charset=utf-8'
          })
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
        res.writeHead(400, {
          'Content-Type': 'application/json; charset=utf-8'
        })
        res.end(JSON.stringify({ error: 'invalid session' }))
        return
      }
      await transport.handleRequest(req, res)
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, {
          'Content-Type': 'application/json; charset=utf-8'
        })
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
