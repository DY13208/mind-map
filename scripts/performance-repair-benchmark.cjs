// Focused comparison against the pre-repair Git revision, isolated PostgreSQL only.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { execFileSync } = require('node:child_process')
const { performance, monitorEventLoopDelay } = require('node:perf_hooks')
const { randomUUID } = require('node:crypto')
const root = path.resolve(__dirname, '..')
const { Pool, Client } = require(path.join(root, 'simple-mind-map/node_modules/pg'))
const baselineRef = process.argv[2] || '8c9c3d16'
process.env.COLLAB_NODES_AUTHORITY = '1'
process.env.COLLAB_V2 = '1'
const filename = path.join(root, 'simple-mind-map/bin/roomNodes.js')
const baseline = new Module(filename, module)
baseline.filename = filename
baseline.paths = Module._nodeModulePaths(path.dirname(filename))
baseline._compile(execFileSync('git', ['show', `${baselineRef}:simple-mind-map/bin/roomNodes.js`], { cwd: root, encoding: 'utf8' }), filename)
const repaired = require(filename)
const pool = new Pool({ host: '127.0.0.1', port: 25492, database: 'mcp_incremental_test', user: 'mcp_test', password: 'mcp-incremental-test-db-password', max: 5 })
const roomKey = `perf-repair-${randomUUID()}`
let stats = null
const originalQuery = Client.prototype.query
Client.prototype.query = function (...args) {
  const sql = String(typeof args[0] === 'string' ? args[0] : args[0]?.text || '')
  if (stats) {
    stats.queries++
    if (/select\s+uid,\s*parent_uid\s+from\s+room_nodes/i.test(sql)) stats.edgeScans++
  }
  return originalQuery.apply(this, args)
}
const quantile = (values, p) => values.slice().sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] || 0
async function measure(label, reader, size) {
  // Warm DB/client connections equally, but keep the first cache fill in the samples.
  await pool.query('select 1')
  stats = { queries: 0, edgeScans: 0 }
  const histogram = monitorEventLoopDelay({ resolution: 10 })
  histogram.enable()
  const elapsed = []
  for (let i = 0; i < 120; i++) {
    const started = performance.now()
    const result = await reader(pool, roomKey, i % 2 ? 'n1' : 'root', { limit: 50 })
    assert.equal(result.descendantCount, i % 2 ? Math.floor((size - 2) / 8) : size - 1)
    assert.equal(result.version, size)
    elapsed.push(performance.now() - started)
  }
  histogram.disable()
  const result = { label, size, samples: elapsed.length, ...stats, p50Ms: quantile(elapsed, .5), p95Ms: quantile(elapsed, .95), eventLoopP95Ms: histogram.percentile(95) / 1e6, rssBytes: process.memoryUsage().rss }
  stats = null
  return result
}
async function seed(size) {
  await pool.query('delete from room_nodes where room_key=$1', [roomKey])
  await pool.query('update rooms set version=$2 where room_key=$1', [roomKey, size])
  await pool.query(`insert into room_nodes(room_key, uid, parent_uid, position, data, is_root, node_version)
    select $1, case when i=0 then 'root' else 'n'||i end,
      case when i=0 then null when i<=8 then 'root' else 'n'||(1+((i-9)%8)) end,
      lpad(i::text, 8, '0'), jsonb_build_object('uid',case when i=0 then 'root' else 'n'||i end,'text','节点 '||i), i=0, $2
    from generate_series(0,$2::int-1) i`, [roomKey, size])
}
async function main() {
  const identity = await pool.query('select current_database() as db, current_user as usr')
  assert.equal(identity.rows[0].db, 'mcp_incremental_test')
  assert.equal(identity.rows[0].usr, 'mcp_test')
  await pool.query('insert into rooms(room_key,title,cos_key,version) values($1,$2,$3,1)', [roomKey, '性能修复隔离夹具', `test/${roomKey}.json`])
  const measurements = []
  try {
    for (const size of [100, 6000]) {
      await seed(size)
      measurements.push(await measure('baseline', baseline.exports.readRoomSubtree, size))
      measurements.push(await measure('repaired', repaired.readRoomSubtree, size))
    }
    for (const row of measurements.filter(row => row.label === 'repaired')) assert.equal(row.edgeScans, 1, 'one count scan per room revision')
    const report = { at: new Date().toISOString(), baselineRef, source: 'direct readRoomSubtree against isolated PostgreSQL; not HTTP or browser latency', measurements,
      gates: measurements.filter(row => row.label === 'repaired').map(row => {
        const before = measurements.find(other => other.label === 'baseline' && other.size === row.size)
        return { size: row.size, p95Ratio: row.p95Ms / before.p95Ms, eventLoopP95Ratio: row.eventLoopP95Ms / before.eventLoopP95Ms, latencyPassed: row.p95Ms <= before.p95Ms * 1.1, eventLoopPassed: row.eventLoopP95Ms <= before.eventLoopP95Ms * 1.1 }
      }) }
    const output = path.join(root, 'output/performance-repair-20261013')
    fs.mkdirSync(output, { recursive: true })
    const contents = JSON.stringify(report, null, 2)
    fs.writeFileSync(path.join(output, `subtree-benchmark-${report.at.replace(/[:.]/g, '-')}.json`), contents)
    fs.writeFileSync(path.join(output, 'subtree-benchmark.json'), contents)
    console.log(JSON.stringify(report, null, 2))
    if (report.gates.some(gate => !gate.latencyPassed || !gate.eventLoopPassed)) process.exitCode = 1
  } finally {
    stats = null
    await pool.query('delete from room_nodes where room_key=$1', [roomKey])
    await pool.query('delete from rooms where room_key=$1', [roomKey])
    await pool.end()
    Client.prototype.query = originalQuery
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; pool.end().catch(() => {}) })
