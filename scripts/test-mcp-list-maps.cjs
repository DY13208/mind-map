const assert = require('assert')
const http = require('http')
const path = require('path')
const { spawn } = require('child_process')
const {
  createFileSystem,
  createMemoryFileStore
} = require('../simple-mind-map/bin/fileSystem')

const TOKEN = 'mcp-list-maps-test-token-32-characters'
const CLIENT_ID = 'mcp-list-maps-test-client'
const OWNER = 'mcp-list-maps-owner'
const VIEWER = 'mcp-list-maps-viewer'
const ROOM_COUNT = 257

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

async function freePort() {
  const server = http.createServer()
  const port = await listen(server)
  await new Promise(resolve => server.close(resolve))
  return port
}

async function waitReady(url, child, stderr) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`MCP exited ${child.exitCode}: ${stderr.join('')}`)
    }
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch (_) {
      // The process is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`MCP did not become ready: ${stderr.join('')}`)
}

function parseRpcBody(raw) {
  if (!raw) return null
  if (!raw.startsWith('event:') && !raw.includes('\ndata:')) return JSON.parse(raw)
  let data = null
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('data:')) data = JSON.parse(line.slice(5).trim())
  }
  return data
}

async function main() {
  const store = createMemoryFileStore()
  const fs = createFileSystem({
    store,
    history: { async ensureHistoryBaseline() { return { revision: 0 } } }
  })
  const visibleRooms = []

  for (let i = 0; i < ROOM_COUNT; i += 1) {
    const title = i % 2 === 0
      ? `SOP 流程 ${String(i).padStart(3, '0')}`
      : `普通事项 ${String(i).padStart(3, '0')}`
    const created = await fs.createRoom({ title, userId: OWNER })
    if (i % 5 !== 0) {
      store.members.push({
        room_key: created.room.roomKey,
        user_id: VIEWER,
        role: 'viewer',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      visibleRooms.push({ roomKey: created.room.roomKey, title })
    }
  }

  const apiRequests = []
  const apiServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    apiRequests.push({ method: req.method, pathname: url.pathname, url })

    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      return sendJson(res, 401, { code: 'unauthorized', error: 'unauthorized' })
    }
    if (req.headers['x-client-id'] !== CLIENT_ID) {
      return sendJson(res, 400, { code: 'CLIENT_ID_REQUIRED', error: 'client id missing' })
    }

    if (req.method === 'GET' && url.pathname === '/api/files') {
      try {
        const listed = await fs.listRooms({
          userId: VIEWER,
          q: url.searchParams.get('q') || '',
          limit: Number(url.searchParams.get('limit') || 20),
          cursor: url.searchParams.get('cursor') || '',
          sort: 'updatedAt',
          order: 'desc'
        })
        return sendJson(res, 200, {
          ok: true,
          list: listed.list,
          total: listed.total,
          limit: listed.limit,
          offset: listed.offset,
          nextCursor: listed.nextCursor
        })
      } catch (err) {
        return sendJson(res, err.statusCode || 400, {
          ok: false,
          code: err.code || 'FILE_SYSTEM_ERROR',
          error: err.message
        })
      }
    }

    if (
      req.method === 'POST' &&
      /^\/api\/files\/[^/]+\/export-tree$/.test(url.pathname)
    ) {
      return sendJson(res, 200, {
        ok: true,
        complete: true,
        room_key: 'export-room',
        summary: { node_count: 1 },
        nodes: [{ uid: 'root', text: '导出仍可用' }],
        edges: [],
        references: []
      })
    }

    return sendJson(res, 404, { code: 'NOT_FOUND', error: 'not found' })
  })

  const apiPort = await listen(apiServer)
  const mcpPort = await freePort()
  const stderr = []
  const child = spawn(process.execPath, ['bin/mcpServer.mjs', '--http'], {
    cwd: path.resolve(__dirname, '..', 'simple-mind-map'),
    env: {
      ...process.env,
      MIND_MAP_API: `http://127.0.0.1:${apiPort}`,
      MCP_PORT: String(mcpPort),
      MCP_HOST: '127.0.0.1',
      MCP_TOKEN: TOKEN,
      MCP_CLIENT_ID: CLIENT_ID
    },
    stdio: ['ignore', 'ignore', 'pipe']
  })
  child.stderr.on('data', chunk => stderr.push(String(chunk)))

  const mcpUrl = `http://127.0.0.1:${mcpPort}/mcp`
  let sessionId = ''
  let rpcId = 0
  async function rpc(method, params) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${TOKEN}`,
      'MCP-Protocol-Version': '2024-11-05'
    }
    if (sessionId) headers['mcp-session-id'] = sessionId
    const body = { jsonrpc: '2.0', id: ++rpcId, method }
    if (params !== undefined) body.params = params
    const response = await fetch(mcpUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    })
    sessionId = response.headers.get('mcp-session-id') || sessionId
    const raw = await response.text()
    assert.ok(response.ok, `${method} HTTP ${response.status}: ${raw}`)
    const parsed = parseRpcBody(raw)
    assert.ok(parsed && parsed.result, `${method} missing result: ${raw}`)
    return parsed.result
  }

  function toolText(result) {
    return JSON.parse((result.content || []).map(item => item.text || '').join(''))
  }

  async function callTool(name, args) {
    return rpc('tools/call', { name, arguments: args })
  }

  try {
    await waitReady(`http://127.0.0.1:${mcpPort}/health`, child, stderr)
    await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mcp-list-maps-test', version: '1.0.0' }
    })

    const listedTools = await rpc('tools/list', {})
    const tools = new Map(listedTools.tools.map(tool => [tool.name, tool]))
    for (const name of ['list_maps', 'get_map', 'query_nodes', 'search_nodes', 'export_room_tree', 'read_room_export']) {
      assert.ok(tools.has(name), `missing existing MCP tool ${name}`)
    }
    assert.ok(!tools.has('get_performance_diagnostics'))
    assert.deepStrictEqual(
      Object.keys(tools.get('list_maps').inputSchema.properties).sort(),
      ['cursor', 'limit', 'query']
    )

    const defaultPage = toolText(await callTool('list_maps', {}))
    assert.strictEqual(defaultPage.list.length, 20)
    assert.strictEqual(defaultPage.total, visibleRooms.length)
    assert.strictEqual(defaultPage.has_more, true)
    assert.strictEqual(defaultPage.next_cursor, defaultPage.nextCursor)
    assert.strictEqual(apiRequests.at(-1).url.searchParams.get('limit'), '20')

    const invalidLimitRequests = apiRequests.length
    const invalidLimit = await callTool('list_maps', { limit: 101 })
    assert.strictEqual(invalidLimit.isError, true)
    assert.strictEqual(apiRequests.length, invalidLimitRequests)

    const collected = []
    let page = toolText(await callTool('list_maps', { limit: 100 }))
    let pageCount = 0
    while (true) {
      pageCount += 1
      assert.ok(page.list.length <= 100)
      assert.strictEqual(page.total, visibleRooms.length)
      assert.ok(page.list.every(room => room.role === 'viewer'))
      collected.push(...page.list)
      if (!page.has_more) break
      assert.ok(page.next_cursor)
      page = toolText(await callTool('list_maps', {
        limit: 100,
        cursor: page.next_cursor
      }))
    }
    assert.strictEqual(pageCount, 3, '205 accessible rooms should span three pages')
    assert.strictEqual(collected.length, visibleRooms.length)
    assert.strictEqual(new Set(collected.map(room => room.roomKey)).size, visibleRooms.length)
    assert.deepStrictEqual(
      new Set(collected.map(room => room.roomKey)),
      new Set(visibleRooms.map(room => room.roomKey))
    )
    assert.ok(collected.every(room => room.title && room.roomKey))
    const pagedApiRequests = apiRequests.filter(item => item.pathname === '/api/files')
    assert.ok(pagedApiRequests.some(item => item.url.searchParams.has('cursor')))
    assert.ok(pagedApiRequests.every(item => !item.url.searchParams.has('query')))

    const searchable = visibleRooms.filter(room => room.title.includes('SOP'))
    assert.ok(searchable.length > 100)
    const searched = []
    let searchPage = toolText(await callTool('list_maps', {
      limit: 60,
      query: 'SOP'
    }))
    while (true) {
      assert.ok(searchPage.list.every(room => room.title.includes('SOP')))
      searched.push(...searchPage.list)
      if (!searchPage.has_more) break
      searchPage = toolText(await callTool('list_maps', {
        limit: 60,
        query: 'SOP',
        cursor: searchPage.next_cursor
      }))
    }
    assert.strictEqual(searched.length, searchable.length)
    assert.deepStrictEqual(
      new Set(searched.map(room => room.roomKey)),
      new Set(searchable.map(room => room.roomKey))
    )
    const searchRequests = apiRequests.filter(
      item => item.pathname === '/api/files' && item.url.searchParams.get('q') === 'SOP'
    )
    assert.ok(searchRequests.length >= 2)
    assert.ok(searchRequests.every(item => !item.url.searchParams.has('query')))

    const invalidCursor = await callTool('list_maps', {
      limit: 20,
      cursor: '%%%broken-cursor%%%'
    })
    assert.strictEqual(invalidCursor.isError, true)
    assert.match(
      (invalidCursor.content || []).map(item => item.text || '').join(''),
      /分页游标无效/
    )

    const exported = toolText(await callTool('export_room_tree', {
      room_key: 'export-room'
    }))
    assert.strictEqual(exported.complete, true)
    assert.strictEqual(exported.nodes[0].uid, 'root')
    assert.ok(apiRequests.some(item => item.pathname === '/api/files/export-room/export-tree'))

    console.log('mcpListMaps.test.js ok')
  } finally {
    child.kill()
    await new Promise(resolve => apiServer.close(resolve))
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
