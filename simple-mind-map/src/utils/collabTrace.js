import collabTraceSwitch from './collabTraceSwitch.cjs'

function runtimeTraceFlag() {
  return collabTraceSwitch.isCollabTraceOn(
    typeof window === 'undefined' ? null : window
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
const performanceListeners = new Set()

// Performance collection is independent of verbose console tracing.
export function subscribeCollabPerformance(fn) {
  performanceListeners.add(fn)
  return () => performanceListeners.delete(fn)
}
export function recordCollabPerformance(stage, detail = {}) {
  performanceListeners.forEach(fn => {
    try { fn(stage, detail) } catch (_) { /* diagnostics never affect collaboration */ }
  })
}

export function setCollabTraceSnapshotProvider(fn) {
  snapshotProvider = typeof fn === 'function' ? fn : null
}

export function collabPersistSnapshot() {
  if (!runtimeTraceFlag()) return {}
  return readTraceSnapshot()
}

function readTraceSnapshot() {
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

export function moveFullTreeForbidden(reason, extra = {}) {
  const row = { reason, ...extra }
  try {
    window.__MOVE_FULL_TREE_HITS__ = Number(window.__MOVE_FULL_TREE_HITS__ || 0) + 1
  } catch (err) {
    // ignore
  }
  if (typeof console !== 'undefined' && console.error) {
    console.error('MOVE_FULL_TREE_RESET_FORBIDDEN', row)
  }
  collabTrace('MOVE_FULL_TREE_RESET_FORBIDDEN', row)
}

export function collabTrace(stage, detail = {}) {
  recordCollabPerformance(stage, detail)
  if (!runtimeTraceFlag()) return
  const snap = readTraceSnapshot()
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
