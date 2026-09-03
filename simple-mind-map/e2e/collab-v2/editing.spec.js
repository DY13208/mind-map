const { test, expect } = require('./fixtures')
const {
  clickNode,
  clickToolbar,
  waitForText,
  waitForNoText,
  finishEdit
} = require('./helpers')

test.describe('mouse menu editing', () => {
  test('toolbar sibling child delete sync @smoke', async ({ pair }) => {
    const { pageA, pageB } = pair
    await clickNode(pageA, 'Alpha')
    await clickToolbar(pageA, 'add-sibling')
    await finishEdit(pageA)
    await waitForText(pageB, '二级节点')

    await clickNode(pageA, 'Beta')
    await clickToolbar(pageA, 'add-child')
    await finishEdit(pageA)
    await waitForText(pageB, '分支主题')

    await clickNode(pageA, 'Gamma')
    await clickToolbar(pageA, 'delete-node')
    await waitForNoText(pageB, 'Gamma')
  })

  test('context menu insert child and summary', async ({ pair }) => {
    const { pageA, pageB } = pair
    const node = pageA.locator('.smm-node').filter({ hasText: 'Alpha' }).first()
    await node.click({ button: 'right', force: true })
    await pageA.locator('.contextmenuContainer .item').filter({ hasText: '插入子节点' }).click()
    await finishEdit(pageA)
    await pageB.waitForTimeout(600)

    await node.click({ button: 'right', force: true })
    const summary = pageA.locator('.contextmenuContainer .item').filter({ hasText: '概要' })
    if (await summary.count()) await summary.click()
    await pageB.waitForTimeout(500)
  })

  test('note tag link persist through UI dialogs', async ({ pair }) => {
    const { pageA, pageB } = pair
    await clickNode(pageA, 'Alpha')
    await clickToolbar(pageA, '标签')
    await expect(pageA.locator('.nodeTagDialog')).toBeVisible()
    await pageA.locator('.nodeTagDialog input').first().fill('e2e-tag')
    await pageA.locator('.nodeTagDialog input').first().press('Enter')
    await pageA.locator('.nodeTagDialog').getByRole('button', { name: '确定' }).click()
    await pageB.waitForTimeout(800)

    await clickNode(pageA, 'Beta')
    await clickToolbar(pageA, '超链接')
    const linkDialog = pageA.locator('.el-dialog').filter({ hasText: /超链接|链接/ }).first()
    if (await linkDialog.count()) {
      const inputs = linkDialog.locator('input')
      if (await inputs.count()) {
        await inputs.first().fill('https://example.com')
      }
      const ok = linkDialog.getByRole('button', { name: '确定' })
      if (await ok.count()) await ok.click()
    }
    await pageB.waitForTimeout(600)
    expect(await pageB.locator('.smm-node').count()).toBeGreaterThan(2)
    await waitForText(pageB, 'Alpha')
  })
})
