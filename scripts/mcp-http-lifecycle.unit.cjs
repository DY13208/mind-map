'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const { once } = require('node:events')

const previous = process.env.PERFORMANCE_DIAGNOSTICS
process.env.PERFORMANCE_DIAGNOSTICS = '1'
const diagnostics = require('../simple-mind-map/bin/performanceDiagnostics')

async function main() {
  const { createMcpHttpLifecycle } = await import('../simple-mind-map/bin/mcpHttpDiagnostics.mjs')
  const headerId = '11111111-2222-4333-8444-555555555555'
  const operationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  let abortBodySeenResolve
  const abortBodySeen = new Promise(resolve => { abortBodySeenResolve = resolve })

  const server = http.createServer(async (req, res) => {
    if (req.url.startsWith('/disabled')) {
      const before = req.listenerCount('aborted')
      process.env.PERFORMANCE_DIAGNOSTICS = '0'
      const disabledTrace = createMcpHttpLifecycle(req, res, diagnostics)
      assert.equal(disabledTrace, null)
      assert.equal(req.listenerCount('aborted'), before, 'disabled diagnostics must not attach request listeners')
      process.env.PERFORMANCE_DIAGNOSTICS = '1'
      req.resume()
      res.writeHead(204)
      res.end()
      return
    }

    const lifecycle = createMcpHttpLifecycle(req, res, diagnostics)
    if (req.url.startsWith('/abort')) {
      req.on('data', () => abortBodySeenResolve())
      return
    }
    if (req.url.startsWith('/get-unread')) {
      res.writeHead(204)
      res.end()
      return
    }
    if (req.url.startsWith('/early-close')) {
      req.resume()
      res.writeHead(200)
      res.write('partial')
      res.destroy()
      return
    }
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      lifecycle.markBodyParsed(body)
      lifecycle.markTransportDispatched()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  const request = (pathname, body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method: 'POST',
      headers: { 'content-type': 'application/json', ...headers }
    }, res => {
      res.resume()
      res.once('end', () => resolve(res.statusCode))
      res.once('close', () => resolve(res.statusCode))
    })
    req.once('error', reject)
    if (body !== undefined) req.end(body)
    else req.end()
  })

  try {
    const before = diagnostics.snapshot().cursor
    const requestBody = JSON.stringify({
      jsonrpc: '2.0', id: 'sensitive-rpc-id', method: 'tools/call',
      params: { name: 'update_node', arguments: { operation_id: operationId, room_key: 'room-alpha', text: 'private node body' } }
    })
    const okStatus = await request('/mcp?private-url-query=must-not-leak', requestBody, {
      authorization: 'Bearer private-token',
      'mcp-session-id': 'private-session-value',
      'x-mcp-request-id': headerId
    })
    assert.equal(okStatus, 200)

    const rows = diagnostics.snapshot({ after: before }).events.filter(row => row.kind === 'mcp-http')
    const successRows = rows.filter(row => row.clientRequestId === headerId)
    const serverRequestId = successRows[0]?.requestId
    assert.match(serverRequestId || '', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    assert(successRows.every(row => row.requestId === serverRequestId), 'server requestId must stay stable across lifecycle stages')
    const stages = successRows.map(row => row.stage)
    for (const stage of ['request-received', 'body-complete', 'body-parsed', 'transport-dispatched', 'response-finish', 'response-close']) {
      assert(stages.includes(stage), `success request omitted ${stage}`)
    }
    assert.equal(successRows.find(row => row.stage === 'body-complete').bodyComplete, true)
    assert.equal(successRows.find(row => row.stage === 'body-parsed').bodyParsed, true)
    assert(!stages.includes('request-aborted'), 'normal request close must not be classified as an abort')
    const parsedRows = successRows.filter(row => ['body-parsed', 'transport-dispatched', 'response-finish', 'response-close'].includes(row.stage))
    assert(parsedRows.every(row => row.operationId === operationId), 'UUID operation_id should be correlated after parsing')
    assert(parsedRows.every(row => row.rpcIdHash && !('rpcId' in row)), 'non-UUID JSON-RPC id should only be retained as a hash')
    assert(successRows.every(row => row.sessionPresent === true), 'diagnostic should retain only session presence')
    assert(!JSON.stringify(successRows).includes('private-token'))
    assert(!JSON.stringify(successRows).includes('private-session-value'))
    assert(!JSON.stringify(successRows).includes('private node body'))
    assert(!JSON.stringify(successRows).includes('private-url-query'))
    assert(!JSON.stringify(successRows).includes('sensitive-rpc-id'))

    const scopedRows = diagnostics.snapshot({ roomKey: 'room-alpha', after: before }).events.filter(row => row.requestId === serverRequestId)
    assert.deepEqual(
      scopedRows.map(row => row.stage).sort(),
      ['body-parsed', 'transport-dispatched', 'response-finish', 'response-close'].sort(),
      'room-scoped snapshot should expose the parsed portion of this request lifecycle'
    )
    assert(scopedRows.every(row => row.roomKey === 'room-alpha'), 'room-scoped lifecycle must carry only its parsed room key')
    assert.equal(diagnostics.snapshot({ roomKey: 'room-other', after: before }).events.some(row => row.requestId === serverRequestId), false, 'another room must not see this request')

    const invalidHeaderCursor = diagnostics.snapshot().cursor
    const invalidHeader = 'caller-controlled-correlation-secret'
    assert.equal(await request('/mcp', JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/list' }), {
      'x-mcp-request-id': invalidHeader
    }), 200)
    const invalidHeaderRows = diagnostics.snapshot({ after: invalidHeaderCursor }).events.filter(row => row.kind === 'mcp-http')
    const invalidHeaderRequestId = invalidHeaderRows.find(row => row.stage === 'request-received')?.requestId
    assert.match(invalidHeaderRequestId || '', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    assert(invalidHeaderRows.some(row => row.rpcId === 42), 'safe numeric JSON-RPC id should be retained')
    assert(invalidHeaderRows.every(row => !('clientRequestId' in row)), 'invalid caller correlation header must be omitted')
    assert(!JSON.stringify(invalidHeaderRows).includes(invalidHeader), 'invalid caller correlation header must not be recorded')

    const getCursor = diagnostics.snapshot().cursor
    const getStatus = await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/get-unread' }, res => {
        res.resume()
        res.once('end', () => resolve(res.statusCode))
      })
      req.once('error', reject)
    })
    assert.equal(getStatus, 204)
    const getRows = diagnostics.snapshot({ after: getCursor }).events.filter(row => row.kind === 'mcp-http')
    const getFinish = getRows.find(row => row.stage === 'response-finish')
    assert(getFinish, 'unread GET should finish normally')
    assert.equal(getFinish.bodyComplete, true, 'req.complete should mark a fully received body even when the handler did not consume it')
    assert.equal(getFinish.bodyParsed, false, 'unread GET must not be described as body-parsed')

    const abortCursor = diagnostics.snapshot().cursor
    let clientErrorResolve
    const clientError = new Promise(resolve => { clientErrorResolve = resolve })
    const abortReq = http.request({ host: '127.0.0.1', port, path: '/abort', method: 'POST', headers: { 'content-type': 'application/json' } })
    abortReq.once('error', clientErrorResolve)
    abortReq.write('{"partial":')
    await abortBodySeen
    abortReq.destroy()
    await clientError
    await new Promise(resolve => setTimeout(resolve, 10))
    const abortedRows = diagnostics.snapshot({ after: abortCursor }).events.filter(row => row.kind === 'mcp-http')
    assert(abortedRows.some(row => row.stage === 'request-aborted'), 'partial request body should record request-aborted')
    assert(!abortedRows.some(row => row.stage === 'body-complete'), 'aborted body must not be marked complete')
    const abortedRequestId = abortedRows.find(row => row.stage === 'request-received')?.requestId
    assert(abortedRequestId, 'global cursor should include the pre-parse aborted request')
    assert(!diagnostics.snapshot({ roomKey: 'room-alpha', after: abortCursor }).events.some(row => row.requestId === abortedRequestId), 'unparsed requests must not appear in room-scoped diagnostics')

    const closeCursor = diagnostics.snapshot().cursor
    const closeReq = http.request({ host: '127.0.0.1', port, path: '/early-close', method: 'POST' })
    closeReq.once('error', () => {})
    closeReq.end('{}')
    await new Promise(resolve => setTimeout(resolve, 20))
    const closeRows = diagnostics.snapshot({ after: closeCursor }).events.filter(row => row.kind === 'mcp-http')
    const closeRow = closeRows.find(row => row.stage === 'response-close')
    assert(closeRow, 'early response close should be recorded')
    assert.equal(closeRow.responseFinished, false, 'early close must be distinguishable from normal finish')

    const disabledCursor = diagnostics.snapshot().cursor
    await request('/disabled', '{}')
    const disabledRows = diagnostics.snapshot({ after: disabledCursor }).events.filter(row => row.kind === 'mcp-http')
    assert.equal(disabledRows.length, 0, 'disabled diagnostics must not record lifecycle events')

    console.log('PASS: real HTTP lifecycle records through performanceDiagnostics ring; success/body abort/early response close, UUID correlation, redaction, and disabled no-listener path.')
  } finally {
    server.close()
    if (previous === undefined) delete process.env.PERFORMANCE_DIAGNOSTICS
    else process.env.PERFORMANCE_DIAGNOSTICS = previous
  }
}

main().catch(error => {
  console.error(error)
  if (previous === undefined) delete process.env.PERFORMANCE_DIAGNOSTICS
  else process.env.PERFORMANCE_DIAGNOSTICS = previous
  process.exitCode = 1
})
