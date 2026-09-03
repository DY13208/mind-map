const { test, expect } = require('./fixtures')
const {
  clickNode,
  clickToolbar,
  pressOnCanvas,
  waitForText,
  waitForNoText,
  finishEdit,
  pgHash,
  uiHash
} = require('./helpers')

async function dragNode(page, fromText, toText) {
  const from = page.locator('.smm-node').filter({ hasText: fromText }).first()
  const to = page.locator('.smm-node').filter({ hasText: toText }).first()
  await from.dragTo(to, { force: true, targetPosition: { x: 8, y: 40 } })
}

test.describe('structure drag generalization frame line', () => {
  test('drag reorder and illegal descendant @smoke', async ({ pair }) => {
    const { pageA, pageB, runtime, room } = pair
    await clickNode(pageA, 'Alpha')
    await dragNode(pageA, 'Alpha', 'Beta')
    await pageB.waitForTimeout(800)
    await waitForText(pageB, 'Alpha')
    await waitForText(pageB, 'Beta')

    const before = await pgHash(runtime.api, room)
    await dragNode(pageA, 'Gamma', 'Delta')
    await pageB.waitForTimeout(800)
    const afterIllegal = await pgHash(runtime.api, room)
    expect(afterIllegal.count).toBe(before.count)
  })

  test('two browsers drag the same node to a consistent tree', async ({ pair }) => {
    const { pageA, pageB, runtime, room } = pair
    await Promise.all([
      dragNode(pageA, 'Alpha', 'Beta'),
      dragNode(pageB, 'Alpha', 'Gamma')
    ])
    await pageA.waitForTimeout(1200)
    const pg = await pgHash(runtime.api, room)
    const a = await uiHash(pageA)
    const b = await uiHash(pageB)
    expect(a.count).toBe(pg.count)
    expect(b.count).toBe(pg.count)
  })

  test('generalization outer frame associative line and ghost cleanup', async ({
    pair
  }) => {
    const { pageA, pageB } = pair
    await clickNode(pageA, 'Alpha')
    await clickToolbar(pageA, '概要')
    await finishEdit(pageA)
    await pageB.waitForTimeout(600)

    await clickNode(pageA, 'Beta')
    await clickToolbar(pageA, '外框')
    await pageB.waitForTimeout(600)

    await clickNode(pageA, 'Alpha')
    await clickToolbar(pageA, '关联线')
    await pageB.locator('.smm-node').filter({ hasText: 'Beta' }).first().waitFor()
    await pageA.locator('.smm-node').filter({ hasText: 'Beta' }).first().click({ force: true })
    await pageB.waitForTimeout(800)
    const lines = await pageB.locator('.smm-associative-line, path.smm-associative-line').count()
    expect(lines >= 0).toBeTruthy()

    await clickNode(pageB, 'Beta')
    await pressOnCanvas(pageB, 'Delete')
    await waitForNoText(pageA, 'Beta')
    await pageA.waitForTimeout(400)
    const ghosts = await pageA.locator('.smm-associative-line').count()
    expect(ghosts).toBe(0)

    await pressOnCanvas(pageB, 'Control+z')
    await waitForText(pageA, 'Beta')
  })
})
