'use strict'

const assert = require('assert')
const {
  playwrightModule,
  login,
  seedRoom,
  openEditor,
  fetchTree
} = require('./c2RendererStable.benchmark.test')

async function main() {
  const pw = await playwrightModule()
  const browser = await pw.chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage']
  })
  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1
  })
  const loginPage = await context.newPage()
  try {
    await login(loginPage)
    const roomKey = await seedRoom(context.request, 10000)
    const page = await context.newPage()
    page.setDefaultTimeout(120000)
    await openEditor(page, roomKey)
    const tree = await fetchTree(page, roomKey, 10000)
    const nodes = []
    const stack = [tree]
    while (stack.length) {
      const node = stack.pop()
      nodes.push(node)
      const children = node.children || []
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i])
    }
    assert.ok(nodes.length >= 10000, 'correctness fixture must use large path')
    nodes[1].data.text = 'Plain node'
    delete nodes[1].data.richText
    nodes[2].data.text = '<p>Legacy &amp; plain</p>'
    nodes[2].data.richText = true
    nodes[3].data.text = '<p><strong>Bold</strong> text</p>'
    nodes[3].data.richText = true
    nodes[4].data.text =
      '<p><span class="ql-formula" data-value="x^2"></span></p>'
    nodes[4].data.richText = true
    nodes[5].data.image =
      'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='
    nodes[5].data.imageSize = { width: 1, height: 1, custom: true }
    nodes[6].data.tag = ['alpha', 'beta']
    nodes[7].data.icon = ['priority_1']
    nodes[8].data.hyperlink = 'https://example.com'
    nodes[8].data.hyperlinkTitle = 'Example'
    nodes[9].data.fontSize = 22
    nodes[9].data.fontWeight = 'bold'
    nodes[10].data.generalization = [
      { uid: 'c2-generalization', text: 'Summary', range: [0, 0] }
    ]
    nodes[11].data.associativeLineTargets = [nodes[12].data.uid]
    nodes[13].data.outerFrame = { width: 2, strokeColor: '#123456' }
    nodes[14].data.text = 'Search needle'

    const featureIds = nodes.slice(1, 15).map(item => item.data.uid)
    const moveId = nodes[nodes.length - 1].data.uid
    const moveTargetId = nodes[2].data.uid
    const result = await page.evaluate(async payload => {
      const { treeData, ids, moveId, moveTargetId } = payload
      const mm = window.__C2_STABLE_MM__
      const waitRender = action =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('render timeout')), 300000)
          const done = () => {
            clearTimeout(timer)
            mm.off('node_tree_render_end', done)
            resolve()
          }
          mm.on('node_tree_render_end', done)
          action()
        })
      await waitRender(() => mm.setData(treeData))
      const byUid = uid => mm.renderer.findNodeByUid(uid)
      const instances = ids.map(byUid)
      const hasForeignObject = node =>
        !!(
          node &&
          node._textData &&
          node._textData.node &&
          node._textData.node.node.querySelector('foreignObject')
        )
      const checks = {
        fullTreeRenderer: mm.renderer.usePlainTextFastPath !== true,
        plainText: !!instances[0] && hasForeignObject(instances[0]),
        legacyPlain: !!instances[1] && hasForeignObject(instances[1]),
        richText: hasForeignObject(instances[2]),
        formula: hasForeignObject(instances[3]),
        image: !!(instances[4] && instances[4]._imgData),
        tag: !!(instances[5] && instances[5]._tagData),
        icon: !!(instances[6] && instances[6]._iconData),
        hyperlink: !!(instances[7] && instances[7]._hyperlinkData),
        customStyle:
          !!instances[8] && Number(instances[8].getData('fontSize')) === 22,
        generalization:
          !!instances[9] &&
          Array.isArray(instances[9]._generalizationList) &&
          instances[9]._generalizationList.length === 1,
        associativeLine:
          !!mm.associativeLine &&
          Array.isArray(instances[10].getData('associativeLineTargets')),
        outerFrame:
          !!mm.outerFrame && !!instances[12].getData('outerFrame')
      }

      mm.search.search('needle')
      checks.search = mm.search.matchNodeList.length === 1
      mm.search.endSearch()

      const collapsible = instances[0]
      await waitRender(() =>
        mm.execCommand('SET_NODE_EXPAND', collapsible, false)
      )
      const collapsed = collapsible.getData('expand') === false
      await waitRender(() => mm.execCommand('SET_NODE_EXPAND', collapsible, true))
      checks.collapseExpand = collapsed && collapsible.getData('expand') === true

      const editNode = byUid(ids[1])
      const historyBefore = mm.command.history.length
      await waitRender(() => editNode.setText('<p>Edited text</p>', true))
      await new Promise(resolve => setTimeout(resolve, 150))
      const historyAfter = mm.command.history.length
      const edited = editNode.getData('text').includes('Edited text')
      const findData = (root, uid) => {
        const pending = [root]
        while (pending.length) {
          const item = pending.pop()
          if (item && item.data && item.data.uid === uid) return item.data
          ;((item && item.children) || []).forEach(child => pending.push(child))
        }
        return null
      }
      const undoTree = mm.command.back()
      const undoneData = findData(undoTree, ids[1])
      const redoTree = mm.command.forward()
      const redoneData = findData(redoTree, ids[1])
      checks.editHistory = edited && historyAfter > historyBefore
      checks.undo = !!undoneData && !String(undoneData.text).includes('Edited text')
      checks.redo = !!redoneData && String(redoneData.text).includes('Edited text')

      // MOVE_NODE_TO is the same renderer command used by drag/drop after its
      // pointer hit-test; move one leaf and verify the target parent changes.
      const moveNode = byUid(moveId)
      const moveTarget = byUid(moveTargetId)
      if (moveNode && moveTarget && moveNode !== moveTarget) {
        mm.execCommand('MOVE_NODE_TO', moveNode, moveTarget)
        checks.dragMove = moveNode.parent === moveTarget
      } else {
        checks.dragMove = false
      }
      return checks
    }, { treeData: tree, ids: featureIds, moveId, moveTargetId })

    console.log('c2 renderer correctness checks', result)
    Object.keys(result).forEach(key => {
      assert.strictEqual(result[key], true, key + ' correctness failed')
    })
    console.log('c2RendererCorrectness.browser.test.js PASS', result)
  } finally {
    await browser.close()
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
