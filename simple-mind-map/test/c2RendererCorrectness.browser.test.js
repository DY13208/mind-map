'use strict'

const assert = require('assert')

function prepareRendererCorrectnessFixture(tree) {
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
    const katex = require('../node_modules/katex')
    nodes[4].data.text = '<p><span class="ql-formula" data-value="x^2">' +
      katex.renderToString('x^2', { output: 'mathml', throwOnError: false, errorColor: '#f00' }) + '</span></p>'
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
    let summaryOwner = nodes.find((node, index) => index > 0 && node.children && node.children.length)
    if (!summaryOwner) {
      // A flat input needs one genuine branch. Reparent an existing tail leaf,
      // preserving cardinality and every UID, instead of inventing a range.
      summaryOwner = nodes[1]
      const tail = nodes[nodes.length - 1]
      const parent = nodes.find(node => (node.children || []).includes(tail))
      parent.children = parent.children.filter(node => node !== tail)
      parent.data.childCount = parent.children.length
      summaryOwner.children = [tail]
      summaryOwner.data.childCount = 1
    }
    summaryOwner.data.generalization = [
      { uid: 'c2-generalization', text: '<p>Summary</p>', richText: true, expand: true, children: [], range: [0, 0] }
    ]
    nodes[11].data.associativeLineTargets = [nodes[12].data.uid]
    nodes[13].data.outerFrame = { groupId: 'c2-frame', text: 'Feature frame', strokeWidth: 2, strokeColor: '#123456' }
    nodes[14].data.text = 'Search needle'

    const featureIds = nodes.slice(1, 15).map(item => item.data.uid)
    const moveId = nodes[nodes.length - 1].data.uid
    const moveTargetId = nodes[2].data.uid
    return { tree, featureIds, moveId, moveTargetId, summaryOwnerUid: summaryOwner.data.uid,
      summaryChildUid: summaryOwner.children[0].data.uid, summaryUid: 'c2-generalization', frameNodeUid: nodes[13].data.uid,
      frameGroupId: 'c2-frame', formulaOutput: 'mathml' }
}

async function runRendererCorrectness(page, tree, options = {}) {
    // An isolated PG caller prepares and persists fixture.tree first, then
    // supplies the same fixture metadata here. No UI-only feature mutation is
    // presented as an authoritative server baseline by this reuse path.
    const fixture = options.fixture || prepareRendererCorrectnessFixture(tree)
    const { featureIds, moveId, moveTargetId, summaryOwnerUid, summaryChildUid, summaryUid, formulaOutput } = fixture
    return await page.evaluate(async payload => {
      const { treeData, ids, moveId, moveTargetId, summaryOwnerUid, summaryChildUid, summaryUid, formulaOutput } = payload
      const mm = window.__C2_STABLE_MM__
      if (!mm.formula || mm.formula.config.output !== formulaOutput) throw new Error('Actual Formula plugin output differs from persisted fixture')
      console.log('[c2-correctness-fixture]', JSON.stringify({ summaryOwnerUid, summaryChildUid, summaryUid, summaryRange: [0, 0], frameNodeUid: ids[12], frameGroupId: 'c2-frame' }))
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
      console.log('[c2-correctness-stage] setData:start')
      await waitRender(() => mm.setData(treeData))
      console.log('[c2-correctness-stage] setData:rendered')
      const byUid = uid => mm.renderer.findNodeByUid(uid)
      const instances = ids.map(byUid)
      const summaryOwner = byUid(summaryOwnerUid)
      const summary = summaryOwner && summaryOwner._generalizationList.find(item => item.generalizationNode.getData('uid') === summaryUid)
      const hasForeignObject = node =>
        !!(
          node &&
          node._textData &&
          node._textData.node &&
          node._textData.node.node.querySelector('foreignObject')
        )
      const formulaSlot = instances[3] && instances[3]._textData && instances[3]._textData.node.node.querySelector('.ql-formula[data-value="x^2"]')
      const formulaMath = formulaSlot && formulaSlot.querySelector('math msup')
      const formulaHtml = formulaSlot && formulaSlot.querySelector('.katex-html')
      const formulaRendered = !!(formulaSlot && (mm.formula.config.output === 'mathml'
        ? formulaMath && formulaMath.querySelector('mi')?.textContent === 'x' && formulaMath.querySelector('mn')?.textContent === '2'
        : formulaHtml && formulaHtml.textContent.includes('x') && formulaHtml.textContent.includes('2')))
      const svgImage = instances[4] && instances[4]._imgData && instances[4]._imgData.node.node
      const imageHref = svgImage && (svgImage.getAttribute('href') || svgImage.getAttributeNS('http://www.w3.org/1999/xlink', 'href'))
      const imageLoaded = imageHref && await new Promise(resolve => {
        const image = new Image()
        image.onload = () => resolve(image.naturalWidth === 1 && image.naturalHeight === 1)
        image.onerror = () => resolve(false)
        image.src = imageHref
      })
      const sourceUid = ids[10], targetUid = ids[11]
      const association = mm.associativeLine && mm.associativeLine.lineList.find(entry =>
        entry[3].getData('uid') === sourceUid && entry[4].getData('uid') === targetUid)
      const associationPath = association && association[0]
      const checks = {
        fullTreeRenderer: mm.renderer.usePlainTextFastPath !== true,
        plainText: !!instances[0] && hasForeignObject(instances[0]),
        legacyPlain: !!instances[1] && hasForeignObject(instances[1]),
        richText: hasForeignObject(instances[2]),
        formula: hasForeignObject(instances[3]) && formulaRendered,
        image: !!(svgImage && svgImage.localName === 'image' && imageHref === instances[4].getImageUrl() && imageLoaded &&
          Number(svgImage.getAttribute('width')) > 0 && Number(svgImage.getAttribute('height')) > 0),
        tag: !!(instances[5] && instances[5]._tagData),
        icon: !!(instances[6] && instances[6]._iconData),
        hyperlink: !!(instances[7] && instances[7]._hyperlinkData),
        customStyle:
          !!instances[8] && Number(instances[8].getData('fontSize')) === 22,
        generalization:
          !!(summary && summaryOwner.children[0]?.getData('uid') === summaryChildUid &&
            summary.generalizationNode.generalizationBelongNode === summaryOwner &&
            summaryOwner.getData('generalization')[0].range[0] === 0 && summaryOwner.getData('generalization')[0].range[1] === 0),
        associativeLine:
          !!(associationPath && mm.associativeLineDraw.node.contains(associationPath.node) && associationPath.node.isConnected &&
            /[CLQ]/.test(associationPath.attr('d')) && associationPath.bbox().width > 0),
        outerFrame: false
      }

      // A frame fixture can start outside the clipped viewport. Test actual
      // navigation into it and re-entry, rather than requiring an off-screen
      // frame to be attached before the user can see its owner.
      const navigateVisible = async uid => {
        mm.execCommand('GO_TARGET_NODE', uid)
        const deadline = Date.now() + 30000
        while (Date.now() < deadline) {
          const node = byUid(uid), group = node && node.group && node.group.node
          const box = group && group.getBoundingClientRect(), canvas = mm.el.getBoundingClientRect()
          if (!mm.renderer.isRendering && !mm.renderer.renderTimer && !mm.renderer.hasWaitRendering && group && group.isConnected &&
            box.right > canvas.left && box.bottom > canvas.top && box.left < canvas.right && box.top < canvas.bottom) {
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
            return
          }
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        throw new Error('Actual frame fixture owner did not enter a settled visible viewport')
      }
      const visibleFrame = () => {
        const frame = mm.outerFrame && mm.outerFrame.outerFrameElList.find(element => element.attr('stroke') === '#123456')
        if (!(frame && frame.node.localName === 'rect' && frame.node.isConnected && mm.outerFrame.draw.node.contains(frame.node) &&
          Number(frame.attr('width')) > 0 && Number(frame.attr('height')) > 0)) return false
        const box = frame.node.getBoundingClientRect(), canvas = mm.el.getBoundingClientRect()
        return box.right > canvas.left && box.bottom > canvas.top && box.left < canvas.right && box.top < canvas.bottom
      }
      await navigateVisible(ids[12])
      checks.outerFrameVisible = visibleFrame()
      await navigateVisible(treeData.data.uid)
      await navigateVisible(ids[12])
      checks.outerFrameReentry = visibleFrame()
      checks.outerFrame = checks.outerFrameVisible && checks.outerFrameReentry

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

      mm.execCommand('GO_TARGET_NODE', ids[1])
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const editNode = byUid(ids[1])
      console.log('[c2-correctness-stage] text-edit:start')
      const cooperate = mm.cooperate
      const isV2 = !!(cooperate && cooperate.collabV2Adapter)
      const historyBefore = mm.command.history.length
      await waitRender(() => editNode.setText('<p>Edited text</p>', true))
      await new Promise(resolve => setTimeout(resolve, 150))
      const historyAfter = mm.command.history.length
      const edited = editNode.getData('text').includes('Edited text')
      console.log('[c2-correctness-stage] text-edit:rendered')
      const waitVisibleText = async expectedEdited => {
        const deadline = Date.now() + 30000
        while (Date.now() < deadline) {
          const node = byUid(ids[1])
          const renderedText = node && node._textData && node._textData.node && node._textData.node.node
          if (node && renderedText && mm.el.contains(renderedText) &&
            String(node.getData('text')).includes('Edited text') === expectedEdited &&
            renderedText.textContent.includes('Edited text') === expectedEdited) return true
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        return false
      }
      if (isV2) await cooperate.flushHttpTextNow()
      const status = isV2 && cooperate.collabV2Adapter.getStatus()
      checks.editHistory = edited && (isV2
        ? historyAfter === 0 && historyBefore === 0 && status.pendingCount === 0
        : historyAfter > historyBefore)
      mm.execCommand('BACK')
      if (isV2) await cooperate._v2HistoryQueue
      checks.undo = await waitVisibleText(false)
      console.log('[c2-correctness-stage] undo:visible', checks.undo)
      mm.execCommand('FORWARD')
      if (isV2) await cooperate._v2HistoryQueue
      checks.redo = await waitVisibleText(true)
      console.log('[c2-correctness-stage] redo:visible', checks.redo)

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
    }, { treeData: tree, ids: featureIds, moveId, moveTargetId, summaryOwnerUid, summaryChildUid, summaryUid, formulaOutput })

}

async function main() {
  // The reusable scenario has no login or environment-file dependency. Only
  // the legacy standalone entry loads its original authentication harness.
  const { playwrightModule, login, seedRoom, openEditor, fetchTree } = require('./c2RendererStable.benchmark.test')
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
    const result = await runRendererCorrectness(page, tree)

    console.log('c2 renderer correctness checks', result)
    Object.keys(result).forEach(key => {
      assert.strictEqual(result[key], true, key + ' correctness failed')
    })
    console.log('c2RendererCorrectness.browser.test.js PASS', result)
  } finally {
    await browser.close()
  }
}

module.exports = { runRendererCorrectness, prepareRendererCorrectnessFixture }

if (require.main === module) main().catch(err => {
  console.error(err)
  process.exit(1)
})
