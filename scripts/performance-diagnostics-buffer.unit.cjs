'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const previous = process.env.PERFORMANCE_DIAGNOSTICS
process.env.PERFORMANCE_DIAGNOSTICS = '1'
const diagnostics = require('../simple-mind-map/bin/performanceDiagnostics')

try {
  const operationId = '11111111-2222-4333-8444-555555555555'
  for (let index = 0; index < 5000; index += 1) {
    diagnostics.record({ kind: 'mcp-queue', roomKey: 'buffer-test', source: 'mcp',
      operationId, durationMs: index, stage: 'waiting', queueDepth: 3,
      authorization: 'secret', payload: { text: 'private node' } })
  }
  let result = diagnostics.snapshot({ roomKey: 'buffer-test', after: 1 })
  assert.equal(result.events.length, 3000)
  assert.equal(result.overwritten, 2000)
  assert.equal(result.oldestRetainedCursor, 2001)
  assert.equal(result.retentionGap, true)
  assert.equal(result.cursorResetRequired, false)
  assert.equal(result.events[0].seq, 2001)
  assert.equal(result.events.at(-1).seq, 5000)
  assert.equal(result.events[0].operationId, operationId)
  assert.equal(result.events[0].queueDepth, 3)
  assert.equal('authorization' in result.events[0], false)
  assert.equal('payload' in result.events[0], false)
  result = diagnostics.snapshot({ after: 4990 })
  assert.equal(result.events.length, 10)
  assert.equal(result.retentionGap, false)
  assert.equal(diagnostics.snapshot({ after: 6000 }).cursorResetRequired, true)
  assert.equal(diagnostics.snapshot({ roomKey: 'other-room' }).events.length, 0)

  const req = { url: '/api/maps/buffer-test/operations', method: 'POST',
    verifiedMcpSource: { principalId: 'not-recorded' }, diagnosticOperationId: operationId }
  const res = new EventEmitter()
  res.statusCode = 200
  diagnostics.observeHttp(req, res)
  res.emit('finish')
  const http = diagnostics.snapshot({ after: 5000 }).events[0]
  assert.equal(http.kind, 'http')
  assert.equal(http.route, '/api/files/:room/operations')
  assert.equal(http.source, 'mcp')
  assert.equal(http.operationId, operationId)
  assert.equal('principalId' in http, false)

  const exportResponse = new EventEmitter()
  exportResponse.statusCode = 200
  diagnostics.observeHttp({ url: '/api/files/buffer-test/export-tree', method: 'POST',
    authUser: { mcp: true }, headers: { 'x-mcp-tool': 'export_room_tree' } }, exportResponse)
  exportResponse.emit('finish')
  const exportEvent = diagnostics.snapshot({ after: 5001 }).events[0]
  assert.equal(exportEvent.route, '/api/files/:room/export-tree')
  assert.equal(exportEvent.mcpTool, 'export_room_tree')
  diagnostics.record({ kind: 'http', mcpTool: 'secret-node-content' })
  assert.equal('mcpTool' in diagnostics.snapshot({ after: 5002 }).events[0], false)

  const count = diagnostics.snapshot().cursor
  process.env.PERFORMANCE_DIAGNOSTICS = '0'
  diagnostics.record({ kind: 'mcp-write', roomKey: 'buffer-test', durationMs: 1 })
  assert.equal(diagnostics.snapshot().cursor, count)
  console.log('性能诊断环形缓冲、游标缺口、MCP路由与脱敏检查通过')
} finally {
  if (previous === undefined) delete process.env.PERFORMANCE_DIAGNOSTICS
  else process.env.PERFORMANCE_DIAGNOSTICS = previous
}
