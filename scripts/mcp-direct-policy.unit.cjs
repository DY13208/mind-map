'use strict'
const assert = require('node:assert/strict')
const {
  classifyMcpDirectReferences,
  isMcpDirectShape,
  isUidToken,
  isMcpDirectBatch,
  referenceUnavailableError
} = require('../simple-mind-map/bin/mcpDirectPolicy')
assert.equal(typeof isUidToken, 'function', 'mindApi reference filter requires the exported UID-token predicate')
assert.equal(isUidToken('parent-a'), true)
assert.equal(isUidToken('root'), false)
assert.equal(isUidToken('标题/路径'), false)
assert.deepEqual(['parent-a', 'root', '标题/路径'].filter(ref => ref && ref !== 'root' && isUidToken(ref)), ['parent-a'])
const source = { principalId: 'verified-test-principal' }
const flat = { type: 'node.insert', payload: { uid: 'new-leaf', parentUid: 'root', text: 'leaf',
  hyperlink: 'https://example.test', hyperlinkTitle: 'link' } }
assert.equal(isMcpDirectShape(flat, source), true)
assert.equal(isMcpDirectBatch({ type: 'node.batch', payload: { ops: [flat] } }), true)
const nested = { type: 'node.insert', payload: { parentUid: 'root', data: { uid: 'nested-leaf', text: 'leaf' } } }
assert.equal(isMcpDirectShape(nested, source), true)
assert.equal(isMcpDirectBatch({ type: 'node.batch', payload: { ops: [nested] } }), true)
for (const payload of [
  { ...flat.payload, attachmentId: 'unsupported-business-field' },
  { parentUid: 'root', data: { text: 'leaf', attachmentId: 'unsupported-business-field' } },
  { parentUid: 'root', data: null },
  { parentUid: 'root', data: [] }
]) {
  const op = { type: 'node.insert', payload }
  assert.equal(isMcpDirectShape(op, source), false)
  assert.equal(isMcpDirectBatch({ type: 'node.batch', payload: { ops: [op] } }), false)
}
assert.equal(isMcpDirectShape(flat, {}), false)

const liveUid = '550e8400-e29b-41d4-a716-446655440000'
const tombstoneUid = '550e8400-e29b-41d4-a716-446655440001'
const missingUid = '550e8400-e29b-41d4-a716-446655440002'
const update = uid => ({ type: 'node.update', payload: { uid, patch: { text: 'value' } } })
const classified = classifyMcpDirectReferences(
  update(liveUid),
  [liveUid, tombstoneUid, missingUid, '标题/路径'],
  new Set([liveUid, tombstoneUid])
)
assert.deepEqual([...classified.knownUids].sort(), [liveUid, missingUid, tombstoneUid].sort())
assert.deepEqual(classified.legacyRefs, ['标题/路径'])
assert.equal(isMcpDirectShape(update(tombstoneUid), source, classified.knownUids), true)
assert.equal(isMcpDirectShape({ type: 'node.delete', payload: { uid: missingUid } }, source, classified.knownUids), true)

const missingParent = '550e8400-e29b-41d4-a716-446655440003'
const insert = {
  type: 'node.insert',
  payload: { uid: 'new-child', parentUid: missingParent, text: 'child' }
}
const insertRefs = classifyMcpDirectReferences(insert, [missingParent])
assert.equal(insertRefs.legacyRefs.length, 0)
assert.equal(isMcpDirectShape(insert, source, insertRefs.knownUids), true)

const canonicalMove = {
  type: 'node.move',
  payload: { uid: 'path/to/node', parentUid: 'parent/by/title' }
}
const moveRefs = classifyMcpDirectReferences(canonicalMove, [
  canonicalMove.payload.uid,
  canonicalMove.payload.parentUid
])
assert.equal(moveRefs.legacyRefs.length, 0)
assert.equal(isMcpDirectShape(canonicalMove, source, moveRefs.knownUids), true)

const unavailable = referenceUnavailableError('uid_proof_query_failed')
assert.equal(unavailable.statusCode, 503)
assert.equal(unavailable.code, 'MCP_DIRECT_REFERENCE_UNAVAILABLE')
assert.deepEqual(unavailable.details, { fallbackReason: 'uid_proof_query_failed' })

const legacyPath = classifyMcpDirectReferences(update('业务标题'), ['业务标题'])
assert.deepEqual(legacyPath.legacyRefs, ['业务标题'])
console.log('MCP Direct 引用证明、墓碑 UID、缺失 UUID、move_node UID 意图及兼容回退边界校验通过')
