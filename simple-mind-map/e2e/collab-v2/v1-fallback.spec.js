const { test, expect } = require('@playwright/test')
const { startStack } = require('./server')
const { createRoom, attachConsole, clickNode, pressOnCanvas, finishEdit } = require('./helpers')

test.describe('v1 fallback smoke', () => {
  test('COLLAB_V2=0 still opens and edits @smoke', async ({ browser }) => {
    const stack = await startStack({ auth: false, collabV2: 0 })
    try {
      const room = await createRoom(stack.api)
      const context = await browser.newContext()
      const page = await context.newPage()
      await attachConsole(page)
      await page.goto(stack.origin + '/#/?room=' + encodeURIComponent(room), {
        waitUntil: 'domcontentloaded'
      })
      await page.waitForSelector('#mindMapContainer', { timeout: 30000 })
      await page.waitForSelector('.smm-node', { timeout: 30000 })
      await clickNode(page, 'Alpha')
      await pressOnCanvas(page, 'Enter')
      await finishEdit(page)
      await expect(page.locator('.smm-node')).toHaveCount(await page.locator('.smm-node').count())
      expect(await page.locator('.smm-node').count()).toBeGreaterThan(3)
      await context.close()
    } finally {
      await stack.close()
    }
  })
})
