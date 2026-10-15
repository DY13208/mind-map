// Candidate-only cold/warm root sampling: S grows with N, unlike leaf samples.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { createHarness, request } = require('./performanceBackendHarness')
process.env.NODE_ENV = 'production'
process.env.COLLAB_V2_TRACE = '0'
const output = path.resolve(__dirname, '../../work/performance-tdd/after-stable/backend/root-count-samples.json')
fs.mkdirSync(path.dirname(output), { recursive: true })
assert.equal(fs.existsSync(output), false, 'preserve existing candidate root samples')
const stats = values => {
  const sorted = [...values].sort((a, b) => a - b)
  const at = q => sorted[Math.ceil(sorted.length * q) - 1]
  return { count: values.length, p50Ms: at(0.5), p95Ms: at(0.95), p99Ms: at(0.99), minMs: sorted[0], maxMs: sorted.at(-1) }
}
async function main() {
  const app = await createHarness()
  app.observer.restore()
  const report = { runtime: process.version, phase: 'candidate-only', timestamp: new Date().toISOString(),
    boundary: 'loopback HTTP + owned real PostgreSQL; synthetic trusted identity and actual room ACL; cold cache disabled, warm cache enabled; no baseline root sample was taken', fixtures: [] }
  try {
    for (const N of [1000, 10000]) {
      const { roomKey } = await app.seed(N)
      const route = `/api/files/${roomKey}/nodes?uids=root`
      for (const mode of ['cold', 'warm']) {
        process.env.COLLAB_NODE_COUNT_CACHE = mode === 'cold' ? '0' : '1'
        for (let i = 0; i < 5; i++) assert.equal((await request(app.base, route)).body.nodes[0].data.descendantCount, N - 1)
        const measured = { N, M: 1, C: 2, S: N - 1, mode, ms: [] }
        for (let i = 0; i < 200; i++) {
          const start = performance.now()
          const result = await request(app.base, route)
          measured.ms.push(performance.now() - start)
          assert.equal(result.status, 200)
          assert.equal(result.body.nodes[0].data.descendantCount, N - 1)
          assert.equal(result.body.nodes[0].data.childCount, 2)
          if ((i + 1) % 50 === 0) process.stderr.write(JSON.stringify({ N, mode, completed: i + 1 }) + '\n')
        }
        measured.stats = stats(measured.ms)
        report.fixtures.push(measured)
        fs.writeFileSync(output, JSON.stringify(report, null, 2))
      }
    }
  } finally { await app.close() }
  process.stdout.write(JSON.stringify({ fixtures: report.fixtures.map(({ ms, ...row }) => row) }) + '\n')
}
main().catch(err => { console.error(err); process.exitCode = 1 })
