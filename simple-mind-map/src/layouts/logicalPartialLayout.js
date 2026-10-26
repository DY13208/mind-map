// P3: partial layout for LogicalStructure (flag: performanceFlags.partialLayoutLogicalStructure).
// Only node instantiation/measurement is scoped to dirty branches. Positions are
// then recomputed with the exact arithmetic of the three full passes
// (computedBaseValue/computedTopValue/adjustTopValue), so results are bit-identical.
// Any condition that cannot be proven equivalent falls back to the full layout.
import { CONSTANTS } from '../constants/constant'

const NEUTRAL_COMMANDS = new Set([
  'SET_NODE_ACTIVE', 'CLEAR_ACTIVE_NODE', 'SELECT_ALL', 'GO_TARGET_NODE', 'RETURN_CENTER'
])
// Commands whose layout impact is: content of node args/active nodes, plus
// structure/expand changes (structure and expand are re-verified per node).
const SCOPED_COMMANDS = new Set([
  'SET_NODE_TEXT', 'SET_NODE_DATA', 'SET_NODE_STYLE', 'SET_NODE_STYLES', 'SET_NODE_IMAGE',
  'SET_NODE_ICON', 'SET_NODE_HYPERLINK', 'SET_NODE_NOTE', 'SET_NODE_TAG', 'SET_NODE_ATTACHMENT',
  'SET_NODE_SHAPE', 'SET_NODE_EXPAND', 'EXPAND_ALL', 'UNEXPAND_ALL', 'UNEXPAND_TO_LEVEL',
  'INSERT_NODE', 'INSERT_MULTI_NODE', 'INSERT_CHILD_NODE', 'INSERT_MULTI_CHILD_NODE',
  'INSERT_PARENT_NODE', 'UP_NODE', 'DOWN_NODE', 'MOVE_UP_ONE_LEVEL', 'INSERT_AFTER',
  'INSERT_BEFORE', 'MOVE_NODE_TO', 'REMOVE_NODE', 'REMOVE_CURRENT_NODE', 'PASTE_NODE', 'CUT_NODE'
])

export const PARTIAL_LAYOUT_DEFAULTS = {
  maxTouchedRatio: 0.3, // re-created/measured nodes / laid-out nodes
  minTouchedForRatio: 64,
  maxMovedRatio: 1 // 1 = never fall back on moved count (moves are cheap arithmetic)
}

export function createDirtyState() {
  return { marked: false, poison: '', uids: new Set() }
}

function addNodeUids(value, set, depth = 0) {
  if (!value || depth > 2) return
  if (Array.isArray(value)) return value.forEach(v => addNodeUids(v, set, depth + 1))
  if (value.nodeData && value.nodeData.data && value.nodeData.data.uid != null) {
    set.add(String(value.nodeData.data.uid))
  }
}

export function isPartialEnabled(renderer) {
  const opt = renderer.mindMap && renderer.mindMap.opt
  return !!(opt && opt.performanceFlags && opt.performanceFlags.partialLayoutLogicalStructure)
}

export function markCommand(renderer, name, args) {
  if (!isPartialEnabled(renderer)) return
  const state = renderer._plDirty || (renderer._plDirty = createDirtyState())
  if (NEUTRAL_COMMANDS.has(name)) return
  if (!SCOPED_COMMANDS.has(name)) {
    if (!state.poison) state.poison = 'command:' + name
    return
  }
  state.marked = true
  ;(args || []).forEach(a => addNodeUids(a, state.uids))
  addNodeUids(renderer.activeNodeList || [], state.uids)
}

export function markRemote(renderer, uids) {
  if (!isPartialEnabled(renderer)) return
  const state = renderer._plDirty || (renderer._plDirty = createDirtyState())
  if (!uids || !uids.length) {
    if (!state.poison) state.poison = 'remote_unscoped'
    return
  }
  state.marked = true
  uids.forEach(u => u != null && state.uids.add(String(u)))
}

export function takeDirty(renderer) {
  const state = renderer._plDirty || createDirtyState()
  renderer._plDirty = createDirtyState()
  return state
}

export function getStats(renderer) {
  if (!renderer._plStats) {
    renderer._plStats = { partial: 0, full: 0, fallback: {}, shadowChecks: 0, shadowMismatch: 0, last: null }
  }
  return renderer._plStats
}

export function recordFallback(renderer, reason) {
  const stats = getStats(renderer)
  stats.full++
  stats.fallback[reason] = (stats.fallback[reason] || 0) + 1
  stats.last = { mode: 'full', reason }
}

const SHALLOW_IGNORE = { isActive: 1, expand: 1 }
function shallowStamp(data) {
  const out = {}
  for (const k in data) if (!SHALLOW_IGNORE[k]) out[k] = data[k]
  return out
}
function shallowSame(stamp, data) {
  if (!stamp) return false
  let n = 0
  for (const k in data) {
    if (SHALLOW_IGNORE[k]) continue
    if (stamp[k] !== data[k]) return false
    n++
  }
  for (const k in stamp) n--
  return n === 0
}

function isSpecialData(data) {
  const g = data.generalization
  if (g && (!Array.isArray(g) || g.length)) return 'generalization'
  if (data.isFloating) return 'floating'
  if (data.customLeft != null || data.customTop != null) return 'custom_position'
  return ''
}

// Stamp baseline fingerprints after a full layout (only while the flag is on).
export function stampAfterFull(layout) {
  const root = layout.renderer.renderTree
  if (!root) return
  const stack = [root]
  while (stack.length) {
    const d = stack.pop()
    const node = d._node
    if (!node) continue
    node._plStamp = shallowStamp(d.data)
    if (d.data.expand !== false && d.children) for (let i = 0; i < d.children.length; i++) stack.push(d.children[i])
  }
  layout._plBaseline = true
}

function preconditions(layout) {
  const renderer = layout.renderer
  const mindMap = layout.mindMap
  if (!layout._plBaseline || !layout.root) return 'no_baseline'
  if (renderer.reRender) return 'rerender'
  if (renderer.checkHasRenderSource([CONSTANTS.CHANGE_THEME, CONSTANTS.CHANGE_LAYOUT])) return 'render_source'
  if (mindMap.nodeInnerPrefixList.length || mindMap.nodeInnerPostfixList.length) return 'node_inner_fix'
  if (!renderer.renderTree) return 'no_tree'
  return ''
}

class Abort extends Error {
  constructor(reason) { super(reason); this.reason = reason }
}

export function tryPartialLayout(layout, dirty) {
  const renderer = layout.renderer
  const flags = (layout.mindMap.opt && layout.mindMap.opt.performanceFlags) || {}
  const started = typeof performance !== 'undefined' ? performance.now() : Date.now()
  let reason = preconditions(layout)
  if (!reason && dirty.poison) reason = 'dirty_invalid:' + dirty.poison
  if (!reason && !dirty.marked) reason = 'dirty_set_missing'
  if (!reason && layout.checkIsNeedResizeSources && layout.checkIsNeedResizeSources()) reason = 'resize_source'
  if (reason) return { ok: false, reason }
  const cfg = { ...PARTIAL_LAYOUT_DEFAULTS, ...(layout.mindMap.opt.partialLayoutConfig || {}) }
  const total = Math.max(1, renderer.nodeIndex ? renderer.nodeIndex.size : 1)
  const touchLimit = Math.max(cfg.minTouchedForRatio, Math.floor(total * cfg.maxTouchedRatio))
  const prevPos = new Map()
  const reused = []
  const newNodes = new Set()
  let touched = 0
  let sortIndex = 0
  const visit = (data, parentData, isRoot, layerIndex, index, parentFresh) => {
    const d = data.data
    const special = isSpecialData(d)
    if (special) throw new Abort('special_dependency:' + special)
    let node = data._node
    const uid = d.uid
    let fresh = true
    if (!node) newNodes.add(data)
    if (node && node.nodeData === data && !dirty.uids.has(String(uid)) && node.layerIndex === layerIndex &&
      (isRoot ? node.isRoot && layout.root === node : !node.isRoot && node.parent === parentData._node) &&
      !node._forceMeasure && !d.needUpdate && !(d.resetRichText && !node.isUseCustomNodeContent()) &&
      shallowSame(node._plStamp, d) &&
      node._sizeStructureSnapshot === JSON.stringify([layerIndex, (data.children || []).map(c => c.data && c.data.uid)])) {
      const kids = data.children || []
      const nk = node.children || []
      if (d.expand === false) fresh = nk.length !== 0
      else {
        fresh = nk.length !== kids.length
        for (let i = 0; !fresh && i < kids.length; i++) if (kids[i]._node !== nk[i]) fresh = true
      }
    }
    if (fresh) {
      if (node && !prevPos.has(node)) prevPos.set(node, [node.left, node.top])
      touched++
      if (touched > touchLimit) throw new Abort('scope_too_large')
      node = layout.createNode(data, parentData, isRoot, layerIndex, index, [])
      if (node.hasCustomPosition && node.hasCustomPosition()) throw new Abort('special_dependency:custom_position')
    } else {
      if (node.hasCustomPosition && node.hasCustomPosition()) throw new Abort('special_dependency:custom_position')
      layout.cacheNode(uid, node)
      if (d.isActive) renderer.addNodeToActiveList(node)
      if (renderer.findActiveNodeIndex(node) !== -1) node.setData({ isActive: true })
      if (isRoot) layout.root = node
      else if (parentFresh) parentData._node.addChildren(node)
      reused.push(node)
    }
    node._plStamp = shallowStamp(d)
    node.sortIndex = sortIndex++
    if (d.expand) {
      const kids = data.children || []
      for (let i = 0; i < kids.length; i++) visit(kids[i], data, false, layerIndex + 1, i, fresh)
      // createNode always appends to parent._node; for a reused parent restore exact order (no duplicates)
      if (!fresh) node.children = kids.map(k => k._node)
    }
  }
  try {
    visit(renderer.renderTree, null, true, 0, 0, true)
    const moved = positionTree(layout, prevPos, newNodes)
    const movedRatio = moved.size / total
    if (cfg.maxMovedRatio < 1 && movedRatio > cfg.maxMovedRatio) throw new Abort('moved_too_large')
    if (flags.partialLayoutShadowValidate) {
      const mismatch = shadowValidate(layout, reused)
      const stats = getStats(renderer)
      stats.shadowChecks++
      if (mismatch) {
        stats.shadowMismatch++
        stats.lastMismatch = mismatch
        // eslint-disable-next-line no-console
        console.warn('[partialLayout] shadow mismatch, fallback to full', mismatch)
        throw new Abort('shadow_mismatch:' + mismatch.reason)
      }
    }
    const stats = getStats(renderer)
    stats.partial++
    const elapsedMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - started
    stats.last = { mode: 'partial', touched, moved: moved.size, total, elapsedMs }
    renderer._partialLayoutMoved = moved
    return { ok: true, touched, moved, total, elapsedMs }
  } catch (error) {
    return { ok: false, reason: error instanceof Abort ? error.reason : 'exception', error }
  }
}

// Exact replica of the three full-layout passes' arithmetic over the node tree.
function positionTree(layout, prevPos, newData) {
  const root = layout.root
  const isUseLeft = layout.isUseLeft
  const moved = new Set()
  const old = node => prevPos.get(node) || [node.left, node.top]
  const olds = new Map()
  // pass 1 left + childrenAreaHeight (post), pass 2 top2 (pre)
  const p1 = (node, parent) => {
    olds.set(node, old(node))
    if (!parent) layout.setNodeCenter(node)
    else node.left = isUseLeft
      ? parent.left - node.width - layout.getMarginX(node.layerIndex)
      : parent.left + parent.width + layout.getMarginX(node.layerIndex)
    const ch = node.children
    for (let i = 0; i < ch.length; i++) p1(ch[i], node)
    const len = node.nodeData.data.expand === false ? 0 : ch.length
    node.childrenAreaHeight = len
      ? ch.reduce((h, item) => h + item.height, 0) + (len + 1) * layout.getMarginY(node.layerIndex + 1)
      : 0
    node.childrenAreaHeight2 = Math.max(node.childrenAreaHeight, 0)
  }
  p1(root, null)
  const p2 = node => {
    if (node.getData('expand') && node.children && node.children.length) {
      const marginY = layout.getMarginY(node.layerIndex + 1)
      const top = node.top + node.height / 2 - node.childrenAreaHeight / 2
      let totalTop = top + marginY
      node.children.forEach(cur => {
        cur.top = totalTop
        totalTop += cur.height + marginY
      })
    }
    node.children.forEach(p2)
  }
  p2(root)
  // pass 3: same accumulation order as Base.adjustSiblingSubtrees
  const totals = new Map()
  const collect = node => {
    node.children.forEach(collect)
    let own = 0
    if (node.getData('expand')) {
      const difference = node.childrenAreaHeight2 - layout.getMarginY(node.layerIndex + 1) * 2 - node.height
      own = Math.max(0, difference) / 2
    }
    let sum = own
    node.children.forEach(child => { sum += totals.get(child) || 0 })
    totals.set(node, sum)
  }
  collect(root)
  const inherited = new Map()
  const siblingOffsets = new Map()
  const position = (node, parent) => {
    const incoming = parent ? inherited.get(parent) || 0 : 0
    const shift = incoming + (siblingOffsets.get(node) || 0)
    if (shift) node.top += shift
    inherited.set(node, shift)
    const children = node.children || []
    let remaining = children.reduce((sum, child) => sum + totals.get(child), 0)
    let preceding = 0
    children.forEach(child => {
      const own = totals.get(child)
      remaining -= own
      siblingOffsets.set(child, preceding - remaining)
      preceding += own
    })
    const o = olds.get(node)
    if (newData.has(node.nodeData) || o[0] !== node.left || o[1] !== node.top) moved.add(node.uid)
    children.forEach(child => position(child, node))
  }
  position(root, null)
  return moved
}

// Shadow validation (debug flag only). Never mutates the live tree:
// 1) skipped (reused) nodes must be exactly what createNode would have left alone;
// 2) positions recomputed by an independent Map-based port of the original
//    passes must match the partial result within tolerance.
function shadowValidate(layout, reused) {
  const bad = []
  for (const node of reused) {
    const data = node.nodeData
    if (layout.checkIsNodeDataChange(node.nodeDataSnapshot, data.data)) bad.push(node.uid)
    else {
      const snap = JSON.stringify([node.layerIndex, (data.children || []).map(c => c.data && c.data.uid)])
      if (node._sizeStructureSnapshot !== snap) bad.push(node.uid)
    }
    if (bad.length >= 20) break
  }
  if (bad.length) return { reason: 'reused_node_changed', uids: bad }
  const pos = new Map()
  const root = layout.root
  const left = new Map(), top = new Map(), cah = new Map()
  const p1 = (node, parent) => {
    left.set(node, parent
      ? (layout.isUseLeft ? left.get(parent) - node.width - layout.getMarginX(node.layerIndex)
        : left.get(parent) + parent.width + layout.getMarginX(node.layerIndex))
      : node.left)
    node.children.forEach(c => p1(c, node))
    const len = node.getData('expand') === false ? 0 : node.children.length
    cah.set(node, len ? node.children.reduce((h, c) => h + c.height, 0) + (len + 1) * layout.getMarginY(node.layerIndex + 1) : 0)
  }
  p1(root, null)
  const rootTop = root.top
  top.set(root, rootTop)
  const p2 = node => {
    if (node.getData('expand') && node.children.length) {
      const mY = layout.getMarginY(node.layerIndex + 1)
      let t = top.get(node) + node.height / 2 - cah.get(node) / 2 + mY
      node.children.forEach(c => { top.set(c, t); t += c.height + mY })
    }
    node.children.forEach(p2)
  }
  p2(root)
  const tot = new Map()
  const col = node => {
    node.children.forEach(col)
    const own = node.getData('expand') ? Math.max(0, cah.get(node) - layout.getMarginY(node.layerIndex + 1) * 2 - node.height) / 2 : 0
    tot.set(node, node.children.reduce((s, c) => s + tot.get(c), own))
  }
  col(root)
  const apply = (node, shift) => {
    const t = top.get(node) + shift
    pos.set(node, [left.get(node), t])
    const ch = node.children
    let remaining = ch.reduce((s, c) => s + tot.get(c), 0)
    let preceding = 0
    ch.forEach(c => {
      remaining -= tot.get(c)
      apply(c, shift + preceding - remaining)
      preceding += tot.get(c)
    })
  }
  apply(root, 0)
  const tol = 0.01
  pos.forEach((p, node) => {
    if (bad.length < 20 && (Math.abs(p[0] - node.left) > tol || Math.abs(p[1] - node.top) > tol)) bad.push(node.uid)
  })
  if (pos.size !== (layout.renderer.nodeCache ? Object.keys(layout.renderer.nodeCache).length : pos.size)) {
    return { reason: 'node_count', uids: [] }
  }
  return bad.length ? { reason: 'geometry', uids: bad } : null
}
