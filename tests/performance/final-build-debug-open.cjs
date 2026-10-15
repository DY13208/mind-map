const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { startFinalFixture, repo, chromium } = require('./final-build-app.cjs')
const { closeOwnedFixture } = require('./online-cleanup.cjs')
const OUT = path.join(repo, 'work/performance-tdd/pi/final-build-e2e/debug')

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const runId = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  const fixture = await startFinalFixture({ instances: 1, profile: 'default' })
  const seed = await fixture.apps[0].control('seedSmall', { runId })
  const browser = await chromium.launch({ headless: true, channel: 'chrome' })
  const origin = fixture.fronts[0].base
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })
  await context.addCookies([{ name: 'perf_fixture_actor', value: 'owner', url: origin }])
  const page = await context.newPage()
  const log = { requests: [], responses: [], console: [], errors: [], failed: [] }
  page.on('request', r => { if (log.requests.length < 200) log.requests.push(r.method() + ' ' + r.url()) })
  page.on('response', async r => {
    if (log.responses.length < 200) {
      let body = null
      if (r.url().includes('/api/') || r.url().endsWith('runtime-config.js')) { try { body = (await r.text()).slice(0, 300) } catch (e) { body = 'ERR ' + e.message } }
      log.responses.push({ status: r.status(), url: r.url(), ct: r.headers()['content-type'], body })
    }
  })
  page.on('console', m => log.console.push(m.type() + ': ' + m.text()))
  page.on('pageerror', e => log.errors.push(e.message))
  page.on('requestfailed', r => log.failed.push(r.url() + ' ' + r.failure().errorText))
  try {
    await page.goto(origin + '/?room=' + encodeURIComponent(seed.roomKey), { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(15000)
    log.html = (await page.content()).slice(0, 2000)
    log.appHtml = await page.evaluate(() => { const a = document.querySelector('#app'); return a ? a.innerHTML.slice(0, 1500) : 'NO #app' })
    log.hasContainer = await page.evaluate(() => !!document.querySelector('#mindMapContainer'))
  } catch (e) { log.fatal = e.message }
  fs.writeFileSync(path.join(OUT, 'open-debug-' + runId + '.json'), JSON.stringify(log, null, 2))
  console.log(JSON.stringify({ seed: seed.roomKey, responses: log.responses.filter(r => r.url.includes('/api/')), errors: log.errors, failed: log.failed, hasContainer: log.hasContainer, console: log.console.slice(0, 20) }, null, 2))
  await closeOwnedFixture(browser, [], fixture)
}
main().catch(e => { console.error(e); process.exitCode = 1 })
