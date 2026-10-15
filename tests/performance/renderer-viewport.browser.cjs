const { runCases } = require('./renderer-runner.cjs')

const cases = [
  { id: 'R32', name: 'fixed visible graph does not traverse every expanded offscreen node on pan',
    observe: page => page.evaluate(async () => {
      const f = rendererFixture, samples = []
      for (const n of [200, 1000]) {
        const mm = await f.create(f.sparseViewportTree(n)), c = f.counters()
        let layouts = 0
        const original = mm.renderer.layout.doLayout
        mm.renderer.layout.doLayout = function (...args) { layouts++; return original.apply(this, args) }
        await f.waitRender(mm, () => mm.view.translateXY(20, 0))
        await f.delay(100)
        samples.push({ n, ...c.values, layouts, edges: f.intersections(mm), attached: mm.nodeDraw.node.querySelectorAll('.smm-node').length })
        c.restore(); mm.destroy()
      }
      return samples
    }), checks: [
      { name: 'pan only renders bounded visible candidates', assert: (x, a) => { a.ok(x[1].renders <= 40, `pan visited ${x[1].renders} of ${x[1].n} nodes`); a.ok(x[1].lines <= 40, `pan processed ${x[1].lines} lines`); a.equal(x[1].layouts, 0) } },
      { name: 'fixture has sparse actual visible content at both sizes', assert: (x, a) => { a.ok(x[0].attached <= 10); a.ok(x[1].attached <= 10) } }
    ] },
  { id: 'R33', name: 'cross-viewport edge survives while fully outside paths detach and re-enter',
    observe: page => page.evaluate(async () => {
      const f = rendererFixture
      const mm = await f.create({ data: { uid: 'root', text: 'Root', expand: true, customLeft: -500, customTop: 300 }, children: [
        { data: { uid: 'cross', text: 'Cross', customLeft: 1800, customTop: 300 }, children: [] },
        { data: { uid: 'outside', text: 'Outside', customLeft: 600, customTop: 2000 }, children: [] }
      ] })
      const before = f.intersections(mm)
      await f.waitRender(mm, () => mm.view.translateXY(0, -1500))
      const entered = f.intersections(mm)
      await f.waitRender(mm, () => mm.view.translateXY(0, 1500))
      const restored = f.intersections(mm)
      mm.destroy()
      return { before, entered, restored }
    }), checks: [
      { name: 'paths crossing viewport remain but fully outside paths are not attached', assert: (x, a) => { a.ok(x.before.inside >= 1); a.equal(x.before.outside, 0) } },
      { name: 're-entry preserves crossing edge', assert: (x, a) => { a.ok(x.entered.inside >= 1); a.equal(x.entered.outside, 0); a.ok(x.restored.inside >= 1); a.equal(x.restored.outside, 0) } }
    ] },
  { id: 'R34', name: 'destroy cancels pending render generations instead of reviving or throwing',
    observe: page => page.evaluate(async () => {
      const f = rendererFixture, errors = []
      const capture = event => { errors.push(event.message); event.preventDefault() }
      window.addEventListener('error', capture)
      const mm = await f.create(f.wideLayered(50))
      const host = mm.el
      mm.setData(f.wideLayered(300))
      mm.destroy()
      await f.delay(1000)
      window.removeEventListener('error', capture)
      return { errors, revived: host.querySelectorAll('svg,.smm-node').length, pending: !!mm.renderer.renderTimer,
        retainedTree: !!mm.renderer.renderTree }
    }), checks: [
      { name: 'no late error or revived canvas after destroy', assert: (x, a) => { a.deepEqual(x.errors, []); a.equal(x.revived, 0) } },
      { name: 'pending model and timer released', assert: (x, a) => { a.equal(x.retainedTree, false); a.equal(x.pending, false) } }
    ] }
]
cases.push({ id: 'R33', name: 'a visible summary remains a live model even when its owner is outside',
  observe: page => page.evaluate(async () => {
    const f = rendererFixture
    const mm = await f.create({ data: { uid: 'root', text: 'Root', expand: true, customLeft: -900, customTop: 300 }, children: [
      { data: { uid: 'owner', text: 'Owner', expand: true, customLeft: -700, customTop: 300,
        generalization: [{ uid: 'visible-summary', text: 'Summary', customLeft: 250, customTop: 300 }] }, children: [
        { data: { uid: 'leaf', text: 'Leaf', customLeft: -500, customTop: 300 }, children: [] }
      ] }
    ] })
    const summary = mm.renderer.findNodeByUid('visible-summary')
    const initiallyVisible = !!(summary && summary.group && summary.group.node.isConnected)
    if (summary) mm.renderer.activeMultiNode([summary])
    await f.waitRender(mm, () => mm.view.translateXY(20, 0))
    const live = mm.renderer.findNodeByUid('visible-summary')
    const result = { initiallyVisible, same: live === summary && !!summary,
      selected: !!(live && live.getData('isActive')), visible: !!(live && live.group && live.group.node.isConnected),
      rawSummary: mm.renderer.renderTree.children[0].data.generalization[0].uid,
      bracket: mm.renderer.findNodeByUid('owner')._generalizationList[0].generalizationLine.node.getAttribute('d') || '',
      bracketWidth: mm.renderer.findNodeByUid('owner')._generalizationList[0].generalizationLine.node.getBBox().width }
    mm.destroy(); return result
  }), checks: [{ name: 'summary visibility and selection survive outside owner', assert: (x,a) => {
    a.equal(x.initiallyVisible,true); a.equal(x.same,true); a.equal(x.selected,true); a.equal(x.visible,true); a.equal(x.rawSummary,'visible-summary'); a.ok(/[LQCHVS]/.test(x.bracket), 'summary needs a routed bracket, not the uninitialized M0 0 path')
  } }]
})
cases.push({ id: 'R36', name: 'local resize preserves detached edges for later viewport re-entry',
  observe: page => page.evaluate(async () => {
    const f = rendererFixture
    const mm = await f.create(f.wideLayered(200), { compactLayout: false })
    const outside = mm.renderer.findNodeByUid('b0')._lines[0]
    const initiallyDetached = !outside.node.isConnected
    await f.waitRender(mm, () => mm.renderer.findNodeByUid('b100l0').setText('Much wider leaf', false))
    await f.waitRender(mm, () => mm.view.translateXY(0, 10000))
    const result = { initiallyDetached, restored: outside.node.isConnected,
      paths: mm.lineDraw.node.querySelectorAll('path').length }
    mm.destroy(); return result
  }), checks: [{ name: 'model-owned culled connector survives index refresh', assert: (x,a) => {
    a.equal(x.initiallyDetached,true); a.equal(x.restored,true); a.ok(x.paths>10)
  } }]
})
cases.push({ id: 'R34', name: 'destroy discards lazy command and expand continuations',
  observe: page => page.evaluate(async () => {
    const f = rendererFixture, mm = await f.create(f.wideLayered(1))
    const leaf = mm.renderer.findNodeByUid('b0l0')
    let resolve, callbacks = 0, repairs = 0
    const pending = new Promise(done => { resolve = done })
    // The delayed hydration service is the boundary. Renderer continuations,
    // commands, instances and lifecycle are the real implementations.
    mm.cooperate = { nodeNeedsHydrate: () => true, hydrateLazyChildren: () => pending,
      hydrateTreeToLevel: () => pending, repairEmptyExpand: () => { repairs++ } }
    leaf.nodeData.data.childCount = 1
    mm.renderer.runAfterHydrate([leaf], () => { callbacks++ }, 'INSERT_CHILD_NODE')
    mm.renderer.hydrateThen(mm.renderer.renderTree, 2, {}, () => { callbacks++ })
    mm.renderer.setNodeExpand(leaf, true)
    mm.destroy(); resolve(); await f.delay(60)
    return { callbacks, repairs, retainedTree: !!mm.renderer.renderTree }
  }), checks: [{ name: 'destroyed renderer invokes neither callback nor repair', assert: (x,a) => {
    a.equal(x.callbacks,0); a.equal(x.repairs,0); a.equal(x.retainedTree,false)
  } }]
})
cases.push({ id: 'R36', name: 'custom left-side leaf resize keeps the incoming connector on its facing edge',
  observe: page => page.evaluate(async () => {
    const f = rendererFixture, mm = await f.create({ data: { uid: 'root', text: 'Parent', expand: true,
      customLeft: 500, customTop: 300 }, children: [{ data: { uid: 'left', text: 'AAAA', fontFamily: 'monospace',
      customLeft: 100, customTop: 300 }, children: [] }] }, { compactLayout: false })
    const node = mm.renderer.findNodeByUid('left')
    await f.waitRender(mm, () => node.setText('BBBBBBBBBBBB', false))
    const values = mm.renderer.root._lines[0].array()
    const end = values[values.length - 1]
    const result = { actualX: end[end.length - 2], expectedX: node.left + node.width,
      actualY: end[end.length - 1], expectedY: node.top + node.height / 2 }
    mm.destroy(); return result
  }), checks: [{ name: 'incoming endpoint follows the resized actual custom position', assert: (x,a) => {
    a.equal(x.actualX,x.expectedX); a.equal(x.actualY,x.expectedY)
  } }]
})
cases.push({ id: 'R34', name: 'a normal same-layout render cancels old viewport frames',
  observe: page => page.evaluate(async () => {
    const f = rendererFixture
    const data = { data: { uid: 'old-root', text: 'Old', expand: true }, children: Array.from({length:1000},(_,i)=>({
      data: { uid: 'old-'+i, text: 'Old', customLeft: 50+(i%40)*25, customTop: 50+Math.floor(i/40)*20 }, children: [] })) }
    const mm = await f.create(data, {compactLayout:false})
    let started = false, staleCalls = 0
    const original = f.MindMapNode.prototype.render
    f.MindMapNode.prototype.render = function(...args) {
      if (started && String(this.uid).startsWith('old-')) staleCalls++
      return original.apply(this,args)
    }
    mm.on('node_tree_render_start', () => { started=true })
    const painting = mm.renderer.paintViewport()
    const next = f.wideLayered(700); next.data.uid = 'new-root'
    await f.waitRender(mm, () => mm.setData(next))
    await painting; await f.delay(50)
    const ghosts = mm.nodeDraw.node.querySelectorAll('[data-uid^="old-"]').length
    f.MindMapNode.prototype.render = original
    mm.destroy(); return { staleCalls, ghosts }
  }), checks: [{ name: 'old frames neither render stale instances nor revive old groups', assert: (x,a) => {
    a.equal(x.staleCalls,0); a.equal(x.ghosts,0)
  } }]
})
cases.push({ id: 'R32', name: 'zoomed partially visible node uses scaled dimensions for visibility',
  observe: page => page.evaluate(async () => {
    const f = rendererFixture, mm = await f.create({ data: { uid: 'root', text: 'Root', expand: true }, children: [
      { data: { uid: 'partial', text: 'MMMMMMMMMMMMMMMM', fontFamily: 'monospace', fontSize:20,
        customLeft:-120, customTop:100 }, children: [] }
    ] })
    const node = mm.renderer.findNodeByUid('partial')
    await f.waitRender(mm, () => mm.view.setTransformData({ state:{scale:2,x:0,y:0,sx:0,sy:0},
      transform:{scaleX:2,scaleY:2,translateX:0,translateY:0} }))
    const result = { actualRight: (node.left+node.width)*2, left:node.left*2,
      visible:!!(node.group && node.group.node.isConnected) }
    mm.destroy(); return result
  }), checks:[{ name:'partial scaled rectangle remains attached', assert:(x,a)=>{
    a.ok(x.actualRight>0 && x.left<0); a.equal(x.visible,true)
  }}]
})
cases.push({ id: 'R36', name: 'local width resize touches only necessary spatial bounds',
  observe: page => page.evaluate(async () => {
    const f=rendererFixture, mm=await f.create(f.wideLayered(200), {compactLayout:false})
    const descriptor=Object.getOwnPropertyDescriptor(f.MindMapNode.prototype,'left')
    const target=mm.renderer.findNodeByUid('b100l0')
    let unrelatedReads=0
    Object.defineProperty(f.MindMapNode.prototype,'left',{...descriptor,get(){
      if(this.uid!=='b100l0' && this.uid!=='b100' && this.uid!=='root') unrelatedReads++
      return descriptor.get.call(this)
    }})
    await f.waitRender(mm,()=>target.setText('A wider leaf',false))
    Object.defineProperty(f.MindMapNode.prototype,'left',descriptor)
    const result={unrelatedReads};mm.destroy();return result
  }),checks:[{name:'hot width resize does not rebuild the entire spatial index',assert:(x,a)=>a.ok(x.unrelatedReads<=20,`${x.unrelatedReads} unrelated position reads`)}]
})
cases.push({ id: 'R34', name: 'unchanged index refresh reuses path bounds without DOM measurement',
  observe: page => page.evaluate(async () => {
    const f=rendererFixture, mm=await f.create(f.sparseViewportTree(500))
    const probe=mm.renderer.root._lines.find(line=>line.node.isConnected).node
    let prototype=probe
    while(!Object.prototype.hasOwnProperty.call(prototype,'getBBox')) prototype=Object.getPrototypeOf(prototype)
    const original=prototype.getBBox
    let calls=0
    prototype.getBBox=function(...args){calls++;return original.apply(this,args)}
    probe.getBBox(); const probeCalls=calls; calls=0
    await mm.renderer.buildViewportIndex()
    prototype.getBBox=original
    mm.destroy();return {calls,probeCalls}
  }),checks:[{name:'stable path geometry causes zero repeated layout measurements',assert:(x,a)=>{a.equal(x.probeCalls,1);a.equal(x.calls,0)}}]
})
cases.push({ id: 'R36', name: 'underlined leaf resize refreshes the incoming line through its new width',
  observe: page => page.evaluate(async () => {
    const f=rendererFixture, mm=await f.create(f.wideLayered(1), {
      compactLayout:false, themeConfig:{nodeUseLineStyle:true,lineStyle:'direct'}
    })
    const node=mm.renderer.findNodeByUid('b0l0')
    await f.waitRender(mm,()=>node.setText('A much wider leaf',false))
    const values=node.parent._lines[0].array(), end=values[values.length-1]
    const result={enabled:mm.themeConfig.nodeUseLineStyle,actualX:end[end.length-2],expectedX:node.left+node.width}
    mm.destroy();return result
  }),checks:[{name:'underline endpoint follows the resized node width',assert:(x,a)=>{a.equal(x.enabled,true);a.equal(x.actualX,x.expectedX)}}]
})
cases.push({ id: 'R34', name: 'full paint spatial indexing yields before reading the entire graph',
  observe: page => page.evaluate(async () => {
    const f=rendererFixture, mm=await f.create(f.sparseViewportTree(500))
    const descriptor=Object.getOwnPropertyDescriptor(f.MindMapNode.prototype,'left')
    const original=mm.renderer.buildViewportIndex
    let indexing=false, reads=0, previousReads=0, maxReadsPerTurn=0, turns=0
    Object.defineProperty(f.MindMapNode.prototype,'left',{...descriptor,get(){
      if(indexing){
        reads++
        const start=performance.now();while(performance.now()-start<0.12){}
      }
      return descriptor.get.call(this)
    }})
    mm.renderer.buildViewportIndex=function(...args){
      indexing=true
      const value=original.apply(this,args)
      if(value && typeof value.then==='function')return value.finally(()=>{indexing=false})
      indexing=false;return value
    }
    const timer=setInterval(()=>{
      if(indexing){turns++;maxReadsPerTurn=Math.max(maxReadsPerTurn,reads-previousReads);previousReads=reads}
    },0)
    await f.waitRender(mm,()=>mm.render())
    maxReadsPerTurn=Math.max(maxReadsPerTurn,reads-previousReads)
    clearInterval(timer)
    Object.defineProperty(f.MindMapNode.prototype,'left',descriptor)
    mm.renderer.buildViewportIndex=original
    mm.destroy();return {turns,reads,maxReadsPerTurn}
  }),checks:[{name:'index collection gives pending input timers a turn within the work budget',assert:(x,a)=>{
    a.ok(x.reads>=500);a.ok(x.turns>=2,`input had ${x.turns} turns during ${x.reads} real bounds reads`)
    a.ok(x.maxReadsPerTurn<=100,`${x.maxReadsPerTurn} delayed reads in one task`)
  }}]
})
cases.push({ id: 'R33', name: 'association curve survives pan without rescanning the unchanged graph',
  observe: page => page.evaluate(async () => {
    const f=rendererFixture, data=f.sparseViewportTree(500)
    data.data.associativeLineTargets=['n450']
    data.children[450].data.customLeft=-500; data.children[450].data.customTop=300
    const mm=await f.create(data)
    mm.addPlugin(f.AssociativeLine); mm.associativeLine.renderAllLines()
    const originalLine=mm.associativeLine.lineList[0][0], before=originalLine.attr('d')
    let reads=0
    const original=f.MindMapNode.prototype.getData
    f.MindMapNode.prototype.getData=function(...args){reads++;return original.apply(this,args)}
    await f.waitRender(mm,()=>mm.view.translateXY(20,0))
    f.MindMapNode.prototype.getData=original
    const current=mm.associativeLine.lineList[0][0]
    const result={reads,same:current===originalLine,connected:current.node.isConnected,
      unchanged:current.attr('d')===before,curved:/C/.test(before)}
    mm.destroy();return result
  }),checks:[{name:'pure view updates preserve the routed relation without whole-model work',assert:(x,a)=>{
    a.equal(x.connected,true);a.equal(x.unchanged,true);a.equal(x.curved,true)
    a.equal(x.same,true);a.ok(x.reads<=100,`${x.reads} node data reads on pan`)
  }}]
})
cases.push({ id: 'R33', name: 'folding a branch removes its primary edges and keeps its raw subtree',
  observe: page => page.evaluate(async () => {
    const f=rendererFixture, mm=await f.create(f.wideLayered(4),{compactLayout:false})
    const branch=mm.renderer.findNodeByUid('b1'), paths=branch._lines.map(line=>line.node)
    await f.waitRender(mm,()=>mm.execCommand('SET_NODE_EXPAND',branch,false))
    const folded=paths.every(path=>!path.isConnected), raw=branch.nodeData.children.length
    await f.waitRender(mm,()=>mm.execCommand('SET_NODE_EXPAND',branch,true))
    mm.getSvgData()
    const reopened=mm.renderer.findNodeByUid('b1')._lines.every(line=>line.node.isConnected)
    mm.destroy();return {folded,raw,reopened}
  }),checks:[{name:'fold and explicit complete export do not retain ghost edges or lose children',assert:(x,a)=>{
    a.equal(x.folded,true);a.equal(x.raw,2);a.equal(x.reopened,true)
  }}]
})
cases.push({ id: 'R33', name: 'a thick connector whose stroke crosses the viewport is retained',
  observe: page => page.evaluate(async () => {
    const f=rendererFixture, mm=await f.create({data:{uid:'root',text:'Root',expand:true,customLeft:-300,customTop:100},children:[
      {data:{uid:'thick',text:'Leaf',customLeft:-40,customTop:350,lineWidth:100},children:[]}
    ]},{compactLayout:false,themeConfig:{lineStyle:'direct'},performanceConfig:{padding:0}})
    const path=mm.renderer.root._lines[0].node
    const connected=path.isConnected
    // Detached SVG getBBox is zero in Chrome. Use the explicit complete export
    // to obtain native geometric truth, after capturing the viewport result.
    mm.getSvgData()
    const box=path.getBBox(), stroke=Number(path.getAttribute('stroke-width'))
    const result={boxRight:box.x+box.width,stroke,strokeRight:box.x+box.width+stroke/2,connected}
    mm.destroy();return result
  }),checks:[{name:'conservative line bounds include the painted stroke width',assert:(x,a)=>{
    a.ok(x.stroke>=100);a.ok(x.boxRight<0);a.ok(x.strokeRight>0);a.equal(x.connected,true)
  }}]
})
cases.push({ id: 'R36', name: 'a leaf with only customLeft keeps its facing connector after width changes',
  observe: page => page.evaluate(async () => {
    const f=rendererFixture, mm=await f.create({data:{uid:'root',text:'Parent',expand:true,customLeft:500,customTop:300},children:[
      {data:{uid:'partial-left',text:'AAAA',fontFamily:'monospace',customLeft:100},children:[]}
    ]},{compactLayout:false})
    const node=mm.renderer.findNodeByUid('partial-left')
    await f.waitRender(mm,()=>node.setText('BBBBBBBBBBBB',false))
    const segments=mm.renderer.root._lines[0].array(), end=segments[segments.length-1]
    const result={partial:node.customLeft!==undefined && node.customTop===undefined,
      actualX:end[end.length-2],expectedX:node.left+node.width}
    mm.destroy();return result
  }),checks:[{name:'single-axis custom position uses a correct connector refresh',assert:(x,a)=>{a.equal(x.partial,true);a.equal(x.actualX,x.expectedX)}}]
})
cases.push({ id: 'R32', name: 'hidden floating-theme connectors do not become visible viewport candidates',
  observe: page => page.evaluate(async () => {
    const f=rendererFixture, data=f.sparseViewportTree(201)
    data.children.forEach((node,index)=>Object.assign(node.data,{isFloating:true,customLeft:9000+index,customTop:9000+index}))
    const mm=await f.create(data,{compactLayout:false})
    await f.waitRender(mm,()=>mm.view.translateXY(10,0))
    const result={modelChildren:mm.renderer.renderTree.children.length,
      allocated:mm.renderer.root._lines.length,
      hidden:mm.renderer.root._lines.filter(line=>line.node.style.display==='none').length,
      candidateEdges:mm.renderer._visibleViewportEdges.size}
    mm.destroy();return result
  }),checks:[{name:'invisible model lines stay out of the viewport edge work set',assert:(x,a)=>{
    a.equal(x.modelChildren,200);a.equal(x.allocated,200);a.equal(x.hidden,200);a.equal(x.candidateEdges,0)
  }}]
})
cases.push({ id: 'R34', name: 'destroy releases the cached selection array after genuine activation',
  observe: page => page.evaluate(async () => {
    const f=rendererFixture, mm=await f.create(f.wideLayered(4),{compactLayout:false})
    const renderer=mm.renderer
    const node=renderer.findNodeByUid('b1l0')
    renderer.activeMultiNode([node])
    const before={active:renderer.activeNodeList.length,cached:renderer._activeIndexList.length,
      contains:renderer._activeIndexList.includes(node)}
    mm.destroy()
    return {before,after:{active:renderer.activeNodeList.length,cached:renderer._activeIndexList.length,
      contains:renderer._activeIndexList.includes(node),index:renderer._activeNodeIndexes.size,
      cachedUids:renderer._activeIndexList.map(item=>item.uid)}}
  }),checks:[{name:'retired renderer has no selected instance references in its cached array',assert:(x,a)=>{
    a.equal(x.before.active,1);a.equal(x.before.cached,1);a.equal(x.before.contains,true)
    a.equal(x.after.active,0);a.equal(x.after.index,0);a.equal(x.after.cached,0);a.equal(x.after.contains,false)
  }}]
})
cases.push({ id: 'R34', name: 'packed index build gives the event loop a real turn and cancels mid-build',
  observe: page => page.evaluate(async () => {
    const V = rendererFixture.ViewportIndex
    const items = []
    for (let i = 0; i < 20000; i++) { const x = (i * 137) % 4000, y = (i * 89) % 3000; items.push({ node: { i }, bounds: { left: x, top: y, right: x + 40, bottom: y + 20 } }) }
    const bruteFor = v => items.filter(it => it.bounds.left <= v.right && it.bounds.right >= v.left && it.bounds.top <= v.bottom && it.bounds.bottom >= v.top).length
    let turns = 0
    const timer = setInterval(() => { turns++ }, 0)
    const index = await V.create(items)
    clearInterval(timer)
    let equivalent = true
    for (const v of [{ left: 0, top: 0, right: 300, bottom: 300 }, { left: 1500, top: 1200, right: 2000, bottom: 1600 }, { left: 3800, top: 2800, right: 4000, bottom: 3000 }]) {
      if (index.query(v).length !== bruteFor(v)) equivalent = false
    }
    // Cancel after several processed chunks: create must return null.
    let checks = 0
    const cancelledIndex = await V.create(items, { cancelled: () => { checks++; return checks > 3 } })
    return { turns, leaves: index.leaves.size, equivalent, cancelChecks: checks, cancelled: cancelledIndex === null ? 'null' : 'not-null' }
  }), checks: [
    { name: 'a large packed build gives the event loop real turns and stays query-equivalent to brute force', assert: (x, a) => { a.equal(x.leaves, 20000); a.equal(x.equivalent, true); a.ok(x.turns >= 1, 'input had ' + x.turns + ' turns') } },
    { name: 'a build cancelled after some items returns null and publishes nothing', assert: (x, a) => { a.ok(x.cancelChecks >= 2, 'cancel checked ' + x.cancelChecks); a.equal(x.cancelled, 'null') } }
  ]
})
cases.push({ id: 'R34', name: 'a layout render performs no redundant SVG path writes for unchanged connectors',
  observe: page => page.evaluate(async () => {
    const f = rendererFixture
    const svgProto = window.SVGElement.prototype
    const origSetAttr = svgProto.setAttribute
    let dWrites = 0, noopDWrites = 0
    svgProto.setAttribute = function (name, value) { if (name === 'd') { dWrites++; if (this.getAttribute('d') === String(value)) noopDWrites++ } return origSetAttr.call(this, name, value) }
    let result
    try {
      const mm = await f.create(f.sparseViewportTree(2000))
      const createDWrites = dWrites
      noopDWrites = 0
      await f.delay(100)
      const owner = mm.renderer.nodeCache.n0
      const target = owner.getData('expand') !== false ? false : true
      await f.waitRender(mm, () => mm.execCommand('SET_NODE_EXPAND', owner, target))
      result = { createDWrites, layoutDWrites: dWrites - createDWrites, layoutNoopDWrites: noopDWrites }
      mm.destroy()
    } finally { svgProto.setAttribute = origSetAttr }
    return result
  }), checks: [
    { name: 'the initial build writes connector paths (instrumentation is exercised)', assert: (x, a) => { a.ok(x.createDWrites >= 1, 'no path writes observed during initial build') } },
    { name: 'a layout pass does not rewrite unchanged connector paths', assert: (x, a) => { a.equal(x.layoutNoopDWrites, 0, x.layoutNoopDWrites + ' redundant path writes in the layout pass') } }
  ]
})
cases.push({ id: 'R34', name: 'a live path rewritten outside the helper is restored even when the requested path is unchanged',
  observe: page => page.evaluate(async () => {
    const f = rendererFixture
    const mm = await f.create(f.sparseViewportTree(50))
    await f.delay(50)
    const root = mm.renderer.nodeCache.root
    const line = root._lines[0]
    const original = line.attr('d')
    line.attr('d', 'M 0,0')
    const mutated = line.attr('d')
    root.renderLine(true)
    const restored = line.attr('d')
    mm.destroy()
    return { original, mutated, restored, restoredMatches: restored === original && mutated !== original }
  }), checks: [
    { name: 'external d mutation is repaired on the next layout pass', assert: (x, a) => { a.ok(!!x.original); a.equal(x.mutated, 'M 0,0'); a.equal(x.restoredMatches, true, 'restored=' + x.restored) } }
  ]
})
module.exports = cases
if (require.main === module) runCases('viewport', cases)
