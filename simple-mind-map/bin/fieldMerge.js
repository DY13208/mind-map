const FIELD_GROUPS = {
  text: ['text', 'richText'],
  note: ['note'],
  image: ['image', 'imageTitle', 'imageSize'],
  icon: ['icon'],
  tag: ['tag'],
  hyperlink: ['hyperlink', 'hyperlinkTitle'],
  outerFrame: ['outerFrame'],
  generalization: ['generalization'],
  formula: ['formula'],
  attachment: ['attachmentUrl', 'attachmentName']
}

const FV_KEY = '__fv'
const ALL_PATCH_KEYS = [
  ...new Set(
    Object.keys(FIELD_GROUPS).reduce(
      (list, group) => list.concat(FIELD_GROUPS[group]),
      []
    )
  )
]

function fieldGroupOf(key) {
  const name = String(key || '')
  if (!name || name === FV_KEY) return null
  for (const group of Object.keys(FIELD_GROUPS)) {
    if (FIELD_GROUPS[group].includes(name)) return group
  }
  // Unknown scalar/style fields get their own LWW bucket.
  return `field:${name}`
}

function groupsForKeys(keys) {
  const groups = new Set()
  ;(keys || []).forEach(key => {
    const group = fieldGroupOf(key)
    if (group) groups.add(group)
  })
  return Array.from(groups)
}

function keysForGroups(groups) {
  const keys = new Set()
  ;(groups || []).forEach(group => {
    if (FIELD_GROUPS[group]) {
      FIELD_GROUPS[group].forEach(key => keys.add(key))
      return
    }
    if (String(group).startsWith('field:')) {
      keys.add(String(group).slice(6))
    }
  })
  return Array.from(keys)
}

function readFieldVersions(data) {
  const raw = data && data[FV_KEY]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const next = {}
  Object.keys(raw).forEach(key => {
    const value = Number(raw[key])
    if (Number.isFinite(value) && value > 0) next[key] = value
  })
  return next
}

function stampFieldVersions(data, keys, version) {
  const ver = Number(version)
  if (!Number.isFinite(ver) || ver <= 0) return { ...(data || {}) }
  const next = { ...(data || {}) }
  const fv = { ...readFieldVersions(next) }
  groupsForKeys(keys).forEach(group => {
    fv[group] = Math.max(Number(fv[group] || 0), ver)
  })
  next[FV_KEY] = fv
  return next
}

function publicNodeData(data) {
  if (!data || typeof data !== 'object') return data
  if (data[FV_KEY] === undefined) return data
  const next = { ...data }
  delete next[FV_KEY]
  return next
}

function stableValue(value) {
  if (value === undefined) return undefined
  try {
    return JSON.stringify(value)
  } catch (err) {
    return String(value)
  }
}

function changedKeysFromPatch(patch = {}) {
  return Object.keys(patch || {}).filter(key => key && key !== FV_KEY)
}

function diffChangedKeys(before = {}, after = {}) {
  const keys = new Set([
    ...Object.keys(before || {}),
    ...Object.keys(after || {})
  ])
  keys.delete(FV_KEY)
  const changed = []
  keys.forEach(key => {
    if (stableValue(before[key]) !== stableValue(after[key])) changed.push(key)
  })
  return changed
}

/**
 * Last-write-wins merge by field group.
 * Only keys present in `patch` are candidates; other local fields stay intact.
 */
function mergeNodeDataLww(baseData = {}, patch = {}, version) {
  const base = { ...(baseData || {}) }
  const incoming = { ...(patch || {}) }
  delete incoming[FV_KEY]
  const changed = changedKeysFromPatch(incoming)
  if (!changed.length) {
    return {
      data: base,
      changedFields: [],
      changedGroups: [],
      fieldVersions: readFieldVersions(base)
    }
  }
  const next = { ...base }
  changed.forEach(key => {
    if (incoming[key] === null) delete next[key]
    else next[key] = incoming[key]
  })
  const stamped = stampFieldVersions(next, changed, version)
  return {
    data: stamped,
    changedFields: changed,
    changedGroups: groupsForKeys(changed),
    fieldVersions: readFieldVersions(stamped)
  }
}

/**
 * Apply remote node data onto local display data using field versions.
 * Falls back to changedFields, then to full public fields when versions absent.
 */
function applyRemoteNodeData(localData = {}, remoteData = {}, options = {}) {
  const local = { ...(localData || {}) }
  const remote = { ...(remoteData || {}) }
  const localFv = readFieldVersions(local)
  const remoteFv = readFieldVersions(remote)
  const explicitFields = Array.isArray(options.changedFields)
    ? options.changedFields.filter(Boolean)
    : null

  let groups = []
  if (Object.keys(remoteFv).length) {
    groups = Object.keys(remoteFv).filter(
      group => Number(remoteFv[group] || 0) > Number(localFv[group] || 0)
    )
  } else if (explicitFields && explicitFields.length) {
    groups = groupsForKeys(explicitFields)
  } else {
    groups = groupsForKeys(ALL_PATCH_KEYS)
  }

  const keys = keysForGroups(groups)
  if (!keys.length && (!explicitFields || !explicitFields.length)) {
    // Legacy remote without versions: replace known collaborative fields.
    ALL_PATCH_KEYS.forEach(key => {
      if (remote[key] === undefined) return
      if (remote[key] === null) delete local[key]
      else local[key] = remote[key]
    })
  } else {
    keys.forEach(key => {
      if (remote[key] === undefined) {
        if (explicitFields && explicitFields.includes(key)) delete local[key]
        return
      }
      if (remote[key] === null) delete local[key]
      else local[key] = remote[key]
    })
  }

  const mergedFv = { ...localFv }
  Object.keys(remoteFv).forEach(group => {
    const rv = Number(remoteFv[group] || 0)
    if (rv > Number(mergedFv[group] || 0)) mergedFv[group] = rv
  })
  if (Object.keys(mergedFv).length) local[FV_KEY] = mergedFv
  else delete local[FV_KEY]
  return {
    data: local,
    appliedGroups: groups,
    appliedKeys: keys
  }
}

function patchDelta(previous = {}, next = {}) {
  const prev = previous || {}
  const curr = next || {}
  const keys = new Set([...Object.keys(prev), ...Object.keys(curr)])
  keys.delete(FV_KEY)
  const delta = {}
  keys.forEach(key => {
    if (stableValue(prev[key]) === stableValue(curr[key])) return
    delta[key] = curr[key] === undefined ? null : curr[key]
  })
  return delta
}

module.exports = {
  FV_KEY,
  FIELD_GROUPS,
  ALL_PATCH_KEYS,
  fieldGroupOf,
  groupsForKeys,
  keysForGroups,
  readFieldVersions,
  stampFieldVersions,
  publicNodeData,
  changedKeysFromPatch,
  diffChangedKeys,
  mergeNodeDataLww,
  applyRemoteNodeData,
  patchDelta
}
