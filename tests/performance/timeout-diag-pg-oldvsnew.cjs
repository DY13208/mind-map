// Cold old-vs-new comparison for the exact-count query in stampAuthoritativeChildCounts.
//
//   NEW (current worktree): recursive `relevant` CTE + LATERAL ... OFFSET 0
//   OLD (HEAD 858-893):     one `select uid, parent_uid ... where room_key=$1 and deleted_at is null`
//
// Preserves the COLD state first (no ANALYZE before the first EXPLAIN), records
// pg_stat_all_tables last_autoanalyze / n_mod_since_analyze, then repeats inside
// the same repeatable-read read-only transaction with `SET LOCAL jit = off`,
// then (only at the end) runs ANALYZE to show the plan flip. Read-only except
// the final ANALYZE on this owned isolated table. No product code touched.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { startFinalFixture, repo } = require('./final-build-app.cjs')

const OUT = path.join(repo, 'work/performance-tdd/pi/timeout-investigation/diag-pg-profile')
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
const OLD_SQL = `select uid, parent_uid
   from room_nodes
   where room_key = $1
     and deleted_at is null`

function countGraphDescendants (children) {
  const memo = new Map()
  const visiting = new Set()
  const count = uid => {
    if (memo.has(uid)) return memo.get(uid)
    if (visiting.has(uid)) return 0
    visiting.add(uid)
    let total = 0
    for (const child of children.get(uid) || []) total += 1 + count(child)
    visiting.delete(uid)
    memo.set(uid, total)
    return total
  }
  for (const uid of children.keys()) count(uid)
  return memo
}

async function main () {
  fs.mkdirSync(OUT, { recursive: true })
  const runId = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  const evidence = { runId, startedAt: new Date().toISOString(), compares: [] }
  let fixture
  try {
    fixture = await startFinalFixture({ instances: 1, profile: 'default', artifact: process.env.PERF_TDD_E2E_ARTIFACT || 'after-web-final23' })
    const seed = await fixture.apps[0].control('seedLarge', { runId, nodes: 10000 })
    evidence.roomKey = seed.roomKey
    const storage = require(path.join(repo, 'simple-mind-map/bin/storage'))
    const pool = storage.getPool()
    const tableStats = async () => (await pool.query(`select relname, n_live_tup, n_mod_since_analyze, last_analyze, last_autoanalyze,
        autoanalyze_count, seq_scan, idx_scan from pg_stat_all_tables where relname in ('room_nodes','rooms') order by relname`)).rows
    evidence.statsBefore = await tableStats()
    evidence.rowCount = (await pool.query('select count(*)::int as c from room_nodes where room_key=$1 and deleted_at is null', [seed.roomKey])).rows[0].c

    const poolWaitStart = process.hrtime.bigint()
    const client = await pool.connect()
    evidence.poolWaitMs = Number(process.hrtime.bigint() - poolWaitStart) / 1e6
    evidence.planCompare = []
    try {
      await client.query('begin isolation level repeatable read read only')
      await client.query("set local statement_timeout = '20000ms'")
      const run = async (label, sql, params) => {
        const started = process.hrtime.bigint()
        const result = await client.query('explain (analyze, buffers, settings) ' + sql, params)
        const ms = Number(process.hrtime.bigint() - started) / 1e6
        const plan = result.rows.map(row => row['QUERY PLAN']).join('\n')
        const record = { label, ms: Math.round(ms), index: (plan.match(/Index Scan using (\S+)/) || [])[1] || null,
          indexCond: (plan.match(/Index Cond: \((.*)\)/) || [])[1] || null,
          rowsRemovedByFilter: (plan.match(/Rows Removed by Filter: (\d+)/) || [])[1] || null,
          sharedHit: (plan.match(/Buffers: shared hit=(\d+)/) || [])[1] || null, plan }
        evidence.planCompare.push(record)
        return record
      }
      await run('cold:new-recursive', NEW_SQL, [seed.roomKey, ['root']])
      await run('cold:old-single-select', OLD_SQL, [seed.roomKey])
      await client.query('set local jit = off')
      await run('cold-jitoff:new-recursive', NEW_SQL, [seed.roomKey, ['root']])
      await run('cold-jitoff:old-single-select', OLD_SQL, [seed.roomKey])
      await client.query('commit')
    } catch (error) { await client.query('rollback').catch(() => {}); throw error } finally { client.release() }

    // Real row fetch + JS bottom-up for the OLD plan (shows PG vs JS split).
    const fetchStart = process.hrtime.bigint()
    const rows = (await pool.query(OLD_SQL, [seed.roomKey])).rows
    const fetchMs = Number(process.hrtime.bigint() - fetchStart) / 1e6
    const children = new Map(rows.map(row => [row.uid, []]))
    for (const row of rows) if (children.has(row.parent_uid)) children.get(row.parent_uid).push(row.uid)
    const jsStart = process.hrtime.bigint()
    const descendants = countGraphDescendants(children)
    evidence.oldPath = { fetchMs: Math.round(fetchMs), jsMs: Math.round(Number(process.hrtime.bigint() - jsStart) / 1e6),
      rows: rows.length, rootChildCount: (children.get('root') || []).length, rootDescendantCount: descendants.get('root') || 0 }

    // Exactness: NEW recursive rows must equal OLD single-select rows for root scope.
    const newRows = (await pool.query(NEW_SQL, [seed.roomKey, ['root']])).rows
    const key = row => row.uid + '\u0000' + row.parent_uid
    const oldSet = new Set(rows.map(key)); const newSet = new Set(newRows.map(key))
    evidence.exactness = { oldRows: rows.length, newRows: newRows.length,
      sameSet: rows.length === newRows.length && [...oldSet].every(k => newSet.has(k)) }

    await pool.query('analyze room_nodes')
    evidence.statsAfterAnalyze = await tableStats()
    const after = await (async () => { const c = await pool.connect(); try {
      await c.query('begin isolation level repeatable read read only')
      await c.query("set local statement_timeout = '20000ms'")
      const started = process.hrtime.bigint()
      const result = await c.query('explain (analyze, buffers, settings) ' + NEW_SQL, [seed.roomKey, ['root']])
      const ms = Number(process.hrtime.bigint() - started) / 1e6
      const plan = result.rows.map(row => row['QUERY PLAN']).join('\n')
      await c.query('commit')
      return { ms: Math.round(ms), index: (plan.match(/Index Scan using (\S+)/) || [])[1] || null, plan }
    } finally { c.release() } })()
    evidence.afterAnalyze = after
    evidence.status = 'COMPLETE'
  } catch (error) {
    evidence.status = 'FAILED'
    evidence.error = String(error.message)
  } finally {
    fs.writeFileSync(path.join(OUT, `oldvsnew-${runId}.json`), JSON.stringify(evidence, null, 2))
    try { if (fixture) await fixture.close() } catch (err) { console.error('cleanup', err.message) }
  }
  console.log(JSON.stringify({ status: evidence.status, rowCount: evidence.rowCount, poolWaitMs: evidence.poolWaitMs,
    statsBefore: evidence.statsBefore, planCompare: (evidence.planCompare || []).map(p => ({ label: p.label, ms: p.ms, index: p.index, rowsRemoved: p.rowsRemovedByFilter, sharedHit: p.sharedHit })),
    oldPath: evidence.oldPath, exactness: evidence.exactness,
    afterAnalyze: evidence.afterAnalyze && { ms: evidence.afterAnalyze.ms, index: evidence.afterAnalyze.index }, error: evidence.error }, null, 1).slice(0, 5000))
}
main().catch(error => { console.error(error); process.exitCode = 1 })
