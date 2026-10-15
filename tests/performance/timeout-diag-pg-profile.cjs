// Narrow read-only profile of the 10k-room cold `readSelectedNodeCounts` SQL
// that dominates the first `preview` HTTP responses (7.3 s / 7.0 s / 7.0 s in
// E1 trials 0-2, then 66 ms). Seeds one owned 10k room, records PG planner /
// stats facts and EXPLAIN (ANALYZE, BUFFERS) of the exact product query, then
// removes only that room. No product code, no default config change.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { startFinalFixture, repo } = require('./final-build-app.cjs')

const OUT = path.join(repo, 'work/performance-tdd/pi/timeout-investigation/diag-pg-profile')
const COUNT_SQL = `with recursive relevant as (
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

async function main () {
  fs.mkdirSync(OUT, { recursive: true })
  const runId = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  const evidence = { runId, startedAt: new Date().toISOString(), queries: [] }
  let fixture
  try {
    fixture = await startFinalFixture({ instances: 1, profile: 'default', artifact: process.env.PERF_TDD_E2E_ARTIFACT || 'after-web-final23' })
    const seed = await fixture.apps[0].control('seedLarge', { runId, nodes: 10000 })
    evidence.roomKey = seed.roomKey
    const storage = require(path.join(repo, 'simple-mind-map/bin/storage'))
    const pool = storage.getPool()
    const stats = async () => (await pool.query(`select relname, n_live_tup, n_dead_tup, n_mod_since_analyze,
        last_analyze, last_autoanalyze, last_vacuum, last_autovacuum, seq_scan, idx_scan
      from pg_stat_all_tables where relname in ('room_nodes','rooms') order by relname`)).rows
    evidence.statsAfterSeed = await stats()
    evidence.settings = (await pool.query(`select name, setting, source from pg_settings where name in ('jit','jit_above_cost','effective_cache_size','work_mem','random_page_cost') order by name`)).rows
    evidence.rowCount = (await pool.query('select count(*)::int as c from room_nodes where room_key=$1 and deleted_at is null', [seed.roomKey])).rows[0].c
    evidence.indexes = (await pool.query(`select indexname, indexdef from pg_indexes where tablename='room_nodes'`)).rows

    const explain = async label => {
      const started = process.hrtime.bigint()
      const result = await pool.query('explain (analyze, buffers, timing) ' + COUNT_SQL, [seed.roomKey, ['root']])
      const ms = Number(process.hrtime.bigint() - started) / 1e6
      const plan = result.rows.map(row => row['QUERY PLAN']).join('\n')
      evidence.queries.push({ label, ms: Math.round(ms), rows: result.rows.length, plan })
      return plan
    }
    await explain('first-run-same-pool')
    await explain('second-run-same-pool')
    evidence.indexUsedByExplain = evidence.queries.map(q => ({ label: q.label, index: (q.plan.match(/Index Scan using (\S+)/) || [])[1] || null,
      filteredRowsRemoved: (q.plan.match(/Rows Removed by Filter: (\d+)/) || [])[1] || null }))
    // Does fresh statistics flip the plan to the (room_key, parent_uid) index?
    await pool.query('analyze room_nodes')
    evidence.statsAfterAnalyze = await stats()
    await explain('after-analyze-room-nodes')
    evidence.indexUsedAfterAnalyze = (evidence.queries.at(-1).plan.match(/Index Scan using (\S+)/) || [])[1] || null
    // fresh connection: cold plan cache but warm shared buffers
    const guarded = require('./isolation.cjs')
    await guarded.withIsolatedPg(async fresh => {
      const started = process.hrtime.bigint()
      const result = await fresh.query('explain (analyze, buffers, timing) ' + COUNT_SQL, [seed.roomKey, ['root']])
      const ms = Number(process.hrtime.bigint() - started) / 1e6
      evidence.queries.push({ label: 'fresh-connection', ms: Math.round(ms), rows: result.rows.length,
        plan: result.rows.map(row => row['QUERY PLAN']).join('\n') })
    })
    evidence.statsAfterExplain = await stats()
    evidence.status = 'COMPLETE'
  } catch (error) {
    evidence.status = 'FAILED'
    evidence.error = String(error.message)
  } finally {
    fs.writeFileSync(path.join(OUT, `pg-profile-${runId}.json`), JSON.stringify(evidence, null, 2))
    try { if (fixture) await fixture.close() } catch (err) { console.error('cleanup', err.message) }
  }
  const head = evidence.queries.map(q => ({ label: q.label, ms: q.ms, rows: q.rows, index: (q.plan.match(/Index Scan using (\S+)/) || [])[1] || null }))
  console.log(JSON.stringify({ status: evidence.status, rowCount: evidence.rowCount, queries: head,
    statsAfterSeed: evidence.statsAfterSeed && evidence.statsAfterSeed.map(s => ({ rel: s.relname, live: s.n_live_tup, mod: s.n_mod_since_analyze, autoanalyze: s.last_autoanalyze })),
    error: evidence.error }, null, 1).slice(0, 4000))
}
main().catch(error => { console.error(error); process.exitCode = 1 })
