import MindMap from '../../simple-mind-map/index.js'
import RichText from '../../simple-mind-map/src/plugins/RichText.js'
import Formula from '../../simple-mind-map/src/plugins/Formula.js'
import MindMapNode from '../../simple-mind-map/src/core/render/node/MindMapNode.js'

// RichText is registered lazily per page so the plain scenarios really stay
// non-rich (a global registration would let RichText.handleDataToRichTextOnInit
// normalize every plain fixture into richText before geometry is captured).
let richReady = false
function ensureRich () {
  if (!richReady) {
    MindMap.usePlugin(RichText).usePlugin(Formula)
    richReady = true
  }
}

const IMG = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
function waitRender (mm, action) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { mm.off('node_tree_render_end', done); reject(new Error('geometry render timeout')) }, 20000)
    const done = () => { clearTimeout(timer); mm.off('node_tree_render_end', done); resolve() }
    mm.on('node_tree_render_end', done)
    action()
  })
}
async function create (data, options = {}) {
  const el = document.createElement('div')
  el.style.cssText = 'width:1100px;height:700px;position:relative;overflow:hidden'
  document.body.appendChild(el)
  const mm = new MindMap({ el, data, layout: 'logicalStructure', fit: false, openPerformance: false,
    openRealtimeRenderOnNodeTextEdit: false, addHistoryTime: 0, maxHistoryCount: 100, createNewNodeBehavior: 'NOT_ACTIVE', ...options })
  await waitRender(mm, () => mm.render())
  await delay(40)
  return mm
}
function round (value) { return Math.round(value * 1000) / 1000 }
// Model coordinates plus exact SVG group markup (transform string, foreignObject
// size, shape transform, nested groups) so changed translate/centering cannot
// hide behind rounded numbers.
function geometry (mm) {
  const out = {}
  for (const uid of Object.keys(mm.renderer.nodeCache)) {
    const node = mm.renderer.nodeCache[uid]
    const group = node.group && node.group.node
    if (!group) continue
    out[uid] = { left: round(node.left), top: round(node.top), width: round(node.width), height: round(node.height), html: group.outerHTML }
  }
  return out
}
function plainTree () {
  return { data: { uid: 'root', text: 'Root', expand: true }, children: [
    { data: { uid: 'plain', text: 'Plain text' }, children: [] },
    { data: { uid: 'multi', text: 'line one\nline two' }, children: [] },
    { data: { uid: 'icon', text: 'With icon', icon: ['priority_1'] }, children: [] },
    { data: { uid: 'tag-bottom', text: 'Bottom tag', tag: ['alpha', 'beta'], tagPlacement: 'bottom' }, children: [] },
    { data: { uid: 'img-top', text: 'Img top', image: IMG, imageSize: { width: 10, height: 10, custom: true }, imgPlacement: 'top' }, children: [] },
    { data: { uid: 'img-bottom', text: 'Img bottom', image: IMG, imageSize: { width: 10, height: 10, custom: true }, imgPlacement: 'bottom' }, children: [] },
    { data: { uid: 'img-left', text: 'Img left', image: IMG, imageSize: { width: 10, height: 10, custom: true }, imgPlacement: 'left' }, children: [] },
    { data: { uid: 'img-right', text: 'Img right', image: IMG, imageSize: { width: 10, height: 10, custom: true }, imgPlacement: 'right' }, children: [] }
  ] }
}
function richTree () {
  return { data: { uid: 'root', text: 'Root', expand: true }, children: [
    { data: { uid: 'rich-1', text: '<p><strong>Bold</strong> <em>italic</em></p>', richText: true }, children: [] },
    { data: { uid: 'rich-2', text: '<p>rich<br>multi</p>', richText: true }, children: [
      { data: { uid: 'rich-child', text: '<p>child</p>', richText: true }, children: [] }
    ] }
  ] }
}
// Degenerate rich content edges that must keep identical geometry after the
// _rectInfo fast path replaces the DOM bbox.
function edgeTree () {
  return { data: { uid: 'root', text: 'Root', expand: true }, children: [
    { data: { uid: 'empty', text: '', richText: true }, children: [] },
    { data: { uid: 'p-empty', text: '<p></p>', richText: true }, children: [] },
    { data: { uid: 'p-br', text: '<p><br></p>', richText: true }, children: [] },
    { data: { uid: 'spaces', text: '   ', richText: true }, children: [] }
  ] }
}
window.rtGeometry = {
  MindMap, MindMapNode, delay, waitRender, create, geometry, plainTree, richTree, edgeTree,
  async scenario (name) {
    if (name === 'plain' || name === 'extras') {
      // No RichText registration on this page: these nodes must remain plain.
      const options = name === 'extras'
        ? { createNodePrefixContent: () => ({ el: Object.assign(document.createElement('span'), { textContent: 'P' }), width: 18, height: 18 }),
            createNodePostfixContent: () => ({ el: Object.assign(document.createElement('span'), { textContent: 'Q' }), width: 18, height: 18 }) }
        : {}
      const mm = await create(plainTree(), options)
      const snapshot = geometry(mm)
      const allRich = Object.values(mm.renderer.nodeCache).every(node => node.getData('richText') !== true)
      mm.destroy()
      return { allPlain: allRich, geometry: snapshot }
    }
    if (name === 'rich') {
      ensureRich()
      const mm = await create(richTree())
      const snapshot = geometry(mm)
      mm.destroy()
      return { geometry: snapshot }
    }
    if (name === 'empty-edges' || name === 'wrap-zero') {
      ensureRich()
      const mm = await create(edgeTree(), name === 'wrap-zero' ? { textAutoWrapWidth: 0 } : {})
      const snapshot = geometry(mm)
      const textAutoWrapWidth = mm.opt.textAutoWrapWidth
      mm.destroy()
      return { geometry: snapshot, textAutoWrapWidth }
    }
    if (name === 'transform') {
      ensureRich()
      const mm = await create(richTree())
      const target = mm.renderer.findNodeByUid('rich-child')
      // Give it a real rotate+skew, then force the product's own translate path
      // (position change) so matrix a/b/c/d must survive and only e/f shift.
      target.group.transform({ rotate: 25, skewX: 10, ox: 0, oy: 0 })
      const before = target.group.node.getAttribute('transform')
      target._left = target._left + 25
      target.update()
      await delay(30)
      const after = target.group.node.getAttribute('transform')
      await waitRender(mm, () => mm.render())
      const first = geometry(mm)
      await waitRender(mm, () => mm.render())
      const second = geometry(mm)
      const parsed = after && after.match(/matrix\(([^)]+)\)/)
      mm.destroy()
      return { before, after, matrix: parsed ? parsed[1] : null, first, second }
    }
    if (name === 'reattach') {
      ensureRich()
      const mm = await create(richTree())
      const node = mm.renderer.findNodeByUid('rich-1')
      const saved = node.group.node
      saved.parentNode.removeChild(saved)
      const detached = saved.parentNode === null
      await waitRender(mm, () => mm.render())
      const sameNode = node.group.node === saved
      const attached = saved.parentNode === mm.nodeDraw.node
      const snapshot = geometry(mm)
      mm.destroy()
      return { detached, sameNode, attached, geometry: snapshot }
    }
    throw new Error('unknown scenario ' + name)
  }
}
