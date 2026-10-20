import { resolveShellMode, withShell, SHELL_MODE_VALUES } from './shellMode'
import { armSkipMyMapsRedirect } from './roomLocation'

const NAV_STORAGE_PREFIX = 'mind-map:file-nav:v1:'
const NAV_ID_PATTERN = /^[A-Za-z0-9_-]{16,80}$/
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/
const PAGE_SIZES = [10, 20, 50, 100]
const MAX_NAV_RECORDS = 50
const MAX_NAV_RECORD_LENGTH = 32768
const LIST_PATH_PATTERN = /^\/(files|my-maps)(?:\/(recent|favorites|shared|trash|folder\/([^/]+)))?\/?$/

function queryValue(query, key) {
  const value = query && query[key]
  return typeof value === 'string' ? value : ''
}

function safeStorage(storage) {
  if (storage !== undefined) return storage
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch (error) {
    return null
  }
}

function safeId(value) {
  const id = String(value == null ? '' : value).trim()
  return RESOURCE_ID_PATTERN.test(id) && id !== '.' && id !== '..' ? id : ''
}

function makeNavigationId() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID().replace(/-/g, '')
    }
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      const bytes = new Uint8Array(18)
      crypto.getRandomValues(bytes)
      return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
    }
  } catch (error) {
    /* Fall through to a tab-local opaque token. */
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random()
    .toString(36)
    .slice(2)}`
}

function splitReturnTo(value) {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (!raw || raw.length > 2048 || !raw.startsWith('/') || raw.startsWith('//')) {
    return null
  }
  if (raw.includes('#') || raw.includes('\\')) return null
  const queryAt = raw.indexOf('?')
  const rawPath = queryAt === -1 ? raw : raw.slice(0, queryAt)
  const rawQuery = queryAt === -1 ? '' : raw.slice(queryAt + 1)
  let path
  try {
    path = decodeURIComponent(rawPath)
  } catch (error) {
    return null
  }
  const normalizedPath = path.length > 1 ? path.replace(/\/$/, '') : path
  const match = normalizedPath.match(LIST_PATH_PATTERN)
  if (!match) return null

  const base = match[1]
  const section = match[2] || ''
  if (base === 'my-maps' && ['recent', 'shared', 'trash'].includes(section)) {
    return null
  }
  const folderId = section.startsWith('folder/') ? safeId(section.slice(7)) : ''
  if (section.startsWith('folder/') && !folderId) return null
  const canonicalPath = folderId
    ? `/${base}/folder/${encodeURIComponent(folderId)}`
    : normalizedPath

  const params = new URLSearchParams(rawQuery)
  const keys = Array.from(params.keys())
  if (keys.some(key => key !== 'team') || params.getAll('team').length > 1) {
    return null
  }
  const teamId = safeId(params.get('team'))
  if (params.has('team') && (!teamId || !['', 'folder'].includes(section) && !section.startsWith('folder/'))) {
    return null
  }
  const query = teamId ? `?team=${encodeURIComponent(teamId)}` : ''
  return { path: canonicalPath, teamId, value: canonicalPath + query }
}

/**
 * Canonicalize the only list destinations accepted by editor return links.
 * The function deliberately rejects editor paths, redirects, external URLs,
 * hashes, and query parameters outside the optional team scope.
 */
export function normalizeReturnTo(value) {
  if (value && typeof value === 'object') {
    const path = String(value.path || '')
    const query = value.query || {}
    const team = queryValue(query, 'team')
    return splitReturnTo(path + (team ? `?team=${encodeURIComponent(team)}` : ''))?.value || ''
  }
  return splitReturnTo(value)?.value || ''
}

export function captureListState(state = {}) {
  const scroll = state.scroll && typeof state.scroll === 'object' ? state.scroll : {}
  const page = Math.floor(Number(state.page) || 1)
  const limitValue = Number(state.limit)
  return {
    search: String(state.search || '').slice(0, 500),
    roleFilter: String(state.roleFilter || '').slice(0, 80),
    sort: String(state.sort || 'updatedAt').slice(0, 80),
    page: Math.max(1, Math.min(page, 1000000)),
    limit: PAGE_SIZES.includes(limitValue) ? limitValue : 20,
    view: state.view === 'list' ? 'list' : 'card',
    scroll: {
      top: Math.max(0, Number(scroll.top) || 0),
      left: Math.max(0, Number(scroll.left) || 0)
    }
  }
}

export function restoreListState(value, options = {}) {
  const source = value && value.state ? value.state : value
  if (!source || typeof source !== 'object') return null
  const state = captureListState(source)
  if (options.total != null) {
    state.page = clampListPage(state.page, options.total, state.limit)
  }
  return state
}

export function clampListPage(page, total, limit) {
  const size = PAGE_SIZES.includes(Number(limit)) ? Number(limit) : 20
  const totalItems = Math.max(0, Number(total) || 0)
  const maxPage = Math.max(1, Math.ceil(totalItems / size))
  return Math.min(Math.max(1, Math.floor(Number(page) || 1)), maxPage)
}

export function isShellOnlyRouteChange(to, from) {
  if (!to || !from || to.path !== from.path) return false
  const withoutShell = route => {
    const query = route.query || {}
    return Object.keys(query)
      .filter(key => key !== 'shell' && key !== 'nav')
      .sort()
      .map(key => [key, query[key]])
  }
  return JSON.stringify(withoutShell(to)) === JSON.stringify(withoutShell(from))
}

function routeQuery(route) {
  return route && route.query && typeof route.query === 'object' ? route.query : {}
}

function sourceReturnTo(route) {
  const query = routeQuery(route)
  if (queryValue(query, 'returnTo')) return normalizeReturnTo(query.returnTo)
  return normalizeReturnTo({ path: route && route.path, query })
}

function storeRecord(storage, record) {
  const target = safeStorage(storage)
  if (!target || typeof target.setItem !== 'function') return
  try {
    const serialized = JSON.stringify(record)
    if (serialized.length > MAX_NAV_RECORD_LENGTH) return
    const keys = []
    for (let index = 0; index < Number(target.length || 0); index++) {
      const key = target.key && target.key(index)
      if (typeof key === 'string' && key.startsWith(NAV_STORAGE_PREFIX)) {
        let createdAt = 0
        try {
          const existing = JSON.parse(target.getItem(key) || 'null')
          createdAt = Number(existing && existing.createdAt) || 0
        } catch (error) {
          /* Invalid records are the first candidates for removal. */
        }
        keys.push({ key, createdAt })
      }
    }
    keys.sort((left, right) => left.createdAt - right.createdAt)
    while (keys.length >= MAX_NAV_RECORDS) {
      const oldest = keys.shift()
      if (target.removeItem) target.removeItem(oldest.key)
    }
    target.setItem(NAV_STORAGE_PREFIX + record.nav, serialized)
  } catch (error) {
    /* Navigation still works without the optional tab-local state snapshot. */
  }
}

export function createEditorLocation({ route, room, state, folderName, storage } = {}) {
  const roomKey = safeId(
    typeof room === 'string' ? room : room && (room.roomKey || room.id)
  )
  const returnTo = normalizeReturnTo(route)
  const shell = resolveShellMode(route || {})
  const query = { room: roomKey }
  if (shell) query.shell = shell

  if (roomKey && returnTo) {
    const nav = makeNavigationId()
    query.returnTo = returnTo
    query.nav = nav
    storeRecord(storage, {
      version: 1,
      nav,
      roomKey,
      returnTo,
      shell,
      folderName: String(folderName || '').trim().slice(0, 200),
      state: captureListState(state),
      createdAt: Date.now()
    })
  }
  return withShell({ path: '/', query }, route || {})
}

export function readReturnContext(route, storage) {
  const query = routeQuery(route)
  const nav = queryValue(query, 'nav')
  if (!NAV_ID_PATTERN.test(nav)) return null
  const expectedReturnTo = sourceReturnTo(route)
  if (!expectedReturnTo) return null
  const target = safeStorage(storage)
  if (!target || typeof target.getItem !== 'function') return null
  let record
  try {
    record = JSON.parse(target.getItem(NAV_STORAGE_PREFIX + nav) || 'null')
  } catch (error) {
    return null
  }
  if (
    !record ||
    record.version !== 1 ||
    record.nav !== nav ||
    normalizeReturnTo(record.returnTo) !== expectedReturnTo ||
    !safeId(record.roomKey)
  ) {
    return null
  }
  return {
    ...record,
    state: restoreListState(record.state)
  }
}

function locationFromReturnTo(value) {
  const parsed = splitReturnTo(value)
  if (!parsed) return null
  return {
    path: parsed.path,
    query: parsed.teamId ? { team: parsed.teamId } : {}
  }
}

function shellForReturn(route, returnTo, context) {
  const query = routeQuery(route)
  const explicit = queryValue(query, 'shell')
  if (SHELL_MODE_VALUES.includes(explicit)) return resolveShellMode(route)
  if (context && SHELL_MODE_VALUES.includes(context.shell)) return context.shell
  if (returnTo) {
    const target = locationFromReturnTo(returnTo)
    if (target) return resolveShellMode(target)
  }
  // Old direct editor links historically returned to the sidebar-free entry.
  return 'focus'
}

function fileFolderTarget(route, file, shell) {
  const folderId = safeId(file && (file.folderId || file.folder_id))
  const explicitRoot = file && (file.folderId === 'root' || file.folderId === 'null')
  const basePath = shell === 'full' ? '/files' : '/my-maps'
  if (!folderId || explicitRoot) return { path: basePath, query: {} }
  const teamId = safeId(file && (file.teamId || file.team_id))
  return {
    path: `${basePath}/folder/${encodeURIComponent(folderId)}`,
    query: teamId ? { team: teamId } : {}
  }
}

export function resolveReturnTarget({ route, file } = {}) {
  const query = routeQuery(route)
  const context = readReturnContext(route)
  const returnTo = normalizeReturnTo(query.returnTo) || (context && context.returnTo) || ''
  const shell = shellForReturn(route, returnTo, context)
  let target = returnTo ? locationFromReturnTo(returnTo) : null
  if (!target) target = fileFolderTarget(route, file, shell)

  const nextQuery = { ...(target.query || {}), shell }
  if (returnTo && NAV_ID_PATTERN.test(queryValue(query, 'nav'))) {
    nextQuery.nav = queryValue(query, 'nav')
  }
  const shellSource = { path: target.path, query: { shell } }
  return withShell({ path: target.path, query: nextQuery }, shellSource)
}

export async function navigateToFileList(router, { route, file } = {}) {
  const target = resolveReturnTarget({ route, file })
  if (target.path === '/my-maps') armSkipMyMapsRedirect()
  if (!router || typeof router.push !== 'function') return target
  await router.push(target)
  return target
}

export function getReturnLabel(route, file, folders = []) {
  const context = readReturnContext(route)
  const returnTo = normalizeReturnTo(routeQuery(route).returnTo) || (context && context.returnTo) || ''
  const parsed = splitReturnTo(returnTo)
  const isFolderReturn = !!(parsed && parsed.path.includes('/folder/'))
  const isTeamRootReturn = !!(parsed && parsed.teamId && !isFolderReturn)
  if (isFolderReturn || isTeamRootReturn) {
    const fromContext = context && String(context.folderName || '').trim()
    if (fromContext && !['根目录', '脑图'].includes(fromContext)) {
      return `返回目录：${fromContext}`
    }
    if (isFolderReturn) {
      const folderName = String((file && file.folderName) || '').trim()
      if (folderName && !['根目录', '脑图'].includes(folderName)) {
        return `返回目录：${folderName}`
      }
      const folderId = safeId(file && (file.folderId || file.folder_id))
      const folder = folderId && folders.find(item => String(item.id) === folderId)
      if (folder && folder.name) return `返回目录：${folder.name}`
    }
  }
  return '返回脑图列表'
}

function findScrollTarget(root, environment) {
  const doc = environment.document
  let current = root
  while (current && current !== doc && current !== doc.body) {
    const style = environment.getComputedStyle
      ? environment.getComputedStyle.call(environment.window, current)
      : null
    const overflowY = style && style.overflowY
    const overflowX = style && style.overflowX
    const scrollableStyle = /auto|scroll|overlay/.test(`${overflowY || ''} ${overflowX || ''}`)
    if (scrollableStyle && current.scrollHeight > current.clientHeight + 1) {
      return current
    }
    current = current.parentElement
  }
  return environment.document.scrollingElement || environment.document.documentElement || environment.window
}

export function captureScrollPosition(root, environment) {
  const env = environment || {
    window: typeof window === 'undefined' ? null : window,
    document: typeof document === 'undefined' ? null : document,
    getComputedStyle: typeof getComputedStyle === 'undefined' ? null : getComputedStyle
  }
  if (!env.document || !env.window) return { top: 0, left: 0 }
  const target = findScrollTarget(root, env)
  if (target === env.window) {
    return {
      top: Math.max(0, Number(env.window.scrollY) || Number(env.document.documentElement.scrollTop) || 0),
      left: Math.max(0, Number(env.window.scrollX) || Number(env.document.documentElement.scrollLeft) || 0)
    }
  }
  return {
    top: Math.max(0, Number(target.scrollTop) || 0),
    left: Math.max(0, Number(target.scrollLeft) || 0)
  }
}

export function restoreScrollPosition(position, root, environment) {
  const env = environment || {
    window: typeof window === 'undefined' ? null : window,
    document: typeof document === 'undefined' ? null : document,
    getComputedStyle: typeof getComputedStyle === 'undefined' ? null : getComputedStyle
  }
  if (!env.document || !env.window) return
  const target = findScrollTarget(root, env)
  const top = Math.max(0, Number(position && position.top) || 0)
  const left = Math.max(0, Number(position && position.left) || 0)
  if (target === env.window) {
    const scrollingElement = env.document.scrollingElement || env.document.documentElement
    env.window.scrollTo(
      Math.min(left, Math.max(0, scrollingElement.scrollWidth - scrollingElement.clientWidth)),
      Math.min(top, Math.max(0, scrollingElement.scrollHeight - scrollingElement.clientHeight))
    )
    return
  }
  target.scrollLeft = Math.min(left, Math.max(0, target.scrollWidth - target.clientWidth))
  target.scrollTop = Math.min(top, Math.max(0, target.scrollHeight - target.clientHeight))
}
