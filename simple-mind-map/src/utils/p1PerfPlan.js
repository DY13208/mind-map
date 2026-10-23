// P1 paint / draft decision helpers. Pure functions so flags can stay off
// and unit tests can lock the old vs new behaviour without a renderer.

const LINE_STYLE_KEYS = {
  lineColor: true,
  lineWidth: true,
  lineDasharray: true,
  lineStyle: true,
  showLineMarker: true,
  lineMarkerDir: true
}

function patchKeys(patch) {
  return Object.keys(patch || {})
}

function hasLineStyleKey(patch) {
  return patchKeys(patch).some(key => LINE_STYLE_KEYS[key])
}

function planRemoteNodePaint(patch, options = {}) {
  const {
    sizeChanged = false,
    inheritAncestorLineStyle = true,
    scopedLine = false,
    scopedGeometry = false,
    needsGeometryRefresh = false
  } = options
  const scheduleLayout = scopedGeometry ? !!sizeChanged : !!needsGeometryRefresh
  if (!scopedLine) {
    return { scheduleLayout, lineRefresh: 'deep-from-parent' }
  }
  if (scheduleLayout) {
    return { scheduleLayout, lineRefresh: 'none' }
  }
  if (!hasLineStyleKey(patch)) {
    return { scheduleLayout, lineRefresh: 'none' }
  }
  if (inheritAncestorLineStyle) {
    return { scheduleLayout, lineRefresh: 'deep-from-node' }
  }
  return { scheduleLayout, lineRefresh: 'local' }
}

function applyRemoteLineRefresh(node, lineRefresh) {
  if (!node || lineRefresh === 'none') return { parentDeep: false, nodeDeep: false, parentLocal: false, nodeLocal: false }
  const parent = node.parent
  if (lineRefresh === 'deep-from-parent') {
    if (parent && typeof parent.renderLine === 'function') parent.renderLine(true)
    else if (typeof node.renderLine === 'function') node.renderLine(true)
    return { parentDeep: !!parent, nodeDeep: !parent, parentLocal: false, nodeLocal: false }
  }
  if (lineRefresh === 'deep-from-node') {
    if (parent && typeof parent.renderLine === 'function') parent.renderLine(false)
    if (typeof node.renderLine === 'function') node.renderLine(true)
    return { parentDeep: false, nodeDeep: true, parentLocal: !!parent, nodeLocal: false }
  }
  if (parent && typeof parent.renderLine === 'function') parent.renderLine(false)
  if (typeof node.renderLine === 'function') node.renderLine(false)
  return { parentDeep: false, nodeDeep: false, parentLocal: !!parent, nodeLocal: true }
}

function shouldDeferDraftTreeCopy({ force, flagEnabled, hasPendingTree, remainingMs } = {}) {
  return !force && !!flagEnabled && !!hasPendingTree && Number(remainingMs) > 0
}

function graphemes(text) {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    return Array.from(
      new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text),
      item => item.segment
    )
  }
  return Array.from(text)
}

function wrapPlainTextLines(source, measureWidth, maxWidth) {
  const paragraphs = String(source == null ? '' : source).split(/\n/)
  const lines = []
  paragraphs.forEach(para => {
    const chars = graphemes(para)
    if (!chars.length) {
      lines.push('')
      return
    }
    let line = ''
    for (let i = 0; i < chars.length; i++) {
      const next = line + chars[i]
      if (!line || measureWidth(next) <= maxWidth) line = next
      else {
        lines.push(line)
        line = chars[i]
      }
    }
    if (line) lines.push(line)
  })
  return lines
}

function canvasPlainTextFallbackReason({
  text,
  fontFamily,
  fontSize,
  letterSpacing,
  fontWeight,
  fontStyle,
  fonts
} = {}) {
  const spacing = letterSpacing
  if (
    spacing != null &&
    spacing !== '' &&
    spacing !== 'normal' &&
    spacing !== 0 &&
    spacing !== '0' &&
    spacing !== '0px'
  ) {
    return 'letter-spacing'
  }
  if (typeof text === 'string' && /[\u202A-\u202E\u2066-\u2069]/.test(text)) {
    return 'bidi-override'
  }
  const checker = fonts || (typeof document !== 'undefined' ? document.fonts : null)
  if (checker && typeof checker.check === 'function') {
    try {
      const italic = fontStyle === 'italic'
      const bold =
        fontWeight === 'bold' ||
        fontWeight === '700' ||
        Number(fontWeight) >= 700
      const spec = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${Number(fontSize) || 16}px ${fontFamily || 'sans-serif'}`
      if (!checker.check(spec)) return 'font-not-ready'
    } catch (error) {
      return 'font-check-error'
    }
  }
  return ''
}

const api = {
  LINE_STYLE_KEYS,
  hasLineStyleKey,
  planRemoteNodePaint,
  applyRemoteLineRefresh,
  shouldDeferDraftTreeCopy,
  wrapPlainTextLines,
  canvasPlainTextFallbackReason
}

module.exports = api
module.exports.default = api
