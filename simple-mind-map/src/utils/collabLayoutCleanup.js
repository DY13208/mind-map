export function destroyStaleLayoutNodes(lastCache = {}, nextCache = {}) {
  const destroyed = []
  const duplicates = []
  Object.keys(lastCache || {}).forEach(uid => {
    const prev = lastCache[uid]
    const next = nextCache[uid]
    if (!prev) return
    if (!next) {
      if (typeof prev.destroy === 'function') prev.destroy()
      destroyed.push(uid)
      return
    }
    if (prev !== next) {
      if (typeof prev.destroy === 'function') prev.destroy()
      destroyed.push(uid)
      duplicates.push(uid)
      if (typeof console !== 'undefined' && console.error) {
        console.error('DUPLICATE_RENDER_NODE_UID', uid)
      }
    }
  })
  return { destroyed, duplicates }
}

export function collectRendererNodeUids(root) {
  const uids = []
  const walk = node => {
    if (!node) return
    const uid =
      (node.getData && node.getData('uid')) ||
      node.uid ||
      (node.nodeData && node.nodeData.data && node.nodeData.data.uid)
    const isGen = !!(node.isGeneralization || node.generalizationBelongNode)
    if (uid && !isGen) uids.push(uid)
    ;(node.children || []).forEach(walk)
  }
  walk(root)
  return uids
}

export function findDuplicateRendererUids(uids = []) {
  const seen = new Set()
  const dup = []
  uids.forEach(uid => {
    if (seen.has(uid)) dup.push(uid)
    else seen.add(uid)
  })
  return dup
}

export function countConnectorArtifacts(nodes = []) {
  let lines = 0
  ;(nodes || []).forEach(node => {
    lines += Array.isArray(node && node._lines) ? node._lines.length : 0
  })
  return lines
}

export function publishLayoutApplyTrace(partial = {}) {
  const row = {
    layout: partial.layout || '',
    source: partial.source || '',
    revision: Number(partial.revision || 0),
    timestamp: Date.now(),
    renderCount: Number(partial.renderCount || 0),
    layoutCount: Number(partial.layoutCount || 0)
  }
  if (typeof window === 'undefined') return row
  const list = Array.isArray(window.__LAYOUT_APPLY_TRACE__)
    ? window.__LAYOUT_APPLY_TRACE__
    : []
  list.push(row)
  window.__LAYOUT_APPLY_TRACE__ = list.slice(-40)
  return row
}

export function inspectLayoutRenderer(mindMap, prevLayout, nextLayout) {
  const renderer = mindMap && mindMap.renderer
  const root = renderer && renderer.root
  const uids = collectRendererNodeUids(root)
  const duplicates = findDuplicateRendererUids(uids)
  const cacheUids = Object.keys((renderer && renderer.nodeCache) || {})
  const stale = cacheUids.filter(uid => !uids.includes(uid) && uid)
  if (duplicates.length && typeof console !== 'undefined' && console.error) {
    console.error('LAYOUT_RENDER_STALE_NODE', {
      uids: duplicates,
      oldLayout: prevLayout,
      newLayout: nextLayout
    })
  }
  if (stale.length && typeof console !== 'undefined' && console.error) {
    console.error('LAYOUT_RENDER_STALE_NODE', {
      uids: stale,
      oldLayout: prevLayout,
      newLayout: nextLayout
    })
  }
  return {
    businessUidCount: uids.length,
    rendererUidCount: cacheUids.length,
    duplicates,
    stale
  }
}
