import { roomFromLocation } from '@/utils/roomLocation'
import { persistConflictDraft } from '@/utils/conflictDraftStore'

export const EDIT_CONFLICT_CODES = ['REPLACE_CONFLICT', 'PRECONDITION_REQUIRED']

export function currentEditPrincipal() {
  try {
    const id = localStorage.getItem('COOPERATE_USER_ID')
    if (id) return String(id)
  } catch (_) {
    // Private browsing can disable localStorage; keep the draft scope anonymous.
  }
  return 'anonymous'
}

export function isCollaborativeRoom(route) {
  return !!roomFromLocation(route)
}

export function getEditCooperate(mindMap) {
  return (mindMap && mindMap.cooperate) || null
}

export function conflictErrorDetails(error) {
  const response = error && error.response
  const body = response && response.data
  const nested = body && (body.error || body.details)
  const code = String(
    (error && error.code) ||
      (body && body.code) ||
      (nested && nested.code) ||
      ''
  )
  const status = Number(
    (response && response.status) ||
      (error && (error.status || error.statusCode)) ||
      0
  )
  const message = String(
    (body && (body.message || body.error_description)) ||
      (error && error.message) ||
      ''
  )
  return { code, status, message, body }
}

export function isEditConflictError(error) {
  const details = conflictErrorDetails(error)
  return EDIT_CONFLICT_CODES.includes(details.code) || details.status === 409 || details.status === 428
}

export function latestSnapshotForEdit(cooperate, session, error) {
  const details = conflictErrorDetails(error)
  const body = details.body || {}
  const supplied =
    body.latestSnapshot ||
    body.currentSnapshot ||
    body.actualSnapshot ||
    body.current ||
    body.actual
  if (supplied && typeof supplied === 'object' && supplied.data) return supplied
  const uid = (session && session.uid) || (supplied && supplied.uid)
  if (cooperate && uid && typeof cooperate.getEditSessionSnapshot === 'function') {
    const snapshot = cooperate.getEditSessionSnapshot(uid)
    if (snapshot) return snapshot
  }
  return supplied && typeof supplied === 'object' ? supplied : null
}

export async function persistEditConflict({
  mindMap,
  route,
  sessionId,
  error,
  fallbackSession
}) {
  const cooperate = getEditCooperate(mindMap)
  if (!cooperate || typeof cooperate.getEditSession !== 'function') {
    throw new Error('协同编辑会话暂不可用')
  }
  const current = cooperate.getEditSession(sessionId) || fallbackSession
  if (!current) throw new Error('找不到待保存的编辑会话')
  const latestSnapshot = latestSnapshotForEdit(cooperate, current, error)
  const details = conflictErrorDetails(error)
  const retained =
    typeof cooperate.retainEditSessionConflict === 'function'
      ? cooperate.retainEditSessionConflict(sessionId, {
          latestSnapshot,
          error: { code: details.code, message: details.message }
        }) || current
      : current
  const serial =
    typeof cooperate.serializeEditSession === 'function'
      ? cooperate.serializeEditSession(sessionId) || retained
      : retained
  const persisted = await persistConflictDraft({
    principal: currentEditPrincipal(),
    room: roomFromLocation(route),
    session: serial,
    latestSnapshot,
    error: details,
    reason: 'conflict'
  })
  return {
    session: (cooperate.getEditSession(sessionId) || retained),
    latestSnapshot,
    record: persisted.record,
    key: persisted.key,
    saved: !persisted.stale,
    revision: Number(serial.draftRevision) || 0
  }
}

export async function persistConflictSessionDraft({
  mindMap,
  route,
  sessionId,
  latestSnapshot,
  error
}) {
  const cooperate = getEditCooperate(mindMap)
  if (!cooperate) throw new Error('协同编辑会话暂不可用')
  const session =
    (typeof cooperate.getEditSession === 'function' &&
      cooperate.getEditSession(sessionId)) ||
    (typeof cooperate.serializeEditSession === 'function' &&
      cooperate.serializeEditSession(sessionId))
  if (!session) throw new Error('找不到待保存的编辑会话')
  const serial =
    typeof cooperate.serializeEditSession === 'function'
      ? cooperate.serializeEditSession(sessionId) || session
      : session
  const latest =
    latestSnapshot ||
    (typeof cooperate.getEditSessionSnapshot === 'function'
      ? cooperate.getEditSessionSnapshot(session.uid)
      : null)
  const persisted = await persistConflictDraft({
    principal: currentEditPrincipal(),
    room: roomFromLocation(route),
    session: serial,
    latestSnapshot: latest,
    error: error || (serial.conflict && serial.conflict.error) || serial.error || {},
    reason: 'conflict'
  })
  return {
    session: serial,
    latestSnapshot: latest,
    key: persisted.key,
    saved: !persisted.stale,
    revision: Number(serial.draftRevision) || 0
  }
}

export async function persistEditSessionEventDraft({
  mindMap,
  route,
  session: eventSession,
  error,
  reason = 'conflict'
}) {
  const cooperate = getEditCooperate(mindMap)
  const sessionId = eventSession && eventSession.id
  if (!sessionId) throw new Error('编辑会话标识缺失')
  const current =
    (cooperate && typeof cooperate.getEditSession === 'function' &&
      cooperate.getEditSession(sessionId)) ||
    eventSession
  const latestSnapshot =
    (cooperate &&
      typeof cooperate.getEditSessionSnapshot === 'function' &&
      cooperate.getEditSessionSnapshot(current.uid)) ||
    (current.conflict && current.conflict.latestSnapshot) ||
    null
  const details = conflictErrorDetails(
    error || (current.conflict && current.conflict.error) || current.error || {}
  )
  const serial =
    cooperate && typeof cooperate.serializeEditSession === 'function'
      ? cooperate.serializeEditSession(sessionId) || current
      : current
  const savedSession = {
    ...serial,
    state: 'conflict',
    conflict: {
      ...((serial && serial.conflict) || {}),
      error: { code: details.code, message: details.message },
      latestSnapshot
    }
  }
  const persisted = await persistConflictDraft({
    principal: currentEditPrincipal(),
    room: roomFromLocation(route) || current.roomKey || '',
    session: savedSession,
    latestSnapshot,
    error: details,
    reason
  })
  return {
    ...persisted,
    session: savedSession,
    latestSnapshot,
    revision: Number(savedSession.draftRevision) || 0
  }
}

export async function persistOutboxConflictDraft({ mindMap, route, payload }) {
  const event = payload || {}
  const uid = String(event.uid || (event.session && event.session.uid) || '')
  const opId = String(event.opId || event.id || '')
  const sourcePatch = event.patch || event.data || {}
  const allowedFields = new Set([
    'text',
    'richText',
    'note',
    'hyperlink',
    'hyperlinkTitle'
  ])
  const fields = Array.from(
    new Set(
      ((event.session && event.session.fields) || Object.keys(sourcePatch)).filter(
        field => allowedFields.has(field)
      )
    )
  )
  const draft = {}
  fields.forEach(field => {
    if (Object.prototype.hasOwnProperty.call(sourcePatch, field)) {
      draft[field] = sourcePatch[field]
    } else if (event.session && event.session.draft) {
      draft[field] = event.session.draft[field]
    }
  })
  if (!uid || !opId || !fields.length) {
    throw new Error('旧协同操作缺少可恢复的文本内容')
  }

  const groups = {
    text: ['text', 'richText'],
    note: ['note'],
    hyperlink: ['hyperlink', 'hyperlinkTitle']
  }
  const expected = event.expected || {}
  const latestSnapshot =
    event.latestSnapshot ||
    (getEditCooperate(mindMap) &&
      typeof getEditCooperate(mindMap).getEditSessionSnapshot === 'function' &&
      getEditCooperate(mindMap).getEditSessionSnapshot(uid)) ||
    null
  const suppliedSession = event.session || {}
  const details = conflictErrorDetails(event.error || {})
  const baseId = String(suppliedSession.id || `outbox-${opId}`)
  const groupedFields = Object.keys(groups)
    .map(group => ({ group, fields: fields.filter(field => groups[group].includes(field)) }))
    .filter(item => item.fields.length)
  const results = []
  for (const item of groupedFields) {
    const groupDraft = {}
    item.fields.forEach(field => {
      if (Object.prototype.hasOwnProperty.call(draft, field)) {
        groupDraft[field] = draft[field]
      }
    })
    const baseVersions = { ...(suppliedSession.baseVersions || {}) }
    baseVersions[item.group] =
      Number(expected[`__fv.${item.group}`]) || Number(baseVersions[item.group]) || 0
    const groupSession = {
      ...suppliedSession,
      id: groupedFields.length === 1 ? baseId : `${baseId}:${item.group}`,
      uid,
      kind: suppliedSession.kind || 'outbox',
      fields: item.fields,
      baseValues: Object.fromEntries(
        item.fields.map(field => [field, (suppliedSession.baseValues || {})[field]])
      ),
      baseVersions: { [item.group]: baseVersions[item.group] },
      draft: groupDraft,
      draftRevision: Number(suppliedSession.draftRevision) || 0,
      composing: false,
      state: 'conflict',
      roomKey: String(event.roomKey || roomFromLocation(route) || ''),
      conflict: suppliedSession.conflict || {
        error: event.error || {},
        latestSnapshot
      },
      outboxOpId: opId
    }
    results.push(
      await persistConflictDraft({
        principal: currentEditPrincipal(),
        room: event.roomKey || roomFromLocation(route),
        session: groupSession,
        latestSnapshot,
        error: details,
        reason: 'conflict'
      })
    )
  }
  return {
    key: results[0] && results[0].key,
    record: results[0] && results[0].record,
    records: results.map(item => item.record).filter(Boolean),
    stale: results.length > 0 && results.every(item => item.stale),
    session: suppliedSession,
    latestSnapshot
  }
}

export function getLiveNode(mindMap, uid) {
  const renderer = mindMap && mindMap.renderer
  if (!renderer || typeof renderer.findNodeByUid !== 'function') return null
  return renderer.findNodeByUid(uid)
}

export function discardEditSession(cooperate, sessionId) {
  if (!cooperate || !sessionId) return
  if (typeof cooperate.discardEditSession === 'function') {
    cooperate.discardEditSession(sessionId)
  }
}
