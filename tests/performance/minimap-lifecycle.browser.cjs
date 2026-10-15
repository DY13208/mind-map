'use strict'
const { runCases } = require('./frontend-runner.cjs')
runCases('minimap', [
  { id: 'R01', name: 'real Navigator plus Edit forwarding has no idle redraw feedback',
    observe: page => page.evaluate(async () => {
      const f = window.perfFrontend, editor = await f.mountEditor(), mm = editor.component.mindMap
      mm.updateConfig({ openPerformance: true })
      await f.waitRender(mm, () => mm.setData(f.tree(70)))
      const style = document.createElement('style'); style.textContent = '.navigatorBox{height:220px;width:370px}.svgBox{position:absolute}'; document.head.appendChild(style)
      const nav = f.mount(f.Navigator, { mindMap: mm })
      await f.pause(350); nav.component.toggle_mini_map(true); await f.Vue.nextTick()
      const deadline = Date.now() + 5000
      while (!nav.component.mindMapImg) { if (Date.now() > deadline) throw new Error('first real minimap image unavailable'); await f.pause(20) }
      const forced = f.spy(mm.renderer, 'forceLoadNode'), exports = f.spy(mm, 'getSvgData')
      await f.pause(1800)
      const result = { forced: forced.calls.length, exports: exports.calls.length, ready: !!nav.component.mindMapImg }
      nav.component.toggle_mini_map(false); f.unmount(nav); f.unmount(editor)
      return result
    }), checks: [
      { name: 'idle main-canvas force paint stays zero', assert: (x, a) => { a.equal(x.ready, true); a.equal(x.forced, 0) } },
      { name: 'idle full export stays zero', assert: (x, a) => a.equal(x.exports, 0) }
    ] },
  { id: 'R02', name: 'view-only translation updates real minimap viewport without full export',
    observe: page => page.evaluate(async () => {
      const f = window.perfFrontend, editor = await f.mountEditor(), mm = editor.component.mindMap
      mm.updateConfig({ openPerformance: true })
      await f.waitRender(mm, () => mm.setData(f.tree(40)))
      const style = document.createElement('style'); style.textContent = '.navigatorBox{height:220px;width:370px}'; document.head.appendChild(style)
      const nav = f.mount(f.Navigator, { mindMap: mm }); await f.pause(350)
      nav.component.toggle_mini_map(true); await f.Vue.nextTick(); await f.pause(100)
      const before = JSON.stringify(nav.component.viewBoxStyle)
      const exports = f.spy(mm, 'getSvgData'), layouts = f.spy(mm.renderer.layout, 'doLayout')
      mm.view.translateXTo(120); mm.view.translateYTo(75)
      await f.pause(1200)
      const result = { exports: exports.calls.length, layouts: layouts.calls.length,
        viewportChanged: JSON.stringify(nav.component.viewBoxStyle) !== before }
      nav.component.toggle_mini_map(false); f.unmount(nav); f.unmount(editor)
      return result
    }), checks: [
      { name: 'view changes do not export complete SVG', assert: (x, a) => a.equal(x.exports, 0) },
      { name: 'viewport moves without new layout', assert: (x, a) => { a.equal(x.layouts, 0); a.equal(x.viewportChanged, true) } }
    ] },
  { id: 'R03', name: 'closing Navigator cancels pending refresh while explicit SVG stays complete',
    observe: page => page.evaluate(async () => {
      const f = window.perfFrontend, editor = await f.mountEditor(), mm = editor.component.mindMap
      mm.updateConfig({ openPerformance: true })
      await f.waitRender(mm, () => mm.setData(f.tree(45)))
      const style = document.createElement('style'); style.textContent = '.navigatorBox{height:220px;width:370px}'; document.head.appendChild(style)
      const nav = f.mount(f.Navigator, { mindMap: mm }); await f.pause(350)
      nav.component.toggle_mini_map(true); await f.Vue.nextTick(); await f.pause(80)
      nav.component.data_change(); nav.component.toggle_mini_map(false)
      const spy = f.spy(mm, 'getSvgData')
      f.unmount(nav); await f.pause(800)
      const afterClose = spy.calls.length
      const exported = mm.getSvgData()
      const exportedNodes = exported.svg.node.querySelectorAll('.smm-node').length
      const dataNodes = Object.keys(mm.renderer.nodeCache).length
      const png = await mm.doExport.png('performance-protection')
      const pngDimensions = await new Promise((resolve, reject) => {
        const image = new Image(); image.onload = () => resolve({ width: image.width, height: image.height }); image.onerror = reject; image.src = png
      })
      const pdf = await mm.doExportPDF.pdf(png)
      const pdfDocument = await f.PDFDocument.load(pdf)
      const pdfSize = pdfDocument.getPages()[0].getSize()
      f.unmount(editor)
      return { afterClose, exportedNodes, dataNodes, fullSvg: exported.svgHTML.includes('Node 44'), pngDimensions, pdfSize,
        pngComplete: pngDimensions.width >= exported.rect.width && pngDimensions.height >= exported.rect.height,
        pdfPages: pdfDocument.getPageCount() }
    }), checks: [
      { name: 'closed/unmounted Navigator performs no delayed export', assert: (x, a) => a.equal(x.afterClose, 0) },
      { name: 'explicit SVG keeps every expanded node', assert: (x, a) => { a.equal(x.exportedNodes, x.dataNodes); a.equal(x.fullSvg, true) } },
      { name: 'actual PNG and PDF cover the same complete bounds', assert: (x, a) => { a.equal(x.pngComplete, true); a.equal(x.pdfPages, 1); a.equal(x.pdfSize.width, x.pngDimensions.width); a.equal(x.pdfSize.height, x.pngDimensions.height) } }
    ] }
  ,{ id: 'R03-stale', name: 'real delayed image conversion cannot overwrite a reopened Navigator',
    observe: page => page.evaluate(async () => {
      const f = window.perfFrontend, editor = await f.mountEditor(), mm = editor.component.mindMap
      mm.updateConfig({ openPerformance: false })
      await f.waitRender(mm, () => mm.setData(f.tree(5)))
      const style = document.createElement('style'); style.textContent = '.navigatorBox{height:220px;width:370px}'; document.head.appendChild(style)
      const nav = f.mount(f.Navigator, { mindMap: mm }); await f.pause(350)
      const original = mm.doExport.fixSvgStrAndToBlob
      let release, delayedImage
      mm.doExport.fixSvgStrAndToBlob = async function(...args) {
        const image = await original.apply(this, args)
        delayedImage = image
        return await new Promise(resolve => { release = () => resolve(image) })
      }
      nav.component.toggle_mini_map(true); await f.Vue.nextTick(); await f.pause(50)
      if (!release) throw new Error('actual image conversion did not reach delayed delivery boundary')
      nav.component.toggle_mini_map(false)
      await f.waitRender(mm, () => mm.setData(f.tree(8)))
      mm.doExport.fixSvgStrAndToBlob = original
      nav.component.toggle_mini_map(true); await f.Vue.nextTick(); await f.pause(100)
      const current = nav.component.mindMapImg
      release(); await f.pause(30)
      const result = { currentReady: !!current, distinct: current !== delayedImage, preserved: nav.component.mindMapImg === current }
      nav.component.toggle_mini_map(false); f.unmount(nav); f.unmount(editor)
      return result
    }), checks: [
      { name: 'reopened current outline survives actual old conversion completion', assert: (x,a) => { a.equal(x.currentReady, true); a.equal(x.distinct, true); a.equal(x.preserved, true) } }
    ] }
  ,{ id: 'R02-outline', name: 'independent outline includes true connectors and refreshes after async layout',
    observe: page => page.evaluate(async () => {
      const f = window.perfFrontend, mm = await f.createEngine(f.tree(8), { openPerformance: true }), mini = mm.miniMap
      const before = mini.calculationMiniMap(370, 220).svgHTML
      const parsed = new DOMParser().parseFromString(before, 'image/svg+xml')
      const expectedLines = Array.from(mm.renderer.nodeIndex.values()).reduce((sum, node) => sum + node._lines.length, 0)
      const pathCount = parsed.querySelectorAll('path').length, nodes = mm.renderer.nodeIndex.size
      const original = mm.renderer.layout.doLayout
      mm.renderer.layout.doLayout = function(callback) { return original.call(this, root => setTimeout(() => callback(root), 650)) }
      mm.renderer.root.active()
      const rendered = f.waitRender(mm, () => mm.execCommand('INSERT_CHILD_NODE', false, mm.renderer.root, { uid: 'outline-added', text: 'Added' }))
      await f.pause(550); mini.calculationMiniMap(370, 220)
      await rendered
      const after = mini.calculationMiniMap(370, 220).svgHTML
      return { pathCount, expectedLines, nodes, changed: after !== before, afterNodes: mm.renderer.nodeIndex.size }
    }), checks: [
      { name: 'outline contains actual connectors in addition to node shapes', assert: (x,a) => { a.ok(x.expectedLines > 0); a.ok(x.pathCount >= x.nodes + x.expectedLines, 'outline paths=' + x.pathCount + ', nodes=' + x.nodes + ', true connectors=' + x.expectedLines) } },
      { name: 'layout completion refreshes a cache read during a slow render', assert: (x,a) => { a.equal(x.afterNodes, x.nodes + 1); a.equal(x.changed, true) } }
    ] }
  ,{ id: 'R02-zoom-drag', name: 'real viewport rectangle drag keeps its pointer offset at both zoom levels',
    observe: page => page.evaluate(async () => {
      const f = window.perfFrontend, data = f.tree(40)
      data.children.forEach((node, i) => { node.data.customLeft = 1000 + i * 100 })
      const mm = await f.createEngine(data, { openPerformance: true }), mini = mm.miniMap
      const rows = []
      for (const scale of [0.75, 2]) {
        mm.view.setScale(scale); mm.view.translateXTo(-1500 * scale); mm.view.translateYTo(-500 * scale)
        const before = mini.calculationMiniMap(370, 220)
        const left = parseFloat(before.viewBoxStyle.left), top = parseFloat(before.viewBoxStyle.top)
        mini.onViewBoxMousedown({ clientX: 100, clientY: 100 })
        mini.onViewBoxMousemove({ clientX: 104, clientY: 106 }); mini.onMouseup()
        const after = mini.calculationMiniMap(370, 220)
        rows.push({ scale, dx: parseFloat(after.viewBoxStyle.left) - left, dy: parseFloat(after.viewBoxStyle.top) - top })
      }
      return rows
    }), checks: [
      { name: 'world translation and mini rectangle remain under the same pointer', assert: (x,a) => x.forEach(row => { a.ok(Math.abs(row.dx - 4) < 0.01, 'scale=' + row.scale + ' dx=' + row.dx); a.ok(Math.abs(row.dy - 6) < 0.01, 'scale=' + row.scale + ' dy=' + row.dy) }) }
    ] }
])
