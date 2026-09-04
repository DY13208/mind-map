/* global module:readonly */

function snapshotValue(value) {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object') return value
  try {
    return JSON.parse(JSON.stringify(value))
  } catch (err) {
    return value
  }
}

function listGeneralization(generalization) {
  if (generalization == null) return []
  return Array.isArray(generalization) ? generalization : [generalization]
}

function stripEphemeralGen(item) {
  if (!item || typeof item !== 'object') return item
  const copy = snapshotValue(item) || {}
  delete copy.inserting
  delete copy.isActive
  delete copy.resetRichText
  return copy
}

function generalizationSignature(generalization) {
  const list = listGeneralization(generalization).filter(Boolean)
  if (!list.length) return ''
  return list
    .map(item => {
      if (!item || typeof item !== 'object') return String(item || '')
      try {
        return JSON.stringify(stripEphemeralGen(item))
      } catch (err) {
        return String(item.uid || '')
      }
    })
    .join('|')
}

function ownerGeneralizationPayload(generalization) {
  const list = listGeneralization(generalization).filter(Boolean)
  if (!list.length) return null
  return list.map(stripEphemeralGen)
}

function mergeVirtualEditIntoOwner(ownerGeneralization, virtualUid, patch = {}) {
  const list = listGeneralization(ownerGeneralization).filter(Boolean)
  if (!list.length || !virtualUid) return ownerGeneralizationPayload(ownerGeneralization)
  const incoming = { ...(snapshotValue(patch) || {}) }
  delete incoming.generalization
  delete incoming.uid
  delete incoming.__fv
  delete incoming.parent
  delete incoming.parentUid
  delete incoming.parent_uid
  delete incoming.index
  delete incoming.position
  const next = list.map(item => {
    if (!item || item.uid !== virtualUid) return stripEphemeralGen(item)
    return stripEphemeralGen({ ...item, ...incoming, uid: virtualUid })
  })
  return next.length ? next : null
}

const api = {
  snapshotValue,
  listGeneralization,
  generalizationSignature,
  ownerGeneralizationPayload,
  mergeVirtualEditIntoOwner
}

module.exports = api
module.exports.default = api
