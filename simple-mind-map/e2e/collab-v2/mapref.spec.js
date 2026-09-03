const { test, expect } = require('./fixtures')
const { createRoom, clickNode, waitForText, readRuntime } = require('./helpers')

test.describe('mapRef', () => {
  test('create icon jump bind permission and back @smoke', async ({ pair, browser }) => {
    const { pageA, pageB, runtime } = pair
    const target = await createRoom(runtime.api, {
      prefix: 'ref-target',
      title: 'Target Map'
    })
    await clickNode(pageA, 'Alpha')
    const node = pageA.locator('.smm-node').filter({ hasText: 'Alpha' }).first()
    await node.click({ button: 'right', force: true })
    await pageA.locator('.contextmenuContainer .item').filter({ hasText: '引用思维导图' }).click()
    await expect(pageA.locator('.mapRefDialog')).toBeVisible()
    await pageA.locator('.mapRefDialog .fileItem').filter({ hasText: 'Target Map' }).click()
    await pageA.locator('.mapRefDialog').getByRole('button', { name: '确定' }).click()
    await pageB.waitForTimeout(1000)
    const icon = pageB.locator('.smm-node').filter({ hasText: 'Alpha' }).locator('svg').last()
    await expect(pageB.locator('.smm-node').filter({ hasText: 'Alpha' })).toBeVisible()
    await pageB.locator('.smm-node').filter({ hasText: 'Alpha' }).locator('title').first().waitFor({ state: 'attached', timeout: 10000 }).catch(() => {})
    const titles = await pageB.locator('title').allTextContents()
    expect(titles.some(text => /引用/.test(text))).toBeTruthy()

    await pageB.locator('.smm-node').filter({ hasText: 'Alpha' }).locator('[cursor="pointer"], svg').last().click({ force: true })
    await pageB.waitForTimeout(800)
    await expect(pageB).toHaveURL(new RegExp(target))
    await waitForText(pageB, 'Alpha')
    await pageB.goBack()
    await pageB.waitForTimeout(800)
    await waitForText(pageB, 'Alpha')
    void icon
    void browser
  })
})
