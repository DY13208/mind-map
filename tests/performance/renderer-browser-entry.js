import MindMap from '../../simple-mind-map/index.js'
import MindMapNode from '../../simple-mind-map/src/core/render/node/MindMapNode.js'
import Export from '../../simple-mind-map/src/plugins/Export.js'
import AssociativeLine from '../../simple-mind-map/src/plugins/AssociativeLine.js'
import ViewportIndex from '../../simple-mind-map/src/utils/viewportIndex.js'
MindMap.usePlugin(Export)

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
function waitRender(mm, action) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { mm.off('node_tree_render_end', done); reject(new Error('real renderer timeout')) }, 30000)
    const done = () => { clearTimeout(timeout); mm.off('node_tree_render_end', done); resolve() }
    mm.on('node_tree_render_end', done)
    action()
  })
}

async function create(data, options = {}) {
  const el = document.createElement('div')
  el.style.cssText = 'width:1100px;height:700px;position:relative;overflow:hidden'
  document.body.appendChild(el)
  const mm = new MindMap({ el, data, layout: 'logicalStructure', fit: false, openPerformance: true,
    openRealtimeRenderOnNodeTextEdit: false, addHistoryTime: 0, createNewNodeBehavior: 'NOT_ACTIVE',
    ...options })
  await waitRender(mm, () => mm.render())
  await delay(60)
  return mm
}

function sparseViewportTree(n) {
  const root = { data: { uid: 'root', text: 'Root', expand: true, customLeft: 4000, customTop: 4000 }, children: [] }
  for (let i = 0; i < n - 1; i++) root.children.push({ data: { uid: `n${i}`, text: 'Leaf', expand: true,
    customLeft: i < 4 ? 150 + i * 120 : 4500 + i,
    customTop: i < 4 ? 250 : 4500 + i }, children: [] })
  return root
}

function wideLayered(k) {
  return { data: { uid: 'root', text: 'Root', expand: true, fontFamily: 'Arial' }, children:
    Array.from({ length: k }, (_, i) => ({ data: { uid: `b${i}`, text: 'Branch', expand: true, fontFamily: 'Arial' }, children:
      [0, 1].map(j => ({ data: { uid: `b${i}l${j}`, text: 'Leaf', expand: true, fontFamily: 'Arial' }, children: [] })) })) }
}

function counters() {
  const values = { renders: 0, lines: 0, measures: 0, writes: 0, writesByUid: {} }
  const restorers = []
  for (const [name, counter] of [['render', 'renders'], ['renderLine', 'lines'], ['getSize', 'measures']]) {
    const original = MindMapNode.prototype[name]
    MindMapNode.prototype[name] = function (...args) { values[counter]++; return original.apply(this, args) }
    restorers.push(() => { MindMapNode.prototype[name] = original })
  }
  for (const name of ['left', 'top']) {
    const descriptor = Object.getOwnPropertyDescriptor(MindMapNode.prototype, name)
    Object.defineProperty(MindMapNode.prototype, name, { ...descriptor,
      set(value) {
        values.writes++
        values.writesByUid[this.uid] = (values.writesByUid[this.uid] || 0) + 1
        descriptor.set.call(this, value)
      }
    })
    restorers.push(() => Object.defineProperty(MindMapNode.prototype, name, descriptor))
  }
  return { values, reset() { values.renders = values.lines = values.measures = values.writes = 0; values.writesByUid = {} }, restore() { restorers.reverse().forEach(fn => fn()) } }
}

function coordinates(mm) {
  return Object.fromEntries(Object.values(mm.renderer.nodeCache).map(node => [node.getData('uid'),
    [node.left, node.top, node.width, node.height].map(value => Math.round(value * 1000) / 1000)]))
}

function intersections(mm) {
  const view = mm.el.getBoundingClientRect()
  const paths = Array.from(mm.lineDraw.node.querySelectorAll('path'))
  let inside = 0, outside = 0
  for (const item of paths) {
    const rect = item.getBoundingClientRect()
    if (rect.right >= view.left && rect.left <= view.right && rect.bottom >= view.top && rect.top <= view.bottom) inside++
    else outside++
  }
  return { inside, outside, paths: paths.length }
}

window.rendererFixture = { MindMap, MindMapNode, AssociativeLine, ViewportIndex, create, waitRender, delay, sparseViewportTree, wideLayered, counters, coordinates, intersections }
