const { test, expect } = require('@playwright/test')
const {
  readRuntime,
  createRoom,
  openRoom,
  attachConsole,
  assertCleanConsole,
    clickNode,
    pressOnCanvas,
    finishEdit,
    renameActive,
    idbPending,
    seedInserts,
    pgHash,
    uiHash,
    lastSyncStatus
} = require('./helpers')

test.describe('indexeddb offline and gap', () => {
  test('offline edits survive reload then flush @smoke', async ({ browser }) => {
    const runtime = readRuntime()
    const room = await createRoom(runtime.api)
    const context = await browser.newContext()
    const page = await context.newPage()
    const errors = await attachConsole(page)
    await openRoom(page, runtime.origin, room)
    const block = route => {
      const url = route.request().url()
      if (/\/collab-v2|\/api\/collab-v2\//.test(url)) return route.abort()
      return route.continue()
    }
    await page.route('**/*', block)
    await clickNode(page, 'Alpha')
    await pressOnCanvas(page, 'Enter')
    await finishEdit(page)
    await clickNode(page, 'Beta')
    await renameActive(page, 'Beta-Off')
    const pending = await idbPending(page)
    expect(pending.length).toBeGreaterThan(0)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.route('**/*', block)
    await page.waitForSelector('#mindMapContainer')
    const pendingAfterReload = await idbPending(page)
    expect(pendingAfterReload.length).toBeGreaterThan(0)
    await page.unroute('**/*')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.toolbarBtn.cooperating', { timeout: 30000 })
    await expect
      .poll(async () => (await idbPending(page)).length, { timeout: 30000 })
      .toBe(0)
    assertCleanConsole(errors)
    await context.close()
  })

  test('closing the page keeps pending outbox', async ({ browser }) => {
    const runtime = readRuntime()
    const room = await createRoom(runtime.api)
    const userDataDir = require('fs').mkdtempSync(
      require('path').join(require('os').tmpdir(), 'collab-e2e-')
    )
    const context = await browser.browserType().launchPersistentContext(userDataDir, {
      viewport: { width: 1440, height: 900 }
    })
    const page = context.pages()[0] || (await context.newPage())
    await openRoom(page, runtime.origin, room)
    const block = route => {
      const url = route.request().url()
      if (/\/collab-v2|\/api\/collab-v2\//.test(url)) return route.abort()
      return route.continue()
    }
    await page.route('**/*', block)
    await clickNode(page, 'Alpha')
    await pressOnCanvas(page, 'Enter')
    await finishEdit(page)
    expect((await idbPending(page)).length).toBeGreaterThan(0)
    await page.close()
    const page2 = await context.newPage()
    await page2.route('**/*', block)
    await page2.goto(runtime.origin + '/#/?room=' + encodeURIComponent(room), {
      waitUntil: 'domcontentloaded'
    })
    const pending = await idbPending(page2)
    expect(pending.length).toBeGreaterThan(0)
    await context.close()
  })

  test('gap larger than 500 uses paged recovery @smoke', async ({ browser }) => {
    const runtime = readRuntime()
    const room = await createRoom(runtime.api)
    const contextA = await browser.newContext()
    const contextB = await browser.newContext()
    const pageA = await contextA.newPage()
    const pageB = await contextB.newPage()
    await openRoom(pageA, runtime.origin, room)
    await openRoom(pageB, runtime.origin, room)
    const blockB = route => {
      const url = route.request().url()
      if (/\/collab-v2|\/api\/collab-v2\//.test(url)) return route.abort()
      return route.continue()
    }
    await pageB.route('**/*', blockB)
    const seeded = await seedInserts(pageA, room, 1200)
    expect(seeded.failed).toBe(0)
    await pageB.unroute('**/*')
    await pageB.reload({ waitUntil: 'domcontentloaded' })
    await pageB.waitForSelector(
      '[data-testid="cooperate"].cooperating, .toolbarBtn.cooperating',
      { timeout: 60000 }
    )
    let sync = null
    await expect
      .poll(
        async () => {
          sync = await lastSyncStatus(pageB)
          return sync && sync.pages
        },
        { timeout: 60000 }
      )
      .toBeGreaterThanOrEqual(3)
    const pageSizes = ((sync && sync.syncPages) || []).map(item => item.count)
    expect(pageSizes.filter(count => count === 500).length).toBeGreaterThanOrEqual(2)
    const a = await uiHash(pageA)
    const b = await uiHash(pageB)
    const pg = await pgHash(runtime.api, room)
    expect(b.count).toBeGreaterThan(500)
    expect(Math.abs(a.count - pg.count)).toBeLessThan(5)
    expect(Math.abs(b.count - pg.count)).toBeLessThan(5)
    await contextA.close()
    await contextB.close()
  })
})
