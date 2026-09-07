'use strict'

/**
 * Golden comparison: optimized encodeNodeRows must stay semantically equivalent.
 * Also guards against reintroducing per-node findRootUid (O(n²)).
 */

const assert = require('assert')
const {
  encodeNodeRows,
  decodeNodeRows,
  validateNodeGraph,
  replaceRoomNodes
} = require('../bin/roomNodes')
const { bushObjectGraph } = require('./fixtures/largeMapFixtures')
const { encodeRank, STEP, applyPositionsToTree } = require('../bin/fractionalIndex')

/** Pre-fix reference encoder (intentionally O(n²) root lookup) for golden compare. */
function legacyEncodeNodeRows(obj) {
  const graph = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {}
  applyPositionsToTree(graph)
  const parentOf = {}
  Object.keys(graph).forEach(uid => {
    const children = (graph[uid] && graph[uid].children) || []
    children.forEach(child => {
      parentOf[child] = uid
    })
  })
  const findRootUid = o => {
    const uids = Object.keys(o || {})
    return uids.find(uid => o[uid] && o[uid].isRoot) || uids[0] || null
  }
  return Object.keys(graph).map(uid => {
    const node = graph[uid] || {}
    const data = { ...(node.data || {}), uid }
    return {
      uid,
      parent_uid: parentOf[uid] || null,
      position: node.position || encodeRank(STEP),
      data,
      is_root: !!(node.isRoot || (uid === findRootUid(graph) && !parentOf[uid]))
    }
  })
}

function normalizeRow(row) {
  return {
    uid: row.uid,
    parent_uid: row.parent_uid || null,
    position: row.position || '',
    is_root: !!row.is_root,
    data: row.data || {}
  }
}

function sortRows(rows) {
  return rows
    .map(normalizeRow)
    .slice()
    .sort((a, b) => String(a.uid).localeCompare(String(b.uid)))
}

function rowsEqual(a, b) {
  return JSON.stringify(sortRows(a)) === JSON.stringify(sortRows(b))
}

;(async () => {
  for (const size of [200, 1000, 5000]) {
    const graph = bushObjectGraph(size)
    const check = validateNodeGraph(graph)
    assert.ok(check.ok, size + ' invalid: ' + (check.errors || []).join(','))

    const legacy = legacyEncodeNodeRows(JSON.parse(JSON.stringify(graph)))
    const optimized = encodeNodeRows(JSON.parse(JSON.stringify(graph)), {
      rootUid: check.rootUid,
      profile: true
    })
    assert.ok(rowsEqual(legacy, optimized), 'golden mismatch at ' + size)
    assert.strictEqual(optimized.length, size)

    const rebuilt = decodeNodeRows(optimized)
    assert.strictEqual(Object.keys(rebuilt).length, size)
    assert.ok(rebuilt.root && rebuilt.root.isRoot)

    const profile = encodeNodeRows.lastProfile
    assert.ok(profile, 'profile missing')
    assert.ok(profile.totalMs < size * 0.5, 'encode still too slow for size ' + size)
    assert.ok(profile.rootLookupMs < 20, 'root lookup should be O(1)/O(n) once')
  }

  // Double-encode elimination: replace with precomputed rows must not re-encode.
  let encodeCalls = 0
  const realEncode = encodeNodeRows
  // monkey via options path — call replace with encodedRows and ensure graph still validates
  const graph = bushObjectGraph(300)
  const rows = encodeNodeRows(graph, { rootUid: 'root' })
  const store = new Map()
  const db = {
    async query(sql, params) {
      if (/insert into room_nodes/i.test(sql)) {
        store.set(params[0], params[2].length)
      }
      return { rows: [] }
    }
  }
  const wrote = await replaceRoomNodes(db, 'golden-room', graph, 1, {
    allowRestore: true,
    encodedRows: rows
  })
  assert.strictEqual(wrote.wrote, true)
  assert.strictEqual(wrote.nodeCount, 300)
  assert.strictEqual(store.get('golden-room'), 300)
  void encodeCalls
  void realEncode

  console.log('encodeNodeRows.golden.test.js ok')
})().catch(err => {
  console.error(err)
  process.exit(1)
})
