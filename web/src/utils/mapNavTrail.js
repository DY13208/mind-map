// 子脑图返回路径：只记录本标签页里用户真实走过的「上级 → 子脑图」路径，不是脑图数据里的父子关系。
// 存在 history.state 里：每条历史记录各存一份，刷新、前进后退自动取回对应那份；
// 新标签页 / 直接打开链接没有这份状态，所以不会出现返回按钮。
// vue-router 3 的 replace 会保留 history.state 里的自定义字段；它自带的 key 在刷新后会变，不能拿来认条目。

export const MAP_NAV_STATE_FIELD = 'mindMapNav'
export const MAP_NAV_VERSION = 1
export const MAX_MAP_NAV_DEPTH = 20

const ROOM_KEY_PATTERN = /^[a-zA-Z0-9._-]{1,80}$/
const NAV_ID_PATTERN = /^[a-zA-Z0-9-]{8,64}$/
const VIEW_RESTORE_KEY = 'mind-map-nav-view-restore'
const VIEW_RESTORE_TTL_MS = 60 * 1000

function defaultHistory() {
  return typeof window !== 'undefined' ? window.history : null
}

function defaultStorage() {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null
  } catch (err) {
    return null
  }
}

export function isValidRoomKey(value) {
  return typeof value === 'string' && ROOM_KEY_PATTERN.test(value)
}

function isValidNavId(value) {
  return typeof value === 'string' && NAV_ID_PATTERN.test(value)
}

export function createNavId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return (
    Date.now().toString(36) +
    '-' +
    Math.random()
      .toString(36)
      .slice(2, 12)
  )
}

function sanitizeTrail(trail) {
  if (!Array.isArray(trail) || trail.length > MAX_MAP_NAV_DEPTH) return null
  const result = []
  for (const item of trail) {
    if (!item || !isValidRoomKey(item.room) || !isValidNavId(item.navId)) {
      return null
    }
    result.push({ room: item.room, navId: item.navId })
  }
  return result
}

/** 读当前历史条目的导航状态；结构不对、或不属于 currentRoom（被 replace 换过房间）都视为没有 */
export function readEntryNav(state, currentRoom) {
  if (!isValidRoomKey(currentRoom)) return null
  const nav = state && state[MAP_NAV_STATE_FIELD]
  if (!nav || nav.version !== MAP_NAV_VERSION) return null
  if (nav.room !== currentRoom || !isValidNavId(nav.navId)) return null
  const trail = sanitizeTrail(nav.trail)
  if (!trail) return null
  // 路径里出现当前脑图 = 状态被篡改或已过期，返回它会形成循环
  if (trail.some(item => item.room === currentRoom)) return null
  return { version: MAP_NAV_VERSION, navId: nav.navId, room: nav.room, trail }
}

/**
 * 当前脑图的返回上下文：null = 不显示返回按钮。
 * toMain：上一级就是用户进入的第一张脑图（显示「返回主脑图」）。
 */
export function getMapNavContext(state, currentRoom) {
  const nav = readEntryNav(state, currentRoom)
  if (!nav || !nav.trail.length) return null
  return {
    parent: nav.trail[nav.trail.length - 1],
    depth: nav.trail.length,
    toMain: nav.trail.length === 1
  }
}

function writeEntryNav(historyApi, nav) {
  if (!historyApi || typeof historyApi.replaceState !== 'function') return false
  try {
    const state = Object.assign({}, historyApi.state, {
      [MAP_NAV_STATE_FIELD]: nav
    })
    // 不传 URL：只改状态，不动地址栏
    historyApi.replaceState(state, '')
    return true
  } catch (err) {
    console.warn('[mapNav] write history state failed', err)
    return false
  }
}

/** 进入子脑图前调用：保证当前条目有自己的 navId，供子脑图记作上级 */
export function ensureEntryNav(currentRoom, historyApi = defaultHistory()) {
  if (!isValidRoomKey(currentRoom) || !historyApi) return null
  const existing = readEntryNav(historyApi.state, currentRoom)
  if (existing) return existing
  const nav = {
    version: MAP_NAV_VERSION,
    navId: createNavId(),
    room: currentRoom,
    trail: []
  }
  return writeEntryNav(historyApi, nav) ? nav : null
}

/** 子脑图的返回路径 = 上级的路径 + 上级本身；子脑图已在路径里时截断，避免循环 */
export function buildChildTrail(parentNav, childRoom) {
  if (!parentNav || !isValidRoomKey(childRoom)) return []
  const path = parentNav.trail.concat({
    room: parentNav.room,
    navId: parentNav.navId
  })
  const loopIndex = path.findIndex(item => item.room === childRoom)
  const trail = loopIndex === -1 ? path : path.slice(0, loopIndex)
  return trail.slice(-MAX_MAP_NAV_DEPTH)
}

/** 进入子脑图后（新历史条目已生成）调用 */
export function writeChildEntryNav(childRoom, trail, historyApi = defaultHistory()) {
  const safeTrail = sanitizeTrail(trail)
  if (!isValidRoomKey(childRoom) || !safeTrail) return null
  const nav = {
    version: MAP_NAV_VERSION,
    navId: createNavId(),
    room: childRoom,
    trail: safeTrail
  }
  return writeEntryNav(historyApi, nav) ? nav : null
}

/** 后退落到的条目是不是记录的那个上级条目 */
export function isParentEntry(state, parent) {
  if (!parent) return false
  const nav = readEntryNav(state, parent.room)
  return !!nav && nav.navId === parent.navId
}

/** 后退没落到上级条目时，用 replace 落到上级后补写的状态（沿用上级原来的路径） */
export function buildParentEntryNav(childTrail, parent) {
  const trail = sanitizeTrail(childTrail)
  if (!trail || !parent) return null
  const index = trail.findIndex(
    item => item.room === parent.room && item.navId === parent.navId
  )
  if (index === -1) return null
  return {
    version: MAP_NAV_VERSION,
    navId: parent.navId,
    room: parent.room,
    trail: trail.slice(0, index)
  }
}

export function replaceEntryNav(nav, historyApi = defaultHistory()) {
  if (!nav || !readEntryNav({ [MAP_NAV_STATE_FIELD]: nav }, nav.room)) return false
  return writeEntryNav(historyApi, nav)
}

/** 返回上级时打个一次性标记：上级脑图打开后恢复离开时的画布位置（跨整页刷新也有效） */
export function markMapNavViewRestore(room, storage = defaultStorage()) {
  if (!isValidRoomKey(room) || !storage) return
  try {
    storage.setItem(VIEW_RESTORE_KEY, JSON.stringify({ room, at: Date.now() }))
  } catch (err) {
    // ignore quota
  }
}

export function consumeMapNavViewRestore(room, storage = defaultStorage()) {
  if (!isValidRoomKey(room) || !storage) return false
  try {
    const raw = storage.getItem(VIEW_RESTORE_KEY)
    if (!raw) return false
    const mark = JSON.parse(raw)
    const fresh =
      !!mark && Date.now() - Number(mark.at || 0) <= VIEW_RESTORE_TTL_MS
    if (fresh && mark.room !== room) return false
    storage.removeItem(VIEW_RESTORE_KEY)
    return fresh
  } catch (err) {
    return false
  }
}
