'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const previous = process.env.PERFORMANCE_DIAGNOSTICS
process.env.PERFORMANCE_DIAGNOSTICS = '1'
const diagnostics = require('../simple-mind-map/bin/performanceDiagnostics')
const roomKey = 'route-test-room'

function observe(url, method = 'GET', extra = {}) {
  const cursor = diagnostics.snapshot({ roomKey }).cursor
  const req = {
    url,
    method,
    verifiedMcpSource: null,
    authUser: { id: 'diagnostic-test-user', mcp: false },
    headers: {},
    ...extra,
  }
  const res = new EventEmitter()
  res.statusCode = 200
  diagnostics.observeHttp(req, res)
  res.emit('finish')
  const rows = diagnostics.snapshot({ roomKey, after: cursor }).events
  assert.equal(rows.length, 1, `expected exactly one HTTP diagnostic event for ${url}`)
  return rows[0]
}

try {
  const routes = [
    [`/api/files/${roomKey}`, '/api/files/:room/snapshot'],
    [`/api/files/${roomKey}?format=meta`, '/api/files/:room/meta'],
    [`/api/files/${roomKey}/presence`, '/api/files/:room/presence'],
    [`/api/files/${roomKey}/subtree?uid=node-1`, '/api/files/:room/subtree'],
    [`/api/files/${roomKey}/nodes`, '/api/files/:room/nodes'],
    [`/api/files/${roomKey}/nodes/query`, '/api/files/:room/nodes'],
    [`/api/maps/${roomKey}/operations`, '/api/files/:room/operations'],
    [`/api/maps/${roomKey}/operations/batch`, '/api/files/:room/operations'],
    [`/api/maps/${roomKey}/snapshot`, '/api/files/:room/snapshot'],
    [`/api/maps/${roomKey}/consistency`, '/api/files/:room/consistency'],
    [`/api/files/${roomKey}/members/member-123`, '/api/files/:room/members'],
    [`/api/files/${roomKey}/sop/proposals/private-id`, '/api/files/:room/sop'],
  ]
  for (const [url, expectedRoute] of routes) {
    assert.equal(observe(url, 'GET').route, expectedRoute, `route normalization failed for ${url}`)
  }

  for (const url of [
    `/api/files/${roomKey}/snapshot`,
    `/api/files/${roomKey}/not-a-real-route/private-label`,
    `/api/files/${roomKey}/nodes-extra/private-node-uid`,
    `/api/files/${roomKey}/`,
    `/api/maps/${roomKey}`,
    `/api/maps/${roomKey}/unknown/private-label`,
  ]) {
    const row = observe(url, 'GET')
    assert.equal(row.route, '/api/files/:room/other', `unknown/non-bare path must not look like a snapshot: ${url}`)
    assert(!row.route.includes('private-label') && !row.route.includes('private-node-uid'), 'caller-controlled suffix must not enter the route label')
  }

  const nestedKnown = observe(`/api/files/${roomKey}/nodes/private-node-uid/comments`, 'GET')
  assert.equal(nestedKnown.route, '/api/files/:room/nodes', 'known first segment should use a fixed label and omit node identifiers')

  const directUidRead = observe(
    `/api/files/${roomKey}/nodes?scope=self&uids=private-node-uid`,
    'GET',
    { diagnosticReadPath: 'direct', diagnosticFallbackReason: 'room_nodes_not_ready' },
  )
  assert.equal(directUidRead.path, 'direct', 'a valid UID-range read path should be recorded')
  assert.equal('fallbackReason' in directUidRead, false, 'direct reads must not retain a fallback reason')
  assert(!JSON.stringify(directUidRead).includes('scope'), 'query scope must not be recorded')
  assert(!JSON.stringify(directUidRead).includes('private-node-uid'), 'UID query values must not be recorded')

  for (const fallbackReason of [
    'collab_v2_disabled',
    'room_nodes_not_ready',
    'room_row_missing',
    'uids_not_requested',
  ]) {
    const fullRead = observe(
      `/api/files/${roomKey}/nodes?scope=tree&uids=private-node-uid`,
      'GET',
      { diagnosticReadPath: 'full', diagnosticFallbackReason: fallbackReason },
    )
    assert.equal(fullRead.path, 'full', 'a valid full-read path should be recorded')
    assert.equal(fullRead.fallbackReason, fallbackReason, 'only a fixed fallback reason should be retained')
    assert(!JSON.stringify(fullRead).includes('scope'), 'query scope must not be recorded')
    assert(!JSON.stringify(fullRead).includes('private-node-uid'), 'UID query values must not be recorded')
  }

  const invalidReadMetadata = observe(
    `/api/files/${roomKey}/nodes?scope=secret-scope&uids=private-node-uid`,
    'GET',
    { diagnosticReadPath: 'direct/private-node-uid', diagnosticFallbackReason: 'private-reason' },
  )
  assert.equal('path' in invalidReadMetadata, false, 'unknown path values must be ignored')
  assert.equal('fallbackReason' in invalidReadMetadata, false, 'unknown fallback reasons must be ignored')
  assert(!JSON.stringify(invalidReadMetadata).includes('secret-scope'), 'query scope must not be recorded')
  assert(!JSON.stringify(invalidReadMetadata).includes('private-reason'), 'caller-controlled reasons must not be recorded')

  const nonGetNodes = observe(`/api/files/${roomKey}/nodes?scope=tree`, 'POST', {
    diagnosticReadPath: 'direct',
    diagnosticFallbackReason: 'room_nodes_not_ready',
  })
  assert.equal('path' in nonGetNodes, false, 'read-path metadata must not be attached to non-GET requests')
  assert.equal('fallbackReason' in nonGetNodes, false, 'fallback reasons must not be attached to non-GET requests')

  const stageCursor = diagnostics.snapshot({ roomKey }).cursor
  const operationId = '11111111-2222-4333-8444-555555555555'
  diagnostics.record({
    kind: 'transaction-stage', roomKey, operationId, type: 'node.move', path: 'direct',
    stage: 'lock-held-until-commit', durationMs: 4.5, ok: true,
    payload: { nodeText: 'must not be recorded' },
  })
  const stageSnapshot = diagnostics.snapshot({ roomKey, after: stageCursor })
  assert.equal(stageSnapshot.events.length, 1, 'transaction-stage should be an accepted diagnostic kind')
  assert.deepEqual(
    { kind: stageSnapshot.events[0].kind, stage: stageSnapshot.events[0].stage, type: stageSnapshot.events[0].type, path: stageSnapshot.events[0].path, operationId: stageSnapshot.events[0].operationId },
    { kind: 'transaction-stage', stage: 'lock-held-until-commit', type: 'node.move', path: 'direct', operationId },
  )
  assert.equal('payload' in stageSnapshot.events[0], false, 'diagnostic payloads must remain excluded')
  const stageGroup = stageSnapshot.summary.find((row) => row.kind === 'transaction-stage')
  assert(stageGroup, 'snapshot summary should retain transaction-stage grouping')
  assert.equal(stageGroup.stage, 'lock-held-until-commit')
  assert.equal(stageGroup.type, 'node.move')

  console.log('PASS: controlled room-route labels, query-scope redaction, node-read path/fallback allowlists, maps normalization, unknown-route redaction, and transaction-stage retention.')
} finally {
  if (previous === undefined) delete process.env.PERFORMANCE_DIAGNOSTICS
  else process.env.PERFORMANCE_DIAGNOSTICS = previous
}
