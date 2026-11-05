/**
 * 概要子树「中间层自己有子节点」时兄弟重叠的回归测试（2026-11-05 现场 3）。
 *
 * 现场（截图像素测量）：右列节点文字行 y = 90 / 138 / 161 / 208 / 256。
 * 正常兄弟间距 48px，但 138 → 161 只有 23px（≈ marginY），两个节点框压在一起。
 * 结构是「中间层 3 个兄弟，其中第 1 个有 2 个子节点、第 3 个有 3 个子节点」。
 *
 * 根因：间距口径不统一。
 *   measureGeneralizationTree() 正确递归算出**子树**高度；
 *   但 childrenAreaHeight 与 layoutGeneralizationChildren 只用了节点自身 height，
 *   并且把子节点摆在自己那一段空间的**顶端**。于是「自己有子节点」的兄弟
 *   其子树向上溢出，压到上一个兄弟 —— 多层节点看起来叠在一起。
 *
 * 修复：
 *   1. 按「子树高度」分档（generalizationSubtreeHeight）
 *   2. 节点在自己那一档里垂直居中，让子树正好填满该档、不溢出
 */
const fs = require('fs')
const path = require('path')

const results = []
function check(name, ok, extra = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`)
}

const ROOT = path.join(__dirname, '../../simple-mind-map/src')
const baseRaw = fs.readFileSync(path.join(ROOT, 'layouts/Base.js'), 'utf8')
const genRaw = fs.readFileSync(path.join(ROOT, 'core/render/node/nodeGeneralization.js'), 'utf8')

function extractMethod(src, name) {
  const start = src.indexOf(`  ${name}(`)
  if (start < 0) return null
  let i = src.indexOf(') {', start)
  if (i < 0) return null
  i += 2
  let depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) {
        return `function ${name}${src.slice(src.indexOf('(', start), i + 1)}`
      }
    }
  }
  return null
}

const layoutFnSrc = extractMethod(baseRaw, 'layoutGeneralizationChildren')
const measureFnSrc = extractMethod(baseRaw, 'measureGeneralizationTree')
const subtreeHFnSrc = extractMethod(baseRaw, 'generalizationSubtreeHeight')
const subtreeWFnSrc = extractMethod(baseRaw, 'generalizationSubtreeWidth')

check('抽出 layoutGeneralizationChildren', !!layoutFnSrc)
check('抽出 measureGeneralizationTree', !!measureFnSrc)
check('新增 generalizationSubtreeHeight', !!subtreeHFnSrc)
check('新增 generalizationSubtreeWidth', !!subtreeWFnSrc)

const MARGIN_X = 30
const MARGIN_Y = 20
const NODE_H = 20
const NODE_W = 100

const host = {
  getMarginX: () => MARGIN_X,
  getMarginY: () => MARGIN_Y,
  getNestedGeneralizationExtent: () => 0
}
new Function(
  'host',
  `${measureFnSrc}
   ${subtreeHFnSrc || ''}
   ${subtreeWFnSrc || ''}
   ${layoutFnSrc}
   host.measureGeneralizationTree = measureGeneralizationTree
   host.layoutGeneralizationChildren = layoutGeneralizationChildren
   ${subtreeHFnSrc ? 'host.generalizationSubtreeHeight = generalizationSubtreeHeight' : ''}
   ${subtreeWFnSrc ? 'host.generalizationSubtreeWidth = generalizationSubtreeWidth' : ''}`
)(host)

function mk(uid, kids = []) {
  const data = { uid, text: uid, expand: true }
  const node = {
    uid,
    isGeneralization: true,
    layerIndex: 3,
    width: NODE_W,
    height: NODE_H,
    children: [],
    childrenAreaHeight: 0,
    getData(key) {
      if (key === undefined) return data
      return data[key]
    },
    addChildren(n) {
      if (!this.children.includes(n)) this.children.push(n)
    }
  }
  kids.forEach(k => {
    k.parent = node
    node.addChildren(k)
  })
  return node
}

// 复刻现场：中间层 3 个兄弟，第 1 个有 2 个子节点，第 3 个有 3 个
function buildScene() {
  const g = mk('g')
  const a = mk('a', [mk('a1'), mk('a2')])
  const b = mk('b')
  const c = mk('c', [mk('c1'), mk('c2'), mk('c3')])
  ;[a, b, c].forEach(n => { n.parent = g; g.children.push(n) })
  const fixLayer = (node, lv) => {
    node.layerIndex = lv
    node.children.forEach(k => fixLayer(k, lv + 1))
  }
  fixLayer(g, 3)
  g.top = 0
  g.left = 0
  return { g, a, b, c }
}

// 子树高度（helper 缺失时退回 measureGeneralizationTree，保证回退验证能跑出断言失败
// 而不是直接抛错）
const subH = (n) =>
  typeof host.generalizationSubtreeHeight === 'function'
    ? host.generalizationSubtreeHeight(n, 'h')
    : host.measureGeneralizationTree(n, 'h').height

// 完全按修复后的口径设置 childrenAreaHeight（子树高度累加）
function applyAreaHeights(node) {
  node.children.forEach(applyAreaHeights)
  const len = node.children.length
  node.childrenAreaHeight = len
    ? node.children.reduce((h, k) => h + subH(k), 0) + (len + 1) * MARGIN_Y
    : 0
}

// 真实布局函数跑一遍整棵概要子树
function layoutTree(g) {
  applyAreaHeights(g)
  host.layoutGeneralizationChildren(g, 'h', false)
}

// 每个节点「实际占据的纵向区间」：自身 + 它所有后代的并集
function verticalExtent(node, out = { top: Infinity, bottom: -Infinity }) {
  const top = node.top
  const bottom = node.top + node.height
  out.top = Math.min(out.top, top)
  out.bottom = Math.max(out.bottom, bottom)
  ;(node.children || []).forEach(k => verticalExtent(k, out))
  return out
}

// 同层兄弟的子树是否互相侵入
function findOverlaps(node, out = []) {
  const kids = node.children || []
  if (kids.length > 1) {
    const boxes = kids.map(k => {
      const ext = verticalExtent(k)
      return { uid: k.uid, top: ext.top, bottom: ext.bottom }
    })
    for (let i = 1; i < boxes.length; i++) {
      if (boxes[i].top < boxes[i - 1].bottom - 0.001) {
        out.push({
          level: node.layerIndex,
          prev: boxes[i - 1].uid,
          cur: boxes[i].uid,
          prevBottom: Math.round(boxes[i - 1].bottom),
          curTop: Math.round(boxes[i].top),
          overlap: Math.round(boxes[i - 1].bottom - boxes[i].top)
        })
      }
    }
  }
  kids.forEach(k => findOverlaps(k, out))
  return out
}

// ---- 1. 现场结构：不重叠 ----
{
  const { g } = buildScene()
  layoutTree(g)
  const overlaps = findOverlaps(g)
  check('现场结构（中间层有子节点）：兄弟子树不重叠', overlaps.length === 0, JSON.stringify(overlaps))
}

// ---- 2. 每个节点都在自己的档位内，且档位间距 = marginY ----
{
  const { g } = buildScene()
  layoutTree(g)
  const a = g.children[0]
  const b = g.children[1]
  const c = g.children[2]
  const aExt = verticalExtent(a)
  const bExt = verticalExtent(b)
  const cExt = verticalExtent(c)
  check('a 的子树与 b 之间留出 marginY', bExt.top - aExt.bottom >= MARGIN_Y - 0.001, 'gap=' + Math.round(bExt.top - aExt.bottom))
  check('b 的子树与 c 之间留出 marginY', cExt.top - bExt.bottom >= MARGIN_Y - 0.001, 'gap=' + Math.round(cExt.top - bExt.bottom))
  check('子节点在自己档内垂直居中（a 的档等于 a 的子树范围）', Math.abs(aExt.top + aExt.bottom - (a.top * 2 + a.height)) < 1)
}

// ---- 3. 对照：用旧口径（只按节点高度 + 摆在档顶）必须能复现重叠 ----
{
  const { g } = buildScene()
  // 旧口径
  const oldArea = node => {
    node.children.forEach(oldArea)
    const len = node.children.length
    node.childrenAreaHeight = len
      ? node.children.reduce((h, k) => h + k.height, 0) + (len + 1) * MARGIN_Y
      : 0
  }
  const oldLayout = node => {
    const kids = node.children || []
    if (!kids.length) return
    const areaH = node.childrenAreaHeight || node.height
    const top = node.top + node.height / 2 - areaH / 2
    let totalTop = top + MARGIN_Y
    kids.forEach(k => {
      k.left = node.left + node.width + MARGIN_X
      k.top = totalTop
      totalTop += k.height + MARGIN_Y
      oldLayout(k)
    })
  }
  oldArea(g)
  oldLayout(g)
  const overlaps = findOverlaps(g)
  check('（对照）旧口径确实重叠', overlaps.length > 0, JSON.stringify(overlaps))
}

// ---- 4. 更深：4 层，每层都有分叉 ----
{
  const g = mk('g')
  const a = mk('a', [mk('a1', [mk('a1x'), mk('a1y')]), mk('a2')])
  const b = mk('b', [mk('b1', [mk('b1x')])])
  const c = mk('c')
  ;[a, b, c].forEach(n => { n.parent = g; g.children.push(n) })
  const fixLayer = (node, lv) => { node.layerIndex = lv; node.children.forEach(k => fixLayer(k, lv + 1)) }
  fixLayer(g, 3)
  g.top = 0
  g.left = 0
  layoutTree(g)
  const overlaps = findOverlaps(g)
  check('4 层嵌套：不重叠', overlaps.length === 0, JSON.stringify(overlaps))
}

// ---- 5. 单子节点 / 无子节点边界 ----
{
  const g = mk('g', [mk('only', [mk('x')])])
  g.top = 0
  g.left = 0
  layoutTree(g)
  check('单子节点：不抛错且位置有效', Number.isFinite(g.children[0].top))
  check('单子节点：子树在父节点附近居中', Math.abs((g.children[0].top + 10) - (g.top + 10)) < 1)

  const leafOnly = mk('g2')
  leafOnly.top = 0
  leafOnly.left = 0
  let threw = null
  try { host.layoutGeneralizationChildren(leafOnly, 'h', false) } catch (e) { threw = e }
  check('叶子概要节点布局不抛错', threw === null, threw ? threw.message : '')
}

// ---- 6. 'v' 布局（横向排列）同样按子树宽度 ----
{
  const g = mk('g')
  const a = mk('a', [mk('a1')])
  const b = mk('b')
  ;[a, b].forEach(n => { n.parent = g; g.children.push(n) })
  g.top = 0
  g.left = 0
  host.layoutGeneralizationChildren(g, 'v', false)
  const aW = typeof host.generalizationSubtreeWidth === 'function' ? host.generalizationSubtreeWidth(a, 'v') : host.measureGeneralizationTree(a, 'v').width
  check('v 布局：第二个子节点的 left 跨过第一个的子树宽度', g.children[1].left >= g.children[0].left + aW, `aLeft=${g.children[0].left} bLeft=${g.children[1].left} aW=${aW}`)
}

// ---- 7. 源码守卫 ----
{
  check('layout 步进用子树高度', /totalTop \+= bandH \+ marginY/.test(layoutFnSrc))
  check('节点在档内垂直居中', /cur\.top = totalTop \+ \(bandH - cur\.height\) \/ 2/.test(layoutFnSrc))
  check('不再用裸 cur.height 做步进', !/totalTop \+= cur\.height \+ marginY/.test(layoutFnSrc))
  check('createGeneralizationChildNodes 的 area 用子树高度', (() => {
    const s = baseRaw.indexOf('createGeneralizationChildNodes(gNode)')
    if (s < 0) return false
    const body = baseRaw.slice(s, s + 2600)
    return /generalizationSubtreeHeight\(item, 'h'\)/.test(body)
  })())
  check('refreshGeneralizationSubtree 的 area 用子树高度', (() => {
    const s = genRaw.indexOf('function refreshGeneralizationSubtree')
    if (s < 0) return false
    const e = genRaw.indexOf('\n}\n', s)
    return /generalizationSubtreeHeight/.test(genRaw.slice(s, e))
  })())
  check('叶子节点子树高度退化为自身高度', /return value > 0 \? value : node\.height \|\| 0/.test(subtreeHFnSrc || ''))
}

const failed = results.filter(r => !r.ok)
console.log(failed.length ? `\n${failed.length} FAILED` : '\nall ok')
process.exit(failed.length ? 1 : 0)
