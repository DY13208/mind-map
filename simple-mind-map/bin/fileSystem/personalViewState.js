// Per-node optimistic versions: independent changes merge, stale changes are ignored.
// The store must call this while holding the user's state row lock.
function mergePersonalViewState(previous = {}, patch = {}) {
  const { expand, expandBase, ...appearance } = patch
  delete appearance.expandVersions
  const next = { ...previous, ...appearance }
  if (expand) {
    next.expand = { ...(previous.expand || {}) }
    next.expandVersions = { ...(previous.expandVersions || {}) }
    for (const [uid, value] of Object.entries(expand)) {
      const version = Object.prototype.hasOwnProperty.call(next.expandVersions, uid) ? next.expandVersions[uid] : 0
      if (expandBase && expandBase[uid] !== version) continue
      Object.defineProperty(next.expand, uid, { value, enumerable: true, configurable: true, writable: true })
      Object.defineProperty(next.expandVersions, uid, { value: version + 1, enumerable: true, configurable: true, writable: true })
    }
  }
  return next
}
module.exports = { mergePersonalViewState }
