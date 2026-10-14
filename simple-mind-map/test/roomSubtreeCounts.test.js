const assert = require('assert')
const { readRoomSubtree, stampAuthoritativeChildCounts } = require('../bin/roomNodes')
const { resetRoomSubtreeCountsCache } = require('../bin/subtreeCountCache')

function makeRow(uid, parent_uid, position, is_root = false, deleted_at = null) {
  return {
    uid,
    parent_uid,
    position,
    data: { uid, text: uid },
    is_root,
    node_version: 1,
    deleted_at
  }
}

function copyState(state) {
  return {
    version: state.version,
    updated_at: state.updated_at,
    rows: state.rows.map(row => ({ ...row, data: { ...row.data } }))
  }
}

function makeQueryable(readState, onMetaRead) {
  const calls = { sql: [], edgeScans: 0 }
  return {
    calls,
    async query(text, params = []) {
      calls.sql.push(String(text).replace(/\s+/g, ' ').trim())
      const sql = String(text).toLowerCase().replace(/\s+/g, ' ')
      const state = readState()
      const liveRows = state.rows.filter(row => !row.deleted_at)

      if (sql.includes('select version, updated_at from rooms')) {
        const result = { rows: [{ version: state.version, updated_at: state.updated_at }] }
        if (onMetaRead) await onMetaRead()
        return result
      }
      if (sql.includes('select uid from room_nodes') && sql.includes('is_root')) {
        return { rows: liveRows.filter(row => row.is_root).slice(0, 1).map(row => ({ uid: row.uid })) }
      }
      if (sql.includes('select uid from room_nodes') && sql.includes('uid = $2')) {
        return { rows: liveRows.filter(row => row.uid === params[1]).slice(0, 1).map(row => ({ uid: row.uid })) }
      }
      if (sql.includes('with recursive walk as')) {
        const byParent = new Map()
        liveRows.forEach(row => {
          if (!byParent.has(row.parent_uid)) byParent.set(row.parent_uid, [])
          byParent.get(row.parent_uid).push(row)
        })
        const found = []
        const stack = [{ uid: params[1], depth: 0 }]
        while (stack.length && found.length < params[2]) {
          const current = stack.shift()
          const row = liveRows.find(item => item.uid === current.uid)
          if (!row) continue
          found.push(row)
          if (current.depth >= 12) continue
          for (const child of byParent.get(current.uid) || []) {
            stack.push({ uid: child.uid, depth: current.depth + 1 })
          }
        }
        return { rows: found.slice(0, params[2]) }
      }
      if (sql.includes('select count(*)::int as total')) {
        return { rows: [{ total: liveRows.filter(row => row.parent_uid === params[1]).length }] }
      }
      if (sql.includes('order by position, uid')) {
        const offset = Number(params[2]) || 0
        const limit = Number(params[3]) || 200
        const rows = liveRows
          .filter(row => row.parent_uid === params[1])
          .sort((a, b) => a.position.localeCompare(b.position) || a.uid.localeCompare(b.uid))
          .slice(offset, offset + limit)
        return { rows }
      }
      if (sql.includes('select uid, parent_uid') && sql.includes('from room_nodes')) {
        calls.edgeScans++
        return { rows: liveRows.map(({ uid, parent_uid }) => ({ uid, parent_uid })) }
      }
      throw new Error('Unexpected fake SQL: ' + text)
    }
  }
}

function makePool(state, onMetaRead) {
  const queryable = makeQueryable(() => state, onMetaRead)
  const pool = {
    calls: queryable.calls,
    async connect() {
      let transactionState = null
      const client = makeQueryable(() => transactionState || state, async () => {
        if (onMetaRead) await onMetaRead()
      })
      return {
        async query(text, params) {
          const sql = String(text).toLowerCase().replace(/\s+/g, ' ').trim()
          pool.calls.sql.push(String(text).replace(/\s+/g, ' ').trim())
          if (sql.startsWith('begin ')) {
            transactionState = copyState(state)
            return { rows: [] }
          }
          if (sql === 'commit' || sql === 'rollback') return { rows: [] }
          const before = client.calls.sql.length
          const result = await client.query(text, params)
          pool.calls.edgeScans += client.calls.edgeScans
          client.calls.edgeScans = 0
          if (pool.calls.sql.length === before) pool.calls.sql.push(String(text))
          return result
        },
        release() { pool.calls.sql.push('release') }
      }
    },
    async query(text, params) { return queryable.query(text, params) }
  }
  return pool
}

async function testVersionedCountsPaginationAndInvalidation() {
  resetRoomSubtreeCountsCache()
  const state = {
    version: 1,
    updated_at: new Date('2026-10-13T00:00:00Z'),
    rows: [
      makeRow('root', null, 'a0', true),
      makeRow('a', 'root', 'a0'),
      makeRow('leaf', 'a', 'a0'),
      makeRow('b', 'root', 'a1')
    ]
  }
  const db = makePool(state)
  const firstPage = await readRoomSubtree(db, 'count-room', 'root', { limit: 1 })
  assert.strictEqual(firstPage.total, 2)
  assert.strictEqual(firstPage.descendantCount, 3)
  assert.strictEqual(firstPage.has_more, true)
  assert.strictEqual(firstPage.children[0].data.childCount, 1)
  assert.strictEqual(db.calls.edgeScans, 1)
  assert.ok(!db.calls.sql.some(sql => /select count\(\*\)/i.test(sql)))

  const secondPage = await readRoomSubtree(db, 'count-room', 'root', { offset: 1, limit: 1 })
  assert.strictEqual(secondPage.total, 2)
  assert.strictEqual(secondPage.children[0].data.uid, 'b')
  assert.strictEqual(db.calls.edgeScans, 1)

  const unchanged = await readRoomSubtree(db, 'count-room', 'root', { knownVersion: 1 })
  assert.strictEqual(unchanged.unchanged, true)
  assert.strictEqual(db.calls.edgeScans, 1)

  state.version = 2
  state.rows = [
    makeRow('root', null, 'a0', true),
    makeRow('a', 'root', 'a0'),
    makeRow('leaf', 'root', 'a1'),
    makeRow('b', 'root', 'a2', false, new Date()),
    makeRow('c', 'root', 'a3')
  ]
  const changed = await readRoomSubtree(db, 'count-room', 'root', { limit: 10 })
  assert.strictEqual(changed.version, 2)
  assert.strictEqual(changed.total, 3)
  assert.strictEqual(changed.descendantCount, 3)
  assert.strictEqual(changed.children.find(item => item.data.uid === 'a').data.childCount, 0)
  assert.strictEqual(db.calls.edgeScans, 2)

  const otherDb = makePool(state)
  await readRoomSubtree(otherDb, 'count-room', 'root')
  assert.strictEqual(otherDb.calls.edgeScans, 1)
}

async function testLegacyTotalsReturnShape() {
  const db = makeQueryable(() => ({
    version: 1,
    updated_at: new Date(),
    rows: [makeRow('root', null, 'a0', true), makeRow('child', 'root', 'a0')]
  }))
  const tree = { data: { uid: 'root' }, children: [{ data: { uid: 'child' }, children: [] }] }
  const result = await stampAuthoritativeChildCounts(db, 'totals-room', tree)
  assert.ok(result.totals instanceof Map)
  assert.strictEqual(result.totals.get('root'), 1)
  assert.strictEqual(result.totals.get('child'), 0)
}

async function testEmptyAndDeepGraphs() {
  resetRoomSubtreeCountsCache()
  const emptyState = {
    version: 1,
    updated_at: new Date(),
    rows: [makeRow('root', null, 'a0', true)]
  }
  const emptyDb = makeQueryable(() => emptyState)
  const empty = await readRoomSubtree(emptyDb, 'empty-room', 'root')
  assert.strictEqual(empty.total, 0)
  assert.strictEqual(empty.descendantCount, 0)
  assert.strictEqual(emptyDb.calls.edgeScans, 1)

  const rows = [makeRow('root', null, 'a0', true)]
  let parent = 'root'
  for (let index = 0; index < 1500; index++) {
    const uid = 'deep-' + index
    rows.push(makeRow(uid, parent, String(index).padStart(6, '0')))
    parent = uid
  }
  const deepDb = makeQueryable(() => ({ version: 1, updated_at: new Date(), rows }))
  const deep = await readRoomSubtree(deepDb, 'deep-room', 'root', { limit: 1 })
  assert.strictEqual(deep.descendantCount, 1500)
  assert.strictEqual(deep.children[0].data.childCount, 1)
}

async function testRepeatableReadSnapshotAndClientReuse() {
  resetRoomSubtreeCountsCache()
  const state = {
    version: 1,
    updated_at: new Date('2026-10-13T00:00:00Z'),
    rows: [makeRow('root', null, 'a0', true), makeRow('a', 'root', 'a0'), makeRow('leaf', 'a', 'a0')]
  }
  let mutateOnce = true
  const pool = makePool(state, async () => {
    if (!mutateOnce) return
    mutateOnce = false
    state.version = 2
    state.rows = [
      makeRow('root', null, 'a0', true),
      makeRow('a', 'root', 'a0'),
      makeRow('leaf', 'a', 'a0', false, new Date()),
      makeRow('b', 'root', 'a1'),
      makeRow('b-leaf', 'b', 'a0')
    ]
  })

  const oldSnapshot = await readRoomSubtree(pool, 'snapshot-room', 'root')
  assert.strictEqual(oldSnapshot.version, 1)
  assert.strictEqual(oldSnapshot.total, 1)
  assert.strictEqual(oldSnapshot.descendantCount, 2)
  assert.strictEqual(oldSnapshot.children[0].data.childCount, 1)
  assert.ok(pool.calls.sql.includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'))
  assert.ok(pool.calls.sql.includes('COMMIT'))
  assert.ok(pool.calls.sql.includes('release'))

  const newSnapshot = await readRoomSubtree(pool, 'snapshot-room', 'root')
  assert.strictEqual(newSnapshot.version, 2)
  assert.strictEqual(newSnapshot.total, 2)
  assert.strictEqual(newSnapshot.descendantCount, 3)

  const directClient = makeQueryable(() => state)
  let directClientConnects = 0
  directClient.getTransactionStatus = () => 'I'
  directClient.connect = async () => {
    directClientConnects++
    throw new Error('must not reconnect a supplied pg.Client')
  }
  await readRoomSubtree(directClient, 'client-room', 'root')
  await readRoomSubtree(directClient, 'client-room', 'root')
  assert.strictEqual(directClientConnects, 0)
  assert.ok(!directClient.calls.sql.some(sql => /^begin\b/i.test(sql)))
  assert.ok(!directClient.calls.sql.some(sql => /^commit\b/i.test(sql)))
  assert.strictEqual(directClient.calls.edgeScans, 2)
}

async function main() {
  await testVersionedCountsPaginationAndInvalidation()
  await testLegacyTotalsReturnShape()
  await testEmptyAndDeepGraphs()
  await testRepeatableReadSnapshotAndClientReuse()
  console.log('room subtree count tests passed')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
