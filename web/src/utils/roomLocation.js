const ROOM_PATH_RE = /^\/room(?:-([a-zA-Z0-9._-]+)|\/([a-zA-Z0-9._-]+))\/?$/

export function roomFromHashPath(hashOrPath) {
  const raw = String(hashOrPath || '').replace(/^#/, '')
  const path = raw.split('?')[0] || ''
  if (!path || path === '/') return ''
  const match = path.match(ROOM_PATH_RE)
  if (!match) return ''
  const suffix = match[1] || match[2] || ''
  if (!suffix) return ''
  if (match[1]) return `room-${suffix}`
  return /^room[-_]/i.test(suffix) ? suffix : `room-${suffix}`
}

export function roomFromPathname(pathname) {
  return roomFromHashPath(pathname)
}

/**
 * Priority:
 * 1. Vue route.query.room
 * 2. window.location.search ?room=
 * 3. clean pathname /room/:roomKey or /room-xxx
 * 4. legacy hash (compat only)
 */
export function roomFromLocation(route) {
  const fromRoute = route && route.query && route.query.room
  if (fromRoute) return String(fromRoute).trim()
  try {
    const fromSearch = new URLSearchParams(window.location.search).get('room')
    if (fromSearch) return String(fromSearch).trim()
    const fromPath = roomFromPathname(window.location.pathname || '')
    if (fromPath) return fromPath
    const hash = String(window.location.hash || '')
    const query = hash.indexOf('?') >= 0 ? hash.slice(hash.indexOf('?') + 1) : ''
    const fromHash = new URLSearchParams(query).get('room')
    if (fromHash) return String(fromHash).trim()
    return roomFromHashPath(hash)
  } catch (e) {
    return ''
  }
}

export function buildInviteUrl(roomKey, origin) {
  const key = String(roomKey || '').trim()
  const base = String(
    origin ||
      (typeof window !== 'undefined' && window.location
        ? window.location.origin
        : '')
  ).replace(/\/$/, '')
  return `${base}/?room=${encodeURIComponent(key)}`
}

/**
 * One-shot legacy hash → clean history URL. Uses replaceState (no loop).
 * Returns the clean URL path+search, or null if nothing changed.
 */
export function migrateLegacyHashUrl(
  locationLike = typeof window !== 'undefined' ? window.location : null,
  historyLike = typeof window !== 'undefined' ? window.history : null
) {
  if (!locationLike) return null
  const hash = String(locationLike.hash || '')
  if (!hash) return null

  const raw = hash.replace(/^#/, '')
  const pathAndQuery = raw || '/'
  const qIdx = pathAndQuery.indexOf('?')
  let pathPart = qIdx >= 0 ? pathAndQuery.slice(0, qIdx) : pathAndQuery
  const hashQuery = qIdx >= 0 ? pathAndQuery.slice(qIdx + 1) : ''
  if (!pathPart) pathPart = '/'
  if (!pathPart.startsWith('/')) pathPart = '/' + pathPart

  const hashParams = new URLSearchParams(hashQuery)
  const existing = new URLSearchParams(locationLike.search || '')
  const merged = new URLSearchParams(existing)
  hashParams.forEach((value, key) => merged.set(key, value))

  let targetPath = pathPart
  const pathRoom = roomFromHashPath(pathPart)
  if (pathRoom) {
    targetPath = '/'
    if (!merged.get('room')) merged.set('room', pathRoom)
  }

  const qs = merged.toString()
  const next = `${targetPath}${qs ? `?${qs}` : ''}`
  const current = `${locationLike.pathname || '/'}${locationLike.search || ''}`
  if (next === current && !hash) return null

  if (historyLike && typeof historyLike.replaceState === 'function') {
    historyLike.replaceState(null, '', next)
  }
  return next
}
