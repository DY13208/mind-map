const { test, expect } = require('./fixtures')
const {
  clickNode,
  pressOnCanvas,
  waitForText,
  renameActive,
  createRoom,
  openRoom
} = require('./helpers')

async function openSearch(page, keyword) {
  await pressOnCanvas(page, 'Control+f')
  await expect(page.locator('.searchContainer.show')).toBeVisible()
  const input = page.locator('.searchContainer .el-input input').first()
  await input.fill(keyword)
  await input.press('Enter')
}

test.describe('search replace', () => {
  test('Ctrl+F live updates when B changes matches @smoke', async ({ pair }) => {
    const { pageA, pageB } = pair
    await openSearch(pageA, 'Alpha')
    await expect(pageA.locator('.searchInfo')).toContainText(/1/)

    await clickNode(pageB, 'Beta')
    await renameActive(pageB, 'Alpha-2')
    await expect(pageA.locator('.searchInfo')).toContainText(/2/, { timeout: 15000 })

    await clickNode(pageB, 'Alpha-2')
    await renameActive(pageB, 'Beta')
    await expect(pageA.locator('.searchInfo')).toContainText(/1/, { timeout: 15000 })

    await clickNode(pageB, 'Alpha')
    await pageB.keyboard.press('Delete')
    await expect(pageA.locator('.searchResultItem, .searchInfo')).not.toContainText('Alpha', {
      timeout: 15000
    })
  })

  test('replace one respects precondition', async ({ pair }) => {
    const { pageA, pageB } = pair
    await openSearch(pageA, 'Alpha')
    await pageA.locator('.searchContainer').getByText('替换', { exact: true }).first().click()
    await pageA.locator('.searchContainer input').nth(1).fill('Alpha-A')
    await clickNode(pageB, 'Alpha')
    await renameActive(pageB, 'Alpha-B')
    await waitForText(pageA, 'Alpha-B')
    await pageA.locator('.searchContainer').getByRole('button', { name: '替换' }).first().click()
    await pageA.waitForTimeout(800)
    await waitForText(pageA, 'Alpha-B')
    await expect(pageA.locator('.smm-node').filter({ hasText: 'Alpha-A' })).toHaveCount(0)
  })

  test('replace all one batch and undo', async ({ pair }) => {
    const { pageA, pageB, room } = pair
    await clickNode(pageA, 'Alpha')
    await renameActive(pageA, 'Hit')
    await clickNode(pageA, 'Beta')
    await renameActive(pageA, 'Hit')
    await clickNode(pageA, 'Delta')
    await renameActive(pageA, 'Hit')
    await waitForText(pageB, 'Hit')
    await openSearch(pageA, 'Hit')
    await pageA.locator('.searchContainer').getByText('替换', { exact: true }).first().click()
    await pageA.locator('.searchContainer input').nth(1).fill('Replaced')
    await pageA.locator('.searchContainer').getByRole('button', { name: '全部替换' }).click()
    await waitForText(pageB, 'Replaced')
    const ops = await pageA.evaluate(async roomKey => {
      const res = await fetch(
        '/api/collab-v2/ops?roomKey=' + encodeURIComponent(roomKey) + '&afterRevision=0'
      )
      return res.json()
    }, room)
    const batches = (ops.operations || []).filter(item => item.type === 'node.batch')
    expect(batches.length).toBeGreaterThan(0)
    const ids = new Set(batches.map(item => item.payload && item.payload.batchId).filter(Boolean))
    expect(ids.size).toBeGreaterThan(0)
    await pressOnCanvas(pageA, 'Control+z')
    await waitForText(pageB, 'Hit')
  })

  test('large map search uses postgres endpoint not full hydrate', async ({
    browser
  }) => {
    const { readRuntime } = require('./helpers')
    const runtime = readRuntime()
    const children = []
    for (let i = 0; i < 80; i++) {
      children.push({
        data: { uid: 'n' + i, text: i === 7 ? 'Needle-E2E' : 'Leaf-' + i },
        children: []
      })
    }
    const room = await require('./helpers').createRoom(runtime.api, {
      prefix: 'searchbig',
      tree: { data: { uid: 'root', text: 'SearchBig' }, children }
    })
    const context = await browser.newContext()
    const page = await context.newPage()
    const hits = []
    page.on('request', req => {
      if (/\/api\/files\/.+\/search/.test(req.url())) hits.push(req.url())
    })
    await openRoom(page, runtime.origin, room)
    await openSearch(page, 'Needle-E2E')
    await expect.poll(() => hits.length).toBeGreaterThan(0)
    await context.close()
  })
})
