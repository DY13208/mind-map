const { test, expect } = require('@playwright/test')
const { runCases } = require('../../../tests/performance/renderer-runner.cjs')
for (const [domain, cases] of [
  ['viewport', require('../../../tests/performance/renderer-viewport.browser.cjs')],
  ['layout', require('../../../tests/performance/layout-work-budget.browser.cjs')]
]) {
  for (const item of cases) test(`[${item.id}] ${item.name}`, async () => {
    const report = await runCases(domain + '-' + item.id, [item], { setExitCode: false })
    expect(report.environmentError).toBeUndefined()
    expect(report.cases[0].status, JSON.stringify(report.cases[0])).toBe('PASS')
  })
}
