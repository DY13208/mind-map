const { test, expect } = require('./fixtures')
const {
  clickNode,
  pressOnCanvas,
  renameActive,
  waitForText,
  waitForNoText,
  uiState,
  clickSidebar,
  openCooperate,
  saveStatusText,
  pgHash,
  uiHash
} = require('./helpers')

test.describe('theme layout ui state undo network reload', () => {
  test('theme and layout sync without resetting viewer @smoke', async ({ pair }) => {
    const { pageA, pageB } = pair
    await clickNode(pageB, 'Alpha')
    await pageB.mouse.wheel(0, -400)
    await pressOnCanvas(pageB, 'Control+f')
    const before = await uiState(pageB)
    await clickSidebar(pageA, '主题')
    const theme = pageA.locator('.themeItem').nth(2)
    await theme.click()
    const confirm = pageA.locator('.el-message-box')
    if (await confirm.count()) {
      const reserve = confirm.getByRole('button', { name: /保留|覆盖/ })
      if (await reserve.count()) await reserve.last().click()
    }
    await pageB.waitForTimeout(800)
    await clickSidebar(pageA, '结构')
    const layout = pageA.locator('.layoutItem').nth(1)
    await layout.click()
    await pageB.waitForTimeout(800)
    const after = await uiState(pageB)
    expect(after.searchOpen).toBeTruthy()
    expect(after.selection.join(',')).toContain('Alpha')
    expect(Math.abs((after.scale || 1) - (before.scale || 1))).toBeLessThan(0.2)
  })

  test('remote apply keeps zoom pan selection search @smoke', async ({ pair }) => {
    const { pageA, pageB } = pair
    await clickNode(pageA, 'Alpha')
    await pageA.mouse.wheel(0, -300)
    await pressOnCanvas(pageA, 'Control+f')
    const before = await uiState(pageA)
    await clickNode(pageB, 'Beta')
    await renameActive(pageB, 'Beta-Remote')
    await waitForText(pageA, 'Beta-Remote')
    const after = await uiState(pageA)
    expect(after.searchOpen).toBeTruthy()
    expect(after.selection.join(',')).toContain('Alpha')
    expect(Math.abs((after.scale || 1) - (before.scale || 1))).toBeLessThan(0.2)
    await clickNode(pageB, 'Alpha')
    await pageB.keyboard.press('Delete')
    await waitForNoText(pageA, 'Alpha')
  })

  test('own undo and undo conflict toast', async ({ pair }) => {
    const { pageA, pageB } = pair
    await clickNode(pageA, 'Alpha')
    await renameActive(pageA, 'Alpha-A1')
    await clickNode(pageB, 'Beta')
    await renameActive(pageB, 'Beta-B1')
    await waitForText(pageA, 'Beta-B1')
    await pressOnCanvas(pageA, 'Control+z')
    await waitForText(pageB, 'Alpha')
    await waitForText(pageB, 'Beta-B1')

    await clickNode(pageA, 'Gamma')
    await renameActive(pageA, 'Gamma-A')
    await clickNode(pageB, 'Gamma-A')
    await renameActive(pageB, 'Gamma-B')
    await waitForText(pageA, 'Gamma-B')
    await pressOnCanvas(pageA, 'Control+z')
    await expect(pageA.getByText(/无法撤销|已被其他协作者修改/)).toBeVisible({
      timeout: 10000
    })
  })

  test('network jitter updates save status', async ({ pair }) => {
    const { pageA, contextA } = pair
    await openCooperate(pageA)
    await expect.poll(async () => saveStatusText(pageA)).toMatch(/已保存|保存中/)
    await contextA.setOffline(true)
    await expect.poll(async () => saveStatusText(pageA), { timeout: 15000 }).toMatch(
      /离线|重新连接|保存失败/
    )
    await contextA.setOffline(false)
    await expect.poll(async () => saveStatusText(pageA), { timeout: 20000 }).toMatch(
      /已保存|保存中|重新连接/
    )
  })

  test('reload keeps A B PostgreSQL hash @smoke', async ({ pair }) => {
    const { pageA, pageB, runtime, room } = pair
    await clickNode(pageA, 'Alpha')
    await renameActive(pageA, 'Alpha-Final')
    await waitForText(pageB, 'Alpha-Final')
    const before = {
      pg: await pgHash(runtime.api, room),
      a: await uiHash(pageA),
      b: await uiHash(pageB)
    }
    await Promise.all([pageA.reload(), pageB.reload()])
    await pageA.waitForSelector('.toolbarBtn.cooperating', { timeout: 30000 })
    await pageB.waitForSelector('.toolbarBtn.cooperating', { timeout: 30000 })
    const after = {
      pg: await pgHash(runtime.api, room),
      a: await uiHash(pageA),
      b: await uiHash(pageB)
    }
    expect(after.pg.hash).toBe(before.pg.hash)
    expect(after.a.count).toBe(after.pg.count)
    expect(after.b.count).toBe(after.pg.count)
  })
})
