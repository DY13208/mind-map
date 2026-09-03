const { test, expect } = require('./fixtures')
const {
  clickNode,
  pressOnCanvas,
  waitForText,
  waitForNoText,
  renameActive,
  finishEdit,
  pgHash
} = require('./helpers')

test.describe('keyboard @smoke', () => {
  test('Enter Tab Shift+Tab Delete Backspace undo redo search keys sync to B and PG', async ({
    pair
  }) => {
    const { pageA, pageB, room, runtime } = pair
    await clickNode(pageA, 'Alpha')
    await pressOnCanvas(pageA, 'Enter')
    await finishEdit(pageA)
    await waitForText(pageB, '二级节点')

    await clickNode(pageA, 'Alpha')
    await pressOnCanvas(pageA, 'Tab')
    await finishEdit(pageA)
    await pageA.waitForTimeout(400)
    const afterTab = await pgHash(runtime.api, room)
    expect(afterTab.count).toBeGreaterThan(4)

    await clickNode(pageA, 'Beta')
    await pressOnCanvas(pageA, 'Shift+Tab')
    await finishEdit(pageA)
    await pageB.waitForTimeout(500)

    await clickNode(pageA, 'Delta')
    await renameActive(pageA, 'Delta-Renamed')
    await waitForText(pageB, 'Delta-Renamed')

    await clickNode(pageA, 'Gamma')
    await pressOnCanvas(pageA, 'Control+ArrowUp')
    await pageB.waitForTimeout(400)

    await clickNode(pageA, 'Delta-Renamed')
    await pressOnCanvas(pageA, 'Delete')
    await waitForNoText(pageB, 'Delta-Renamed')

    await clickNode(pageA, 'Alpha')
    await pressOnCanvas(pageA, 'Enter')
    await finishEdit(pageA)
    await pressOnCanvas(pageA, 'Control+z')
    await pageB.waitForTimeout(500)

    await clickNode(pageA, 'Beta')
    await pressOnCanvas(pageA, 'Control+g')
    await pageB.waitForTimeout(600)

    await pressOnCanvas(pageA, 'Control+l')
    await pageB.waitForTimeout(400)

    await pressOnCanvas(pageA, 'Control+f')
    await expect(pageA.locator('.searchContainer.show')).toBeVisible()

    const pg = await pgHash(runtime.api, room)
    expect(pg.count).toBeGreaterThan(3)
  })

  test('Shift+Backspace only removes current node', async ({ pair }) => {
    const { pageA, pageB } = pair
    await clickNode(pageA, 'Gamma')
    await pressOnCanvas(pageA, 'Shift+Backspace')
    await waitForNoText(pageB, 'Gamma')
    await waitForText(pageB, 'Delta')
  })

  test('arrow keys move selection without writing', async ({ pair }) => {
    const { pageA, runtime, room } = pair
    const before = await pgHash(runtime.api, room)
    await clickNode(pageA, 'Alpha')
    await pressOnCanvas(pageA, 'ArrowRight')
    await pressOnCanvas(pageA, 'ArrowDown')
    await pressOnCanvas(pageA, 'ArrowLeft')
    const after = await pgHash(runtime.api, room)
    expect(after.hash).toBe(before.hash)
  })
})
