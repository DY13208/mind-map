const { test, expect } = require('./fixtures')
const {
  clickNode,
  pressOnCanvas,
  waitForText,
  finishEdit,
  renameActive,
  waitForCollab,
  apiJson
} = require('./helpers')

async function waitSaved(page) {
  await page.waitForFunction(() => {
    const state = window.__COLLAB_V2_STATE__
    const fn = window.__COLLAB_V2_STATUS__
    const snap = state || (typeof fn === 'function' ? fn() : null)
    return !!(
      snap &&
      snap.status === 'live' &&
      snap.phase === 'LIVE' &&
      Number(snap.pendingCount || 0) === 0 &&
      (snap.saveState === 'saved' || snap.outboxPending === 0)
    )
  }, null, { timeout: 20000 })
}

async function collabState(page) {
  return page.evaluate(() => {
    return (
      window.__COLLAB_V2_STATE__ ||
      (typeof window.__COLLAB_V2_STATUS__ === 'function'
        ? window.__COLLAB_V2_STATUS__()
        : null)
    )
  })
}

async function roomNodes(api, room) {
  const data = await apiJson(
    api + '/api/files/' + encodeURIComponent(room) + '?format=nodes'
  )
  const raw = data.nodes
  const list = Array.isArray(raw)
    ? raw
    : Object.keys(raw || {}).map(uid => ({
        uid,
        text: (raw[uid] && raw[uid].data && raw[uid].data.text) || '',
        deleted: !!(raw[uid] && raw[uid].deleted)
      }))
  return list.filter(item => item && !item.deleted)
}

async function roomOps(api, room) {
  const data = await apiJson(
    api +
      '/api/collab-v2/ops?roomKey=' +
      encodeURIComponent(room) +
      '&afterRevision=0'
  )
  return data.operations || []
}

async function refreshBoth(pageA, pageB, origin, room) {
  await pageA.reload({ waitUntil: 'domcontentloaded' })
  await waitForCollab(pageA)
  await pageB.reload({ waitUntil: 'domcontentloaded' })
  await waitForCollab(pageB)
  void origin
  void room
}

test.describe('collab v2 core persist', () => {
  test('text update reaches PG and survives refresh', async ({ pair }) => {
    const { pageA, pageB, room, runtime } = pair
    const stateA = await collabState(pageA)
    const stateB = await collabState(pageB)
    expect(stateA && stateA.clientId).toBeTruthy()
    expect(stateB && stateB.clientId).toBeTruthy()
    expect(stateA.clientId).not.toBe('')
    expect(stateB.clientId).not.toBe('')
    expect(stateA.clientId).not.toBe(stateB.clientId)
    const beforeOps = await roomOps(runtime.api, room)
    const next = 'Alpha-core-text'
    await clickNode(pageA, 'Alpha')
    await renameActive(pageA, next)
    await waitSaved(pageA)
    await waitForText(pageB, next)
    const nodes = await roomNodes(runtime.api, room)
    expect(nodes.some(item => item.text === next && item.uid)).toBeTruthy()
    const ops = await roomOps(runtime.api, room)
    const newest = ops.filter(
      op => Number(op.serverRevision || op.version || 0) > (beforeOps.length ? Number(beforeOps[beforeOps.length - 1].serverRevision || beforeOps[beforeOps.length - 1].version || 0) : 0)
    )
    expect(newest.length).toBeGreaterThan(0)
    newest.forEach(op => {
      const clientId = op.clientId || op.client_id
      expect(clientId).toBeTruthy()
      expect(clientId).not.toBe('')
    })
    expect(
      ops.some(op =>
        ['node.update', 'node.updated'].includes(op.type || (op.event && op.event.type))
      )
    ).toBeTruthy()
    await pageA.waitForTimeout(1200)
    const afterQuiet = await roomOps(runtime.api, room)
    expect(afterQuiet.length).toBe(ops.length)
    await refreshBoth(pageA, pageB, runtime.origin, room)
    await waitForText(pageA, next)
    await waitForText(pageB, next)
    const refreshedA = await collabState(pageA)
    const refreshedB = await collabState(pageB)
    expect(refreshedA.clientId).toBe(stateA.clientId)
    expect(refreshedB.clientId).toBe(stateB.clientId)
  })

  test('Enter insert reaches PG and survives refresh', async ({ pair }) => {
    const { pageA, pageB, room, runtime } = pair
    const before = await roomNodes(runtime.api, room)
    await clickNode(pageA, 'Alpha')
    await pressOnCanvas(pageA, 'Enter')
    await finishEdit(pageA)
    await waitSaved(pageA)
    await waitForText(pageB, '二级节点')
    const after = await roomNodes(runtime.api, room)
    expect(after.length).toBeGreaterThan(before.length)
    const created = after.filter(
      item => !before.some(prev => prev.uid === item.uid)
    )
    expect(created.length).toBeGreaterThan(0)
    const ops = await roomOps(runtime.api, room)
    expect(
      ops.some(op =>
        ['node.insert', 'node.batch', 'node.inserted'].includes(
          op.type || (op.event && op.event.type)
        )
      )
    ).toBeTruthy()
    await refreshBoth(pageA, pageB, runtime.origin, room)
    await waitForText(pageA, '二级节点')
    await waitForText(pageB, '二级节点')
    const afterRefresh = await roomNodes(runtime.api, room)
    created.forEach(item => {
      expect(afterRefresh.some(row => row.uid === item.uid)).toBeTruthy()
    })
  })

  test('paste reaches PG and survives refresh', async ({ pair }) => {
    const { pageA, pageB, room, runtime } = pair
    const before = await roomNodes(runtime.api, room)
    const beforeCount = await pageB.locator('.smm-node').count()
    await clickNode(pageA, 'Alpha')
    await pressOnCanvas(pageA, 'Control+c')
    await pageA.waitForTimeout(200)
    await clickNode(pageA, 'Beta')
    await pressOnCanvas(pageA, 'Control+v')
    await waitSaved(pageA)
    await expect
      .poll(async () => pageB.locator('.smm-node').count(), { timeout: 15000 })
      .toBeGreaterThan(beforeCount)
    const after = await roomNodes(runtime.api, room)
    expect(after.length).toBeGreaterThan(before.length)
    const created = after.filter(
      item => !before.some(prev => prev.uid === item.uid)
    )
    expect(created.length).toBeGreaterThan(0)
    const ops = await roomOps(runtime.api, room)
    expect(
      ops.some(op =>
        ['node.insert', 'node.batch', 'node.inserted'].includes(
          op.type || (op.event && op.event.type)
        )
      )
    ).toBeTruthy()
    await refreshBoth(pageA, pageB, runtime.origin, room)
    await expect(pageA.locator('.smm-node')).toHaveCount(after.length, {
      timeout: 15000
    })
    await expect(pageB.locator('.smm-node')).toHaveCount(after.length, {
      timeout: 15000
    })
    const afterRefresh = await roomNodes(runtime.api, room)
    created.forEach(item => {
      expect(afterRefresh.some(row => row.uid === item.uid)).toBeTruthy()
    })
  })
})
