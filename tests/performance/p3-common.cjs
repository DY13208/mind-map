// Shared browser entry pieces for P3 partial-layout tests (isolated harness, real engine code).
const ENTRY_COMMON = `
import MindMap from './simple-mind-map/index.js'
import Base from './simple-mind-map/src/layouts/Base.js'
import LogicalStructure from './simple-mind-map/src/layouts/LogicalStructure.js'
import MindMapNode from './simple-mind-map/src/core/render/node/MindMapNode.js'
const now = () => performance.now()
const sleep = ms => new Promise(r => setTimeout(r, ms))
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 } }
function text(i) {
  if (i % 7 === 0) return '这是一个较长的需求节点标题，用于覆盖自动换行与文本测量 #' + i
  if (i % 3 === 0) return '任务 ' + i + ' 评审与排期'
  return '节点 ' + i
}
function makeExpandedTree(n) {
  let id = 0
  const mk = () => { const i = id++; return { data: { uid: 'n' + i, text: text(i), expand: true }, children: [] } }
  const root = mk(); root.data.text = '根节点'
  const q = [root]
  while (id < n) {
    const cur = q.shift(); const fan = cur === root ? 12 : 8
    for (let i = 0; i < fan && id < n; i++) { const c = mk(); cur.children.push(c); q.push(c) }
  }
  return root
}
function makeRandomTree(n, r) {
  let id = 0
  const mk = () => { const i = id++; return { data: { uid: 'n' + i, text: r() < 0.2 ? text(7) + i : text(i), expand: r() > 0.1 }, children: [] } }
  const root = mk(); root.data.expand = true
  const all = [root]
  while (id < n) { const p = all[Math.floor(r() * all.length)]; const c = mk(); p.children.push(c); all.push(c) }
  return root
}
function makeChain(depth) {
  const root = { data: { uid: 'n0', text: 'chain', expand: true }, children: [] }
  let cur = root
  for (let i = 1; i < depth; i++) { const c = { data: { uid: 'n' + i, text: text(i), expand: true }, children: [] }; cur.children.push(c); cur = c; if (i % 5 === 0) cur.children.push({ data: { uid: 's' + i, text: 'side ' + i, expand: true }, children: [] }) }
  return root
}
const hosts = []
async function create(data, flags, extra) {
  const host = document.createElement('div')
  host.style.cssText = 'width:1200px;height:800px;position:relative;overflow:hidden'
  document.body.appendChild(host); hosts.push(host)
  const mm = new MindMap({
    el: host, data: JSON.parse(JSON.stringify(data)), layout: 'logicalStructure', compactLayout: false, fit: false,
    openPerformance: true, openRealtimeRenderOnNodeTextEdit: false, addHistoryTime: 0,
    createNewNodeBehavior: 'NOT_ACTIVE', errorHandler: (t, e) => { window.__errs = window.__errs || []; window.__errs.push(t + ':' + (e && e.message)) },
    performanceFlags: flags || {}, ...(extra || {})
  })
  await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('init timeout')), 300000); mm.on('render_complete', function f() { clearTimeout(t); mm.off('render_complete', f); res() }) })
  await settle(mm)
  return mm
}
function destroyAll(list) { list.forEach(m => { try { m.destroy() } catch (e) {} }); hosts.splice(0).forEach(h => h.remove()) }
async function waitRender(mm, action) {
  await new Promise((resolve, reject) => {
    let settled = false
    const t = setTimeout(() => { if (!settled) reject(new Error('render timeout')) }, 180000)
    const done = () => { if (settled) return; settled = true; clearTimeout(t); mm.off('render_complete', done); resolve() }
    mm.on('render_complete', done)
    action()
    setTimeout(() => { if (!settled && !mm.renderer.isRendering && !mm.renderer.renderTimer) done() }, 80)
  })
}
async function settle(mm) {
  for (let i = 0; i < 200 && (mm.renderer.isRendering || mm.renderer.renderTimer); i++) await sleep(10)
  await sleep(20)
}
const byUid = (mm, uid) => { const r = mm.renderer.findNodeByUid(uid) || Array.from(mm.renderer.nodeIndex.values()).find(n => n.getData('uid') === uid); return r }
const plStats = mm => JSON.parse(JSON.stringify(mm.renderer._plStats || { partial: 0, full: 0, fallback: {} }))
`
module.exports = { ENTRY_COMMON }
