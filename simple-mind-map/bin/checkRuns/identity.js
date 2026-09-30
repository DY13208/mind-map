'use strict'

const crypto = require('crypto')
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
function digest(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex') }
function sourceIdFor(ref = {}) {
  const identity = ref.topic || ref.path || ref.id || ref.uid || ref.nodeUid || [ref.topicKey, ref.slot].filter(Boolean).join('/')
  return `source-${digest(stableJson([ref.type || ref.kind || '', ref.roomId || ref.roomKey || '', identity])).slice(0, 24)}`
}
function findingKeyFor(item = {}) {
  return `finding-${digest(stableJson([item.ruleId, item.nodeUid, item.field, item.checkKey,
    item.sourceRef ? sourceIdFor(item.sourceRef) : '', item.scope || '', item.error || ''])).slice(0, 24)}`
}
module.exports = { stableJson, digest, sourceIdFor, findingKeyFor }
