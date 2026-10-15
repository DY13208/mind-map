"use strict"
// Sole repeatable acceptance entry. Compose must already be running under its
// existing owned project; each child creates and drops a fresh exact-owned DB.
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { root, node, assertFrozen } = require('./safeload-isolated-run.cjs')
async function main() {
  const id = crypto.randomBytes(8).toString('hex')
  const output = path.join(root, 'work/performance-tdd/safeload-acceptance/acceptance-' + id + '.json')
  const receipt = { id, startedAt: new Date().toISOString(), frozen: assertFrozen(), runs: [] }
  fs.mkdirSync(path.dirname(output), { recursive: true })
  const save = () => fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n')
  save()
  for (const file of ['safeload-isolated-run.cjs', 'safeload-strengthened-run.cjs']) {
    const entry = path.join(__dirname, file)
    const child = spawn(node, [entry], { cwd: root, env: process.env, stdio: ['ignore','pipe','pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', bytes => { stdout += String(bytes); process.stdout.write(bytes) })
    child.stderr.on('data', bytes => { stderr += String(bytes); process.stderr.write(bytes) })
    const result = await new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
    const summary = stdout.trim().split('\n').reverse().map(line => { try { return JSON.parse(line) } catch (_) { return null } }).find(item => item && item.runDir)
    const row = { file, sha256: crypto.createHash('sha256').update(fs.readFileSync(entry)).digest('hex'), ...result,
      runDir: summary && summary.runDir, status: summary && summary.status }
    receipt.runs.push(row); save()
    assert.equal(result.code, 0, file + ' failed')
    assert.ok(summary && summary.runDir, 'child acceptance receipt missing')
    const fixture = JSON.parse(fs.readFileSync(path.join(summary.runDir, 'fixture-receipt.json'), 'utf8'))
    assert.equal(fixture.hostUnchanged, true); assert.equal(fixture.cleanup.databaseDropped, true)
    assert.deepEqual(fixture.cleanupErrors, [])
  }
  receipt.finishedAt = new Date().toISOString(); receipt.finalFrozen = assertFrozen()
  receipt.status = 'FULL_AND_STRENGTHENED_PASS_NO_SKIP'; save()
  console.log(JSON.stringify({ status: receipt.status, receipt: output }))
}
main().catch(error => { console.error(JSON.stringify({ status: 'FAILED', error: error.message })); process.exitCode = 1 })
