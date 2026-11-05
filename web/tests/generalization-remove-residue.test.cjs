/**
 * 「点概要删除后会留一个边框」回归测试。
 *
 * 现象：删掉概要（那个带边框的「概要」框）后，画布上残留一个空的框/括号线。
 *
 * 三个原因：
 * ① removeGeneralization 原先的兜底清理条件写反了：
 *      if (!this.isGeneralization && this.generalizationBelongNode)
 *    普通节点没有 generalizationBelongNode（它只挂在概要节点上），
 *    概要节点的 isGeneralization 又是 true —— 两个条件互斥，永远为假，
 *    这段「清残留」的 hack 从来没执行过。
 * ② 清理只按 _generalizationList 里的引用删；引用一丢（重建/复用中 item
 *    被替换）就留下孤儿 SVG 元素。连线原本也没有类名，无法按类名兜底。
 * ③ removeCurrentNode 的概要分支漏了 removeNodeFromActiveList（removeNode
 *    里有），概要节点留在 activeNodeList 里，下次渲染又被画成激活态边框。
 */
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const results = []
function check(name, ok, extra = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`)
}

const ROOT = path.join(__dirname, '../../simple-mind-map/src')
const raw = fs.readFileSync(path.join(ROOT, 'core/render/node/nodeGeneralization.js'), 'utf8')
const source = raw.replace(/^import .*$/gm, '').replace(/^export default /m, 'module.exports = ')

// ---- 极简 SVG 容器桩：记录 add 过什么、按类名 find 得到什么 ----
class FakeEl {
  constructor(cls = '') {
    this.classes = new Set(cls ? [cls] : [])
    this.removed = false
    this.node = {}
  }
  addClass(c) {
    String(c).split(/\s+/).filter(Boolean).forEach(x => this.classes.add(x))
    return this
  }
  hasClass(c) {
    return this.classes.has(c)
  }
  remove() {
    this.removed = true
    return this
  }
  plot() { return this }
  show() { return this }
  hide() { return this }
  attr() { return this }
  size() { return this }
  x() { return this }
  y() { return this }
}

class FakeDraw {
  constructor() { this.children = [] }
  add(el) { this.children.push(el); return this }
  path() { const el = new FakeEl(); this.children.push(el); return el }
  find(selector) {
    const cls = String(selector).replace(/^\./, '')
    const hits = this.children.filter(el => !el.removed && el.hasClass(cls))
    return { remove: () => { hits.forEach(el => { el.removed = true }); return hits } }
  }
}

// generalizationNode 桩
class FakeNode {
  constructor(uid) {
    this.uid = uid
    this.group = null
    this.style = { onRemove: () => {} }
    this.removed = false
  }
  getData(key) {
    if (key === undefined) return { uid: this.uid }
    return key === 'uid' ? this.uid : undefined
  }
  remove() { this.removed = true }
}

const sandbox = {
  module: { exports: {} },
  console,
  MindMapNode: FakeNode,
  createUid: () => 'gen-' + Math.random().toString(36).slice(2, 8),
  collabGeneralization: require(path.join(ROOT, 'utils/collabGeneralization.js'))
}
vm.runInNewContext(source, sandbox)
const api = sandbox.module.exports

function makeOwner(uid) {
  const owner = Object.create(FakeNode.prototype)
  owner.uid = uid
  owner.isGeneralization = false
  owner.generalizationBelongNode = null
  owner.nodeDraw = new FakeDraw()
  owner.lineDraw = new FakeDraw()
  owner._generalizationList = []
  owner._generalizationSig = ''
  owner.getData = key => {
    if (key === undefined) return { uid }
    return key === 'uid' ? uid : undefined
  }
  owner.renderer = {
    nodeCache: {},
    lastNodeCache: {},
    layout: { lru: { delete: () => {} } },
    unregisterNodeIndex: () => {},
    removeNodeFromActiveList: () => {},
    registerNodeIndex: () => {}
  }
  return owner
}

// ---- 1. 正常路径：引用都在，元素被移除 ----
{
  const owner = makeOwner('owner-1')
  const genEl = new FakeEl()
  genEl.addClass('generalization_owner-1')
  owner.nodeDraw.add(genEl)
  const lineEl = owner.lineDraw.path()
  const genNode = new FakeNode('gen-1')
  owner._generalizationList = [{ generalizationNode: genNode, generalizationLine: lineEl }]

  api.removeGeneralization.call(owner)
  check('正常路径：概要节点实例被 remove', genNode.removed === true)
  check('正常路径：概要 group 被移除', genEl.removed === true)
  check('正常路径：括号线被移除', lineEl.removed === true)
  check('正常路径：_generalizationList 清空', owner._generalizationList.length === 0)
  check('正常路径：signature 清空', owner._generalizationSig === '')
}

// ---- 2. 孤儿元素（引用丢失）：按类名兜底清理 -> 本次修复的核心 ----
{
  const owner = makeOwner('owner-2')
  const orphanGroup = new FakeEl()
  orphanGroup.addClass('generalization_owner-2')
  owner.nodeDraw.add(orphanGroup)
  const orphanLine = owner.lineDraw.path()
  orphanLine.addClass('generalization-line_owner-2')
  // _generalizationList 是空的（引用丢了），但画布上还有东西
  owner._generalizationList = []

  api.removeGeneralization.call(owner)
  check('孤儿 group 被按类名清掉', orphanGroup.removed === true)
  check('孤儿括号线被按类名清掉', orphanLine.removed === true)
}

// ---- 3. 不能误删别人：只清自己 uid 的残留 ----
{
  const owner = makeOwner('owner-3')
  const mine = new FakeEl('generalization_owner-3')
  const other = new FakeEl('generalization_other-owner')
  owner.nodeDraw.add(mine)
  owner.nodeDraw.add(other)
  owner._generalizationList = []

  api.removeGeneralization.call(owner)
  check('自己的残留被清', mine.removed === true)
  check('别人的概要不受影响', other.removed === false)
}

// ---- 4. 概要节点自身调用时不能删自己（老注释里的坑） ----
{
  const owner = makeOwner('owner-4')
  const gen = makeOwner('gen-4')
  gen.isGeneralization = true
  gen.generalizationBelongNode = owner
  const selfEl = new FakeEl('generalization_owner-4')
  gen.nodeDraw.add(selfEl)
  gen._generalizationList = []

  api.removeGeneralization.call(gen)
  check('概要节点自己不执行 owner 级清理（避免误删自己/兄弟）', selfEl.removed === false)
}

// ---- 5. 缓存清理：已删除的实例不能留在 lru/nodeCache ----
{
  const owner = makeOwner('owner-5')
  const genNode = new FakeNode('gen-5')
  const dropped = []
  owner.renderer.nodeCache['gen-5'] = genNode
  owner.renderer.lastNodeCache['gen-5'] = genNode
  owner.renderer.layout.lru = {
    delete: uid => dropped.push(uid)
  }
  owner._generalizationList = [{ generalizationNode: genNode, generalizationLine: null }]

  api.removeGeneralization.call(owner)
  check('nodeCache 不再持有已删实例', !owner.renderer.nodeCache['gen-5'])
  check('lastNodeCache 不再持有已删实例', !owner.renderer.lastNodeCache['gen-5'])
  check('lru 里也摘掉了', dropped.includes('gen-5'))
}

// ---- 6. owner 的类名用的是自己 uid（老代码用 generalizationBelongNode，恒 null） ----
{
  check(
    '兜底清理条件是「非概要节点」而不是原来的恒假组合',
    /if \(!this\.isGeneralization\) \{/.test(raw) &&
      !/!this\.isGeneralization && this\.generalizationBelongNode/.test(raw)
  )
  check('按 owner 自己的 uid 查找', /find\('\.generalization_' \+ ownerUid\)/.test(raw))
  check('连线也按类名兜底', /find\('\.generalization-line_' \+ ownerUid\)/.test(raw))
  check(
    '创建连线时打上 owner 类名',
    /cur\.generalizationLine\.addClass\('generalization-line_' \+ lineOwnerUid\)/.test(raw)
  )
}

// ---- 7. removeCurrentNode 的概要分支补了 removeNodeFromActiveList ----
{
  const renderSrc = fs.readFileSync(path.join(ROOT, 'core/render/Render.js'), 'utf8')
  const start = renderSrc.indexOf('removeCurrentNode(appointNodes = [])')
  const body = renderSrc.slice(start, start + 2600)
  check(
    'removeCurrentNode 概要分支调用 removeNodeFromActiveList',
    /this\.deleteNodeGeneralization\(node\)\s*\n\s*this\.removeNodeFromActiveList\(node\)/.test(body)
  )
  check('removeNode 的概要分支也保持同样顺序', (() => {
    const s = renderSrc.indexOf('removeNode(appointNodes = [])')
    const b = renderSrc.slice(s, s + 2600)
    return /this\.deleteNodeGeneralization\(node\)\s*\n\s*this\.removeNodeFromActiveList\(node\)/.test(b)
  })())
}

const failed = results.filter(r => !r.ok)
console.log(failed.length ? `\n${failed.length} FAILED` : '\nall ok')
process.exit(failed.length ? 1 : 0)
