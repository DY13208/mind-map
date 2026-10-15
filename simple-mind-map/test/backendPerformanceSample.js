// Isolated real HTTP measurement; never loads project .env or production data.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { performance } = require('node:perf_hooks')
const { createHarness, request } = require('./performanceBackendHarness')
process.env.NODE_ENV = 'production'
process.env.COLLAB_V2_TRACE = '0'
const phase = process.argv[2]
assert.ok(['before', 'after', 'after-stable'].includes(phase), 'usage: node test/backendPerformanceSample.js before|after|after-stable')
const repo = path.resolve(__dirname, '../..')
const output = path.join(repo, 'work/performance-tdd/' + phase + '/backend')
fs.mkdirSync(output, { recursive: true })
const target = path.join(output, 'http-samples.json')
assert.equal(fs.existsSync(target), false, 'preserve existing samples; explicitly select another run before repeating')

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const at = quantile => sorted[Math.ceil(sorted.length * quantile) - 1]
  return { count: values.length, p50Ms: at(0.5), p95Ms: at(0.95), p99Ms: at(0.99), minMs: sorted[0], maxMs: sorted.at(-1) }
}

async function main() {
  const app = await createHarness()
  // SQL/crypto spies must not inflate the baseline or the comparison sample.
  app.observer.restore()
  const report = {
    phase, sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    runtime: process.version, timestamp: new Date().toISOString(),
    boundary: 'loopback HTTP + real owned PostgreSQL; synthetic trusted transport identity with real room ACL; excludes browser, OAuth, history workers and network RTT',
    flags: { COLLAB_HTTP_DIRECT: '1', COLLAB_MCP_DIRECT: '1', COLLAB_NODE_COUNT_CACHE: '1', COLLAB_NODE_COUNT_CACHE_WRITERS_READY: '1' },
    sourceState: phase.startsWith('after') ? 'authorized uncommitted candidate working tree' : 'baseline production code at sourceCommit',
    samplesPerOperation: 200, fixtures: []
  }
  try {
    for (const N of [1000, 10000]) {
      const { roomKey } = await app.seed(N)
      const route = `/api/files/${roomKey}/nodes?uids=grand-0-0`
      const write = async i => request(app.base, `/api/files/${roomKey}/nodes/grand-0-0`, {
        method: 'PATCH', body: { operation_id: randomUUID(), client_id: 'performance-sample', text: 'sample-' + i }
      })
      for (let i = 0; i < 5; i++) {
        assert.equal((await request(app.base, route)).status, 200)
        assert.equal((await write(-i - 1)).status, 200)
      }
      const measured = { N, M: 1, C: 0, S: 0, readMs: [], writeMs: [] }
      for (const operation of ['read', 'write']) {
        for (let i = 0; i < 200; i++) {
          const start = performance.now()
          const result = operation === 'read' ? await request(app.base, route) : await write(i)
          assert.equal(result.status, 200, operation + ' sample failed: ' + JSON.stringify(result.body))
          measured[operation + 'Ms'].push(performance.now() - start)
          if ((i + 1) % 50 === 0) process.stderr.write(JSON.stringify({ phase, N, operation, completed: i + 1 }) + '\n')
        }
      }
      measured.read = stats(measured.readMs)
      measured.write = stats(measured.writeMs)
      report.fixtures.push(measured)
      fs.writeFileSync(target, JSON.stringify(report, null, 2))
    }
  } finally { await app.close() }
  process.stdout.write(JSON.stringify({ phase, fixtures: report.fixtures.map(row => ({ N: row.N, read: row.read, write: row.write })) }) + '\n')
}
main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1 })
