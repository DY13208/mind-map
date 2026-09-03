const ROOM_PATH_RE = /^\/room(?:-([a-zA-Z0-9._-]+)|\/([a-zA-Z0-9._-]+))\/?$/

export function roomFromHashPath(hash) {
  const raw = String(hash || '').replace(/^#/, '')
  const path = raw.split('?')[0] || ''
  if (!path || path === '/') return ''
  const match = path.match(ROOM_PATH_RE)
  if (!match) return ''
  const suffix = match[1] || match[2] || ''
  if (!suffix) return ''
  if (match[1]) return `room-${suffix}`
  return /^room[-_]/i.test(suffix) ? suffix : `room-${suffix}`
}

export function roomFromLocation(route) {
  const fromRoute = route && route.query && route.query.room
  if (fromRoute) return String(fromRoute).trim()
  try {
    const fromSearch = new URLSearchParams(window.location.search).get('room')
    if (fromSearch) return String(fromSearch).trim()
    const hash = String(window.location.hash || '')
    const query = hash.indexOf('?') >= 0 ? hash.slice(hash.indexOf('?') + 1) : ''
    const fromHash = new URLSearchParams(query).get('room')
    if (fromHash) return String(fromHash).trim()
    return roomFromHashPath(hash)
  } catch (e) {
    return ''
  }
}
