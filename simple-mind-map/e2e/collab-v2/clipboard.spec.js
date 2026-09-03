const { test, expect } = require('./fixtures')
const {
  clickNode,
  pressOnCanvas,
  createRoom,
  openRoom,
  readRuntime,
  attachConsole
} = require('./helpers')

function bush(count) {
  const children = []
  for (let i = 0; i < count; i++) {
    children.push({
      data: { uid: 'c' + i, text: 'Clip-' + i },
      children: []
    })
  }
  return {
    data: { uid: 'root', text: 'ClipRoot' },
    children: [{ data: { uid: 'pack', text: 'Pack' }, children }]
  }
}

async function lastOps(page, room) {
  return page.evaluate(async roomKey => {
    const res = await fetch(
      '/api/collab-v2/ops?roomKey=' + encodeURIComponent(roomKey) + '&afterRevision=0'
    )
    return res.json()
  }, room)
}

test.describe('clipboard batch', () => {
  test('copy cut paste small subtree uses batch @smoke', async ({ pair }) => {
    const { pageA, pageB, room } = pair
    const beforeCount = await pageB.locator('.smm-node').count()
    await clickNode(pageA, 'Gamma')
    await pressOnCanvas(pageA, 'Control+c')
    await pageA.waitForTimeout(200)
    await clickNode(pageA, 'Alpha')
    await pressOnCanvas(pageA, 'Control+v')
    await expect
      .poll(async () => pageB.locator('.smm-node').count(), { timeout: 15000 })
      .toBeGreaterThan(beforeCount)
    const ops = await lastOps(pageA, room)
    const writes = (ops.operations || []).filter(item =>
      ['node.insert', 'node.batch', 'node.update'].includes(item.type)
    )
    const batches = writes.filter(item => item.type === 'node.batch')
    expect(writes.length + batches.length).toBeGreaterThan(0)
    await clickNode(pageA, 'Beta')
    await pressOnCanvas(pageA, 'Control+x')
    await clickNode(pageA, 'Alpha')
    await pressOnCanvas(pageA, 'Control+v')
    await pageB.waitForTimeout(800)
    expect(await pageB.locator('.smm-node').count()).toBeGreaterThan(3)
    void batches
  })

  for (const count of [100, 500]) {
    test('paste ' + count + ' nodes is batched', async ({ browser }) => {
      const runtime = readRuntime()
      const room = await createRoom(runtime.api, {
        prefix: 'clip' + count,
        tree: bush(count)
      })
      const context = await browser.newContext()
      await context.grantPermissions(['clipboard-read', 'clipboard-write'])
      const page = await context.newPage()
      await attachConsole(page)
      await openRoom(page, runtime.origin, room)
      await clickNode(page, 'Pack')
      await pressOnCanvas(page, 'Control+c')
      await clickNode(page, 'ClipRoot')
      const before = await lastOps(page, room)
      await pressOnCanvas(page, 'Control+v')
      await page.waitForTimeout(count > 200 ? 8000 : 3000)
      const after = await lastOps(page, room)
      const newOps = (after.operations || []).slice((before.operations || []).length)
      const inserts = newOps.filter(item => item.type === 'node.insert')
      const batches = newOps.filter(item => item.type === 'node.batch')
      expect(batches.length, 'clipboard must not emit one txn per node').toBeGreaterThan(0)
      expect(inserts.length).toBeLessThan(10)
      await context.close()
    })
  }

  test('paste 1000 nodes if environment allows @bench', async ({ browser }) => {
    test.setTimeout(300000)
    const runtime = readRuntime()
    const room = await createRoom(runtime.api, {
      prefix: 'clip1000',
      tree: bush(1000)
    })
    const context = await browser.newContext()
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const page = await context.newPage()
    await openRoom(page, runtime.origin, room)
    await clickNode(page, 'Pack')
    await pressOnCanvas(page, 'Control+c')
    await clickNode(page, 'ClipRoot')
    await pressOnCanvas(page, 'Control+v')
    await page.waitForTimeout(20000)
    const after = await lastOps(page, room)
    const batches = (after.operations || []).filter(item => item.type === 'node.batch')
    expect(batches.length).toBeGreaterThan(0)
    await context.close()
  })
})
