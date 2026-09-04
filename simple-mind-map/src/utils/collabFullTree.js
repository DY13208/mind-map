const FULL_TREE_REASONS = {
  IMPORT: true,
  VERSION_RESTORE: true,
  INITIAL_LEGACY_MIGRATION: true,
  AUTHORITATIVE_SNAPSHOT_RECOVERY: true,
  IMPORT_UNDO: true
}

const FORBIDDEN_FULL_TREE_FEATURES = {
  theme: true,
  layout: true,
  style: true,
  delete: true,
  undo: true,
  replaceAll: true,
  drag: true
}

let fullTreeContext = ''

function normalizeReason(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_')
}

function resolveFullTreeReason(extra = {}) {
  const direct = normalizeReason(
    extra.reason || extra.fullTreeReason || extra.allowReason
  )
  if (FULL_TREE_REASONS[direct]) return direct
  const source = String(extra.source || extra.feature || '').toLowerCase()
  if (source === 'import') return 'IMPORT'
  if (source === 'import_undo' || source === 'import-undo') return 'IMPORT_UNDO'
  if (source === 'restore' || source === 'version_restore') return 'VERSION_RESTORE'
  if (source === 'legacy-migrate' || source === 'legacy_migrate') {
    return 'INITIAL_LEGACY_MIGRATION'
  }
  if (source === 'authoritative_snapshot' || source === 'snapshot-recovery') {
    return 'AUTHORITATIVE_SNAPSHOT_RECOVERY'
  }
  return ''
}

function isFullTreeMutationAllowed(extra = {}) {
  const reason = resolveFullTreeReason({
    ...extra,
    reason: extra.reason || fullTreeContext
  })
  return !!(reason && FULL_TREE_REASONS[reason])
}

function withAllowedFullTreeMutation(reason, fn) {
  const next = normalizeReason(reason)
  if (!FULL_TREE_REASONS[next]) {
    const err = new Error('COLLAB_V2_UNEXPECTED_FULL_TREE_MUTATION')
    err.code = 'UNEXPECTED_FULL_TREE_MUTATION'
    err.reason = next || 'UNKNOWN'
    throw err
  }
  const prev = fullTreeContext
  fullTreeContext = next
  const restore = () => {
    fullTreeContext = prev
  }
  try {
    const out = fn()
    if (out && typeof out.then === 'function') {
      return Promise.resolve(out).then(
        value => {
          restore()
          return value
        },
        err => {
          restore()
          throw err
        }
      )
    }
    restore()
    return out
  } catch (err) {
    restore()
    throw err
  }
}

function currentFullTreeReason() {
  return fullTreeContext || ''
}

function publishImportTrace(row = {}) {
  const next = {
    timestamp: Date.now(),
    ...row
  }
  if (typeof window === 'undefined') return next
  window.__IMPORT_TRACE__ = next
  if (!Array.isArray(window.__IMPORT_TRACE_LOG__)) {
    window.__IMPORT_TRACE_LOG__ = []
  }
  window.__IMPORT_TRACE_LOG__.push(next)
  if (window.__IMPORT_TRACE_LOG__.length > 50) {
    window.__IMPORT_TRACE_LOG__.shift()
  }
  return next
}

const api = {
  FULL_TREE_REASONS,
  FORBIDDEN_FULL_TREE_FEATURES,
  resolveFullTreeReason,
  isFullTreeMutationAllowed,
  withAllowedFullTreeMutation,
  currentFullTreeReason,
  publishImportTrace
}

module.exports = api
module.exports.default = api
