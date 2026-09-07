'use strict'

/**
 * Encoded-rows must be single-call transient results.
 * Never reuse encodedRows across insert/update/move/delete mutations.
 */

const assert = require('assert')
const {
  snapshotCanonicalForStorage,
  replaceRoomNodes,
  decodeNodeRows
} = require('../bin/roomNodes')
const { bushObjectGraph } = require('./fixtures/largeMapFixtures')

function memoryDb() {
  const tables = new Map()
  return {
    async query(sql, params) {
      const text = String(sql || '').replace(/\s+/g, ' ').trim().toLowerCase()
      if (
        text.startsWith('begin') ||
        text.startsWith('commit') ||
        text.startsWith('rollback')
      ) {
        return { rowCount: 0, rows: [] }
      }
      if (text.includes('select uid from room_nodes') && text.includes('deleted_at is not null')) {
        return { rowCount: 0, rows: [] }
      }
      if (text.includes('set is_root = false')) {
        return { rowCount: 0, rows: [] }
      }
      if (text.includes('insert into room_nodes')) {
        const roomKey = params[0]
        const uids = params[2]
        const parents = params[3]
        const positions = params[4]
        const datas = params[5]
        const roots = params[6]
        const version = params[1]
        const rows = []
        for (let i = 0; i < uids.length; i++) {
          const data =
            datas[i] && typeof datas[i] === 'object'
              ? datas[i]
              : { uid: uids[i] }
          rows.push({
            uid: uids[i],
            parent_uid: parents[i],
            position: positions[i],
            data,
            is_root: !!roots[i],
            node_version: version,
            deleted_at: null
          })
        }
        tables.set(roomKey, rows)
        return { rowCount: rows.length, rows: [] }
      }
      if (text.includes('set deleted_at = now()')) {
        const roomKey = params[0]
        const keep = new Set(params[1] || [])
        const prev = tables.get(roomKey) || []
        tables.set(
          roomKey,
          prev.filter(row => keep.has(row.uid))
        )
        return { rowCount: 0, rows: [] }
      }
      return { rowCount: 0, rows: [] }
    },
    _tables: tables
  }
}

;(async () => {
  let insertStale = 'PASS'
  let updateStale = 'PASS'
  let moveStale = 'PASS'
  let deleteStale = 'PASS'

  try {
    const graph = bushObjectGraph(40)
    const stale = snapshotCanonicalForStorage(graph)
    assert.ok(stale.ok)
    const parent = 'root'
    const uid = 'insert-x'
    graph[uid] = { data: { uid, text: 'INSERT_X' }, children: [] }
    graph[parent].children = graph[parent].children.concat([uid])
    const fresh = snapshotCanonicalForStorage(graph)
    assert.ok(fresh.encodedRows.some(r => r.uid === uid))
    assert.ok(!stale.encodedRows.some(r => r.uid === uid))

    const db = memoryDb()
    await replaceRoomNodes(db, 'r-insert-stale', graph, 1, {
      encodedRows: stale.encodedRows,
      allowRestore: true
    })
    const bad = decodeNodeRows(db._tables.get('r-insert-stale') || [])
    assert.ok(!bad[uid], 'stale encodedRows must omit the new node')

    await replaceRoomNodes(db, 'r-insert-fresh', graph, 1, {
      encodedRows: fresh.encodedRows,
      allowRestore: true
    })
    const good = decodeNodeRows(db._tables.get('r-insert-fresh') || [])
    assert.ok(good[uid])
    assert.strictEqual(good[uid].data.text, 'INSERT_X')
  } catch (err) {
    insertStale = 'FAIL'
    console.error('ENCODE_CACHE_INSERT_STALE', err)
    throw err
  }

  try {
    const graph = bushObjectGraph(40)
    const victim = Object.keys(graph).find(uid => uid !== 'root')
    const stale = snapshotCanonicalForStorage(graph)
    graph[victim].data.text = 'UPDATED_SAME_LEN_XXXX'
    const fresh = snapshotCanonicalForStorage(graph)
    assert.notStrictEqual(
      stale.encodedRows.find(r => r.uid === victim).data.text,
      fresh.encodedRows.find(r => r.uid === victim).data.text
    )
    const db = memoryDb()
    await replaceRoomNodes(db, 'r-update', graph, 1, {
      encodedRows: fresh.encodedRows,
      allowRestore: true
    })
    const nodes = decodeNodeRows(db._tables.get('r-update') || [])
    assert.strictEqual(nodes[victim].data.text, 'UPDATED_SAME_LEN_XXXX')
  } catch (err) {
    updateStale = 'FAIL'
    console.error('ENCODE_CACHE_UPDATE_STALE', err)
    throw err
  }

  try {
    // bushObjectGraph puts only n0 under root; n0 has multiple siblings under it.
    const graph = bushObjectGraph(40)
    const parent = 'n0'
    assert.ok((graph[parent].children || []).length >= 2)
    const child = graph[parent].children[0]
    const sibling = graph[parent].children[1]
    assert.ok(child && sibling)
    const stale = snapshotCanonicalForStorage(graph)
    graph[parent].children = graph[parent].children.filter(id => id !== child)
    graph[sibling].children = (graph[sibling].children || []).concat([child])
    const fresh = snapshotCanonicalForStorage(graph)
    const staleParent = stale.encodedRows.find(r => r.uid === child).parent_uid
    const freshParent = fresh.encodedRows.find(r => r.uid === child).parent_uid
    assert.notStrictEqual(staleParent, freshParent)
    const db = memoryDb()
    await replaceRoomNodes(db, 'r-move', graph, 1, {
      encodedRows: fresh.encodedRows,
      allowRestore: true
    })
    const nodes = decodeNodeRows(db._tables.get('r-move') || [])
    assert.ok(nodes[sibling].children.includes(child))
  } catch (err) {
    moveStale = 'FAIL'
    console.error('ENCODE_CACHE_MOVE_STALE', err)
    throw err
  }

  try {
    const graph = bushObjectGraph(40)
    // Delete a leaf under n0 so the remaining graph stays canonical.
    const parent = 'n0'
    const victim = graph[parent].children[graph[parent].children.length - 1]
    assert.ok(victim)
    assert.ok(!(graph[victim].children || []).length)
    const stale = snapshotCanonicalForStorage(graph)
    graph[parent].children = graph[parent].children.filter(id => id !== victim)
    delete graph[victim]
    const fresh = snapshotCanonicalForStorage(graph)
    assert.ok(fresh.ok)
    assert.ok(stale.encodedRows.some(r => r.uid === victim))
    assert.ok(!fresh.encodedRows.some(r => r.uid === victim))
    const db = memoryDb()
    await replaceRoomNodes(db, 'r-delete', graph, 1, {
      encodedRows: fresh.encodedRows,
      allowRestore: true
    })
    const nodes = decodeNodeRows(db._tables.get('r-delete') || [])
    assert.ok(!nodes[victim])
  } catch (err) {
    deleteStale = 'FAIL'
    console.error('ENCODE_CACHE_DELETE_STALE', err)
    throw err
  }

  console.log('ENCODE_CACHE_INSERT_STALE =', insertStale)
  console.log('ENCODE_CACHE_UPDATE_STALE =', updateStale)
  console.log('ENCODE_CACHE_MOVE_STALE =', moveStale)
  console.log('ENCODE_CACHE_DELETE_STALE =', deleteStale)
  assert.strictEqual(insertStale, 'PASS')
  assert.strictEqual(updateStale, 'PASS')
  assert.strictEqual(moveStale, 'PASS')
  assert.strictEqual(deleteStale, 'PASS')
})().catch(err => {
  console.error(err)
  process.exit(1)
})
