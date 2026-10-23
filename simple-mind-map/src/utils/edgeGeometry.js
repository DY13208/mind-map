// Analytic SVG path bounds. Used so viewport indexing does not need getBBox()
// or a mounted <path>. Unsupported commands return null and callers fall back.

function addPoint(bounds, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return
  if (x < bounds.left) bounds.left = x
  if (y < bounds.top) bounds.top = y
  if (x > bounds.right) bounds.right = x
  if (y > bounds.bottom) bounds.bottom = y
}

function emptyBounds() {
  return { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity }
}

function quadraticPoint(p0, p1, p2, t) {
  const mt = 1 - t
  return mt * mt * p0 + 2 * mt * t * p1 + t * t * p2
}

function cubicPoint(p0, p1, p2, p3, t) {
  const mt = 1 - t
  return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3
}

function quadraticExtrema(p0, p1, p2) {
  const denom = p0 - 2 * p1 + p2
  if (Math.abs(denom) < 1e-8) return []
  const t = (p0 - p1) / denom
  return t > 0 && t < 1 ? [t] : []
}

function cubicExtrema(p0, p1, p2, p3) {
  const a = -p0 + 3 * p1 - 3 * p2 + p3
  const b = 2 * p0 - 4 * p1 + 2 * p2
  const c = -p0 + p1
  const ts = []
  if (Math.abs(a) < 1e-8) {
    if (Math.abs(b) > 1e-8) {
      const t = -c / b
      if (t > 0 && t < 1) ts.push(t)
    }
    return ts
  }
  const disc = b * b - 4 * a * c
  if (disc < 0) return ts
  const root = Math.sqrt(disc)
  const t1 = (-b + root) / (2 * a)
  const t2 = (-b - root) / (2 * a)
  if (t1 > 0 && t1 < 1) ts.push(t1)
  if (t2 > 0 && t2 < 1) ts.push(t2)
  return ts
}

function addQuadratic(bounds, x0, y0, x1, y1, x2, y2) {
  addPoint(bounds, x0, y0)
  addPoint(bounds, x2, y2)
  quadraticExtrema(x0, x1, x2).forEach(t => addPoint(bounds, quadraticPoint(x0, x1, x2, t), quadraticPoint(y0, y1, y2, t)))
  quadraticExtrema(y0, y1, y2).forEach(t => addPoint(bounds, quadraticPoint(x0, x1, x2, t), quadraticPoint(y0, y1, y2, t)))
}

function addCubic(bounds, x0, y0, x1, y1, x2, y2, x3, y3) {
  addPoint(bounds, x0, y0)
  addPoint(bounds, x3, y3)
  cubicExtrema(x0, x1, x2, x3).forEach(t => addPoint(bounds, cubicPoint(x0, x1, x2, x3, t), cubicPoint(y0, y1, y2, y3, t)))
  cubicExtrema(y0, y1, y2, y3).forEach(t => addPoint(bounds, cubicPoint(x0, x1, x2, x3, t), cubicPoint(y0, y1, y2, y3, t)))
}

function tokenizePath(d) {
  const tokens = []
  const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?\d*\.?\d+(?:e[-+]?\d+)?)/g
  let match
  while ((match = re.exec(String(d || '')))) {
    if (match[1]) tokens.push({ type: 'cmd', value: match[1] })
    else tokens.push({ type: 'num', value: parseFloat(match[2]) })
  }
  return tokens
}

function takeNums(tokens, i, count) {
  const nums = []
  let j = i
  while (nums.length < count && tokens[j] && tokens[j].type === 'num') {
    nums.push(tokens[j].value)
    j++
  }
  return nums.length === count ? { nums, next: j } : null
}

function boundsFromPath(d) {
  if (d == null || d === '' || d === 'M 0,0' || d === 'M0,0') return null
  const tokens = tokenizePath(d)
  if (!tokens.length) return null
  const bounds = emptyBounds()
  let i = 0
  let x = 0
  let y = 0
  let sx = 0
  let sy = 0
  let lastCmd = ''
  let cx = 0
  let cy = 0
  while (i < tokens.length) {
    const token = tokens[i]
    if (token.type !== 'cmd') return null
    let cmd = token.value
    i++
    const repeat = cmd
    const rel = cmd === cmd.toLowerCase()
    cmd = cmd.toUpperCase()
    const read = count => {
      const got = takeNums(tokens, i, count)
      if (!got) return null
      i = got.next
      return got.nums
    }
    if (cmd === 'Z') {
      x = sx
      y = sy
      lastCmd = cmd
      continue
    }
    const consume = () => {
      if (cmd === 'M' || cmd === 'L') {
        const nums = read(2)
        if (!nums) return false
        const nx = rel ? x + nums[0] : nums[0]
        const ny = rel ? y + nums[1] : nums[1]
        if (cmd === 'M') {
          sx = nx
          sy = ny
        } else {
          addPoint(bounds, x, y)
        }
        addPoint(bounds, nx, ny)
        x = nx
        y = ny
        return true
      }
      if (cmd === 'H') {
        const nums = read(1)
        if (!nums) return false
        const nx = rel ? x + nums[0] : nums[0]
        addPoint(bounds, x, y)
        addPoint(bounds, nx, y)
        x = nx
        return true
      }
      if (cmd === 'V') {
        const nums = read(1)
        if (!nums) return false
        const ny = rel ? y + nums[0] : nums[0]
        addPoint(bounds, x, y)
        addPoint(bounds, x, ny)
        y = ny
        return true
      }
      if (cmd === 'Q') {
        const nums = read(4)
        if (!nums) return false
        const x1 = rel ? x + nums[0] : nums[0]
        const y1 = rel ? y + nums[1] : nums[1]
        const nx = rel ? x + nums[2] : nums[2]
        const ny = rel ? y + nums[3] : nums[3]
        addQuadratic(bounds, x, y, x1, y1, nx, ny)
        cx = x1
        cy = y1
        x = nx
        y = ny
        return true
      }
      if (cmd === 'T') {
        const nums = read(2)
        if (!nums) return false
        const x1 = lastCmd === 'Q' || lastCmd === 'T' ? 2 * x - cx : x
        const y1 = lastCmd === 'Q' || lastCmd === 'T' ? 2 * y - cy : y
        const nx = rel ? x + nums[0] : nums[0]
        const ny = rel ? y + nums[1] : nums[1]
        addQuadratic(bounds, x, y, x1, y1, nx, ny)
        cx = x1
        cy = y1
        x = nx
        y = ny
        return true
      }
      if (cmd === 'C') {
        const nums = read(6)
        if (!nums) return false
        const x1 = rel ? x + nums[0] : nums[0]
        const y1 = rel ? y + nums[1] : nums[1]
        const x2 = rel ? x + nums[2] : nums[2]
        const y2 = rel ? y + nums[3] : nums[3]
        const nx = rel ? x + nums[4] : nums[4]
        const ny = rel ? y + nums[5] : nums[5]
        addCubic(bounds, x, y, x1, y1, x2, y2, nx, ny)
        cx = x2
        cy = y2
        x = nx
        y = ny
        return true
      }
      if (cmd === 'S') {
        const nums = read(4)
        if (!nums) return false
        const x1 = lastCmd === 'C' || lastCmd === 'S' ? 2 * x - cx : x
        const y1 = lastCmd === 'C' || lastCmd === 'S' ? 2 * y - cy : y
        const x2 = rel ? x + nums[0] : nums[0]
        const y2 = rel ? y + nums[1] : nums[1]
        const nx = rel ? x + nums[2] : nums[2]
        const ny = rel ? y + nums[3] : nums[3]
        addCubic(bounds, x, y, x1, y1, x2, y2, nx, ny)
        cx = x2
        cy = y2
        x = nx
        y = ny
        return true
      }
      if (cmd === 'A') {
        const nums = read(7)
        if (!nums) return false
        const nx = rel ? x + nums[5] : nums[5]
        const ny = rel ? y + nums[6] : nums[6]
        const rx = Math.abs(nums[0])
        const ry = Math.abs(nums[1])
        addPoint(bounds, x, y)
        addPoint(bounds, nx, ny)
        addPoint(bounds, Math.min(x, nx) - rx, Math.min(y, ny) - ry)
        addPoint(bounds, Math.max(x, nx) + rx, Math.max(y, ny) + ry)
        x = nx
        y = ny
        return true
      }
      return false
    }
    if (!consume()) return null
    lastCmd = cmd
    while (tokens[i] && tokens[i].type === 'num') {
      if (cmd === 'M') cmd = 'L'
      if (!consume()) return null
      lastCmd = cmd
    }
    if (repeat === 'M' || repeat === 'm') lastCmd = 'M'
  }
  if (!Number.isFinite(bounds.left)) return null
  return bounds
}

function inflateBounds(bounds, { strokeWidth = 0, miterLimit = 4, hasMarker = false } = {}) {
  if (!bounds) return null
  const width = Number(strokeWidth) || 0
  const miter = Number(miterLimit) || 4
  const padding = Math.max(width / 2 * Math.max(1, miter), hasMarker ? 20 : 0)
  return {
    left: bounds.left - padding,
    top: bounds.top - padding,
    right: bounds.right + padding,
    bottom: bounds.bottom + padding
  }
}

function boundsFromPathWithStroke(d, extras) {
  return inflateBounds(boundsFromPath(d), extras)
}

function makeStubLine() {
  const attrs = {}
  const node = {
    getAttribute(name) { return attrs[name] == null ? null : String(attrs[name]) },
    setAttribute(name, value) { attrs[name] = value },
    style: {},
    parentNode: null,
    isConnected: false
  }
  return {
    node,
    plot(d) { attrs.d = d; return this },
    show() { delete attrs.display; return this },
    hide() { attrs.display = 'none'; return this },
    visible() { return attrs.display !== 'none' },
    addClass() { return this },
    stroke(opts) {
      if (opts && opts.width != null) attrs['stroke-width'] = opts.width
      if (opts && opts.color != null) attrs.stroke = opts.color
      return this
    },
    fill() { return this },
    attr(name, value) {
      if (value !== undefined) { attrs[name] = value; return this }
      return attrs[name]
    },
    marker() { return this }
  }
}

function captureNodeConnectors(node) {
  if (!node || !node.renderer || !node.renderer.layout) return []
  const layout = node.renderer.layout
  const lineDraw = node.lineDraw || (node.mindMap && node.mindMap.lineDraw)
  if (!lineDraw || typeof layout.renderLine !== 'function') return []
  const origPath = lineDraw.path && lineDraw.path.bind(lineDraw)
  // OrganizationStructure.straight pushes an extra path onto node._lines.
  // Dry-run must not leak stubs into the live connector list.
  const prevLines = node._lines
  const stubs = []
  if (origPath) {
    lineDraw.path = function () {
      const stub = makeStubLine()
      stubs.push(stub)
      return stub
    }
  }
  try {
    node._lines = Array.isArray(prevLines) ? prevLines.slice() : []
    const children = node.children || []
    const lines = children.map(() => {
      const stub = makeStubLine()
      stubs.push(stub)
      return stub
    })
    const lineStyle = node.style && typeof node.style.getStyle === 'function'
      ? node.style.getStyle('lineStyle', true)
      : 'straight'
    layout.renderLine(node, lines, () => {}, lineStyle)
  } catch (error) {
    return []
  } finally {
    node._lines = prevLines
    if (origPath) lineDraw.path = origPath
  }
  const seen = new Set()
  const specs = []
  stubs.forEach(line => {
    const d = line.node && line.node.getAttribute('d')
    if (!d || seen.has(line)) return
    seen.add(line)
    if (line.node.getAttribute('display') === 'none') return
    const raw = boundsFromPath(d)
    if (!raw) return
    specs.push({ d, bounds: raw, line })
  })
  return specs
}

const api = {
  boundsFromPath,
  inflateBounds,
  boundsFromPathWithStroke,
  quadraticExtrema,
  cubicExtrema,
  quadraticPoint,
  cubicPoint,
  makeStubLine,
  captureNodeConnectors
}

module.exports = api
module.exports.default = api
