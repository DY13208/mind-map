const assert = require('assert')
const http = require('http')
const path = require('path')
const { spawn } = require('child_process')

const TOKEN = 'mcp-history-test-token-32-characters'
const CLIENT_ID = 'mcp-history-test-client'

function version(id = 'ver-1') {
  return {
    versionId: id,
    revision: 7,
    checkpointRevision: 5,
    name: '发布前',
    type: 'MANUAL',
    createdBy: '测试用户',
    createdById: 'user-1',
    createdAt: '2026-09-21T01:00:00.000Z',
    description: '发布前备份',
    source: 'manual',
    sourceKind: 'manual',
    editors: [{ userId: 'user-1', name: '测试用户' }],
    summary: { inserted: 2, updated: 3, deleted: 1, moved: 4, restored: 9 },
    summaryStatus: 'ready',
    summaryText: '新增 2 · 修改 3 · 删除 1 · 移动 4',
    availability: 'readable',
    readOnly: true,
    capabilities: { canCreate: true, canRestore: true },
    tree: { secret: 'history tree must not reach MCP' },
    metadata: { secret: 'history metadata must not reach MCP' }
  }
}

function coverage() {
  return {
    earliestAvailableRevision: 5,
    currentRevision: 9,
    completeFromRevision: 5,
    historyStartRevision: 5
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
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
      // process is still starting
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`MCP did not become ready: ${stderr.join('')}`)
}

function parseRpcBody(raw) {
  if (!raw) return null
  if (!raw.startsWith('event:') && !raw.includes('\ndata:'))
    return JSON.parse(raw)
  let data = null
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    data = JSON.parse(line.slice(5).trim())
  }
  return data
}

async function main() {
  const requests = []
  const apiServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    const body = raw ? JSON.parse(raw) : null
    requests.push({
      method: req.method,
      pathname: url.pathname,
      searchParams: Object.fromEntries(url.searchParams),
      headers: req.headers,
      body
    })

    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      return sendJson(res, 401, { code: 'unauthorized', error: 'unauthorized' })
    }
    if (req.headers['x-client-id'] !== CLIENT_ID) {
      return sendJson(res, 400, {
        code: 'CLIENT_ID_REQUIRED',
        error: 'client id missing'
      })
    }
    if (
      url.pathname.includes('/viewer-room/versions') &&
      req.method === 'POST'
    ) {
      return sendJson(res, 403, { code: 'FORBIDDEN', error: '没有编辑权限' })
    }
    if (
      url.pathname.includes('/editor-room/versions/') &&
      url.pathname.endsWith('/restore')
    ) {
      return sendJson(res, 403, { code: 'FORBIDDEN', error: '没有管理权限' })
    }
    if (url.pathname.endsWith('/conflict/restore')) {
      return sendJson(res, 409, {
        code: 'RESTORE_CONFLICT',
        error: 'current revision changed'
      })
    }
    if (
      req.method === 'GET' &&
      url.pathname === '/api/files/room-after-restore' &&
      url.searchParams.get('format') === 'meta'
    ) {
      return sendJson(res, 200, { room_key: 'room-after-restore', revision: 10 })
    }
    if (
      req.method === 'POST' &&
      url.pathname === '/api/files/room-after-restore/nodes'
    ) {
      return sendJson(res, 200, { ok: true, uid: 'new-node', version: 11 })
    }
    if (req.method === 'GET' && /\/versions$/.test(url.pathname)) {
      return sendJson(res, 200, {
        ok: true,
        versions: [version()],
        nextCursor: 'next-page',
        ...coverage()
      })
    }
    if (req.method === 'GET' && /\/versions\/[^/]+$/.test(url.pathname)) {
      return sendJson(res, 200, { ok: true, version: version(), ...coverage() })
    }
    if (req.method === 'POST' && /\/versions$/.test(url.pathname)) {
      return sendJson(res, 201, {
        ok: true,
        version: version('created-version'),
        ...coverage()
      })
    }
    if (req.method === 'POST' && url.pathname.endsWith('/restore')) {
      return sendJson(res, 200, {
        ok: true,
        fromRevision: 9,
        targetRevision: 7,
        newRevision: 10,
        preRestoreVersionId: 'pre-restore',
        restoreVersionId: 'restored-version',
        ...coverage(),
        currentRevision: 10
      })
    }
    return sendJson(res, 404, { code: 'NOT_FOUND', error: 'not found' })
  })

  const apiPort = await listen(apiServer)
  const mcpPort = await freePort()
  const stderr = []
  const child = spawn(process.execPath, ['bin/mcpServer.mjs', '--http'], {
    cwd: path.resolve(__dirname, '..'),
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
    const rawResponse = await response.text()
    assert.ok(response.ok, `${method} HTTP ${response.status}: ${rawResponse}`)
    const parsed = parseRpcBody(rawResponse)
    assert.ok(
      parsed && parsed.result,
      `${method} missing result: ${rawResponse}`
    )
    return parsed.result
  }

  function toolText(result) {
    return JSON.parse(
      (result.content || []).map(item => item.text || '').join('')
    )
  }

  async function callTool(name, args) {
    return rpc('tools/call', { name, arguments: args })
  }

  try {
    await waitReady(`http://127.0.0.1:${mcpPort}/health`, child, stderr)
    await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mcp-history-test', version: '1.0.0' }
    })

    const listedTools = await rpc('tools/list', {})
    const tools = new Map(listedTools.tools.map(tool => [tool.name, tool]))
    const expectedTools = [
      'list_versions',
      'get_version',
      'create_version',
      'restore_version'
    ]
    expectedTools.forEach(name =>
      assert.ok(tools.has(name), `missing MCP tool ${name}`)
    )
    assert.deepStrictEqual(tools.get('list_versions').inputSchema.required, [
      'room_key'
    ])
    assert.deepStrictEqual(tools.get('get_version').inputSchema.required, [
      'room_key',
      'version_id'
    ])
    assert.deepStrictEqual(tools.get('create_version').inputSchema.required, [
      'room_key',
      'name'
    ])
    assert.deepStrictEqual(tools.get('restore_version').inputSchema.required, [
      'room_key',
      'version_id',
      'expected_current_revision',
      'confirm'
    ])

    const listResult = await callTool('list_versions', {
      room_key: 'room/a',
      limit: 20,
      cursor: 'cursor-1',
      type: 'MANUAL',
      created_by: 'user-1',
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-30T23:59:59.999Z'
    })
    assert.strictEqual(listResult.isError, undefined)
    const listData = toolText(listResult)
    assert.deepStrictEqual(listData.versions[0].summary, {
      inserted: 2,
      updated: 3,
      deleted: 1,
      moved: 4
    })
    assert.strictEqual(listData.currentRevision, 9)
    assert.ok(
      !JSON.stringify(listData).includes('history tree must not reach MCP')
    )
    const listRequest = requests.at(-1)
    assert.strictEqual(listRequest.pathname, '/api/files/room%2Fa/versions')
    assert.deepStrictEqual(listRequest.searchParams, {
      limit: '20',
      cursor: 'cursor-1',
      type: 'MANUAL',
      createdBy: 'user-1',
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-30T23:59:59.999Z'
    })

    const getResult = await callTool('get_version', {
      room_key: 'room/a',
      version_id: 'ver/1'
    })
    const getData = toolText(getResult)
    assert.strictEqual(getData.version.versionId, 'ver-1')
    assert.ok(
      !JSON.stringify(getData).includes('history tree must not reach MCP')
    )
    assert.strictEqual(
      requests.at(-1).pathname,
      '/api/files/room%2Fa/versions/ver%2F1'
    )

    const createResult = await callTool('create_version', {
      room_key: 'room-a',
      name: '发布前',
      description: '手动备份'
    })
    assert.strictEqual(
      toolText(createResult).version.versionId,
      'created-version'
    )
    const createRequest = requests.at(-1)
    assert.deepStrictEqual(createRequest.body, {
      name: '发布前',
      description: '手动备份'
    })
    assert.strictEqual(createRequest.headers.authorization, `Bearer ${TOKEN}`)
    assert.strictEqual(createRequest.headers['x-client-id'], CLIENT_ID)

    for (const args of [
      { room_key: 'room-a', version_id: 'ver-1', expected_current_revision: 9 },
      {
        room_key: 'room-a',
        version_id: 'ver-1',
        expected_current_revision: 9,
        confirm: false
      },
      { room_key: 'room-a', expected_current_revision: 9, confirm: true },
      { room_key: 'room-a', version_id: 'ver-1', confirm: true }
    ]) {
      const count = requests.length
      const invalid = await callTool('restore_version', args)
      assert.strictEqual(invalid.isError, true)
      assert.strictEqual(
        requests.length,
        count,
        'invalid restore must not call API'
      )
    }

    const restoreResult = await callTool('restore_version', {
      room_key: 'room-a',
      version_id: 'ver-1',
      expected_current_revision: 9,
      confirm: true
    })
    const restoreData = toolText(restoreResult)
    assert.strictEqual(restoreData.preRestoreVersionId, 'pre-restore')
    assert.strictEqual(restoreData.restoreVersionId, 'restored-version')
    assert.strictEqual(restoreData.newRevision, 10)
    const restoreRequest = requests.at(-1)
    assert.strictEqual(restoreRequest.body.expectedCurrentRevision, 9)
    assert.strictEqual(restoreRequest.body.clientId, CLIENT_ID)
    assert.ok(restoreRequest.body.idempotencyKey)
    assert.strictEqual(
      restoreRequest.headers['idempotency-key'],
      restoreRequest.body.idempotencyKey
    )

    const writeAfterRestore = await callTool('add_node', {
      room_key: 'room-after-restore',
      text: '恢复后的新节点'
    })
    assert.strictEqual(writeAfterRestore.isError, undefined)
    assert.strictEqual(toolText(writeAfterRestore).uid, 'new-node')
    const nodeRequest = requests.at(-1)
    assert.strictEqual(nodeRequest.pathname, '/api/files/room-after-restore/nodes')
    assert.strictEqual(nodeRequest.body.baseVersion, 10)
    assert.strictEqual(nodeRequest.body.text, '恢复后的新节点')
    assert.strictEqual(requests.at(-2).pathname, '/api/files/room-after-restore')
    assert.strictEqual(requests.at(-2).searchParams.format, 'meta')

    const conflict = await callTool('restore_version', {
      room_key: 'room-a',
      version_id: 'conflict',
      expected_current_revision: 9,
      confirm: true
    })
    assert.strictEqual(conflict.isError, true)
    assert.deepStrictEqual(toolText(conflict), {
      ok: false,
      code: 'RESTORE_CONFLICT',
      error: 'current revision changed',
      statusCode: 409
    })

    const viewerCreate = await callTool('create_version', {
      room_key: 'viewer-room',
      name: '不允许'
    })
    assert.strictEqual(viewerCreate.isError, true)
    assert.strictEqual(toolText(viewerCreate).code, 'FORBIDDEN')
    const editorRestore = await callTool('restore_version', {
      room_key: 'editor-room',
      version_id: 'ver-1',
      expected_current_revision: 9,
      confirm: true
    })
    assert.strictEqual(editorRestore.isError, true)
    assert.strictEqual(toolText(editorRestore).code, 'FORBIDDEN')

    console.log('mcpHistory.test.js ok')
  } finally {
    child.kill()
    await new Promise(resolve => apiServer.close(resolve))
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
