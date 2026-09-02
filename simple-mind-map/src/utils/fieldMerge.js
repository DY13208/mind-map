export const FV_KEY = '__fv'

export const FIELD_GROUPS = {
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

export const ALL_PATCH_KEYS = [
  ...new Set(
    Object.keys(FIELD_GROUPS).reduce(
      (list, group) => list.concat(FIELD_GROUPS[group]),
      []
    )
  )
]

export function fieldGroupOf(key) {
  const name = String(key || '')
  if (!name || name === FV_KEY) return null
  for (const group of Object.keys(FIELD_GROUPS)) {
    if (FIELD_GROUPS[group].includes(name)) return group
  }
  return `field:${name}`
}

export function groupsForKeys(keys) {
  const groups = new Set()
  ;(keys || []).forEach(key => {
    const group = fieldGroupOf(key)
    if (group) groups.add(group)
  })
  return Array.from(groups)
}

export function keysForGroups(groups) {
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

export function readFieldVersions(data) {
  const raw = data && data[FV_KEY]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const next = {}
  Object.keys(raw).forEach(key => {
    const value = Number(raw[key])
    if (Number.isFinite(value) && value > 0) next[key] = value
  })
  return next
}

export function publicNodeData(data) {
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

export function applyRemoteNodeData(localData = {}, remoteData = {}, options = {}) {
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
    ALL_PATCH_KEYS.forEach(key => {
      if (remote[key] === undefined) return
      if (remote[key] === null) delete local[key]
      else local[key] = remote[key]
    })
  } else {
    keys.forEach(key => {
      if (remote[key] === undefined) {
        // A versioned group update with the field absent means it was cleared.
        delete local[key]
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

export function patchDelta(previous = {}, next = {}) {
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
