/* global module:readonly */

let historyCopy = null

function cloneTrees(trees) {
  const list = Array.isArray(trees) ? trees : trees ? [trees] : []
  try {
    return JSON.parse(JSON.stringify(list))
  } catch (cause) {
    const error = new Error('历史分支副本无法安全保存')
    error.code = 'HISTORY_COPY_INVALID'
    error.cause = cause
    throw error
  }
}

function roomKeyOf(roomKey) {
  return String(roomKey == null ? '' : roomKey).trim()
}

/** Store the one in-memory history copy and its exact SMM clipboard payload. */
function setHistoryCopy(roomKey, trees) {
  const key = roomKeyOf(roomKey)
  if (!key) {
    const error = new Error('历史分支副本缺少脑图标识')
    error.code = 'HISTORY_COPY_ROOM_REQUIRED'
    throw error
  }
  const copy = cloneTrees(trees)
  if (!copy.length) {
    const error = new Error('历史分支副本不能为空')
    error.code = 'HISTORY_COPY_EMPTY'
    throw error
  }
  const signature = JSON.stringify({ simpleMindMap: true, data: copy })
  historyCopy = { roomKey: key, trees: copy, signature }
  return signature
}

/** Return a fresh tree copy only when the requested room owns the buffer. */
function getHistoryCopy(roomKey) {
  const key = roomKeyOf(roomKey)
  if (!historyCopy || !key || historyCopy.roomKey !== key) return null
  return cloneTrees(historyCopy.trees)
}

/** Return the SMM JSON written to the system clipboard for this room. */
function getHistoryCopySignature(roomKey) {
  const key = roomKeyOf(roomKey)
  if (!historyCopy || !key || historyCopy.roomKey !== key) return ''
  return historyCopy.signature
}

/** Clear the singleton buffer, or clear it only when the room matches. */
function clearHistoryCopy(roomKey) {
  if (roomKey == null || !String(roomKey).trim()) {
    historyCopy = null
    return true
  }
  const key = roomKeyOf(roomKey)
  if (historyCopy && historyCopy.roomKey === key) {
    historyCopy = null
    return true
  }
  return false
}

module.exports = {
  setHistoryCopy,
  getHistoryCopy,
  getHistoryCopySignature,
  clearHistoryCopy
}
module.exports.default = module.exports
