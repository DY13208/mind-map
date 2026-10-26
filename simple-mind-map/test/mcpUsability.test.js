'use strict'

// Real MCP transport against a local in-memory HTTP backend. Not a PG/bridge acceptance.
const assert = require('node:assert/strict')
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')
const vm = require('node:vm')
const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { once } = require('node:events')
const { queryLegacyNodes } = require('../bin/nodeQuery')
const { assertNodeWritePreconditions } = require('../bin/nodeUpdateExpected')
const { stampFieldVersions } = require('../bin/fieldMerge')
const { buildNodeWriteHints, buildWriteGuidance, decorateBatchResult } = require('../bin/mcpWriteGuidance')

const TOKEN = 'mcp-usability-local-test-only-32-characters'
const source = fs.readFileSync(path.resolve(__dirname, '../bin/mindApi.js'), 'utf8')
const serializerStart = source.indexOf('function serializeMapOperationError(')
const serializerEnd = source.indexOf('\n}', serializerStart) + 2
assert.ok(serializerStart >= 0 && serializerEnd > serializerStart)
const sandbox = {}
vm.runInNewContext(source.slice(serializerStart, serializerEnd) + '\nthis.serialize = serializeMapOperationError', sandbox)

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}
async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server.address().port
}
function parseRpc(raw) {
  if (!raw.includes('data:')) return JSON.parse(raw)
  return raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)))[0]
}
function content(result) { return JSON.parse(result.content.find(block => block.type === 'text').text) }

async function main() {
  let checks = 0
  function check(label, fn) { fn(); checks++; console.log('PASS ' + label) }
  check('hint values, missing zero versions, malformed groups, and immutability', () => {
    const data = { __fv: { text: 12, note: '4', hyperlink: -1 } }
    const snapshot = JSON.stringify(data)
    const result = buildNodeWriteHints('node-1', data)
    assert.deepEqual(result.writeHints.update.text, { uid: 'node-1', '__fv.text': 12 })
    assert.deepEqual(result.writeHints.update.note, { uid: 'node-1', '__fv.note': 4 })
    assert.equal(result.writeHints.update.hyperlink, undefined)
    assert.equal(result.warnings.length, 1)
    assert.equal(JSON.stringify(data), snapshot)
    assert.equal(buildNodeWriteHints('old', {}).writeHints.update.text['__fv.text'], 0)
    for (const invalid of [null, [], 'bad']) assert.equal(buildNodeWriteHints('bad', { __fv: invalid }).writeHints, null)
    for (const invalid of [NaN, Infinity, true, '', null, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(buildNodeWriteHints('bad', { __fv: { text: invalid } }).writeHints.update.text, undefined)
    }
  })
  check('guidance is presentation-only and unknown outcomes never invite new intent', () => {
    const original = { outcome: 'partial', version: 9, items: [{ index: 0, status: 'failed', code: 'PRECONDITION_REQUIRED' }] }
    const snapshot = JSON.stringify(original)
    const decorated = decorateBatchResult(original, { args: { operations: [{ op: 'update', text: 'new', expected: { uid: 'n', __fv: { text: 1 } } }] } })
    assert.equal(decorated.items[0].guidance.reason, 'nested_field_version')
    assert.equal(JSON.stringify(original), snapshot)
    assert.equal(decorated.outcome, original.outcome)
    const unknown = buildWriteGuidance({ outcomeUnknown: true, code: 'MCP_DIRECT_UNAVAILABLE' })
    assert.equal(unknown.reason, 'outcome_unknown')
    assert.equal(unknown.next_action, 'verify_same_operation')
    assert.equal(unknown.auto_retry_allowed, false)
    const deleting = buildWriteGuidance({ code: 'PRECONDITION_REQUIRED' }, { args: { op: 'delete' } })
    assert.deepEqual(deleting.required_expected_keys, ['uid', 'subtree_token'])
    assert.match(deleting.message, /include_subtree_token/)
    assert.ok(!deleting.message.includes('__fv.text'))
    const moving = buildWriteGuidance({ code: 'PRECONDITION_REQUIRED' }, { args: { op: 'move' } })
    assert.deepEqual(moving.required_expected_keys, ['uid', 'parent_uid', 'position'])
    assert.match(moving.message, /anchor_side/)
    const unknownReason = buildWriteGuidance({ code: 'MCP_DIRECT_UNAVAILABLE', details: { fallbackReason: 'secret-string' } })
    assert.ok(!JSON.stringify(unknownReason).includes('secret-string'))
  })

  let revision = 20
  let data = { uid: 'node-1', text: 'before', note: 'note', hyperlink: 'https://example.test/old', __fv: { text: 12, note: 4, hyperlink: 2 } }
  const requests = []
  const receipt = { outcome: 'partial', version: 21, items: [
    { index: 0, status: 'applied', result: { uid: 'new' } },
    { index: 1, status: 'failed', code: 'PRECONDITION_REQUIRED', message: 'missing expected' },
    { index: 2, status: 'dependency_failed', code: 'MCP_BATCH_DEPENDENCY_FAILED', depends_on: [1] }
  ] }
  const api = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null
      requests.push({ method: req.method, pathname: url.pathname, body, operationId: req.headers['x-operation-id'] })
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(res, 401, { error: 'unauthorized' })
      if (req.method === 'GET' && url.pathname.startsWith('/api/files/')) return json(res, 200, { revision })
      if (url.pathname.endsWith('/nodes/query')) {
        return json(res, 200, queryLegacyNodes({ 'node-1': { isRoot: true, data, children: [] } }, 'test', revision, body))
      }
      if (req.method === 'PATCH') {
        if (url.pathname.includes('/viewer/')) return json(res, 403, { error: '没有编辑权限', code: 'FORBIDDEN' })
        if (url.pathname.includes('/sop/')) return json(res, 403, { error: 'SOP需要用户确认', code: 'SOP_CONFIRM_REQUIRED' })
        const patch = Object.fromEntries(['text', 'note', 'hyperlink', 'hyperlinkTitle'].filter(key => body[key] !== undefined).map(key => [key, body[key]]))
        assertNodeWritePreconditions({ type: 'node.update', uid: 'node-1', payload: { patch, expected: body.expected }, baselineNode: { data } })
        revision++
        data = stampFieldVersions({ ...data, ...patch }, Object.keys(patch), revision)
        return json(res, 200, { uid: 'node-1', version: revision })
      }
      if (url.pathname.endsWith('/operations')) {
        if (url.pathname.includes('/unknown/')) return json(res, 500, { error: 'upstream failed', code: 'HTTP_500' })
        if (url.pathname.includes('/receipt/')) return json(res, 200, receipt)
        if (url.pathname.includes('/all-failed/')) return json(res, 200, { ...receipt, outcome: 'all_failed', items: receipt.items.slice(1) })
        const fallbackReason = decodeURIComponent(url.pathname.split('/')[3])
        const error = Object.assign(new Error('MCP Direct 批量写入不可用'), {
          code: 'MCP_DIRECT_UNAVAILABLE', statusCode: fallbackReason === 'direct_policy_unsupported' ? 400 : 503,
          details: { fallbackReason, sql: 'must-not-leak', token: 'must-not-leak' }
        })
        const serialized = sandbox.serialize(error)
        return json(res, serialized.status, serialized.body)
      }
      return json(res, 404, { error: 'not found' })
    } catch (error) { return json(res, error.statusCode || 500, { error: error.message, code: error.code }) }
  })
  const apiPort = await listen(api)
  const portProbe = http.createServer()
  const mcpPort = await listen(portProbe)
  await new Promise(resolve => portProbe.close(resolve))
  const child = spawn(process.execPath, ['bin/mcpServer.mjs', '--http'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, MIND_MAP_SKIP_ROOT_ENV: '1', MIND_MAP_API: `http://127.0.0.1:${apiPort}`, MCP_PORT: String(mcpPort), MCP_HOST: '127.0.0.1', MCP_TOKEN: TOKEN, MCP_CLIENT_ID: 'mcp-usability-test' },
    stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true
  })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  const url = `http://127.0.0.1:${mcpPort}/mcp`
  let sessionId = ''
  let id = 0
  async function rpc(method, params) {
    const response = await fetch(url, {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${TOKEN}`, ...(sessionId ? { 'mcp-session-id': sessionId } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params })
    })
    sessionId = response.headers.get('mcp-session-id') || sessionId
    const raw = await response.text()
    assert.equal(response.status, 200, raw)
    const parsed = parseRpc(raw)
    assert.ok(parsed.result, raw)
    return parsed.result
  }
  const call = (name, args) => rpc('tools/call', { name, arguments: args })
  try {
    const deadline = Date.now() + 15000
    while (true) {
      if (child.exitCode !== null) throw new Error('MCP exited: ' + stderr)
      try { if ((await fetch(`http://127.0.0.1:${mcpPort}/health`)).ok) break } catch {}
      assert.ok(Date.now() < deadline, 'MCP start timeout: ' + stderr)
      await new Promise(resolve => setTimeout(resolve, 80))
    }
    const initialized = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'usability-test', version: '1' } })
    const tools = await rpc('tools/list', {})
    check('new tool definitions retain record compatibility and explain batch requirements', () => {
      const query = tools.tools.find(tool => tool.name === 'query_nodes')
      const update = tools.tools.find(tool => tool.name === 'update_node')
      assert.equal(query.inputSchema.properties.include_write_hints.type, 'boolean')
      assert.ok(!query.inputSchema.required.includes('include_write_hints'))
      assert.ok(update.inputSchema.properties.expected.additionalProperties)
      assert.match(update.inputSchema.properties.expected.description, /"__fv.text":12/)
      assert.match(initialized.instructions, /能力不可用时报告具体原因并停止/)
    })
    const queryArgs = { room_key: 'test', scope: 'self', selector: { type: 'uid', value: 'node-1' } }
    const oldQuery = content(await call('query_nodes', queryArgs))
    const hinted = content(await call('query_nodes', { ...queryArgs, include_write_hints: true }))
    check('query flag passes through HTTP; old clients see no hints', () => {
      assert.equal(oldQuery.items[0].write_hints, undefined)
      assert.equal(hinted.items[0].write_hints.update.text['__fv.text'], 12)
      assert.equal(requests.findLast(item => item.pathname.endsWith('/nodes/query')).body.include_write_hints, true)
    })
    const updateArgs = { room_key: 'test', node: 'node-1', text: 'after', expected: hinted.items[0].write_hints.update.text, base_revision: revision, operation_id: randomUUID() }
    const updated = await call('update_node', updateArgs)
    check('copy-ready expected succeeds without normalizing request conditions', () => {
      assert.ok(!updated.isError)
      assert.equal(data.text, 'after')
      assert.deepEqual(requests.findLast(item => item.method === 'PATCH').body.expected, updateArgs.expected)
    })
    const stale = await call('update_node', { ...updateArgs, text: 'stale overwrite', operation_id: randomUUID() })
    check('stale field version is rejected and never overwrites', () => {
      assert.equal(stale.structuredContent.code, 'REPLACE_CONFLICT')
      assert.equal(stale.structuredContent.guidance.next_action, 'report_and_wait')
      assert.equal(stale.structuredContent.outcome, 'rejected')
      assert.equal(data.text, 'after')
    })
    const nested = await call('update_node', { room_key: 'test', node: 'node-1', text: 'wrong', expected: { uid: 'node-1', __fv: { text: revision } }, base_revision: revision })
    check('nested expected remains 428, with useful text and structured guidance', () => {
      assert.equal(nested.structuredContent.statusCode, 428)
      assert.equal(nested.structuredContent.guidance.reason, 'nested_field_version')
      assert.deepEqual(nested.structuredContent.guidance.missing_expected_keys, ['__fv.text'])
      assert.match(nested.content[0].text, /完整 JSON 键名/)
      assert.equal(nested.structuredContent.outcomeUnknown, false)
    })
    const noExpected = await call('update_node', { room_key: 'test', node: 'node-1', text: 'wrong', base_revision: revision })
    check('room revision never replaces field guards', () => {
      assert.equal(noExpected.structuredContent.code, 'PRECONDITION_REQUIRED')
      assert.equal(data.text, 'after')
    })
    const wrongUid = await call('update_node', { ...updateArgs, expected: { uid: 'wrong', '__fv.text': revision }, operation_id: randomUUID() })
    check('wrong uid remains a conflict', () => assert.equal(wrongUid.structuredContent.code, 'REPLACE_CONFLICT'))
    for (const room of ['viewer', 'sop']) {
      const denied = await call('update_node', { ...updateArgs, room_key: room, operation_id: randomUUID() })
      check(room + ' guard remains enforced', () => assert.equal(denied.structuredContent.statusCode, 403))
    }
    const operations = [{ op: 'update', node: 'node-1', text: 'batch', expected: { uid: 'node-1', '__fv.text': revision } }]
    for (const reason of ['collab_v2_disabled', 'event_bridge_disabled', 'mcp_direct_disabled', 'room_nodes_not_initialized', 'direct_policy_unsupported']) {
      const before = requests.length
      const result = await call('apply_nodes', { room_key: reason, operations, base_revision: revision, operation_id: randomUUID() })
      check('HTTP to MCP preserves safe fallback: ' + reason, () => {
        assert.equal(result.structuredContent.code, 'MCP_DIRECT_UNAVAILABLE')
        assert.equal(result.structuredContent.statusCode, reason === 'direct_policy_unsupported' ? 400 : 503)
        assert.deepEqual(result.structuredContent.details, { fallbackReason: reason })
        assert.equal(result.structuredContent.outcome, 'rejected')
        assert.equal(result.structuredContent.outcomeUnknown, false)
        assert.equal(result.structuredContent.writeSubmitted, true)
        assert.match(result.content[0].text, new RegExp(reason))
        assert.equal(result.structuredContent.guidance.auto_retry_allowed, false)
        assert.ok(!JSON.stringify(result).includes('must-not-leak'))
        assert.equal(requests.slice(before).filter(item => item.pathname.endsWith('/operations')).length, 1)
        assert.equal(requests.slice(before).filter(item => item.method === 'PATCH').length, 0)
      })
    }
    const batchArgs = { operations: [operations[0], { ...operations[0], expected: undefined }, { ...operations[0], depends_on: [1] }], base_revision: revision, operation_id: randomUUID() }
    const partial = content(await call('apply_nodes', { ...batchArgs, room_key: 'receipt' }))
    const repeated = content(await call('apply_nodes', { ...batchArgs, room_key: 'receipt' }))
    check('partial receipts decorate only failed items without mutating source', () => {
      assert.equal(partial.outcome, 'partial')
      assert.deepEqual(partial.items[0], receipt.items[0])
      assert.deepEqual(partial.items[2], receipt.items[2])
      assert.equal(partial.items[1].guidance.next_action, 'report_and_wait')
      assert.equal(receipt.items[1].guidance, undefined)
      assert.deepEqual(repeated, partial)
    })
    const allFailed = await call('apply_nodes', { ...batchArgs, room_key: 'all-failed' })
    check('all_failed stays an error with original outcome', () => {
      assert.equal(allFailed.isError, true)
      assert.equal(allFailed.structuredContent.outcome, 'all_failed')
      assert.equal(allFailed.structuredContent.items[0].guidance.auto_retry_allowed, false)
    })
    const reads = content(await call('query_nodes', queryArgs))
    check('presentation metadata never enters node data', () => {
      assert.equal(reads.items[0].data.guidance, undefined)
      assert.equal(reads.items[0].data.write_hints, undefined)
      assert.equal(data.text, 'after')
    })
    const fresh = content(await call('query_nodes', { ...queryArgs, include_write_hints: true }))
    const expected = { ...fresh.items[0].write_hints.update.note, ...fresh.items[0].write_hints.update.hyperlink }
    const multi = await call('update_node', { room_key: 'test', node: 'node-1', note: 'new note', hyperlinkTitle: 'new title', expected, base_revision: revision })
    check('note and hyperlinkTitle use only their own field groups', () => {
      assert.ok(!multi.isError)
      assert.equal(data.note, 'new note')
      assert.equal(data.hyperlinkTitle, 'new title')
      assert.equal(data.hyperlink, 'https://example.test/old')
      assert.equal(data.text, 'after')
    })
    const unknownId = randomUUID()
    const beforeUnknown = requests.length
    const unknown = await call('apply_nodes', { room_key: 'unknown', operations, base_revision: revision, operation_id: unknownId })
    const unknownReplay = await call('apply_nodes', { room_key: 'unknown', operations, base_revision: revision, operation_id: unknownId })
    check('unknown HTTP errors are not automatically retried; explicit replay retains original intent', () => {
      assert.equal(unknown.structuredContent.outcome, 'unknown')
      assert.equal(unknown.structuredContent.outcomeUnknown, true)
      assert.equal(unknown.structuredContent.operation_id, unknownId)
      assert.equal(unknown.structuredContent.guidance.next_action, 'verify_same_operation')
      assert.equal(unknownReplay.structuredContent.operation_id, unknownId)
      const attempts = requests.slice(beforeUnknown).filter(item => item.pathname.endsWith('/operations'))
      assert.equal(attempts.length, 2)
      assert.ok(attempts.every(attempt => attempt.operationId === unknownId))
      assert.ok(attempts.every(attempt => attempt.body.baseVersion === revision))
      assert.ok(attempts.every(attempt => JSON.stringify(attempt.body) === JSON.stringify(attempts[0].body)))
    })
    console.log(`mcpUsability.test.js: ${checks} checks passed (local HTTP/MCP; not PG/event-bridge acceptance)`)
  } finally {
    const stopped = child.exitCode === null ? once(child, 'exit') : Promise.resolve()
    child.kill()
    await stopped
    api.closeAllConnections()
    await new Promise(resolve => api.close(resolve))
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
