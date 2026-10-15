const { runCases } = require('./renderer-runner.cjs')

const cases = [
  { id: 'R35', name: 'wide layered real layout has linear coordinate writes and nonoverlapping branches',
    observe: page => page.evaluate(async () => {
      const f = rendererFixture, samples = []
      for (const layout of ['logicalStructure', 'mindMap']) for (const branches of [20, 80]) {
        const c = f.counters(), mm = await f.create(f.wideLayered(branches), { layout, openPerformance: false, compactLayout: false })
        const children = mm.renderer.root.children
        let overlap = false
        for (const direction of ['left','right',undefined]) {
          const group = children.filter(node=>node.dir===direction)
          for (let i=1;i<group.length;i++) if(group[i].top < group[i-1].top + group[i-1].height) overlap=true
        }
        samples.push({ layout, branches, n: 1 + branches * 3, writes: c.values.writes, overlap, coords: f.coordinates(mm) })
        c.restore(); mm.destroy()
      }
      return samples
    }), checks: [
      { name: 'coordinate assignments scale linearly with node count', assert: (x, a) => { for (const layout of ['logicalStructure','mindMap']) { const [small,large] = x.filter(row=>row.layout===layout); a.ok(large.writes <= large.n*20, `${layout}: ${large.writes} writes for ${large.n} nodes`); a.ok(large.writes/small.writes<=5, layout+' must scale linearly') } } },
      { name: 'coordinates finite and branch rectangles do not overlap', assert: (x, a) => { for (const sample of x) { a.equal(sample.overlap, false); for (const values of Object.values(sample.coords)) a.ok(values.every(Number.isFinite)) } } }
    ] },
  { id: 'R36', name: 'equal-size content update does not lay out or remeasure unrelated branches',
    observe: page => page.evaluate(async () => {
      const f = rendererFixture, data = f.wideLayered(60)
      data.children[0].children[0].data.fontFamily = 'monospace'
      data.children[0].children[0].data.text = 'AAAA'
      const mm = await f.create(data, { openPerformance: false })
      const before = f.coordinates(mm), c = f.counters()
      let layouts = 0
      const layout = mm.renderer.layout, original = layout.doLayout
      layout.doLayout = function (...args) { layouts++; return original.apply(this, args) }
      const node = mm.renderer.findNodeByUid('b0l0')
      await f.waitRender(mm, () => mm.execCommand('SET_NODE_TEXT', node, 'BBBB'))
      await f.delay(100)
      const after = f.coordinates(mm)
      const unrelatedWrites = Object.entries(c.values.writesByUid).filter(([uid]) => !['root', 'b0', 'b0l0'].includes(uid)).reduce((sum, [, writes]) => sum + writes, 0)
      const dimensionsEqual = before.b0l0[2] === after.b0l0[2] && before.b0l0[3] === after.b0l0[3]
      const unrelatedStable = Object.keys(before).filter(uid => !['root', 'b0', 'b0l0'].includes(uid)).every(uid => JSON.stringify(before[uid]) === JSON.stringify(after[uid]))
      const metrics = { layouts, unrelatedWrites, measures: c.values.measures, dimensionsEqual, unrelatedStable, text: node.getData('text') }
      c.restore(); mm.destroy(); return metrics
    }), checks: [
      { name: 'fixed-size update leaves unrelated layout work at zero', assert: (x, a) => { a.equal(x.dimensionsEqual, true, 'test labels must have equal measured dimensions'); a.equal(x.layouts, 0); a.equal(x.unrelatedWrites, 0); a.ok(x.measures <= 3) } },
      { name: 'new text committed and unrelated final geometry stable', assert: (x, a) => { a.equal(x.text, 'BBBB'); a.equal(x.unrelatedStable, true) } }
    ] },
  { id: 'R37', name: 'structural edits collapse/expand undo and layout switch preserve source and geometry',
    observe: page => page.evaluate(async () => {
      const f = rendererFixture, data = f.wideLayered(5)
      data.children[0].data.customLeft = 900
      data.children[0].data.customTop = 100
      const mm = await f.create(data, { openPerformance: false })
      const parent = mm.renderer.findNodeByUid('b1')
      await f.waitRender(mm, () => mm.execCommand('SET_NODE_EXPAND', parent, false))
      const rawRetained = parent.nodeData.children.length
      await f.waitRender(mm, () => mm.execCommand('SET_NODE_EXPAND', parent, true))
      const beforeCount = Object.keys(mm.renderer.nodeCache).length
      await f.waitRender(mm, () => mm.execCommand('INSERT_CHILD_NODE', false, [parent], { text: 'Inserted', uid: 'inserted-test' }))
      const insertedCount = Object.keys(mm.renderer.nodeCache).length
      await f.waitRender(mm, () => mm.execCommand('BACK'))
      const undoCount = Object.keys(mm.renderer.nodeCache).length
      await f.waitRender(mm, () => mm.setLayout('mindMap'))
      const custom = mm.renderer.findNodeByUid('b0')
      const coords = f.coordinates(mm)
      const svg = mm.getSvgData().svg.svg()
      const result = { rawRetained, beforeCount, insertedCount, undoCount, custom: [custom.left, custom.top],
        finite: Object.values(coords).every(values => values.every(Number.isFinite)), hasRoot: svg.includes('Root'),
        paths: mm.lineDraw.node.querySelectorAll('path').length, activeLive: mm.renderer.activeNodeList.every(node => mm.renderer.findNodeByUid(node.getData('uid')) === node) }
      mm.destroy(); return result
    }), checks: [
      { name: 'source subtree and structural undo preserved', assert: (x, a) => { a.equal(x.rawRetained, 2); a.equal(x.insertedCount, x.beforeCount + 1); a.equal(x.undoCount, x.beforeCount) } },
      { name: 'custom position finite connectors export and selection preserved', assert: (x, a) => { a.deepEqual(x.custom, [900, 100]); a.equal(x.finite, true); a.equal(x.hasRoot, true); a.ok(x.paths > 0); a.equal(x.activeLive, true) } }
    ] }
]
cases.push({ id: 'R35', name: 'small layout golden preserves direction custom positions and compact routing',
  observe: page => page.evaluate(async () => {
    const f = rendererFixture, rows = []
    for (const layout of ['logicalStructure', 'logicalStructureLeft', 'mindMap']) {
      for (const compactLayout of [false, true]) {
        const data = f.wideLayered(4)
        data.children[1].data.customLeft = 880; data.children[1].data.customTop = 180
        const mm = await f.create(data, { layout, compactLayout, openPerformance: false })
        rows.push({ layout, compactLayout, coords: f.coordinates(mm) }); mm.destroy()
      }
    }
    return rows
  }), checks: [{ name: 'coordinates match baseline real renderer', assert: (x,a) => a.deepEqual(x, require('./layout-golden.json')) }]
})
cases.push({ id: 'R36', name: 'width-only leaf resize updates its necessary range',
  observe: page => page.evaluate(async () => {
    const f = rendererFixture, data = f.wideLayered(60)
    data.children[0].children[0].data.fontFamily = 'monospace'
    data.children[0].children[0].data.text = 'AAAA'
    const mm = await f.create(data, { openPerformance: false, compactLayout: false })
    const before = f.coordinates(mm), c = f.counters(), node = mm.renderer.findNodeByUid('b0l0')
    await f.waitRender(mm, () => mm.execCommand('SET_NODE_TEXT', node, 'BBBBBBBBBBBB'))
    const after = f.coordinates(mm)
    const unrelatedWrites = Object.entries(c.values.writesByUid).filter(([uid]) => !['root','b0','b0l0'].includes(uid)).reduce((sum,[,count])=>sum+count,0)
    const result = { unrelatedWrites, heightEqual: before.b0l0[3] === after.b0l0[3],
      widthChanged: before.b0l0[2] !== after.b0l0[2],
      unrelatedStable: Object.keys(before).filter(uid=>!['root','b0','b0l0'].includes(uid)).every(uid=>JSON.stringify(before[uid])===JSON.stringify(after[uid])) }
    c.restore(); mm.destroy(); return result
  }), checks: [
    { name: 'width-only leaf does not reposition unrelated branches', assert: (x,a) => { a.equal(x.heightEqual,true); a.equal(x.widthChanged,true); a.equal(x.unrelatedStable,true); a.equal(x.unrelatedWrites,0) } }
  ]
})
module.exports = cases
if (require.main === module) runCases('layout', cases)
