const assert = require('assert')
const {
  tryPg,
  seedPgRoom,
  startV2Server,
  joinClient,
  submitOp,
  wait
} = require('./collabV2.pgHarness')

async function benchSize(api, url, nodeCount) {
  const roomKey = 'pg-bench-' + nodeCount + '-' + Date.now()
  console.log('[pg-bench] seed', nodeCount, roomKey)
  const seedStarted = process.hrtime.bigint()
  await seedPgRoom(api, roomKey, nodeCount)
  const seedMs = Number(process.hrtime.bigint() - seedStarted) / 1e6
  console.log('[pg-bench] seeded', nodeCount, Number(seedMs.toFixed(1)), 'ms')
  const a = await joinClient(url, roomKey, 'A-' + nodeCount)
  const b = await joinClient(url, roomKey, 'B-' + nodeCount)
  const heapBefore = process.memoryUsage().heapUsed
  const cpuBefore = process.cpuUsage()
  const text = await submitOp(a, 'node.update', { uid: 'n0', text: 'pg-' + nodeCount })
  const eventWait = Date.now()
  while (
    !b.events.some(op => (op.event && op.event.payload && op.event.payload.text) === 'pg-' + nodeCount) &&
    Date.now() - eventWait < 2000
  ) {
    await wait(10)
  }
  const bEventMs = Date.now() - eventWait
  const style = await submitOp(a, 'node.update', { uid: 'n0', fillColor: '#abc' })
  const note = await submitOp(a, 'node.update', { uid: 'n1', note: 'note' })
  const mapRef = await submitOp(a, 'node.update', {
    uid: 'n2',
    mapRef: { mapId: 'x', nodeId: 'y', type: 'node' }
  })
  const insert = await submitOp(a, 'node.insert', {
    uid: 'leaf-' + nodeCount,
    parent: 'n0',
    text: 'leaf'
  })
  const move = await submitOp(a, 'node.move', {
    uid: 'leaf-' + nodeCount,
    parent: 'n1',
    index: 0
  })
  const del = await submitOp(a, 'node.delete', { uid: 'leaf-' + nodeCount })
  const batches = {}
  for (const size of [20, 100, 1000]) {
    batches[size] = await submitOp(a, 'node.batch', {
      ops: Array.from({ length: size }, (_, i) => ({
        type: 'node.insert',
        payload: {
          uid: 'pgb-' + nodeCount + '-' + size + '-' + i,
          parent: 'n3',
          text: 'b' + i
        }
      }))
    })
  }
  const cpu = process.cpuUsage(cpuBefore)
  a.socket.close()
  b.socket.close()
  assert.strictEqual(text.result.ok, true, JSON.stringify(text.result))
  assert.strictEqual(batches[1000].result.ok, true, JSON.stringify(batches[1000].result))
  assert.ok((text.result.queryStats && text.result.queryStats.queries) <= 8)
  console.log('[pg-bench] done', nodeCount, {
    text: text.ms,
    batch1000: batches[1000].ms,
    queries: batches[1000].result.queryStats && batches[1000].result.queryStats.queries
  })
  return {
    roomKey,
    nodes: nodeCount,
    seedMs: Number(seedMs.toFixed(1)),
    textAckMs: Number(text.ms.toFixed(2)),
    textQueries: text.result.queryStats && text.result.queryStats.queries,
    styleAckMs: Number(style.ms.toFixed(2)),
    noteAckMs: Number(note.ms.toFixed(2)),
    mapRefAckMs: Number(mapRef.ms.toFixed(2)),
    insertAckMs: Number(insert.ms.toFixed(2)),
    moveAckMs: Number(move.ms.toFixed(2)),
    deleteAckMs: Number(del.ms.toFixed(2)),
    batch20AckMs: Number(batches[20].ms.toFixed(2)),
    batch100AckMs: Number(batches[100].ms.toFixed(2)),
    batch1000AckMs: Number(batches[1000].ms.toFixed(2)),
    batch1000Queries: batches[1000].result.queryStats && batches[1000].result.queryStats.queries,
    bEventMs,
    cpuUserMs: Number((cpu.user / 1000).toFixed(1)),
    heapDeltaMb: Number(((process.memoryUsage().heapUsed - heapBefore) / 1048576).toFixed(2))
  }
}

async function explainCore(api, roomKey) {
  const client = await api.getPool().connect()
  const out = {}
  try {
    const queries = {
      getNode: {
        text: `explain (analyze, buffers, format json)
               select uid from room_nodes
               where room_key = $1 and uid = $2 and deleted_at is null`,
        params: [roomKey, 'n0']
      },
      siblings: {
        text: `explain (analyze, buffers, format json)
               select uid, position from room_nodes
               where room_key = $1 and parent_uid = $2 and deleted_at is null
               order by position, uid`,
        params: [roomKey, 'n0']
      },
      ancestors: {
        text: `explain (analyze, buffers, format json)
               with recursive walk as (
                 select uid, parent_uid, 0 as depth
                 from room_nodes
                 where room_key = $1 and uid = $2 and deleted_at is null
                 union all
                 select n.uid, n.parent_uid, w.depth + 1
                 from room_nodes n
                 inner join walk w on n.room_key = $1 and n.uid = w.parent_uid and n.deleted_at is null
                 where w.depth < 64
               )
               select uid from walk`,
        params: [roomKey, 'n19999']
      },
      descendants: {
        text: `explain (analyze, buffers, format json)
               with recursive walk as (
                 select uid, 0 as depth
                 from room_nodes
                 where room_key = $1 and parent_uid = $2 and deleted_at is null
                 union all
                 select n.uid, w.depth + 1
                 from room_nodes n
                 inner join walk w on n.room_key = $1 and n.parent_uid = w.uid and n.deleted_at is null
                 where w.depth < 64
               )
               select uid from walk`,
        params: [roomKey, 'n19990']
      },
      opsAfter: {
        text: `explain (analyze, buffers, format json)
               select version from room_operations
               where room_key = $1 and version > $2
               order by version asc limit 500`,
        params: [roomKey, 0]
      }
    }
    for (const [name, q] of Object.entries(queries)) {
      const res = await client.query(q.text, q.params)
      const plan = res.rows[0]['QUERY PLAN'][0]
      out[name] = {
        ms: Number(plan['Execution Time'] || 0),
        planningMs: Number(plan['Planning Time'] || 0),
        node: plan.Plan && plan.Plan['Node Type'],
        index: plan.Plan && (plan.Plan['Index Name'] || (plan.Plan.Plans && plan.Plan.Plans[0] && plan.Plan.Plans[0]['Index Name']))
      }
    }
  } finally {
    client.release()
  }
  return out
}

async function main() {
  const api = await tryPg()
  if (api.error) {
    console.log('skip collabV2 PG bench: PostgreSQL unavailable', api.error.message)
    return
  }
  const { server, url } = await startV2Server()
  try {
    const report = []
    for (const size of [1000, 5000, 10000, 20000]) {
      report.push(await benchSize(api, url, size))
    }
    const explainRoom = report[report.length - 1] && report[report.length - 1].roomKey
    const explain = explainRoom ? await explainCore(api, explainRoom) : {}
    console.log('collabV2 PostgreSQL integration benchmark', JSON.stringify(report, null, 2))
    console.log('collabV2 EXPLAIN ANALYZE 20k', JSON.stringify(explain, null, 2))
    const at1k = report.find(row => row.nodes === 1000)
    const at20k = report.find(row => row.nodes === 20000)
    assert.ok(at20k.textAckMs < Math.max(250, at1k.textAckMs * 8), 'PG text scaled too much')
    assert.ok(at20k.textQueries <= 8)
    assert.ok((at20k.batch1000Queries || 99) < 200, 'batch 1000 still too many SQL round trips')
    console.log('collabV2 PG bench ok')
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
