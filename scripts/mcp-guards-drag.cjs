'use strict'
const assert = require('node:assert/strict')
const path = require('node:path')
module.exports = async function ({ clients, call, query, state, converge, roomKey, check, OUT }) {
  if (!clients.length) return
  const page = clients[1].page
  async function startDrag(uid) {
    await page.evaluate(uid => new Promise(resolve => {
      const mm = __guardMM, node = mm.renderer.findNodeByUid(uid)
      if (!node) {
        const data = [], instances = [], walkData = n => { if (!n) return; if (n.data?.uid === uid) data.push(n.data.uid); (n.children || []).forEach(walkData) }
        const walk = n => { if (!n) return; if (n.getData?.('uid') === uid) instances.push(n.getData('uid')); (n.children || []).forEach(walk) }
        walkData(mm.renderer.renderTree); walk(mm.renderer.root)
        throw new Error('Visible source missing: ' + uid + ' ' + JSON.stringify({ data, instances,
          cached: !!mm.renderer.nodeCache?.[uid], indexed: mm.renderer.nodeIndex?.size, authority: !!mm.cooperate.currentData?.[uid] }))
      }
      mm.execCommand('GO_TARGET_NODE', node, resolve)
    }), uid)
    await page.waitForFunction(uid => !!__guardMM.renderer.findNodeByUid(uid)?.group?.node?.isConnected, uid)
    const box = await page.evaluate(uid => {
      const n = __guardMM.renderer.findNodeByUid(uid)
      const rect = n.group.node.getBoundingClientRect()
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    }, uid)
    await page.mouse.move(box.x, box.y)
    await page.mouse.down()
    await page.mouse.move(box.x + 65, box.y + 20, { steps: 6 })
    await page.waitForFunction(() => __guardMM.cooperate._dragViewDeferred === true)
  }
  await check('real drag freezes view while authority applies remote text and move; stale drop cancels', async () => {
    const uid = 'add-80-10', initial = (await query(uid)).items[0]
    await startDrag(uid)
    const changed = await call('update_node', { room_key: roomKey, node: uid, text: '拖拽期间远端文字',
      expected: { uid, '__fv.text': initial.data.__fv?.text || 0 } })
    assert.equal(changed.toolError, false, JSON.stringify(changed))
    const current = (await query(uid)).items[0]
    const moved = await call('move_node', { room_key: roomKey, uid, parent_uid: 'branch-1',
      expected: { uid, parent_uid: current.parent_uid, position: current.position } })
    assert.equal(moved.toolError, false, JSON.stringify(moved))
    const revision = Number(await state())
    await page.waitForFunction(revision => Number(__guardMM.cooperate.lastAppliedVersion) >= revision, revision)
    const frozen = await page.evaluate(uid => {
      const c = __guardMM.cooperate, node = __guardMM.renderer.findNodeByUid(uid)
      return { authority: c.currentData[uid]?.data.text, text: node?.getData('text'),
        parent: node?.parent?.getData('uid'), dirty: c.dirtyUIDSet.size, deferred: c.viewDeferred }
    }, uid)
    assert.equal(frozen.authority, '拖拽期间远端文字'); assert.equal(frozen.text, initial.data.text)
    assert.equal(frozen.parent, 'root'); assert.equal(frozen.deferred, true)
    await page.mouse.up()
    await page.waitForFunction(() => !__guardMM.cooperate._dragViewDeferred && !__guardMM.cooperate.viewDeferred && !__guardMM.renderer.isRendering)
    await converge(revision)
    assert.equal(Number(await state()), revision, 'invalid old drop must not submit another move')
    assert.equal((await query(uid)).items[0].parent_uid, 'branch-1')
    await page.screenshot({ path: path.join(OUT, 'drag-remote-move.png') })
    return { authorityAppliedWhileFrozen: true, staleDropCancelled: true, boundedDirtyUids: frozen.dirty }
  })
  await check('remote source deletion during real drag cannot be resurrected by drop', async () => {
    const uid = 'add-80-11', item = (await query(uid, true)).items[0]
    await startDrag(uid)
    const deleted = await call('delete_node', { room_key: roomKey, node: uid,
      expected: { uid, subtree_token: item.subtree_token } })
    assert.equal(deleted.toolError, false, JSON.stringify(deleted))
    const revision = Number(await state())
    await page.waitForFunction(revision => Number(__guardMM.cooperate.lastAppliedVersion) >= revision, revision)
    assert.equal(await page.evaluate(uid => !!__guardMM.renderer.findNodeByUid(uid), uid), true)
    await page.mouse.up()
    await page.waitForFunction(uid => !__guardMM.cooperate.viewDeferred && !__guardMM.renderer.findNodeByUid(uid), uid)
    await converge(revision)
    assert.equal(Number(await state()), revision)
    return { staleSourceRemoved: true, resurrected: false }
  })
}
