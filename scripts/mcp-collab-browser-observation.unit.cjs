const assert = require('assert')
const path = require('path')
const { spawnSync } = require('child_process')

const runner = path.join(__dirname, 'mcp-collab-performance.cjs')
const result = spawnSync(process.execPath, [runner, '--browser-observation-self-test'], {
  encoding: 'utf8',
  timeout: 10000,
  windowsHide: true
})

assert.ifError(result.error)
assert.strictEqual(result.status, 0, result.stderr || result.stdout || `test process exited ${result.status}`)
const report = JSON.parse(result.stdout)
assert.strictEqual(report.status, 'pass', JSON.stringify(report, null, 2))
assert(report.checks.length >= 5, 'expected transient renderer, editor timing, first-key, and long-task checks')
console.log(JSON.stringify(report, null, 2))
