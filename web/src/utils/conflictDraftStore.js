import {
  deleteLocalDraftValue,
  listLocalDraftEntries,
  writeLocalDraftValue
} from '@/api'

const VERSION = 1
const queues = new Map()
const closedSessions = new Set()
const latestRevisionByKey = new Map()

function encode(value) {
  return encodeURIComponent(String(value == null ? '' : value))
}

function clone(value) {
  if (value == null) return value
  return JSON.parse(JSON.stringify(value))
}

function sessionIdentity(key, sessionId) {
  return `${key}:${String(sessionId || '')}`
}

function enqueue(key, task) {
  const previous = queues.get(key) || Promise.resolve()
  const next = previous.catch(() => {}).then(task)
  queues.set(key, next)
  return next.finally(() => {
    if (queues.get(key) === next) queues.delete(key)
  })
}

function fieldGroup(session) {
  const fields = Array.isArray(session && session.fields) ? session.fields : []
  if (fields.some(field => field === 'hyperlink' || field === 'hyperlinkTitle')) {
    return 'hyperlink'
  }
  if (fields.some(field => field === 'note')) return 'note'
  if (fields.some(field => field === 'text' || field === 'richText')) return 'text'
  return String((session && session.kind) || 'field')
}

export function conflictDraftPrefix(principal, room) {
  return `conflictDraft:v${VERSION}:${encode(principal)}:${encode(room)}:`
}

export function conflictDraftKey({ principal, room, uid, group, sessionId }) {
  return `${conflictDraftPrefix(principal, room)}${encode(uid)}:${encode(
    group
  )}:${encode(sessionId)}`
}

export function createConflictDraftRecord({
  principal,
  room,
  session,
  latestSnapshot,
  error,
  reason = 'conflict',
  savedAt = Date.now()
}) {
  if (!session || !session.id || !session.uid) {
    throw new Error('冲突草稿缺少编辑会话标识')
  }
  const group = fieldGroup(session)
  const key = conflictDraftKey({
    principal,
    room,
    uid: session.uid,
    group,
    sessionId: session.id
  })
  const safeError = error || {}
  return {
    version: VERSION,
    key,
    sessionId: String(session.id),
    uid: String(session.uid),
    group,
    principal: String(principal || ''),
    room: String(room || ''),
    session: clone(session),
    latestSnapshot: clone(latestSnapshot || null),
    reason: String(reason || 'conflict'),
    error: {
      code: String(safeError.code || ''),
      message: String(safeError.message || '')
    },
    savedAt: Number(savedAt) || Date.now()
  }
}

/**
 * Writes are serialized by scoped session key. A newer editor revision
 * supersedes a queued older snapshot; a cleared session is tombstoned before
 * deletion is queued so delayed editor callbacks cannot recreate the record.
 */
export function persistConflictDraft(input) {
  const record = createConflictDraftRecord(input)
  const identity = sessionIdentity(record.key, record.sessionId)
  if (closedSessions.has(identity)) {
    return Promise.reject(new Error('冲突草稿会话已关闭'))
  }
  const revision = Number(record.session.draftRevision) || 0
  const previousRevision = latestRevisionByKey.get(record.key) || -1
  if (revision < previousRevision) {
    return Promise.resolve({ key: record.key, record: null, stale: true })
  }
  latestRevisionByKey.set(record.key, revision)
  return enqueue(record.key, async () => {
    if (
      closedSessions.has(identity) ||
      latestRevisionByKey.get(record.key) !== revision
    ) {
      return { key: record.key, record: null, stale: true }
    }
    await writeLocalDraftValue(record, record.key)
    return { key: record.key, record }
  })
}

export async function listConflictDrafts(principal, room) {
  const prefix = conflictDraftPrefix(principal, room)
  const entries = await listLocalDraftEntries(prefix)
  return entries
    .map(entry => ({ ...entry.value, key: entry.key }))
    .filter(
      item =>
        item &&
        item.version === VERSION &&
        item.session &&
        item.session.state === 'conflict'
    )
    .sort((a, b) => (Number(b.savedAt) || 0) - (Number(a.savedAt) || 0))
}

export function removeConflictDraft(record) {
  if (!record || !record.key) return Promise.resolve(false)
  const identity = sessionIdentity(record.key, record.sessionId)
  closedSessions.add(identity)
  latestRevisionByKey.delete(record.key)
  return enqueue(record.key, async () => {
    await deleteLocalDraftValue(record.key)
    return true
  })
}

export function resetConflictDraftStoreForTests() {
  queues.clear()
  closedSessions.clear()
  latestRevisionByKey.clear()
}
