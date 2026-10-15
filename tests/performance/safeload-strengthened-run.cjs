"use strict"
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
const { fork } = require('node:child_process')
const { fixture, finishRun, bounded, root, node, preload } = require('./safeload-isolated-run.cjs')
const { gateBrowser } = require('./safeload-browser-gate.cjs')
async function finishStrengthened(child, f, logs) {
  await finishRun(child, f, logs, 'strengthened.log')
}
async function main() {
  let f, child
  const logs = []
  try {
    f = await fixture()
    const entry = path.join(__dirname, 'safeload-strengthened-child.cjs')
    child = fork(entry, [], { execPath: node, execArgv: ['--require', preload], cwd: root,
      env: f.env, detached: true, stdio: ['ignore','pipe','pipe','ipc'] })
    child.stdout.on('data', chunk => { logs.push(String(chunk)); const stages = String(chunk).match(/SAFE_STRENGTHENED_(?:STEP|PASS|FAIL)/g); if (stages) console.log(JSON.stringify({ progress: stages, at: new Date().toISOString() })) })
    child.stderr.on('data', chunk => { logs.push(String(chunk)) })
    const result = await bounded(new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal }))), 480000, 'strengthened SafeLoad total fixture budget exceeded')
    const reportPath = path.join(f.runDir, 'strengthened-report.json')
    f.receipt.strengthened = { ...result, entrySha256: crypto.createHash('sha256').update(fs.readFileSync(entry)).digest('hex'),
      reportWritten: fs.existsSync(reportPath) }; f.save()
    assert.equal(result.code, 0, 'strengthened script failed; see ' + f.runDir)
    assert.equal(f.receipt.strengthened.reportWritten, true, 'strengthened report missing')
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
    assert.equal(report.status, 'PASS', 'strengthened business assertions did not pass')
    f.receipt.browserGate = gateBrowser(JSON.parse(fs.readFileSync(path.join(f.runDir, 'browser-observations.json'), 'utf8')))
    f.receipt.status = 'STRENGTHENED_PASS'; f.save()
    console.log(JSON.stringify({ runDir: f.runDir, status: f.receipt.status, steps: report.steps && report.steps.length }))
  } catch (error) {
    if (f) { f.receipt.status = 'FAILED'; f.receipt.error = f.clean(error.stack || error); f.save() }
    console.error(JSON.stringify({ status: 'FAILED', runDir: f && f.runDir || error.runDir, error: f ? f.clean(error.message) : error.message }))
    process.exitCode = 1
  } finally {
    await finishStrengthened(child, f, logs)
  }
}
module.exports = { finishStrengthened }
if (require.main === module) main().catch(error => { console.error(JSON.stringify({ status: 'FAILED', error: error.message })); process.exitCode = 1 })
