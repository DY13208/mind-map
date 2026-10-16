'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync, execFileSync } = require('node:child_process')

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-baseline-guard-'))
const manifest = path.join(directory, 'manifest.json')
try {
  fs.writeFileSync(manifest, JSON.stringify({ baseCommit: 'wrong-frozen-commit' }))
  // --run must reject a stale source identity before Docker/DB setup, not only
  // in the optional read-only preflight path.
  const result = spawnSync(process.execPath, [
    path.join(__dirname, 'mcp-collab-performance.cjs'), '--run', '--variant', 'A',
    '--baseline-ref', execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.join(__dirname, '..'), encoding: 'utf8' }).trim(), '--baseline-image', 'unused-image',
    '--baseline-source-manifest', manifest
  ], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
  assert.ifError(result.error)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Baseline image manifest commit does not match/)
  assert.doesNotMatch(result.stderr, /docker|ECONNREFUSED|password authentication/i)
  console.log('PASS: --run rejects a mismatched baseline manifest before service/database setup')
} finally {
  fs.unlinkSync(manifest)
  fs.rmdirSync(directory)
}
