const ROOM_PATH_RE = /^\/room(?:-([a-zA-Z0-9._-]+)|\/([a-zA-Z0-9._-]+))\/?$/
const LAST_ROOM_STORAGE_KEY = 'cpd:lastRoom'
const SESSION_STORAGE_KEY = 'SIMPLE_MIND_MAP_SESSION'
const SOP_ROOM_STORAGE_KEY = 'assistant.sopRoom'
const SKIP_MY_MAPS_REDIRECT_KEY = 'cpd:skipMyMapsRedirect'

export function rememberLastRoom(roomKey) {
  const key = String(roomKey || '').trim()
  if (!key) return
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(LAST_ROOM_STORAGE_KEY, key)
    // 与协作会话对齐，避免只写新 key 时旧环境读不到
    try {
      const raw = localStorage.getItem(SESSION_STORAGE_KEY)
      const prev = raw ? JSON.parse(raw) : {}
      localStorage.setItem(
        SESSION_STORAGE_KEY,
        JSON.stringify({
          ...(prev && typeof prev === 'object' ? prev : {}),
          backend: 'collab',
          room: key,
          at: Date.now()
        })
      )
    } catch (e) {
      /* ignore parse */
    }
  } catch (e) {
    /* ignore quota / private mode */
  }
}

function roomFromSessionStorage() {
  try {
    if (typeof localStorage === 'undefined') return ''
    const raw = localStorage.getItem(SESSION_STORAGE_KEY)
    if (!raw) return ''
    const session = JSON.parse(raw)
    const room = session && session.room
    return room ? String(room).trim() : ''
  } catch (e) {
    return ''
  }
}

export function getLastRoom() {
  try {
    if (typeof localStorage === 'undefined') return ''
    const fromKey = String(
      localStorage.getItem(LAST_ROOM_STORAGE_KEY) || ''
    ).trim()
    if (fromKey) return fromKey
    const fromSession = roomFromSessionStorage()
    if (fromSession) return fromSession
    return String(localStorage.getItem(SOP_ROOM_STORAGE_KEY) || '').trim()
  } catch (e) {
    return ''
  }
}

export function clearLastRoom() {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(LAST_ROOM_STORAGE_KEY)
    }
  } catch (e) {
    /* ignore */
  }
}

/** 编辑页点返回时：本次进入 /my-maps 不跳回房间 */
export function armSkipMyMapsRedirect() {
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(SKIP_MY_MAPS_REDIRECT_KEY, '1')
    }
  } catch (e) {
    /* ignore */
  }
}

export function consumeSkipMyMapsRedirect() {
  try {
    if (typeof sessionStorage === 'undefined') return false
    const skip = sessionStorage.getItem(SKIP_MY_MAPS_REDIRECT_KEY) === '1'
    if (skip) sessionStorage.removeItem(SKIP_MY_MAPS_REDIRECT_KEY)
    return skip
  } catch (e) {
    return false
  }
}

/** 编辑页返回脑图列表（跳过「回房间」重定向） */
export function navigateToMyMaps(router) {
  armSkipMyMapsRedirect()
  if (!router || typeof router.push !== 'function') return Promise.resolve()
  return router.push({ path: '/my-maps' }).catch(() => {})
}

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
