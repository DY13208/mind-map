'use strict'
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { createHarness } = require('./engine-harness.cjs')
const { createMemoryTransport } = require('./frontend-memory-transport.cjs')

async function runCases(domain, cases, options = {}) {
  const phase = process.env.PERF_TDD_PHASE || 'red'
  if (!['red', 'green'].includes(phase)) throw new Error('PERF_TDD_PHASE must be red or green')
  const output = path.resolve(__dirname, '../../work/performance-tdd/' + phase + '/frontend')
  fs.mkdirSync(output, { recursive: true })
  const label = process.env.PERF_TDD_LABEL || 'baseline'
  if (!/^[a-z0-9_-]+$/.test(label)) throw new Error('invalid report label')
  const file = path.join(output, domain + '-' + label + '.json')
  if (fs.existsSync(file)) throw new Error('refusing to overwrite frontend evidence: ' + file)
  const repo = path.resolve(__dirname, '../..')
  const productionDiff = execFileSync('git', ['diff', '--name-only', '--', 'simple-mind-map/index.js', 'simple-mind-map/src', 'web/src'], { cwd: repo, encoding: 'utf8' }).trim()
  const report = { domain, phase, baseline: 'd5793106098afe8a2ff9bbb60193bc25e5e45f88',
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    productionModified: !!productionDiff, productionDiff: productionDiff.split('\n').filter(Boolean), nodeVersion: process.version,
    startedAt: new Date().toISOString(), cases: [] }
  let harness
  try {
    harness = await createHarness({ entry: options.entry || path.join(__dirname, 'frontend-browser-entry.js'), handleRequest: createMemoryTransport(), sourceRoot: process.env.PERF_TDD_SOURCE_ROOT })
    report.browserVersion = harness.browser.version()
    report.bundleHash = harness.bundleHash
    report.sourceRoot = harness.sourceRoot
    const selected = process.env.PERF_TDD_CASE ? cases.filter(item => item.id === process.env.PERF_TDD_CASE) : cases
    if (!selected.length) throw new Error('PERF_TDD_CASE selected no cases')
    for (const item of selected) {
      const page = await harness.newPage()
      const errors = []
      const consoleErrors = []
      page.on('pageerror', error => errors.push(error.message))
      page.on('console', message => { if (message.type() === 'error' || message.type() === 'warn') consoleErrors.push(message.text().slice(0, 1800)) })
      let row = { id: item.id, name: item.name, assertions: [] }
      try {
        await page.waitForFunction(() => !!window.perfFrontend)
        const observed = await item.observe(page)
        row.observed = observed
        for (const check of item.checks) {
          try { check.assert(observed, assert); row.assertions.push({ name: check.name, status: 'PASS' }) }
          catch (error) {
            if (!(error instanceof assert.AssertionError)) throw error
            row.assertions.push({ name: check.name, status: 'RED_CONFIRMED', message: error.message })
          }
        }
        row.pageErrors = errors
        row.status = row.assertions.some(check => check.status === 'RED_CONFIRMED') ? (phase === 'red' ? 'RED_CONFIRMED' : 'REGRESSION_FAILED') : (phase === 'red' ? 'BASELINE_PROTECTION_PASS' : 'GREEN_CONFIRMED')
      } catch (error) {
        row.status = 'BLOCKED_ENV'
        row.error = error.stack || String(error)
        row.pageErrors = errors
      } finally { await page.close() }
      row.consoleErrors = consoleErrors
      report.cases.push(row)
      console.log(JSON.stringify(row))
    }
  } catch (error) {
    report.environmentError = error.stack || String(error)
    process.exitCode = 2
  } finally {
    if (harness) await harness.close()
    report.finishedAt = new Date().toISOString()
    fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
    console.log('FRONTEND_BASELINE_REPORT ' + file)
    if (!process.exitCode && report.cases.some(row => row.status === 'BLOCKED_ENV')) process.exitCode = 2
    else if (!process.exitCode && report.cases.some(row => ['RED_CONFIRMED', 'REGRESSION_FAILED'].includes(row.status))) process.exitCode = 1
  }
}
module.exports = { runCases }
