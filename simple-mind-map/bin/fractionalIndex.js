const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const WIDTH = 16
const STEP = 1n << 20n
const MAX_RANK = 36n ** BigInt(WIDTH) - 1n
const MAX_POSITION_LENGTH = WIDTH + 1

function isPaddedIndex(value) {
  return typeof value === 'string' && /^\d{8}$/.test(value)
}

function isValidPosition(value) {
  if (value == null || value === '') return false
  const text = String(value)
  if (isPaddedIndex(text)) return true
  if (text.length !== WIDTH) return false
  for (let i = 0; i < text.length; i++) {
    if (DIGITS.indexOf(text[i]) < 0) return false
  }
  return true
}

function digitValue(ch) {
  const n = DIGITS.indexOf(ch)
  if (n < 0) throw new Error(`invalid position digit: ${ch}`)
  return n
}

function decodeRank(key) {
  if (key == null || key === '') return 0n
  const text = String(key)
  if (isPaddedIndex(text)) return BigInt(text) * STEP
  let n = 0n
  const padded = text.length >= WIDTH ? text.slice(0, WIDTH) : text.padStart(WIDTH, '0')
  for (let i = 0; i < padded.length; i++) {
    n = n * 36n + BigInt(digitValue(padded[i]))
  }
  return n
}

function encodeRank(rank) {
  let n = rank
  if (n < 1n) n = 1n
  if (n > MAX_RANK) n = MAX_RANK
  const chars = []
  for (let i = 0; i < WIDTH; i++) {
    chars.push(DIGITS[Number(n % 36n)])
    n = n / 36n
  }
  return chars.reverse().join('')
}

function generateKeyBetween(a, b) {
  const left = a == null || a === '' ? null : String(a)
  const right = b == null || b === '' ? null : String(b)
  if (left != null && right != null && left >= right) {
    throw new Error(`position bounds out of order: ${left} >= ${right}`)
  }
  if (left == null && right == null) return encodeRank(STEP)
  const min = left == null ? 0n : decodeRank(left)
  const max = right == null ? MAX_RANK : decodeRank(right)
  if (max <= min + 1n) return null
  const mid = (min + max) / 2n
  if (mid <= min || mid >= max) return null
  return encodeRank(mid)
}

function generateNKeysBetween(a, b, count) {
  const n = Math.max(0, Number(count) || 0)
  if (!n) return []
  const min = a == null || a === '' ? 0n : decodeRank(a)
  const max = b == null || b === '' ? MAX_RANK : decodeRank(b)
  const span = max - min
  if (span <= BigInt(n + 1)) {
    const start = min + 1n
    return Array.from({ length: n }, (_, i) => encodeRank(start + BigInt(i)))
  }
  const step = span / BigInt(n + 1)
  return Array.from({ length: n }, (_, i) => encodeRank(min + step * BigInt(i + 1)))
}

function comparePositions(a, b, uidA, uidB) {
  const left = String(a || '')
  const right = String(b || '')
  if (left && right && left !== right) return left < right ? -1 : 1
  if (left && !right) return -1
  if (!left && right) return 1
  return String(uidA || '').localeCompare(String(uidB || ''))
}

function needsReindex(key) {
  return !key || String(key).length > MAX_POSITION_LENGTH
}

function reindexSiblings(obj, parentUid) {
  const parent = obj && obj[parentUid]
  const kids = parent && Array.isArray(parent.children) ? parent.children : []
  const keys = generateNKeysBetween(null, null, kids.length)
  const positions = {}
  kids.forEach((uid, index) => {
    const key = keys[index]
    positions[uid] = key
    if (obj[uid]) obj[uid].position = key
  })
  return { positions, reindexed: true, changed: true }
}

function applySiblingPositions(obj, parentUid, options = {}) {
  const parent = obj && obj[parentUid]
  const kids = parent && Array.isArray(parent.children) ? parent.children : []
  const positions = {}
  if (!kids.length) return { positions, reindexed: false, changed: false }
  if (options.reindex === true) return reindexSiblings(obj, parentUid)

  const existing = kids.map(uid => {
    const pos = obj[uid] && obj[uid].position
    return isValidPosition(pos) ? String(pos) : ''
  })
  if (existing.some(pos => isPaddedIndex(pos))) {
    return reindexSiblings(obj, parentUid)
  }
  const ordered = existing.every((pos, index) => {
    if (!pos) return false
    if (index === 0) return true
    return existing[index - 1] < pos
  })
  if (ordered) {
    kids.forEach((uid, index) => {
      positions[uid] = existing[index]
      if (obj[uid]) obj[uid].position = existing[index]
    })
    return { positions, reindexed: false, changed: false }
  }

  let prev = null
  let changed = false
  for (let i = 0; i < kids.length; i++) {
    const uid = kids[i]
    let after = null
    for (let j = i + 1; j < kids.length; j++) {
      const candidate = existing[j]
      if (candidate && (prev == null || prev < candidate)) {
        after = candidate
        break
      }
    }
    let current = existing[i]
    const keep =
      current &&
      (prev == null || prev < current) &&
      (after == null || current < after)
    if (!keep) {
      let generated = null
      try {
        generated = generateKeyBetween(prev, after)
      } catch (err) {
        generated = null
      }
      if (!generated) return reindexSiblings(obj, parentUid)
      current = generated
      existing[i] = current
      changed = true
    }
    positions[uid] = current
    if (obj[uid]) obj[uid].position = current
    prev = current
  }
  return { positions, reindexed: false, changed }
}

function insertPositionAt(obj, parentUid, uid) {
  const parent = obj && obj[parentUid]
  const kids = parent && Array.isArray(parent.children) ? parent.children : []
  const slot = kids.indexOf(uid)
  if (slot < 0) return applySiblingPositions(obj, parentUid, { reindex: true })
  const leftUid = slot > 0 ? kids[slot - 1] : null
  const rightUid = slot < kids.length - 1 ? kids[slot + 1] : null
  const left = leftUid && obj[leftUid] ? obj[leftUid].position : null
  const right = rightUid && obj[rightUid] ? obj[rightUid].position : null
  if (
    (left && isPaddedIndex(left)) ||
    (right && isPaddedIndex(right)) ||
    (left && right && !(left < right))
  ) {
    const result = reindexSiblings(obj, parentUid)
    return {
      position: obj[uid] && obj[uid].position,
      reindexed: true,
      positions: result.positions
    }
  }
  let key = null
  try {
    key = generateKeyBetween(left || null, right || null)
  } catch (err) {
    key = null
  }
  if (!key || needsReindex(key)) {
    const result = reindexSiblings(obj, parentUid)
    return {
      position: obj[uid] && obj[uid].position,
      reindexed: true,
      positions: result.positions
    }
  }
  if (obj[uid]) obj[uid].position = key
  return { position: key, reindexed: false, positions: { [uid]: key } }
}

function applyPositionsToTree(obj, options = {}) {
  const next = obj || {}
  const changedParents = []
  Object.keys(next).forEach(uid => {
    const children = next[uid] && next[uid].children
    if (!Array.isArray(children) || !children.length) return
    const result = applySiblingPositions(next, uid, options)
    if (result.changed || result.reindexed) changedParents.push(uid)
  })
  const rootUid = Object.keys(next).find(uid => next[uid] && next[uid].isRoot)
  if (rootUid && !next[rootUid].position) {
    next[rootUid].position = encodeRank(STEP)
  }
  return { nodes: next, changedParents }
}

module.exports = {
  DIGITS,
  WIDTH,
  STEP,
  MAX_POSITION_LENGTH,
  isPaddedIndex,
  isValidPosition,
  decodeRank,
  encodeRank,
  generateKeyBetween,
  generateNKeysBetween,
  comparePositions,
  needsReindex,
  insertPositionAt,
  applySiblingPositions,
  applyPositionsToTree
}
