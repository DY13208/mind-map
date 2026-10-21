'use strict'

process.env.MIND_MAP_SKIP_ROOT_ENV = '1'

const assert = require('node:assert/strict')
const { generateNKeysBetween } = require('../simple-mind-map/bin/fractionalIndex')
const Y = require('../simple-mind-map/node_modules/yjs')
const { applyDirect } = require('../simple-mind-map/bin/collabV2/directApplier')
const { createMemoryStore } = require('../simple-mind-map/bin/collabV2/directStore')
const { applyUndoOrRedo, createMemoryLookup } = require('../simple-mind-map/bin/collabV2/undoApply')
const {
  subtreeToken,
  readSubtreeRows,
  SUBTREE_TOKEN_ROWS_SQL,
  readSubtreeRowsForRoots,
  SUBTREE_TOKEN_ROWS_FOR_ROOTS_SQL,
  subtreeTokensFromRows
} = require('../simple-mind-map/bin/subtreeToken')
const { readLegacyPreconditionBaseline, graphBaseline } = require('../simple-mind-map/bin/nodePreconditions')
const { applyNodeCommand } = require('../simple-mind-map/bin/roomCommands')
const { isDirectNodeShape } = require('../simple-mind-map/bin/mcpDirectPolicy')
const mindDoc = require('../simple-mind-map/bin/mindDoc')

function makeGraph() {
  const positions = generateNKeysBetween(null, null, 5)
  return {
    root: {
      isRoot: true,
      data: { uid: 'root', text: 'Root' },
      children: ['parent', 'empty'],
      position: ''
    },
    parent: {
      data: { uid: 'parent', text: 'Parent' },
      children: ['moving', 'a', 'b'],
      position: positions[0]
    },
    empty: {
      data: { uid: 'empty', text: 'Empty' },
      children: [],
      position: positions[1]
    },
    moving: {
      data: { uid: 'moving', text: 'Moving', __fv: { text: 0 } },
      children: [],
      position: positions[2]
    },
    a: { data: { uid: 'a', text: 'A' }, children: [], position: positions[3] },
    b: { data: { uid: 'b', text: 'B' }, children: [], position: positions[4] }
  }
}

function sourceExpected(graph, uid, parentUid) {
  return {
    uid,
    parent_uid: parentUid,
    position: graph[uid].position
  }
}

function anchorExpected(graph, anchorUid, side) {
  return {
    anchor_uid: anchorUid,
    anchor_parent_uid: 'parent',
    anchor_position: graph[anchorUid].position,
    anchor_side: side
  }
}

function errorCode(promise, code, statusCode) {
  return promise.then(
    () => { throw new Error(`expected ${code}`) },
    err => {
      assert.equal(err.code, code)
      if (statusCode != null) assert.equal(err.statusCode, statusCode)
      return err
    }
  )
}

async function testFieldVersionsAndMissingPreconditions() {
  const graph = makeGraph()
  const store = createMemoryStore(graph)
  await errorCode(applyDirect(store, {
    type: 'node.update', payload: { uid: 'moving', patch: { text: 'missing' } }
  }, { version: 1 }), 'PRECONDITION_REQUIRED', 428)

  const staleStore = createMemoryStore({
    ...graph,
    moving: { ...graph.moving, data: { ...graph.moving.data, __fv: { text: 4 } } }
  })
  await errorCode(applyDirect(staleStore, {
    type: 'node.update',
    payload: { uid: 'moving', patch: { text: 'stale' }, expected: { uid: 'moving', '__fv.text': 0 } }
  }, { version: 5 }), 'REPLACE_CONFLICT', 409)
}

async function testMoveAnchorRebasesAndEmptyParentWorks() {
  const graph = makeGraph()
  const store = createMemoryStore(graph)
  const moved = await applyDirect(store, {
    type: 'node.move',
    payload: {
      uid: 'moving', parentUid: 'parent', index: 0,
      expected: { ...sourceExpected(graph, 'moving', 'parent'), ...anchorExpected(graph, 'a', 'after') }
    }
  }, { version: 2 })
  assert.equal(moved.result.index, 1)
  assert.deepEqual((await store.listChildren('parent')).map(row => row.uid), ['a', 'moving', 'b'])

  const emptyGraph = makeGraph()
  const emptyStore = createMemoryStore(emptyGraph)
  const inserted = await applyDirect(emptyStore, {
    type: 'node.move',
    payload: {
      uid: 'moving', parentUid: 'empty', index: 0,
      expected: { ...sourceExpected(emptyGraph, 'moving', 'parent'), target_empty: true }
    }
  }, { version: 3 })
  assert.equal(inserted.result.index, 0)
  assert.deepEqual((await emptyStore.listChildren('empty')).map(row => row.uid), ['moving'])
}

async function testMoveRequiresGuardAndRejectsChangedAnchorOrOccupiedEmptyTarget() {
  const graph = makeGraph()
  const missingStore = createMemoryStore(graph)
  await errorCode(applyDirect(missingStore, {
    type: 'node.move',
    payload: {
      uid: 'moving', parentUid: 'parent', index: 0,
      expected: sourceExpected(graph, 'moving', 'parent')
    }
  }, { version: 2 }), 'PRECONDITION_REQUIRED', 428)

  const staleAnchorStore = createMemoryStore(graph)
  await errorCode(applyDirect(staleAnchorStore, {
    type: 'node.move',
    payload: {
      uid: 'moving', parentUid: 'parent', index: 0,
      expected: {
        ...sourceExpected(graph, 'moving', 'parent'),
        ...anchorExpected(graph, 'a', 'before'),
        anchor_position: 'stale'
      }
    }
  }, { version: 2 }), 'REPLACE_CONFLICT', 409)

  const occupiedGraph = makeGraph()
  occupiedGraph.empty.children.push('b')
  const occupiedStore = createMemoryStore(occupiedGraph)
  await errorCode(applyDirect(occupiedStore, {
    type: 'node.move',
    payload: {
      uid: 'moving', parentUid: 'empty', index: 0,
      expected: { ...sourceExpected(occupiedGraph, 'moving', 'parent'), target_empty: true }
    }
  }, { version: 2 }), 'REPLACE_CONFLICT', 409)
}

async function testDirectAllowlistAcceptsTargetEmptyGuard() {
  const graph = makeGraph()
  assert.equal(isDirectNodeShape({
    type: 'node.move',
    payload: {
      uid: 'moving', parentUid: 'empty', index: 0,
      expected: { ...sourceExpected(graph, 'moving', 'parent'), target_empty: true }
    }
  }, new Set(['moving', 'empty'])), true)
}

async function testImmutableBatchBaselineAndNewUidDependency() {
  const graph = makeGraph()
  const store = createMemoryStore(graph)
  const repeated = await applyDirect(store, {
    type: 'node.batch',
    payload: { ops: [
      { type: 'node.update', payload: { uid: 'moving', patch: { text: 'first' }, expected: { uid: 'moving', '__fv.text': 0 } } },
      { type: 'node.update', payload: { uid: 'moving', patch: { text: 'second' }, expected: { uid: 'moving', '__fv.text': 0 } } }
    ] }
  }, { version: 4, preserveBatchOrder: true })
  assert.equal(repeated.result.count, 2)
  assert.equal((await store.getLive('moving')).data.text, 'second')

  const newUidStore = createMemoryStore(makeGraph())
  const addedThenUpdated = await applyDirect(newUidStore, {
    type: 'node.batch', roomKey: 'unit-room',
    payload: { ops: [
      { type: 'node.insert', payload: { uid: 'new-node', parentUid: 'parent', text: 'new' } },
      { type: 'node.update', payload: { uid: 'new-node', patch: { text: 'updated' } } }
    ] }
  }, { version: 5, mcpPartial: true, preserveBatchOrder: true })
  assert.equal(addedThenUpdated.result.count, 2)
  assert.equal((await newUidStore.getLive('new-node')).data.text, 'updated')
}

async function testSubtreeTokenDetectsDescendantChanges() {
  const graph = makeGraph()
  graph.parent.children.push('descendant')
  graph.descendant = { data: { uid: 'descendant', text: 'before' }, children: [], position: 'z' }
  const store = createMemoryStore(graph)
  const token = await store.subtreeToken('parent')
  await store.updateData('descendant', { uid: 'descendant', text: 'after' }, 8)
  assert.notEqual(await store.subtreeToken('parent'), token)
  await errorCode(applyDirect(store, {
    type: 'node.delete',
    payload: { uid: 'parent', expected: { uid: 'parent', subtree_token: token } }
  }, { version: 9 }), 'REPLACE_CONFLICT', 409)
  assert.equal(subtreeToken([{ uid: 'a', node_version: 0 }]), subtreeToken([{ uid: 'a', node_version: 0 }]))
}

async function testOverlappingDeleteBatchBaselineReadsOnce() {
  const graph = makeGraph()
  graph.a.children.push('descendant')
  graph.descendant = { data: { uid: 'descendant', text: 'Nested' }, children: [], position: 'nested' }
  const store = createMemoryStore(graph)
  const parentToken = await store.subtreeToken('parent')
  const childToken = await store.subtreeToken('a')
  const readBatchTokens = store.subtreeTokens.bind(store)
  const readSingleToken = store.subtreeToken.bind(store)
  let batchReads = 0
  let singleReads = 0
  store.subtreeTokens = async uids => {
    batchReads += 1
    const tokens = await readBatchTokens(uids)
    assert.equal(tokens.get('parent'), parentToken)
    assert.equal(tokens.get('a'), childToken)
    return tokens
  }
  store.subtreeToken = async uid => {
    singleReads += 1
    return readSingleToken(uid)
  }

  const result = await applyDirect(store, {
    type: 'node.batch',
    payload: { ops: [
      { type: 'node.delete', payload: { uid: 'parent', expected: { uid: 'parent', subtree_token: parentToken } } },
      { type: 'node.delete', payload: { uid: 'a', expected: { uid: 'a', subtree_token: childToken } } }
    ] }
  }, { version: 10 })

  assert.equal(batchReads, 1)
  assert.equal(singleReads, 0)
  assert.equal(result.result.skipped, 0, JSON.stringify(result.result.skippedItems))
  assert.equal(result.result.count, 1)
  assert.equal(await store.getLive('parent'), null)

  const partialGraph = makeGraph()
  partialGraph.a.children.push('descendant')
  partialGraph.descendant = { data: { uid: 'descendant', text: 'Nested' }, children: [], position: 'nested' }
  const partialStore = createMemoryStore(partialGraph)
  const partialParentToken = await partialStore.subtreeToken('parent')
  const partialChildToken = await partialStore.subtreeToken('a')
  const readPartialBatchTokens = partialStore.subtreeTokens.bind(partialStore)
  let partialBatchReads = 0
  partialStore.subtreeTokens = async uids => {
    partialBatchReads += 1
    return readPartialBatchTokens(uids)
  }
  const partial = await applyDirect(partialStore, {
    type: 'node.batch',
    roomKey: 'unit-room',
    payload: { ops: [
      { type: 'node.delete', payload: { uid: 'parent', expected: { uid: 'parent', subtree_token: partialParentToken } } },
      { type: 'node.delete', payload: { uid: 'a', expected: { uid: 'a', subtree_token: partialChildToken } } }
    ] }
  }, { version: 11, mcpPartial: true, preserveBatchOrder: true })
  assert.equal(partialBatchReads, 1)
  assert.equal(partial.result.count, 1)
  assert.equal(partial.result.failed, 1)
  assert.equal(partial.result.items[0].status, 'applied')
  assert.equal(partial.result.items[1].code, 'NODE_DELETED')
}

async function testSharedSubtreeTokenRowsQuery() {
  const rows = [{ uid: 'root', parent_uid: null, position: '', node_version: 0, cycle: false }]
  let calls = 0
  let lastParams
  const query = async (sql, params) => {
    assert.equal(sql, SUBTREE_TOKEN_ROWS_SQL)
    calls += 1
    lastParams = params
    return { rows }
  }
  assert.deepEqual(await readSubtreeRows(query, 'room', 'root'), rows)
  assert.deepEqual(await readSubtreeRows({ query }, 'room', 'root'), rows)
  assert.equal(calls, 2)
  assert.deepEqual(lastParams, ['room', 'root'])
  assert.match(SUBTREE_TOKEN_ROWS_SQL, /room_rows as materialized/i)
  assert.match(SUBTREE_TOKEN_ROWS_SQL, /select uid, parent_uid, position, node_version/i)
  assert.doesNotMatch(SUBTREE_TOKEN_ROWS_SQL, /\b(data|is_root)\b/i)

  const batchRows = [
    { uid: 'parent', parent_uid: 'root', position: 'a', node_version: 1, cycle: false },
    { uid: 'child', parent_uid: 'parent', position: 'b', node_version: 2, cycle: false },
    { uid: 'leaf', parent_uid: 'child', position: 'c', node_version: 3, cycle: false },
    { uid: 'sibling', parent_uid: 'parent', position: 'd', node_version: 4, cycle: false }
  ]
  let batchCalls = 0
  let batchParams
  const batchQuery = async (sql, params) => {
    assert.equal(sql, SUBTREE_TOKEN_ROWS_FOR_ROOTS_SQL)
    batchCalls += 1
    batchParams = params
    return { rows: batchRows }
  }
  const unionRows = await readSubtreeRowsForRoots(batchQuery, 'room', ['parent', 'child', 'parent'])
  const batchTokens = subtreeTokensFromRows(unionRows, ['parent', 'child'])
  assert.equal(batchCalls, 1)
  assert.deepEqual(batchParams, ['room', ['parent', 'child']])
  assert.equal(batchTokens.get('parent'), subtreeToken(batchRows))
  assert.equal(batchTokens.get('child'), subtreeToken(batchRows.filter(row => row.uid === 'child' || row.uid === 'leaf')))
  assert.match(SUBTREE_TOKEN_ROWS_FOR_ROOTS_SQL, /room_rows as materialized/i)
  assert.match(SUBTREE_TOKEN_ROWS_FOR_ROOTS_SQL, /select distinct uid, parent_uid, position, node_version, cycle/i)
  assert.doesNotMatch(SUBTREE_TOKEN_ROWS_FOR_ROOTS_SQL, /\b(data|is_root)\b/i)
}

async function testLegacyMoveUsesSameAnchorSemantics() {
  const graph = makeGraph()
  const doc = new Y.Doc()
  mindDoc.applyObjectToDoc(doc, graph, { replace: true })
  try {
    const result = applyNodeCommand(doc, {
      type: 'node.move',
      payload: {
        uid: 'moving', parentUid: 'parent', index: 0,
        expected: { ...sourceExpected(graph, 'moving', 'parent'), ...anchorExpected(graph, 'a', 'after') }
      }
    }, {
      version: 2,
      enforcePreconditions: true,
      preconditionBaseline: { nodes: graphBaseline(graph), subtreeTokens: new Map() }
    })
    assert.equal(result.result.index, 1)
    assert.deepEqual(mindDoc.readObject(doc).parent.children, ['a', 'moving', 'b'])
  } finally {
    doc.destroy()
  }
}

async function testLegacyDeleteWithoutIndexCannotBypassGuard() {
  const graph = makeGraph()
  const rows = [
    { uid: 'parent', parent_uid: 'root', position: graph.parent.position, node_version: 0 },
    { uid: 'moving', parent_uid: 'parent', position: graph.moving.position, node_version: 0 },
    { uid: 'a', parent_uid: 'parent', position: graph.a.position, node_version: 0 },
    { uid: 'b', parent_uid: 'parent', position: graph.b.position, node_version: 0 }
  ]
  const baseline = await readLegacyPreconditionBaseline({
    async query() { return { rows } }
  }, 'room', {
    type: 'node.delete', payload: { uid: 'parent' }
  }, graph)
  assert.equal(baseline.subtreeTokens.get('parent'), subtreeToken(rows))

  await errorCode(readLegacyPreconditionBaseline({
    async query() { const err = new Error('missing node_version'); err.code = '42703'; throw err }
  }, 'room', { type: 'node.delete', payload: { uid: 'parent' } }, graph), 'PRECONDITION_UNSUPPORTED', 503)
}

async function testLegacyOverlappingDeleteRootsReadOnce() {
  const graph = makeGraph()
  graph.a.children.push('descendant')
  graph.descendant = { data: { uid: 'descendant', text: 'Nested' }, children: [], position: 'nested' }
  const rows = [
    { uid: 'parent', parent_uid: 'root', position: graph.parent.position, node_version: 1 },
    { uid: 'moving', parent_uid: 'parent', position: graph.moving.position, node_version: 0 },
    { uid: 'a', parent_uid: 'parent', position: graph.a.position, node_version: 2 },
    { uid: 'descendant', parent_uid: 'a', position: graph.descendant.position, node_version: 3 },
    { uid: 'b', parent_uid: 'parent', position: graph.b.position, node_version: 0 }
  ]
  let calls = 0
  let params
  const baseline = await readLegacyPreconditionBaseline({
    async query(sql, values) {
      assert.equal(sql, SUBTREE_TOKEN_ROWS_FOR_ROOTS_SQL)
      calls += 1
      params = values
      return { rows }
    }
  }, 'room', {
    type: 'node.batch',
    payload: { ops: [
      { type: 'node.delete', payload: { uid: 'parent' } },
      { type: 'node.delete', payload: { uid: 'a' } }
    ] }
  }, graph)
  assert.equal(calls, 1)
  assert.deepEqual(params, ['room', ['parent', 'a']])
  assert.equal(baseline.subtreeTokens.get('parent'), subtreeToken(rows))
  assert.equal(baseline.subtreeTokens.get('a'), subtreeToken(rows.filter(row => row.uid === 'a' || row.uid === 'descendant')))
}

async function testUndoRedoUseInternalConflictChecks() {
  const graph = makeGraph()
  graph.moving.data.text = 'new'
  graph.moving.data.__fv = { text: 1 }
  const store = createMemoryStore(graph)
  const target = {
    operation_id: 'update-1', operation_type: 'node.update', actor_id: 'actor', version: 1,
    payload: { uid: 'moving', patch: { text: 'new' } },
    inverse_payload: { type: 'node.update', payload: { uid: 'moving', patch: { text: 'old' } } }
  }
  const room = { ops: [target], opsById: new Map([[target.operation_id, target]]) }
  const undo = await applyUndoOrRedo(store, {
    type: 'operation.undo', roomKey: 'unit-room', userId: 'actor',
    payload: { targetOperationId: target.operation_id }
  }, { version: 2, lookup: createMemoryLookup(room) })
  assert.equal((await store.getLive('moving')).data.text, 'old')
  const undoOp = {
    operation_id: 'undo-1', operation_type: 'operation.undo', actor_id: 'actor', version: 2,
    payload: { targetOperationId: target.operation_id },
    inverse_payload: undo.inversePayload
  }
  room.ops.push(undoOp)
  room.opsById.set(undoOp.operation_id, undoOp)
  await applyUndoOrRedo(store, {
    type: 'operation.redo', roomKey: 'unit-room', userId: 'actor',
    payload: { targetOperationId: target.operation_id }
  }, { version: 3, lookup: createMemoryLookup(room) })
  assert.equal((await store.getLive('moving')).data.text, 'new')
}

async function main() {
  const tests = [
    testFieldVersionsAndMissingPreconditions,
    testMoveAnchorRebasesAndEmptyParentWorks,
    testMoveRequiresGuardAndRejectsChangedAnchorOrOccupiedEmptyTarget,
    testDirectAllowlistAcceptsTargetEmptyGuard,
    testImmutableBatchBaselineAndNewUidDependency,
    testSubtreeTokenDetectsDescendantChanges,
    testOverlappingDeleteBatchBaselineReadsOnce,
    testSharedSubtreeTokenRowsQuery,
    testLegacyMoveUsesSameAnchorSemantics,
    testLegacyDeleteWithoutIndexCannotBypassGuard,
    testLegacyOverlappingDeleteRootsReadOnce,
    testUndoRedoUseInternalConflictChecks
  ]
  for (const test of tests) {
    await test()
    console.log('PASS ' + test.name)
  }
  console.log(`PASS ${tests.length} MCP write-guard unit checks`)
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
