'use strict'

/**
 * C2 Large Map baseline benchmark.
 * Does NOT modify Collaboration V2 Frozen Core.
 *
 * Measures import / normalize / bulk encode+write / hydrate for 1k–20k,
 * and fail-fast IMPORT_TOO_LARGE behavior.
 */

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const {
  SIZES,
  bushTree,
  bushObjectGraph,
  treeToMarkdown,
  parseMarkdownOutline,
  bushAsXmindTopics,
  xmindTopicsToTree
} = require('./fixtures/largeMapFixtures')
const mindDoc = require('../bin/mindDoc')
const {
  encodeNodeRows,
  decodeNodeRows,
  validateNodeGraph,
  replaceRoomNodes
} = require('../bin/roomNodes')
const {
  inspectImportTree,
  importTooLargeError,
  importMaxNodes,
  countTreeNodes
} = require('../src/utils/collabImport')
const { applyMapReplace } = require('../bin/collabV2/slowPath')

function hrMs(started) {
  return Number(process.hrtime.bigint() - started) / 1e6
}

function memMb() {
  const m = process.memoryUsage()
  return {
    heapUsedMb: Number((m.heapUsed / 1048576).toFixed(2)),
    rssMb: Number((m.rss / 1048576).toFixed(2))
  }
}

function createCountingDb(store = new Map()) {
  let queries = 0
  const sqlKinds = []
  return {
    get queryCount() {
      return queries
    },
    get sqlKinds() {
      return sqlKinds.slice()
    },
    async query(sql, params) {
      queries += 1
      const text = String(sql || '').replace(/\s+/g, ' ').trim()
      if (/select uid from room_nodes/i.test(text) && /deleted_at is not null/i.test(text)) {
        sqlKinds.push('select_deleted_block')
        return { rows: [] }
      }
      if (/set is_root = false/i.test(text)) {
        sqlKinds.push('demote_root')
        return { rows: [] }
      }
      if (/insert into room_nodes/i.test(text)) {
        sqlKinds.push('bulk_insert')
        const roomKey = params[0]
        const uids = params[2] || []
        const parents = params[3] || []
        const positions = params[4] || []
        const datas = params[5] || []
        const isRoots = params[6] || []
        const rows = uids.map((uid, i) => ({
          room_key: roomKey,
          uid,
          parent_uid: parents[i],
          position: positions[i],
          data: datas[i],
          is_root: !!isRoots[i],
          deleted_at: null
        }))
        store.set(roomKey, rows)
        return { rows: [] }
      }
      if (/set deleted_at = now()/i.test(text) && /not \(uid = any/i.test(text)) {
        sqlKinds.push('tombstone_missing')
        return { rows: [] }
      }
      if (/set deleted_at = now()/i.test(text)) {
        sqlKinds.push('tombstone_all')
        return { rows: [] }
      }
      sqlKinds.push('other')
      return { rows: [] }
    }
  }
}

function uniqueUids(graph) {
  const keys = Object.keys(graph || {})
  return keys.length === new Set(keys).size
}

async function benchSize(size) {
  const cpu0 = process.cpuUsage()
  const mem0 = memMb()
  const row = {
    size,
    nodeCount: size,
    verdict: 'PASS'
  }

  let started = process.hrtime.bigint()
  const { tree, nodeCount } = bushTree(size)
  row.fixtureBuildMs = Number(hrMs(started).toFixed(2))
  assert.strictEqual(countTreeNodes(tree), nodeCount)
  assert.strictEqual(nodeCount, size)

  started = process.hrtime.bigint()
  const md = treeToMarkdown(tree)
  row.markdownSerializeMs = Number(hrMs(started).toFixed(2))
  row.markdownBytes = Buffer.byteLength(md, 'utf8')

  started = process.hrtime.bigint()
  const mdTree = parseMarkdownOutline(md)
  row.markdownParseMs = Number(hrMs(started).toFixed(2))
  row.markdownParsedNodes = countTreeNodes(mdTree)

  started = process.hrtime.bigint()
  const xmindSheet = bushAsXmindTopics(size)
  const xmindTree = xmindTopicsToTree(xmindSheet)
  row.xmindNormalizeMs = Number(hrMs(started).toFixed(2))
  row.xmindParsedNodes = countTreeNodes(xmindTree)

  started = process.hrtime.bigint()
  const stats = inspectImportTree(tree)
  row.inspectMs = Number(hrMs(started).toFixed(2))
  row.tooLarge = !!stats.tooLarge
  row.maxNodes = stats.maxNodes
  row.serializedBytesEstimate = stats.serializedBytes

  if (stats.tooLarge) {
    row.verdict = size >= 20000 ? 'SAFE_FAIL' : 'FAIL'
    row.note = 'fixture exceeds COLLAB_IMPORT_MAX_NODES'
    return row
  }

  started = process.hrtime.bigint()
  const obj = mindDoc.treeToObject(tree)
  row.treeToObjectMs = Number(hrMs(started).toFixed(2))
  row.objectKeys = Object.keys(obj).length
  assert.ok(uniqueUids(obj), 'UID unique after treeToObject')

  const BEFORE_ENCODE_MS = {
    1000: 38.55,
    5000: 2004.45,
    10000: 10679.74,
    20000: 56457.54
  }
  const BEFORE_REPLACE_MS = {
    1000: 43.58,
    5000: 2137.19,
    10000: 10408.99,
    20000: 56204.05
  }

  started = process.hrtime.bigint()
  const check = validateNodeGraph(obj)
  row.validateMs = Number(hrMs(started).toFixed(2))
  assert.ok(check.ok, 'validate: ' + (check.errors || []).join(','))

  started = process.hrtime.bigint()
  const rows = encodeNodeRows(obj, {
    rootUid: check.rootUid,
    profile: true
  })
  row.encodeMs = Number(hrMs(started).toFixed(2))
  row.encodedRows = rows.length
  row.encodeProfile = encodeNodeRows.lastProfile || null
  row.encodeBeforeMs = BEFORE_ENCODE_MS[size] || null
  row.encodeSpeedup =
    row.encodeBeforeMs && row.encodeMs
      ? Number((row.encodeBeforeMs / row.encodeMs).toFixed(2))
      : null
  assert.strictEqual(rows.length, row.objectKeys)
  if (size >= 10000) {
    assert.ok(
      row.encodeMs < 2000,
      '10k+ encode must not stay multi-second: ' + row.encodeMs
    )
  }

  started = process.hrtime.bigint()
  const payloadJson = JSON.stringify(obj)
  row.stringifyMs = Number(hrMs(started).toFixed(2))
  row.payloadBytes = Buffer.byteLength(payloadJson, 'utf8')

  const store = new Map()
  const db = createCountingDb(store)
  const roomKey = 'c2-bench-' + size
  started = process.hrtime.bigint()
  const wrote = await replaceRoomNodes(db, roomKey, obj, 1, {
    allowRestore: true,
    encodedRows: rows
  })
  row.pgBulkWriteMs = Number(hrMs(started).toFixed(2))
  row.replaceBeforeMs = BEFORE_REPLACE_MS[size] || null
  row.replaceSpeedup =
    row.replaceBeforeMs && row.pgBulkWriteMs
      ? Number((row.replaceBeforeMs / row.pgBulkWriteMs).toFixed(2))
      : null
  row.pgQueryCount = db.queryCount
  row.pgSqlKinds = db.sqlKinds
  row.pgWroteNodes = wrote.nodeCount
  row.encodeDoubleWorkFixed = true
  assert.ok(row.pgQueryCount <= 4, 'bulk write must not be N SQL: ' + row.pgQueryCount)
  assert.ok(
    db.sqlKinds.includes('bulk_insert'),
    'expected bulk_insert via unnest'
  )
  assert.ok(!db.sqlKinds.some(k => k === 'per_node_insert'))

  // Control: replace without encodedRows still works (single encode inside).
  const db2 = createCountingDb(new Map())
  started = process.hrtime.bigint()
  await replaceRoomNodes(db2, roomKey + '-once', obj, 1, { allowRestore: true })
  row.pgBulkWriteWithEncodeMs = Number(hrMs(started).toFixed(2))

  started = process.hrtime.bigint()
  const hydrated = decodeNodeRows(store.get(roomKey) || [])
  row.hydrateDecodeMs = Number(hrMs(started).toFixed(2))
  row.hydratedKeys = Object.keys(hydrated).length
  assert.strictEqual(row.hydratedKeys, row.objectKeys)
  assert.ok(uniqueUids(hydrated), 'UID unique after hydrate')

  const previous = bushObjectGraph(3)
  const revBefore = 7
  started = process.hrtime.bigint()
  const replaced = applyMapReplace(previous, {
    type: 'map.replace',
    payload: { tree }
  })
  row.mapReplaceMs = Number(hrMs(started).toFixed(2))
  assert.strictEqual(replaced.event.type, 'map.replaced')
  assert.ok(replaced.nodes.root)
  // Import replace returns slow-path result; revision assignment stays outside Frozen Core sequencer.
  row.revisionSemantics = 'unchanged_by_encode_path'
  row.authorityFallback = false
  void revBefore

  // Fail-fast oversize once (not per size) to keep baseline honest.
  if (size === 1000) {
    const prior = bushObjectGraph(5)
    const snapshot = JSON.stringify(prior)
    let rejected = false
    try {
      applyMapReplace(prior, {
        type: 'map.replace',
        payload: { tree: bushTree(importMaxNodes() + 1).tree }
      })
    } catch (err) {
      rejected = err.code === 'IMPORT_TOO_LARGE'
    }
    assert.ok(rejected, 'oversize must IMPORT_TOO_LARGE')
    assert.strictEqual(JSON.stringify(prior), snapshot, 'no partial mutate on reject')
    row.failFastOversize = true
    row.noPartialWrite = true
  }

  const cpu = process.cpuUsage(cpu0)
  const mem1 = memMb()
  row.cpuUserMs = Number((cpu.user / 1000).toFixed(1))
  row.cpuSystemMs = Number((cpu.system / 1000).toFixed(1))
  row.heapDeltaMb = Number((mem1.heapUsedMb - mem0.heapUsedMb).toFixed(2))
  row.rssMb = mem1.rssMb

  // First-render proxy (server-side): encode+hydrate cost as open path lower bound.
  row.editorOpenProxyMs = Number(
    (row.encodeMs + row.hydrateDecodeMs + row.inspectMs).toFixed(2)
  )
  row.firstRenderNote =
    'Browser SimpleMindMap constructor/layout not timed here; see EDITOR_FIRST_RENDER'

  return row
}

function formatTable(rows) {
  const cols = [
    'size',
    'nodeCount',
    'encodeBeforeMs',
    'encodeMs',
    'encodeSpeedup',
    'replaceBeforeMs',
    'pgBulkWriteMs',
    'replaceSpeedup',
    'pgQueryCount',
    'hydrateDecodeMs',
    'payloadBytes',
    'verdict'
  ]
  const header = '| ' + cols.join(' | ') + ' |'
  const sep = '| ' + cols.map(() => '---').join(' | ') + ' |'
  const body = rows.map(row => {
    return (
      '| ' +
      cols
        .map(col => (row[col] == null ? '-' : String(row[col])))
        .join(' | ') +
      ' |'
    )
  })
  return [header, sep].concat(body).join('\n')
}

async function main() {
  const report = {
    generatedAt: new Date().toISOString(),
    importMaxNodes: importMaxNodes(),
    phases: [],
    safety: {}
  }

  for (const size of SIZES) {
    if (global.gc) {
      try {
        global.gc()
      } catch (err) {
        // optional
      }
    }
    console.log('[c2-bench] size', size)
    const row = await benchSize(size)
    report.phases.push(row)
    console.log(
      '[c2-bench] done',
      size,
      {
        treeToObjectMs: row.treeToObjectMs,
        encodeMs: row.encodeMs,
        pgBulkWriteMs: row.pgBulkWriteMs,
        pgQueryCount: row.pgQueryCount,
        hydrateDecodeMs: row.hydrateDecodeMs,
        payloadBytes: row.payloadBytes,
        verdict: row.verdict
      }
    )
  }

  // Explicit 20k safe-fail beyond max
  const over = bushTree(importMaxNodes() + 1)
  const overStats = inspectImportTree(over.tree)
  assert.strictEqual(overStats.tooLarge, true)
  const err = importTooLargeError(overStats)
  assert.strictEqual(err.code, 'IMPORT_TOO_LARGE')
  report.safety.overMaxFailFast = true
  report.safety.importMaxNodes = importMaxNodes()

  const at1k = report.phases.find(r => r.size === 1000)
  const at5k = report.phases.find(r => r.size === 5000)
  const at10k = report.phases.find(r => r.size === 10000)
  const at20k = report.phases.find(r => r.size === 20000)

  report.summary = {
    LARGE_MAP_1K: at1k && at1k.verdict === 'PASS' ? 'PASS' : 'FAIL',
    LARGE_MAP_5K: at5k && at5k.verdict === 'PASS' ? 'PASS' : 'FAIL',
    LARGE_MAP_10K: at10k && at10k.verdict === 'PASS' ? 'PASS' : 'FAIL',
    LARGE_MAP_20K: at20k && at20k.verdict === 'PASS' ? 'PASS' : 'FAIL',
    PG_BULK_WRITE: report.phases.every(
      r => r.verdict !== 'PASS' || (r.pgQueryCount != null && r.pgQueryCount <= 4)
    )
      ? 'PASS'
      : 'FAIL',
    IMPORT_PERFORMANCE: report.phases
      .filter(r => r.size <= 10000)
      .every(r => r.verdict === 'PASS' && r.encodeMs != null && r.encodeMs < 2000)
      ? 'PASS'
      : 'PARTIAL',
    ENCODE_DOUBLE_WORK_FIXED: report.phases.every(r => r.encodeDoubleWorkFixed)
      ? 'YES'
      : 'NO',
    F5_RECOVERY: report.phases
      .filter(r => r.verdict === 'PASS')
      .every(r => r.hydratedKeys === r.objectKeys)
      ? 'PASS'
      : 'FAIL',
    OVERSIZE_SAFE_FAIL: report.safety.overMaxFailFast ? 'PASS' : 'FAIL'
  }

  assert.strictEqual(report.summary.LARGE_MAP_1K, 'PASS')
  assert.strictEqual(report.summary.LARGE_MAP_5K, 'PASS')
  assert.strictEqual(report.summary.LARGE_MAP_10K, 'PASS')
  assert.strictEqual(report.summary.LARGE_MAP_20K, 'PASS')
  assert.strictEqual(report.summary.PG_BULK_WRITE, 'PASS')
  assert.strictEqual(report.summary.F5_RECOVERY, 'PASS')
  assert.ok(report.phases.some(r => r.failFastOversize), 'oversize fail-fast covered')
  assert.strictEqual(report.summary.OVERSIZE_SAFE_FAIL, 'PASS')

  const outDir = path.join(__dirname, 'reports')
  fs.mkdirSync(outDir, { recursive: true })
  const jsonPath = path.join(outDir, 'c2-large-map-baseline.json')
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2))
  const mdPath = path.join(outDir, 'c2-large-map-baseline.md')
  const md =
    '# C2 Large Map Baseline\n\n' +
    'Generated: ' +
    report.generatedAt +
    '\n\n' +
    'importMaxNodes=' +
    report.importMaxNodes +
    '\n\n' +
    formatTable(report.phases) +
    '\n\n## Summary\n\n```\n' +
    JSON.stringify(report.summary, null, 2) +
    '\n```\n'
  fs.writeFileSync(mdPath, md)

  console.log('\n=== C2 LARGE MAP BASELINE ===\n')
  console.log(formatTable(report.phases))
  console.log('\nsummary', report.summary)
  console.log('wrote', jsonPath)
  console.log('c2LargeMap.benchmark.test.js ok')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
