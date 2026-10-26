const contentFields = ['text', 'richText', 'textMentions', 'note', 'hyperlink', 'hyperlinkTitle']
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key)
const stable = value => JSON.stringify(value, (_, item) => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item
  return Object.keys(item).sort().reduce((out, key) => { out[key] = item[key]; return out }, {})
})
const groupOf = field => field === 'richText' ? 'text'
  : field === 'hyperlinkTitle' ? 'hyperlink' : field

export function hasUnchangedDraft(session = {}) {
  const draft = session.draft || {}
  const fields = Object.keys(draft).filter(field => contentFields.includes(field))
  return fields.length > 0 && fields.every(field => {
    const version = (session.baseVersions || {})[groupOf(field)]
    return own(session.baseValues, field) && typeof version === 'number' &&
      Number.isFinite(version) && version >= 0 && stable(draft[field]) === stable(session.baseValues[field])
  })
}

export function classifyConflictDraft(record = {}) {
  const session = record.session || record
  const draft = session.draft || {}
  const error = (record.error && record.error.code ? record.error : null) || (session.conflict && session.conflict.error) || record.error || {}
  const code = String(error.code || '')
  const fields = Object.keys(draft).filter(field => contentFields.includes(field))
  if (session.state === 'resolved' || hasUnchangedDraft(session)) return { kind: 'record', canRetry: false, code }
  if (draft.operation && ['node.move', 'node.reorder', 'node.delete'].includes(draft.operation.type)) {
    return { kind: 'operation', canRetry: false, code }
  }
  if (!fields.some(field => field !== 'richText')) return { kind: 'record', canRetry: false, code }
  if (code === 'REPLACE_CONFLICT') return { kind: 'conflict', canRetry: false, code }
  const hasBaseline = Array.isArray(session.fields) && fields.every(field => {
    const version = (session.baseVersions || {})[groupOf(field)]
    const groupHasBaseline = contentFields.some(candidate => groupOf(candidate) === groupOf(field) && own(session.baseValues, candidate))
    return session.fields.includes(field) && groupHasBaseline && typeof version === 'number' && Number.isFinite(version) && version >= 0
  })
  const canRetry = record.reason === 'save_failed' && hasBaseline &&
    ['', 'NETWORK_ERROR', 'TIMEOUT', 'ECONNABORTED', 'COLLAB_WRITE_UNAVAILABLE'].includes(code)
  return { kind: 'unsaved', canRetry, code }
}
