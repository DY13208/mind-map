'use strict'

const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')

// Reuse native authentication, an ephemeral database, compiled App and cleanup.
const fixture = path.join(__dirname, '../../scripts/mcp-guards-browser.cjs')
let source = fs.readFileSync(fixture, 'utf8')
source = source.replace("'mcp-guards-seed.cjs'", "'paste-connector-seed.cjs'")
source = source.replace("['owner', 'editor-a', 'editor-b']", "['owner', 'editor-a']")
const start = source.indexOf('  const converge = async revision => {')
const end = source.indexOf('\nmain().catch(error =>')
assertBoundaries()

function assertBoundaries() {
  if (start < 0 || end <= start) throw new Error('Browser fixture boundaries changed')
}

const focused = async function () {
  const page = clients[0].page
  const idle = async target => {
    await target.waitForFunction(() => {
      const mm = __guardMM, c = mm.cooperate, r = mm.renderer
      const status = c.collabV2Adapter.getStatus()
      return !r.isRendering && !r.renderTimer && !r._lazyCommandPending &&
        !c.httpInsertPromise && status.pendingCount === 0 && status.outboxPending === 0
    }, null, { timeout: 60000 })
    await target.waitForTimeout(400)
  }
  const snapshot = target => target.evaluate(() => {
    const mm = __guardMM, parent = mm.renderer.findNodeByUid('b1')
    return {
      local: parent.nodeData.children.map(n => n.data.uid),
      canonical: mm.cooperate.currentData.b1?.children,
      placementFix: typeof mm.cooperate.acknowledgeLocalNodePlacement === 'function'
    }
  })
  const dbOrder = async () => (await serverChildren('b1')).map(n => n.uid)
  const bind = async target => {
    await target.waitForFunction(`(() => {const mm=(${mapInBrowser.toString()})();if(mm)window.__guardMM=mm;return mm&&mm.renderer.root&&!mm.renderer.isRendering&&mm.cooperate.collabV2Adapter.getStatus().phase==='LIVE'})()`)
    await target.evaluate(() => __guardMM.execCommand('SET_NODE_EXPAND', __guardMM.renderer.findNodeByUid('b1'), true))
    await target.waitForFunction(() => __guardMM.renderer.findNodeByUid('b1l3'))
    await idle(target)
  }
  await bind(page)
  const initial = await dbOrder()
  assert.equal(initial.length, 4)
  assert.equal((await snapshot(page)).placementFix, true, 'candidate compiled App includes placement fix')

  for (const immediate of [false, true]) {
    const moved = await page.evaluate(() => {
      const mm = __guardMM, r = mm.renderer
      const parent = r.findNodeByUid('b1')
      const kids = parent.nodeData.children
      const order = kids.map(child => child.data.uid)
      mm.execCommand('INSERT_BEFORE', r.findNodeByUid(kids.at(-1).data.uid), r.findNodeByUid(kids[0].data.uid))
      return [order.at(-1), ...order.slice(0, -1)]
    })
    await page.waitForFunction(uid => __guardMM.renderer.findNodeByUid('b1')?.nodeData.children[0]?.data.uid === uid && !__guardMM.renderer.isRendering, moved[0])
    if (!immediate) await idle(page)
    const count = moved.length
    await page.evaluate(() => {
      const mm = __guardMM, r = mm.renderer
      r.clearActiveNodeList()
      r.addNodeToActiveList(r.findNodeByUid('b1'))
      mm.execCommand('INSERT_CHILD_NODE', false)
    })
    await idle(page)
    const first = await snapshot(page)
    assert.equal(first.local.length, count + 1, 'one child command creates exactly one node')
    assert.deepEqual(first.local.slice(0, count), moved, 'new child follows every existing sibling without undoing the move')
    assert.deepEqual(await dbOrder(), first.local, 'database and displayed sibling order agree')
    // Keep the parent selected as when its context menu is used repeatedly.
    await page.evaluate(() => {
      const mm = __guardMM, r = mm.renderer
      for (let i = 0; i < 3; i++) {
        r.clearActiveNodeList()
        r.addNodeToActiveList(r.findNodeByUid('b1'))
        mm.execCommand('INSERT_CHILD_NODE', false)
      }
    })
    await idle(page)
    const repeated = await snapshot(page)
    assert.equal(repeated.local.length, count + 4, 'three more commands add exactly three nodes')
    assert.deepEqual(repeated.local.slice(0, count + 1), first.local)
    assert.deepEqual(await dbOrder(), repeated.local)
    report.checks.push({ name: immediate ? 'insert immediately after reorder' : 'insert after move ACK', ok: true, children: repeated.local.length })
    await page.reload()
    await bind(page)
    assert.deepEqual((await snapshot(page)).local, repeated.local, 'order survives reload')
  }
  for (const input of ['context-menu', 'Tab']) {
    const before = await dbOrder()
    await page.evaluate(() => new Promise(resolve => {
      const mm = __guardMM, r = mm.renderer, parent = r.findNodeByUid('b1')
      r.clearActiveNodeList()
      r.addNodeToActiveList(parent)
      mm.execCommand('GO_TARGET_NODE', parent, resolve)
    }))
    const box = await page.evaluate(() => {
      const rect = __guardMM.renderer.findNodeByUid('b1').group.node.getBoundingClientRect()
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    })
    if (input === 'context-menu') {
      await page.mouse.click(box.x, box.y, { button: 'right' })
      await page.getByText('插入子级节点', { exact: true }).locator('..').click()
    } else {
      await page.mouse.click(box.x, box.y)
      await page.keyboard.press('Tab')
    }
    await page.waitForTimeout(300)
    await page.evaluate(() => __guardMM.renderer.textEdit.hideEditTextBox())
    await idle(page)
    const after = await snapshot(page)
    assert.equal(after.local.length, before.length + 1, input + ' creates exactly one child')
    assert.deepEqual(after.local.slice(0, -1), before, input + ' appends at bottom')
    assert.deepEqual(await dbOrder(), after.local)
    report.checks.push({ name: input + ' adds exactly one child at bottom', ok: true })
  }
  await page.screenshot({ path: path.join(OUT, 'child-order.png') })
  report.passed = true
  console.log('PASS reordered children stay in place, every insert appends once, and reload retains order')
}

source = source.slice(0, start) + '\n await (' + focused.toString() + ')()\n}\n' + source.slice(end)
const runtime = new Module(fixture, module)
runtime.filename = fixture
runtime.paths = module.paths
runtime._compile(source, fixture)
