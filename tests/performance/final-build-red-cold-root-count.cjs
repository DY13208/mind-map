// RED regression: cold-statistics root-scope exact-count preview.
//
// Real product entry: the fixture's real `/api/files/<room>/preview?depth=2`
// handler -> storage -> roomNodes.getRoomSubtree(root, deep, maxNodes 80) ->
// stampAuthoritativeChildCounts -> readSelectedNodeCounts.
//
// Cold statistics are established deterministically inside the isolated fixture:
// autoanalyze is disabled for this owned table (prior reloptions preserved), the
// table is ANALYZEd while still small, then a real 10k room is bulk-seeded
// through the product seed path and the preview is called immediately.
//
// FORMAL assertions are product behaviour only, so a legitimate product fix
// turns this test GREEN without editing the test:
//   - HTTP 200; the returned root is the DB root (parent_uid null);
//   - every node returned by the preview has exact childCount/descendantCount
//     vs an independent single-select + bottom-up computation over real rows;
//   - the real preview completes under PREVIEW_MAX_MS with cold statistics.
// Raw SQL plans are DIAGNOSTIC ONLY (isolated try/catch, never asserted).
//
// Run: node tests/performance/final-build-red-cold-root-count.cjs
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { startFinalFixture, repo } = require('./final-build-app.cjs')

const OUT = path.join(repo, 'work/performance-tdd/pi/timeout-investigation/red-cold-root-count')
const NEW_SQL = `with recursive relevant as (
   select uid, parent_uid from room_nodes
   where room_key = $1 and uid = any($2::text[]) and deleted_at is null
   union
   select n.uid, n.parent_uid from relevant p
   cross join lateral (
     select uid, parent_uid from room_nodes
     where room_key = $1 and parent_uid = p.uid and deleted_at is null
     offset 0
   ) n
 )
 select uid, parent_uid from relevant`
const OLD_SQL = `select uid, parent_uid from room_nodes where room_key = $1 and deleted_at is null`
const PREVIEW_MAX_MS = 1500
const PREVIEW_FETCH_DEADLINE_MS = 30000

function withDeadline (promise, ms, label) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); if (timer.unref) timer.unref() })])
    .finally(() => clearTimeout(timer))
}

function bottomUpCounts (rows) {
  const children = new Map(rows.map(row => [row.uid, []]))
  for (const row of rows) if (children.has(row.parent_uid)) children.get(row.parent_uid).push(row.uid)
  const memo = new Map(); const visiting = new Set()
  const count = uid => {
    if (memo.has(uid)) return memo.get(uid)
    if (visiting.has(uid)) return 0
    visiting.add(uid)
    let total = 0
    for (const child of children.get(uid) || []) total += 1 + count(child)
    visiting.delete(uid); memo.set(uid, total)
    return total
  }
  for (const uid of children.keys()) count(uid)
  const rootRow = rows.find(row => !row.parent_uid)
  return { childCount: uid => (children.get(uid) || []).length, descendantCount: uid => memo.get(uid) || 0,
    rootUid: rootRow ? rootRow.uid : null }
}

async function main () {
  fs.mkdirSync(OUT, { recursive: true })
  const runId = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  const testSha = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex')
  const evidence = { runId, testSha256: testSha, startedAt: new Date().toISOString(), assertions: [] }
  const receiptPath = () => path.join(OUT, `${evidence.status === 'GREEN' ? 'result' : 'failure'}-${runId}.json`)
  const check = (name, fn) => {
    try { fn(); evidence.assertions.push({ name, ok: true }) }
    catch (error) { evidence.assertions.push({ name, ok: false, message: String(error.message) }); throw error }
  }
  let fixture
  try {
    fixture = await startFinalFixture({ instances: 1, profile: 'default', artifact: process.env.PERF_TDD_E2E_ARTIFACT || 'after-web-final23' })
    const storage = require(path.join(repo, 'simple-mind-map/bin/storage'))
    const pool = storage.getPool()
    // Preserve the existing reloptions so finally can restore the exact prior state.
    evidence.autovacuumPrior = (await pool.query(`select coalesce(reloptions, '{}') as reloptions from pg_class where relname='room_nodes'`)).rows[0].reloptions
    // Must fail up front if cold statistics cannot be guaranteed.
    await pool.query('alter table room_nodes set (autovacuum_enabled = false)')
    evidence.autovacuumDisabled = true
    await pool.query('analyze room_nodes')
    evidence.coldStats = (await pool.query(`select n_live_tup, n_mod_since_analyze, last_analyze, last_autoanalyze
      from pg_stat_all_tables where relname='room_nodes'`)).rows[0]
    const seed = await fixture.apps[0].control('seedLarge', { runId, nodes: 10000 })
    evidence.roomKey = seed.roomKey
    evidence.seeded = seed.count
    evidence.statsAfterSeed = (await pool.query(`select n_live_tup, n_mod_since_analyze from pg_stat_all_tables where relname='room_nodes'`)).rows[0]
    evidence.rowCount = (await pool.query('select count(*)::int as c from room_nodes where room_key=$1 and deleted_at is null', [seed.roomKey])).rows[0].c

    const edges = (await pool.query(OLD_SQL, [seed.roomKey])).rows
    const expected = bottomUpCounts(edges)
    evidence.expected = { rootUid: expected.rootUid, rootChildCount: expected.childCount(expected.rootUid),
      rootDescendantCount: expected.descendantCount(expected.rootUid), edges: edges.length }

    const fetchStarted = Date.now()
    const response = await withDeadline(
      fetch(`${fixture.fronts[0].base}/api/files/${encodeURIComponent(seed.roomKey)}/preview?depth=2`,
        { headers: { cookie: 'perf_fixture_actor=owner' } }),
      PREVIEW_FETCH_DEADLINE_MS, 'preview fetch exceeded the explicit test deadline')
    const body = await withDeadline(response.json(), 10000, 'preview body parse exceeded its deadline')
    const previewMs = Date.now() - fetchStarted
    evidence.preview = { status: response.status, ms: previewMs, deadlineMs: PREVIEW_FETCH_DEADLINE_MS }
    const previewTree = body && body.tree
    const previewNodes = []
    const walkPreview = node => { if (!node || !node.data) return
      previewNodes.push({ uid: node.data.uid, childCount: node.data.childCount, descendantCount: node.data.descendantCount })
      ;(node.children || []).forEach(walkPreview) }
    walkPreview(previewTree)
    evidence.previewNodes = previewNodes
    evidence.previewMismatches = previewNodes.filter(node =>
      node.childCount !== expected.childCount(node.uid) || node.descendantCount !== expected.descendantCount(node.uid))

    // DIAGNOSTIC ONLY — isolated so a diagnostic failure can never create a false RED.
    try {
      const explain = await pool.query('explain (analyze, buffers, settings) ' + NEW_SQL, [seed.roomKey, [expected.rootUid]])
      const plan = explain.rows.map(row => row['QUERY PLAN']).join('\n')
      evidence.countSqlDiagnostic = { index: (plan.match(/Index Scan using (\S+)/) || [])[1] || null,
        sharedHit: Number((plan.match(/Buffers: shared hit=(\d+)/) || [])[1] || 0),
        rowsRemovedByFilter: Number((plan.match(/Rows Removed by Filter: (\d+)/) || [])[1] || 0), plan }
      const oldExplain = await pool.query('explain (analyze, buffers) ' + OLD_SQL, [seed.roomKey])
      const oldPlan = oldExplain.rows.map(row => row['QUERY PLAN']).join('\n')
      evidence.oldSqlDiagnostic = { sharedHit: Number((oldPlan.match(/Buffers: shared hit=(\d+)/) || [])[1] || 0), plan: oldPlan }
      const newRows = (await pool.query(NEW_SQL, [seed.roomKey, [expected.rootUid]])).rows
      const key = row => row.uid + '\u0000' + row.parent_uid
      const oldSet = new Set(edges.map(key)); const newSet = new Set(newRows.map(key))
      evidence.exactnessDiagnostic = { oldRows: edges.length, newRows: newRows.length, sameSet: edges.length === newRows.length && [...oldSet].every(k => newSet.has(k)) }
    } catch (error) { evidence.diagnosticError = String(error.message) }

    // FORMAL product assertions.
    check('preview HTTP 200', () => assert.equal(response.status, 200))
    check('preview root is the DB root (parent_uid null)', () => assert.equal(previewTree && previewTree.data && previewTree.data.uid, expected.rootUid))
    check('exact root childCount', () => assert.equal(previewTree && previewTree.data && previewTree.data.childCount, expected.childCount(expected.rootUid)))
    check('exact root descendantCount', () => assert.equal(previewTree && previewTree.data && previewTree.data.descendantCount, expected.descendantCount(expected.rootUid)))
    check('preview returned nodes', () => assert.ok(previewNodes.length > 1))
    check('every returned node has exact counts', () => assert.equal(evidence.previewMismatches.length, 0, JSON.stringify(evidence.previewMismatches.slice(0, 5))))
    check(`real preview completes < ${PREVIEW_MAX_MS} ms (cold stats)`, () => assert.ok(previewMs < PREVIEW_MAX_MS,
      `real preview HTTP+parse took ${previewMs} ms with cold statistics (diagnostic: recursive count SQL ${evidence.countSqlDiagnostic ? evidence.countSqlDiagnostic.sharedHit : 'n/a'} shared hits / ${evidence.countSqlDiagnostic ? evidence.countSqlDiagnostic.rowsRemovedByFilter : 'n/a'} rows removed per loop, index ${evidence.countSqlDiagnostic ? evidence.countSqlDiagnostic.index : 'n/a'})`))

    evidence.status = 'GREEN'
    fs.writeFileSync(receiptPath(), JSON.stringify(evidence, null, 2))
    console.log('RED_COLD_ROOT_COUNT_GREEN ' + JSON.stringify(evidence.assertions))
  } catch (error) {
    evidence.status = 'RED'
    evidence.error = String(error.message)
    fs.writeFileSync(receiptPath(), JSON.stringify(evidence, null, 2))
    console.error('RED_COLD_ROOT_COUNT_FAILED:', error.message)
    console.error('receipt:', receiptPath())
    throw error
  } finally {
    try {
      const storage = require(path.join(repo, 'simple-mind-map/bin/storage'))
      const pool = storage.getPool()
      const priorDisabled = (evidence.autovacuumPrior || []).some(option => /^autovacuum_enabled=false/.test(String(option)))
      if (priorDisabled) await pool.query('alter table room_nodes set (autovacuum_enabled = false)')
      else await pool.query('alter table room_nodes reset (autovacuum_enabled)')
      evidence.autovacuumRestored = true
      evidence.autovacuumRestoredTo = priorDisabled ? 'disabled' : 'default'
    } catch (error) { evidence.autovacuumRestoreError = String(error.message) }
    try { if (fixture) await fixture.close() } catch (err) { console.error('cleanup', err.message) }
    try { fs.writeFileSync(receiptPath(), JSON.stringify(evidence, null, 2)) } catch (_) {}
  }
}
if (require.main === module) main().catch(() => { process.exitCode = 1 })
module.exports = { main }
