import { runWorkInSlices } from './layoutSlices'

const FANOUT = 8
const intersects = (a, b) => a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top
// Build one bounds object per parent instead of allocating a new object per
// child (the previous reduce). Semantics are identical (component min/max).
const union = items => {
  if (!items.length) return { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity }
  const first = items[0].bounds
  const bounds = { left: first.left, top: first.top, right: first.right, bottom: first.bottom }
  for (let i = 1; i < items.length; i++) {
    const b = items[i].bounds
    if (b.left < bounds.left) bounds.left = b.left
    if (b.top < bounds.top) bounds.top = b.top
    if (b.right > bounds.right) bounds.right = b.right
    if (b.bottom > bounds.bottom) bounds.bottom = b.bottom
  }
  return bounds
}
function spread(value) {
  value &= 0xffff
  value = (value | (value << 8)) & 0x00ff00ff
  value = (value | (value << 4)) & 0x0f0f0f0f
  value = (value | (value << 2)) & 0x33333333
  return (value | (value << 1)) & 0x55555555
}

// A packed spatial tree. Every item appears once, including long edges whose
// endpoints are outside the viewport. No giant-box overflow bucket to scan.
export default class ViewportIndex {
  constructor(items = []) {
    const work = this.build(items)
    while (!work.next().done) { /* Explicit exports keep a synchronous build. */ }
  }

  static async create(items, options = {}) {
    const index = Object.create(ViewportIndex.prototype)
    return await runWorkInSlices(index.build(items), options) ? index : null
  }

  *build(items) {
    this.leaves = new Map()
    this.root = null
    const valid = []
    const extent = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity }
    // Pure arithmetic passes below advance a yielded iterator by a very cheap
    // step. Yield in small fixed chunks so a large build does not pay a
    // generator/clock turn per item; the slice budget (8ms) and cancellation
    // still bound the whole build, and the overshoot is a few cheap steps.
    let chunk = 0
    const tick = () => (++chunk & 31) === 0
    for (const item of items) {
      if (Object.values(item.bounds).every(Number.isFinite)) {
        valid.push(item)
        extent.left = Math.min(extent.left, item.bounds.left)
        extent.top = Math.min(extent.top, item.bounds.top)
        extent.right = Math.max(extent.right, item.bounds.right)
        extent.bottom = Math.max(extent.bottom, item.bounds.bottom)
      }
      if (tick()) yield
    }
    if (!valid.length) return
    const width = extent.right - extent.left || 1
    const height = extent.bottom - extent.top || 1
    // Sort the item array directly, stashing the Morton key on each item, so a
    // full build does not allocate an extra {item,key} object per item.
    let ordered = valid.slice()
    for (const item of ordered) {
      const x = Math.min(65535, Math.max(0, Math.floor(((item.bounds.left + item.bounds.right) / 2 - extent.left) / width * 65535)))
      const y = Math.min(65535, Math.max(0, Math.floor(((item.bounds.top + item.bounds.bottom) / 2 - extent.top) / height * 65535)))
      item.__smmKey = (spread(x) | (spread(y) << 1)) >>> 0
      if (tick()) yield
    }
    // Four stable byte passes keep the same unsigned Morton ordering without
    // a single native sort that blocks input for the whole scene.
    let target = new Array(ordered.length)
    for (let shift = 0; shift < 32; shift += 8) {
      const counts = new Uint32Array(256)
      for (const item of ordered) { counts[(item.__smmKey >>> shift) & 255]++; if (tick()) yield }
      let offset = 0
      for (let i = 0; i < counts.length; i++) {
        const count = counts[i]; counts[i] = offset; offset += count
      }
      for (const item of ordered) { target[counts[(item.__smmKey >>> shift) & 255]++] = item; if (tick()) yield }
      const previous = ordered; ordered = target; target = previous
    }
    let level = []
    for (const item of ordered) {
      const leaf = { bounds: item.bounds, item }
      this.leaves.set(item.node || item.element, leaf)
      level.push(leaf)
      if (tick()) yield
    }
    while (level.length > 1) {
      const parents = []
      for (let i = 0; i < level.length; i += FANOUT) {
        const children = level.slice(i, i + FANOUT)
        const parent = { bounds: union(children), children }
        children.forEach(child => { child.parent = parent })
        parents.push(parent)
        if (tick()) yield
      }
      level = parents
    }
    this.root = level[0]
  }

  // Preserve the packed topology for a single size change. Refit only its
  // ancestor boxes; unrelated nodes and connectors are never read again.
  update(item) {
    const leaf = this.leaves.get(item.node || item.element)
    if (!leaf || !Object.values(item.bounds).every(Number.isFinite)) return false
    leaf.item.bounds = item.bounds
    leaf.bounds = item.bounds
    for (let parent = leaf.parent; parent; parent = parent.parent) {
      parent.bounds = union(parent.children)
    }
    return true
  }

  query(bounds) {
    const result = []
    const stack = this.root ? [this.root] : []
    while (stack.length) {
      const node = stack.pop()
      if (!intersects(node.bounds, bounds)) continue
      if (node.item) result.push(node.item)
      else stack.push(...node.children)
    }
    return result
  }
}
