const FIELD_GROUPS = {
  text: ['text', 'richText'],
  textMentions: ['textMentions'],
  note: ['note'],
  hyperlink: ['hyperlink', 'hyperlinkTitle']
}

function cloneObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  return { ...value }
}

function createSessionId(sequence) {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID()
    }
  } catch (err) {
    // Fall through to the per-manager random nonce.
  }
  const nonce = Math.random().toString(36).slice(2, 12)
  return `edit-${Date.now().toString(36)}-${nonce}-${sequence.toString(36)}`
}

function fieldGroup(field) {
  const name = String(field || '')
  return Object.keys(FIELD_GROUPS).find(group =>
    FIELD_GROUPS[group].includes(name)
  ) || `field:${name}`
}

function readVersions(data = {}) {
  const source = data.__fv
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {}
  const versions = {}
  Object.keys(source).forEach(group => {
    const version = Number(source[group])
    if (Number.isFinite(version) && version > 0) versions[group] = version
  })
  return versions
}

function valuesForFields(data, fields) {
  const values = {}
  ;(fields || []).forEach(field => {
    values[field] = data && data[field]
  })
  return values
}

function sessionCopy(session) {
  if (!session) return null
  return {
    ...session,
    fields: (session.fields || []).slice(),
    baseValues: cloneObject(session.baseValues) || {},
    baseVersions: cloneObject(session.baseVersions) || {},
    draft: cloneObject(session.draft) || {},
    conflict: session.conflict
      ? {
          ...session.conflict,
          latestSnapshot: session.conflict.latestSnapshot
            ? {
                ...session.conflict.latestSnapshot,
                data: cloneObject(session.conflict.latestSnapshot.data) || {},
                fieldVersions:
                  cloneObject(session.conflict.latestSnapshot.fieldVersions) || {}
              }
            : null
        }
      : null
  }
}

function normalizeSnapshot(snapshot = {}) {
  snapshot = snapshot || {}
  const data = cloneObject(snapshot.data) || {}
  return {
    uid: snapshot.uid || data.uid || '',
    data,
    fieldVersions: cloneObject(snapshot.fieldVersions) || readVersions(data),
    serverRevision: Number(snapshot.serverRevision) || 0,
    source: snapshot.source || 'unknown'
  }
}

export function createEditSessionManager() {
  const sessions = new Map()
  let sequence = 0

  const get = id => sessionCopy(sessions.get(String(id || '')))

  const begin = ({
    uid,
    fields = ['text'],
    kind = 'field',
    initialDraft,
    snapshot = {},
    roomKey = ''
  } = {}) => {
    if (!uid) throw new Error('edit session uid required')
    const normalizedFields = Array.from(new Set(fields.map(String).filter(Boolean)))
    if (!normalizedFields.length) throw new Error('edit session fields required')
    const current = normalizeSnapshot({ ...snapshot, uid })
    const baseValues = valuesForFields(current.data, normalizedFields)
    const baseVersions = {}
    normalizedFields.forEach(field => {
      const group = fieldGroup(field)
      baseVersions[group] = Number(current.fieldVersions[group]) || 0
    })
    sequence += 1
    const id = createSessionId(sequence)
    const session = {
      id,
      uid: String(uid),
      roomKey: String(roomKey || ''),
      kind: String(kind || 'field'),
      fields: normalizedFields,
      baseValues,
      baseVersions,
      draft: {
        ...baseValues,
        ...(initialDraft && typeof initialDraft === 'object' ? initialDraft : {})
      },
      draftRevision: 0,
      composing: false,
      state: 'editing',
      startedAt: Date.now(),
      conflict: null
    }
    sessions.set(id, session)
    return sessionCopy(session)
  }

  const updateDraft = (id, patch = {}) => {
    const session = sessions.get(String(id || ''))
    if (!session || !patch || typeof patch !== 'object') return null
    // A single DOM input can reach both Quill and the native input listener.
    // Re-reading the same draft during save must not look like a new edit.
    if (Object.keys(patch).every(field => stableValue(session.draft[field]) === stableValue(patch[field]))) return sessionCopy(session)
    session.draft = { ...session.draft, ...patch }
    session.draftRevision += 1
    session.updatedAt = Date.now()
    return sessionCopy(session)
  }

  const setComposing = (id, composing) => {
    const session = sessions.get(String(id || ''))
    if (!session) return false
    session.composing = !!composing
    return true
  }

  const buildExpected = (id, fields) => {
    const session = sessions.get(String(id || ''))
    if (!session) return null
    const selected = Array.isArray(fields) && fields.length ? fields : session.fields
    const expected = { uid: session.uid }
    const groups = new Set(selected.map(fieldGroup))
    groups.forEach(group => {
      expected[`__fv.${group}`] = Number(session.baseVersions[group]) || 0
    })
    return expected
  }

  // Only the caller that owns a successful insert ACK may use this. A fresh
  // local node has no server versions yet; adopting that creation's versions
  // must never adopt changed content or replace the user's in-progress draft.
  const acknowledgeCreation = (id, snapshot, creationRevision, initialValues) => {
    const session = sessions.get(String(id || ''))
    const revision = Number(creationRevision)
    if (!session || session.state !== 'editing' || !Number.isSafeInteger(revision) || revision <= 0) return null
    const latest = normalizeSnapshot(snapshot)
    if (String(latest.uid) !== session.uid) return null
    const groups = new Set(session.fields.map(fieldGroup))
    const initial = initialValues || latest.data
    if (!session.fields.every(field => stableValue(session.baseValues[field]) === stableValue(initial[field]))) return null
    if (![...groups].every(group =>
      (Number(session.baseVersions[group]) || 0) === 0 &&
      Number(latest.fieldVersions[group]) === revision
    )) return null
    groups.forEach(group => { session.baseVersions[group] = revision })
    session.baseValues = valuesForFields(latest.data, session.fields)
    return sessionCopy(session)
  }

  const validate = (id, latestSnapshot, fields) => {
    const session = sessions.get(String(id || ''))
    if (!session) {
      return { ok: false, code: 'EDIT_SESSION_MISSING', conflicts: [], latestSnapshot: null }
    }
    const latest = normalizeSnapshot(latestSnapshot)
    const selected = Array.isArray(fields) && fields.length ? fields : session.fields
    const conflicts = []
    selected.forEach(field => {
      const group = fieldGroup(field)
      const expectedVersion = Number(session.baseVersions[group]) || 0
      const actualVersion = Number(latest.fieldVersions[group]) || 0
      const expectedValue = session.baseValues[field]
      const actualValue = latest.data && latest.data[field]
      if (
        expectedVersion !== actualVersion ||
        stableValue(expectedValue) !== stableValue(actualValue)
      ) {
        conflicts.push({
          field,
          group,
          expectedVersion,
          actualVersion,
          expectedValue,
          actualValue
        })
      }
    })
    if (!latest.uid || !latest.data || !Object.keys(latest.data).length) {
      conflicts.push({ field: '*', reason: 'node-missing' })
    }
    const missingNode = !latest.uid || !latest.data || !Object.keys(latest.data).length
    return {
      ok: conflicts.length === 0,
      code: conflicts.length ? (missingNode ? 'PRECONDITION_REQUIRED' : 'REPLACE_CONFLICT') : '',
      status: conflicts.length ? (missingNode ? 428 : 409) : 0,
      conflicts,
      latestSnapshot: latest
    }
  }

  const retainConflict = (id, { latestSnapshot, error, validation } = {}) => {
    const session = sessions.get(String(id || ''))
    if (!session) return null
    session.state = 'conflict'
    session.conflict = {
      error: error
        ? {
            code: String(error.code || ''),
            message: String(error.message || error)
          }
        : null,
      validation: validation
        ? {
            ok: !!validation.ok,
            code: validation.code || '',
            conflicts: (validation.conflicts || []).map(item => ({ ...item }))
          }
        : null,
      latestSnapshot: latestSnapshot ? normalizeSnapshot(latestSnapshot) : null,
      at: Date.now()
    }
    return sessionCopy(session)
  }

  const rebase = (id, latestSnapshot) => {
    const session = sessions.get(String(id || ''))
    if (!session) return null
    const latest = normalizeSnapshot(latestSnapshot)
    if (!latest.uid || !Object.keys(latest.data || {}).length) return null
    session.baseValues = valuesForFields(latest.data, session.fields)
    session.baseVersions = {}
    session.fields.forEach(field => {
      const group = fieldGroup(field)
      session.baseVersions[group] = Number(latest.fieldVersions[group]) || 0
    })
    session.state = 'editing'
    session.conflict = null
    session.updatedAt = Date.now()
    return sessionCopy(session)
  }

  const serialize = id => get(id)

  const restore = snapshot => {
    if (!snapshot || !snapshot.id || !snapshot.uid) return null
    const restored = {
      ...snapshot,
      fields: Array.from(new Set((snapshot.fields || []).map(String).filter(Boolean))),
      baseValues: cloneObject(snapshot.baseValues) || {},
      baseVersions: cloneObject(snapshot.baseVersions) || {},
      draft: cloneObject(snapshot.draft) || {},
      draftRevision: Number(snapshot.draftRevision) || 0,
      composing: false,
      state: 'conflict',
      conflict: snapshot.conflict || { restored: true, at: Date.now() },
      restoredAt: Date.now()
    }
    sessions.set(String(restored.id), restored)
    return sessionCopy(restored)
  }

  const resolve = id => {
    const key = String(id || '')
    const session = get(key)
    sessions.delete(key)
    return session
  }

  return {
    begin,
    get,
    updateDraft,
    setComposing,
    buildExpected,
    acknowledgeCreation,
    validate,
    retainConflict,
    rebase,
    serialize,
    restore,
    resolve,
    discard: resolve,
    list: () => Array.from(sessions.keys()).map(get)
  }
}

function stableValue(value) {
  if (value === undefined || value === null) return null
  try {
    return JSON.stringify(value)
  } catch (err) {
    return String(value)
  }
}

export { fieldGroup as editFieldGroup, readVersions as readEditFieldVersions }
