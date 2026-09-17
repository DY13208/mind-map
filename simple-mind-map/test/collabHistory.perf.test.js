const assert = require('assert')
const { randomUUID } = require('crypto')
const {
  createHistoryEngine,
  createMemoryHistoryStore
} = require('../bin/collabHistory')

function percentile(values, p) {
  const sorted = values.slice().sort((a, b) => a - b)
  if (!sorted.length) return 0
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  )
  return sorted[idx]
}

function bush(count) {
  const nodes = {
    root: { isRoot: true, data: { uid: 'root', text: 'Root' }, children: [] }
  }
  for (let i = 0; i < count; i++) {
    const uid = 'n' + i
    const parent = i === 0 ? 'root' : 'n' + Math.floor((i - 1) / 8)
    nodes[uid] = {
      isRoot: false,
      data: { uid, text: 'N' + i },
      children: []
    }
    if (!nodes[parent]) {
      nodes[parent] = {
        isRoot: parent === 'root',
        data: { uid: parent, text: parent },
        children: []
      }
    }
    nodes[parent].children.push(uid)
  }
  return nodes
}

async function time(fn) {
  const started = process.hrtime.bigint()
  await fn()
  return Number(process.hrtime.bigint() - started) / 1e6
}

async function runSize(label, nodeCount) {
  const roomKey = 'perf-' + label
  const store = createMemoryHistoryStore({
    room: {
      roomKey,
      revision: 3,
      nodes: bush(nodeCount),
      metadata: { theme: 'classic', layout: 'mindMap' }
    }
  })
  const engine = createHistoryEngine({
    store,
    config: { checkpointEvery: 100000, autoVersionOnCheckpoint: false }
  })
  await engine.ensureHistoryBaseline(roomKey)
  const version = await engine.createVersion(roomKey, {
    name: 'perf',
    type: 'MANUAL',
    createdBy: 'bench'
  })
  const listSamples = []
  const treeSamples = []
  const commitSamples = []
  for (let i = 0; i < 8; i++) {
    listSamples.push(await time(() => engine.listVersions(roomKey, { limit: 20 })))
    treeSamples.push(await time(() => engine.getVersionTree(roomKey, version.id)))
    commitSamples.push(
      await time(async () => {
        const live = await store.getLiveState(roomKey)
        live.revision += 1
        await store.setLiveState(roomKey, live)
        await store.appendOperation({
          room_key: roomKey,
          version: live.revision,
          operation_id: randomUUID(),
          actor_id: 'bench',
          operation_type: 'node.update',
          payload: { uid: 'n0', text: 'x' + i },
          event: { type: 'node.updated', payload: { uid: 'n0' } }
        })
        await engine.onCommitted({
          roomKey,
          version: live.revision,
          operation: {
            operation_id: randomUUID(),
            version: live.revision,
            operation_type: 'node.update',
            actor_id: 'bench',
            payload: { uid: 'n0' }
          }
        })
      })
    )
  }
  const report = {
    label,
    nodeCount,
    listP95Ms: Number(percentile(listSamples, 95).toFixed(2)),
    treeP95Ms: Number(percentile(treeSamples, 95).toFixed(2)),
    commitP95Ms: Number(percentile(commitSamples, 95).toFixed(2))
  }
  console.log('HISTORY_PERF', JSON.stringify(report))
  assert.ok(report.listP95Ms <= 500, label + ' list p95 ' + report.listP95Ms)
  if (nodeCount <= 10000) {
    assert.ok(report.treeP95Ms <= 2000, label + ' tree p95 ' + report.treeP95Ms)
  }
  return report
}

;(async () => {
  const sizes = String(process.env.HISTORY_PERF_NODES || '1000,10000')
    .split(',')
    .map(item => Number(item.trim()))
    .filter(item => item > 0)
  const reports = []
  for (const size of sizes) {
    reports.push(await runSize(size + 'n', size))
  }
  console.log('collabHistory.perf.test.js ok', JSON.stringify(reports))
})().catch(err => {
  console.error(err)
  process.exit(1)
})
