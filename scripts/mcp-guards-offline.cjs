'use strict'
const assert = require('node:assert/strict')
module.exports = async function ({ clients, call, query, batch, state, converge, roomKey, check }) {
  if (!clients.length) return
  const { page, context } = clients[2]
  await check('disconnected browser catches up ordered batches after reconnect', async () => {
    await context.setOffline(true)
    try {
      const added = await batch(Array.from({ length: 8 }, (_, i) => ({ op: 'add', node: 'offline-gap-' + i, parent: 'root', text: '断线补拉' + i })))
      assert.equal(added.toolError, false, JSON.stringify(added))
    } finally { await context.setOffline(false) }
    const revision = Number(await state())
    await converge(revision)
    assert.equal(await page.evaluate(() => __guardMM.renderer.findNodeByUid('offline-gap-7')?.getData('text')), '断线补拉7')
    return { revision, clients: clients.length }
  })
  await check('offline guarded intent keeps original condition and becomes terminal conflict after reconnect', async () => {
    const uid = 'offline-gap-0', item = (await query(uid)).items[0]
    const expected = { uid, '__fv.text': item.data.__fv?.text || 0 }
    await context.setOffline(true)
    await page.evaluate(({ uid, expected }) => {
      window.__offlineOutcome = null
      __guardMM.cooperate.submitV2('node.update', { uid, patch: { text: '离线人工未保存草稿' }, expected })
        .then(() => { window.__offlineOutcome = 'unexpected-success' })
        .catch(error => { window.__offlineOutcome = error.code })
    }, { uid, expected })
    const remote = await call('update_node', { room_key: roomKey, node: uid, text: '在线先提交内容', expected })
    assert.equal(remote.toolError, false, JSON.stringify(remote))
    await context.setOffline(false)
    await page.waitForFunction(() => !!window.__offlineOutcome, null, { timeout: 90000 })
    const code = await page.evaluate(() => window.__offlineOutcome)
    assert.equal(code, 'REPLACE_CONFLICT')
    await converge(await state())
    assert.equal((await query(uid)).items[0].data.text, '在线先提交内容')
    await page.waitForFunction(uid => __guardMM.cooperate.listEditSessions().some(session => session.uid === uid &&
      session.draft.text === '离线人工未保存草稿' && session.state === 'conflict'), uid)
    return { code, preservedOriginalCondition: true, authoritativeValueKept: true }
  })
}
