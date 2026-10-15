const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { createHarness, repo } = require('./engine-harness.cjs')

async function runCases(domain, cases, options = {}) {
  const phase = process.env.PERF_TDD_PHASE || 'red'
  const destination = path.join(repo, 'work/performance-tdd', phase, 'renderer')
  fs.mkdirSync(destination, { recursive: true })
  const report = { domain, phase, base: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), cases: [] }
  let harness
  try {
    harness = await createHarness({ entry: path.join(__dirname, 'renderer-browser-entry.js') })
    report.browser = harness.browser.version()
    report.runtime = process.version
    report.sourceRoot = harness.sourceRoot
    report.bundleHash = harness.bundleHash
    const selected = cases.filter(test => (!process.env.PERF_TDD_CASE || test.id === process.env.PERF_TDD_CASE) &&
      (!process.env.PERF_TDD_NAME || test.name.includes(process.env.PERF_TDD_NAME)))
    if (!selected.length) throw new Error('No renderer cases matched the requested filter')
    for (const test of selected) {
      const page = await harness.newPage()
      const row = { id: test.id, name: test.name, assertions: [] }
      try {
        await page.waitForFunction(() => !!window.rendererFixture)
        row.observed = await test.observe(page)
        for (const check of test.checks) {
          try { check.assert(row.observed, assert); row.assertions.push({ name: check.name, status: 'PASS' }) }
          catch (error) {
            if (!(error instanceof assert.AssertionError)) throw error
            row.assertions.push({ name: check.name, status: 'FAIL', error: error.message })
          }
        }
        row.status = row.assertions.some(item => item.status === 'FAIL') ? 'FAIL' : 'PASS'
      } catch (error) { row.status = 'HARNESS_ERROR'; row.error = error.stack || String(error) }
      await page.close()
      report.cases.push(row)
      console.log(JSON.stringify(row))
    }
  } catch (error) { report.environmentError = error.stack || String(error); process.exitCode = 2 }
  finally {
    if (harness) await harness.close()
    fs.writeFileSync(path.join(destination, `${domain}.json`), JSON.stringify(report, null, 2))
    if (options.setExitCode !== false && report.cases.some(row => row.status === 'HARNESS_ERROR')) process.exitCode = 2
    else if (options.setExitCode !== false && report.cases.some(row => row.status === 'FAIL')) process.exitCode = 1
  }
  return report
}
module.exports = { runCases }
