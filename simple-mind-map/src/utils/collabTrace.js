function runtimeTraceFlag() {
  if (typeof window === 'undefined') return false
  if (window.__COLLAB_V2_TRACE__ === false) return false
  if (window.__COLLAB_V2_TRACE__ === true) return true
  try {
    if (window.localStorage && window.localStorage.getItem('COLLAB_V2_TRACE') === '1') {
      return true
    }
  } catch (err) {
    // ignore
  }
  const runtime = window.__MIND_MAP_RUNTIME__ || {}
  if (runtime.collabV2Trace === true || runtime.collabV2Trace === '1') return true
  if (runtime.collabV2Trace === false || runtime.collabV2Trace === '0') return false
  const search = window.location && window.location.search
  if (search && /(?:\?|&)collabTrace=1(?:&|$)/.test(search)) return true
  const host = (window.location && window.location.hostname) || ''
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    /^192\.168\./.test(host) ||
    /^10\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  )
}

export function isCollabTraceOn() {
  return runtimeTraceFlag()
}

export function createTraceId() {
  const rand = Math.random().toString(16).slice(2, 10)
  return 'tr-' + Date.now().toString(16) + '-' + rand
}

let snapshotProvider = null

export function setCollabTraceSnapshotProvider(fn) {
  snapshotProvider = typeof fn === 'function' ? fn : null
}

export function collabPersistSnapshot() {
  try {
    return snapshotProvider ? snapshotProvider() || {} : {}
  } catch (err) {
    return {}
  }
}

export function isUndoTraceOn() {
  if (typeof window === 'undefined') return false
  if (window.__UNDO_TRACE__ === true) return true
  try {
    if (window.localStorage && window.localStorage.getItem('UNDO_TRACE') === '1') {
      return true
    }
  } catch (err) {
    // ignore
  }
  return false
}

export function undoTrace(stage, detail = {}) {
  if (!isUndoTraceOn()) return
  const row = {
    t: Date.now(),
    stage,
    ...(detail && typeof detail === 'object' ? detail : { detail })
  }
  try {
    if (!Array.isArray(window.__UNDO_TRACE_LOG__)) window.__UNDO_TRACE_LOG__ = []
    window.__UNDO_TRACE_LOG__.push(row)
    if (window.__UNDO_TRACE_LOG__.length > 200) window.__UNDO_TRACE_LOG__.shift()
  } catch (err) {
    // ignore
  }
  if (typeof console !== 'undefined' && console.info) {
    console.info('[undo-trace]', stage, row)
  }
}

export function undoFullTreeForbidden(reason, extra = {}) {
  const row = { reason, ...extra }
  try {
    window.__UNDO_FULL_TREE_HITS__ = Number(window.__UNDO_FULL_TREE_HITS__ || 0) + 1
  } catch (err) {
    // ignore
  }
  if (typeof console !== 'undefined' && console.error) {
    console.error('UNDO_FULL_TREE_REPLACE_FORBIDDEN', row)
  }
  undoTrace('UNDO_FULL_TREE_REPLACE_FORBIDDEN', row)
}

export function collabTrace(stage, detail = {}) {
  if (!runtimeTraceFlag()) return
  const snap = collabPersistSnapshot()
  const row = {
    t: Date.now(),
    stage,
    ...snap,
    ...(detail && typeof detail === 'object' ? detail : { detail })
  }
  try {
    if (!Array.isArray(window.__V2_TRACE_LOG__)) window.__V2_TRACE_LOG__ = []
    window.__V2_TRACE_LOG__.push(row)
    if (window.__V2_TRACE_LOG__.length > 400) window.__V2_TRACE_LOG__.shift()
  } catch (err) {
    // ignore
  }
  if (typeof console !== 'undefined' && console.info) {
    console.info('[v2-trace]', stage, row)
  }
}
