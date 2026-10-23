// Client-side rules for personal expand/appearance.
// Persist payload stays { expand, theme, layout, themeConfig }.

export const EXPAND_SOURCE = {
  USER: 'user',
  REVEAL: 'reveal',
  OVERVIEW: 'overview'
}

export function normalizeExpandSource(meta) {
  if (!meta || typeof meta !== 'object') return EXPAND_SOURCE.USER
  const source = meta.source || meta.reason
  if (source === EXPAND_SOURCE.REVEAL || source === EXPAND_SOURCE.OVERVIEW) return source
  return EXPAND_SOURCE.USER
}

export function shouldPersistExpandChange(meta, options = {}) {
  if (options.overviewFrozen || options.applying) return false
  return normalizeExpandSource(meta) === EXPAND_SOURCE.USER
}

export function shouldAcceptRemoteViewState(options = {}) {
  if (options.stopped) return false
  if (options.roomKey && options.boundRoomKey && options.roomKey !== options.boundRoomKey) {
    return false
  }
  if (options.fetchId != null && options.latestFetchId != null && options.fetchId !== options.latestFetchId) {
    return false
  }
  if (options.locallyChanged) return false
  return true
}

// Same-session late GET must not beat a newer local edit.
// Cross-device still uses remote-over-local when this session has not edited.
export function mergeIncomingExpand(local, remote, options = {}) {
  const left = local && typeof local === 'object' && !Array.isArray(local) ? local : {}
  const right = remote && typeof remote === 'object' && !Array.isArray(remote) ? remote : {}
  if (!shouldAcceptRemoteViewState(options)) return { ...left }
  return { ...left, ...right }
}

export function copyExpandState(state) {
  if (!state || typeof state !== 'object') return {}
  try {
    return JSON.parse(JSON.stringify(state))
  } catch (err) {
    return { ...state }
  }
}
