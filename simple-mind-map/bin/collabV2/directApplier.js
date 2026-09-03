const { generateKeyBetween, generateNKeysBetween, isPaddedIndex } = require('../fractionalIndex')
const { mergeNodeDataLww } = require('../fieldMerge')
const {
  parentDeletedError,
  nodeDeletedError,
  moveConflictError,
  uidReusedError,
  cycleError,
  commandError
} = require('../conflictErrors')
const { createUid } = require('../mindDoc')
const { isSopLabel } = require('./directStore')
const { normalizeOperation, normalizeType, BATCH_MAX } = require('./protocol')
const { collabTrace } = require('./trace')
const { stripSearchHtml } = require('../roomNodes')

const DIRECT_TYPES = new Set([
  'node.insert',
  'node.update',
  'node.move',
  'node.reorder',
  'node.delete',
  'node.restore',
  'node.batch',
  'map.meta.update',
  'operation.undo',
  'operation.redo'
])

const META_KEYS = [
  'theme',
  'themeConfig',
  'layout',
  'background',
  'lineStyle',
  'canvas',
  'title'
]

const DATA_META_KEYS = [
  'uid',
  'parent',
  'parentUid',
  'parent_uid',
  'index',
  'position',
  'operationId',
  'operation_id',
  'actorId',
  'actor_id',
  'clientId',
  'client_id',
  'clientSeq',
  'baseVersion',
  'baseRevision',
  'base_version',
  'type',
  'payload',
  'confirm_sop_change',
  'keep_children',
  'keepChildren',
  'ops',
  'tree',
  'nodes',
  'event',
  'expected',
  'expectedValue',
  'batchId'
]

const STRUCTURAL_PAYLOAD_KEYS = ['parentUid', 'parent_uid', 'parent', 'index', 'position', 'order']

function unique(list) {
  return Array.from(new Set((list || []).filter(Boolean)))
}

function warnStructuralUpdate(op) {
  const payload = (op && op.payload) || {}
  const keys = STRUCTURAL_PAYLOAD_KEYS.filter(key => payload[key] !== undefined)
  if (!keys.length) return false
  const row = {
    type: op && op.type,
    uid: payload.uid,
    keys
  }
  try {
    collabTrace('UPDATE_STRUCTURAL_FIELD_FORBIDDEN', row)
  } catch (err) {
    // ignore
  }
  if (typeof console !== 'undefined' && console.warn) {
    console.warn('UPDATE_STRUCTURAL_FIELD_FORBIDDEN', row)
  }
  return true
}

function sopError() {
  const err = new Error('修改SOP前必须获得用户确认并设置confirm_sop_change=true')
  err.statusCode = 400
  err.code = 'SOP_CONFIRM_REQUIRED'
  return err
}

function dataFields(input = {}) {
  const patch = { ...(input || {}) }
  DATA_META_KEYS.forEach(key => delete patch[key])
  return patch
}

function stableValue(value) {
  try {
    return JSON.stringify(value === undefined ? null : value)
  } catch (err) {
    return String(value)
  }
}

function clampIndex(index, max) {
  if (index == null || index === '') return max
  const n = Number(index)
  if (!Number.isFinite(n) || n < 0) return max
  return Math.min(Math.floor(n), max)
}

async function assertNotSop(store, uid, payload) {
  if (payload && payload.confirm_sop_change === true) return
  if (!uid) return
  const chain = await store.walkAncestors(uid)
  if (chain.some(item => isSopLabel(item.data))) throw sopError()
}

async function resolveParent(store, raw) {
  const requested = raw || 'root'
  if (requested === 'root') {
    const root = await store.resolveRoot()
    const live = await store.getLive(root)
    if (!live) throw parentDeletedError(root)
    return live
  }
  const live = await store.getLive(requested)
  if (!live) throw parentDeletedError(requested)
  return live
}

async function placeAmongSiblings(store, parentUid, uid, index, version) {
  const kids = (await store.listChildren(parentUid)).filter(item => item.uid !== uid)
  const slot = clampIndex(index, kids.length)
  const left = slot > 0 ? kids[slot - 1].position : null
  const right = slot < kids.length ? kids[slot].position : null
  let key = null
  try {
    if (!isPaddedIndex(left) && !isPaddedIndex(right)) {
      key = generateKeyBetween(left || null, right || null)
    }
  } catch (err) {
    key = null
  }
  if (!key) {
    const ordered = kids.slice()
    ordered.splice(slot, 0, { uid, position: '' })
    const keys = generateNKeysBetween(null, null, ordered.length)
    const pairs = ordered.map((item, i) => ({ uid: item.uid, position: keys[i] }))
    await store.updatePositions(pairs, version)
    const positions = {}
    pairs.forEach(item => {
      positions[item.uid] = item.position
    })
    return {
      position: keys[slot],
      reindexed: true,
      index: slot,
      siblingPositions: positions
    }
  }
  return { position: key, reindexed: false, index: slot }
}

function stampEvent(event, stamp) {
  const payload = {
    ...(event.payload || {}),
    position: stamp.position,
    index: stamp.index
  }
  if (stamp.reindexed) {
    payload.reindex = true
    payload.siblingPositions = stamp.siblingPositions
  }
  return { ...event, payload }
}

async function applyInsert(store, op, version) {
  const payload = op.payload || {}
  const parent = await resolveParent(
    store,
    payload.parentUid || payload.parent_uid || payload.parent
  )
  await assertNotSop(store, parent.uid, payload)
  const uid = String(payload.uid || '').trim() || createUid()
  const existing = await store.getAny(uid)
  if (existing && !existing.deleted) {
    throw commandError(`节点已存在: ${uid}`, 'UID_EXISTS', 409)
  }
  if (existing && existing.deleted) throw uidReusedError(uid)
  const stamp = await placeAmongSiblings(
    store,
    parent.uid,
    uid,
    payload.index,
    version
  )
  const extra = dataFields(payload.data || payload)
  const data = {
    uid,
    text: payload.text != null ? String(payload.text) : extra.text || '新节点',
    expand: true,
    ...extra
  }
  data.uid = uid
  if (payload.note != null && data.note == null) data.note = payload.note
  const merged = mergeNodeDataLww({}, data, version)
  await store.insert({
    uid,
    parent_uid: parent.uid,
    position: stamp.position,
    data: merged.data,
    is_root: false,
    node_version: version
  })
  return {
    result: { uid, parent_uid: parent.uid, position: stamp.position, index: stamp.index },
    inversePayload: { type: 'node.delete', payload: { uid } },
    event: stampEvent(
      {
        type: 'node.inserted',
        payload: {
          ...payload,
          uid,
          parentUid: parent.uid,
          data: merged.data,
          text: merged.data.text
        },
        affectedUids: [uid, parent.uid]
      },
      stamp
    )
  }
}

async function applyMove(store, op, version, live) {
  const payload = op.payload || {}
  const uid = payload.uid
  const parentRaw = payload.parentUid || payload.parent_uid || payload.parent
  const parent = parentRaw
    ? await resolveParent(store, parentRaw)
    : await resolveParent(store, live.parent_uid || 'root')
  if (parent.uid === uid) throw cycleError()
  if (await store.isDescendant(uid, parent.uid)) throw cycleError()
  const oldParent = live.parent_uid
  const stamp = await placeAmongSiblings(
    store,
    parent.uid,
    uid,
    payload.index,
    version
  )
  await store.updateLocation(
    uid,
    { parent_uid: parent.uid, position: stamp.position },
    version
  )
  return {
    oldParent,
    parent,
    stamp
  }
}

async function applyUpdate(store, op, version) {
  const type = normalizeType(op.type)
  const allowMove = type === 'node.move' || type === 'node.reorder'
  const payload = op.payload || {}
  const uid = payload.uid
  if (!uid) throw nodeDeletedError(uid)
  const live = await store.getLive(uid)
  if (!live) throw nodeDeletedError(uid)
  await assertNotSop(store, uid, payload)
  const expected = payload.expected || payload.expectedValue
  if (expected && typeof expected === 'object') {
    const keys = Object.keys(expected).filter(key => key !== 'revision' && key !== 'uid')
    const conflict = keys.find(key => {
      if (key === 'text') {
        return stripSearchHtml(live.data[key]) !== stripSearchHtml(expected[key])
      }
      return stableValue(live.data[key]) !== stableValue(expected[key])
    })
    if (conflict) {
      throw commandError('目标已被其他协作者修改', 'REPLACE_CONFLICT', 409)
    }
  }
  const structural =
    payload.parentUid !== undefined ||
    payload.parent_uid !== undefined ||
    payload.parent !== undefined ||
    payload.index !== undefined ||
    payload.position !== undefined ||
    payload.order !== undefined
  if (structural && !allowMove) {
    warnStructuralUpdate(op)
  }
  const moving = allowMove && structural
  let moveInfo = null
  if (moving) {
    if (live.is_root && (payload.parent || payload.parentUid || payload.parent_uid)) {
      throw cycleError()
    }
    moveInfo = await applyMove(store, op, version, live)
  }
  const patch = dataFields(payload.patch || payload.data || payload)
  let merged = { data: live.data, changedFields: [], fieldVersions: {} }
  if (Object.keys(patch).length) {
    merged = mergeNodeDataLww(live.data, patch, version)
    await store.updateData(uid, merged.data, version)
  }
  const parentUid = moveInfo ? moveInfo.parent.uid : live.parent_uid
  const stamp = moveInfo
    ? moveInfo.stamp
    : {
        position: live.position,
        index: undefined,
        reindexed: false
      }
  const eventType = moving
    ? payload.parent != null || payload.parentUid != null || payload.parent_uid != null
      ? 'node.moved'
      : 'node.reordered'
    : 'node.updated'
  const inversePatch = {}
  merged.changedFields.forEach(key => {
    inversePatch[key] = live.data[key] === undefined ? null : live.data[key]
  })
  const fieldPayload = {
    uid,
    patch: merged.changedFields.length
      ? merged.changedFields.reduce((acc, key) => {
          acc[key] = merged.data[key] === undefined ? null : merged.data[key]
          return acc
        }, {})
      : undefined,
    data: merged.data,
    text: merged.data && merged.data.text,
    note: merged.data && merged.data.note
  }
  const event = moving
    ? stampEvent(
        {
          type: eventType,
          payload: {
            ...fieldPayload,
            parentUid
          },
          affectedUids: unique([uid, live.parent_uid, parentUid])
        },
        stamp
      )
    : {
        type: eventType,
        payload: fieldPayload,
        affectedUids: unique([uid, live.parent_uid, parentUid])
      }
  return {
    result: {
      uid,
      position: stamp.position,
      index: moving ? stamp.index : undefined
    },
    inversePayload: moving
      ? {
          type: 'node.move',
          payload: {
            uid,
            parentUid: live.parent_uid,
            parent: live.parent_uid,
            position: live.position
          }
        }
      : {
          type: 'node.update',
          payload: { uid, patch: inversePatch }
        },
    event,
    title: live.is_root && merged.data && merged.data.text ? merged.data.text : null
  }
}

async function applyDelete(store, op, version) {
  const payload = op.payload || {}
  const uid = payload.uid
  if (!uid) throw nodeDeletedError(uid)
  const live = await store.getLive(uid)
  if (!live) throw nodeDeletedError(uid)
  if (live.is_root) {
    throw commandError('不能删除根节点', 'ROOT_DELETE', 400)
  }
  await assertNotSop(store, uid, payload)
  const keepChildren = !!(payload.keepChildren || payload.keep_children)
  const kids = await store.listChildren(uid)
  let promoted = []
  let removed = [uid]
  if (keepChildren) {
    promoted = kids.map(item => item.uid)
    for (let i = 0; i < promoted.length; i++) {
      await store.updateLocation(
        promoted[i],
        { parent_uid: live.parent_uid, position: kids[i].position },
        version
      )
    }
  } else {
    const descendants = await store.descendantUids(uid)
    removed = [uid].concat(descendants)
  }
  const snapshot = await store.getMany(removed)
  await store.tombstone(removed, version)
  return {
    result: { uid, removed, promoted },
    inversePayload: {
      type: 'node.restore',
      payload: {
        uid,
        parentUid: live.parent_uid,
        position: live.position,
        keepChildren,
        rows: snapshot.map(row => ({
          uid: row.uid,
          parent_uid: row.parent_uid,
          position: row.position,
          data: row.data,
          is_root: !!row.is_root
        }))
      }
    },
    event: {
      type: 'node.deleted',
      payload: {
        uid,
        parentUid: live.parent_uid,
        removed,
        keepChildren,
        promoted
      },
      affectedUids: unique([uid, live.parent_uid, ...removed, ...promoted])
    }
  }
}

async function applyRestore(store, op, version) {
  const payload = op.payload || {}
  const uid = payload.uid
  let rows = Array.isArray(payload.rows) ? payload.rows.slice() : []
  if (!rows.length) {
    const uids = Array.isArray(payload.removed) && payload.removed.length
      ? payload.removed
      : uid
        ? [uid]
        : []
    rows = (await store.getMany(uids)).filter(row => row.deleted)
  }
  if (!rows.length) throw nodeDeletedError(uid)
  const liveHits = (await store.getMany(rows.map(row => row.uid))).filter(
    row => row && !row.deleted
  )
  if (liveHits.length) {
    throw commandError(`节点已存在: ${liveHits[0].uid}`, 'UID_EXISTS', 409)
  }
  let parentUid = payload.parentUid || payload.parent_uid || payload.parent || rows[0].parent_uid
  let parent = parentUid ? await store.getLive(parentUid) : null
  let parentFallback = false
  if (!parent) {
    parentUid = await store.resolveRoot()
    parent = await store.getLive(parentUid)
    parentFallback = true
    if (!parent) throw parentDeletedError(parentUid)
  }
  const root = rows.find(row => row.uid === uid) || rows[0]
  const stamp = await placeAmongSiblings(
    store,
    parent.uid,
    root.uid,
    payload.index,
    version
  )
  const revived = rows.map(row => {
    const next = {
      uid: row.uid,
      parent_uid: row.parent_uid,
      position: row.position || '',
      data: { ...(row.data || {}), uid: row.uid },
      is_root: !!row.is_root
    }
    if (row.uid === root.uid) {
      next.parent_uid = parent.uid
      next.position = stamp.position
    }
    return next
  })
  await store.revive(revived, version)
  return {
    result: { uid: root.uid, restored: revived.map(row => row.uid), parentFallback },
    inversePayload: { type: 'node.delete', payload: { uid: root.uid } },
    event: stampEvent(
      {
        type: 'node.restored',
        payload: {
          uid: root.uid,
          parentUid: parent.uid,
          rows: revived,
          parentFallback
        },
        affectedUids: unique([root.uid, parent.uid, ...revived.map(row => row.uid)])
      },
      stamp
    )
  }
}

async function applyMeta(store, op, version) {
  const payload = op.payload || {}
  const prev = (store.getMeta && store.getMeta()) || {}
  const next = { ...prev }
  META_KEYS.forEach(key => {
    if (payload[key] !== undefined) next[key] = payload[key]
  })
  if (payload.metadata && typeof payload.metadata === 'object') {
    Object.assign(next, payload.metadata)
  }
  if (store.setMeta) store.setMeta(next)
  const title = payload.title != null ? String(payload.title).trim().slice(0, 80) : next.title
  return {
    result: { metadata: next, title },
    title: title || null,
    metadata: next,
    inversePayload: {
      type: 'map.meta.update',
      payload: { metadata: prev, title: prev.title }
    },
    event: {
      type: 'map.updated',
      payload: { metadata: next, title, resnapshot: false },
      affectedUids: []
    }
  }
}

async function applyInsertBulk(store, childOps, version, roomKey) {
  const existing = await store.getMany(childOps.map(op => (op.payload || {}).uid).filter(Boolean))
  existing.forEach(row => {
    if (!row.deleted) throw commandError(`节点已存在: ${row.uid}`, 'UID_EXISTS', 409)
    if (row.deleted) throw uidReusedError(row.uid)
  })
  const byParent = new Map()
  const parentCache = new Map()
  for (let i = 0; i < childOps.length; i++) {
    const payload = childOps[i].payload || {}
    const parentRaw = payload.parentUid || payload.parent_uid || payload.parent || 'root'
    let parent = parentCache.get(parentRaw)
    if (!parent) {
      parent = await resolveParent(store, parentRaw)
      await assertNotSop(store, parent.uid, payload)
      parentCache.set(parentRaw, parent)
      parentCache.set(parent.uid, parent)
    }
    if (!byParent.has(parent.uid)) byParent.set(parent.uid, { parent, items: [] })
    byParent.get(parent.uid).items.push({ payload, uid: String(payload.uid || '').trim() || createUid() })
  }
  const events = []
  const inverses = []
  const rows = []
  for (const [parentUid, group] of byParent.entries()) {
    const kids = await store.listChildren(parentUid)
    const keys = generateNKeysBetween(
      kids.length ? kids[kids.length - 1].position : null,
      null,
      group.items.length
    )
    group.items.forEach((item, index) => {
      const extra = dataFields(item.payload.data || item.payload)
      const data = {
        uid: item.uid,
        text: item.payload.text != null ? String(item.payload.text) : extra.text || '新节点',
        expand: true,
        ...extra
      }
      data.uid = item.uid
      const merged = mergeNodeDataLww({}, data, version)
      rows.push({
        uid: item.uid,
        parent_uid: parentUid,
        position: keys[index],
        data: merged.data,
        is_root: false,
        node_version: version
      })
      inverses.push({ type: 'node.delete', payload: { uid: item.uid } })
      events.push({
        type: 'node.inserted',
        payload: {
          uid: item.uid,
          parentUid,
          data: merged.data,
          text: merged.data.text,
          position: keys[index],
          index: kids.length + index
        },
        affectedUids: [item.uid, parentUid]
      })
    })
  }
  if (typeof store.insertMany === 'function') await store.insertMany(rows)
  else {
    for (let i = 0; i < rows.length; i++) await store.insert(rows[i])
  }
  return {
    result: { count: rows.length, bulk: true },
    inversePayload: {
      type: 'node.batch',
      payload: { ops: inverses.reverse() }
    },
    event: {
      type: 'batch.applied',
      payload: { count: rows.length, events, resnapshot: false, bulk: true },
      affectedUids: unique(events.flatMap(item => item.affectedUids || []))
    }
  }
}

async function applyBatch(store, op, options) {
  const childOps = Array.isArray(op.payload && op.payload.ops) ? op.payload.ops : []
  if (childOps.length > BATCH_MAX) {
    throw commandError(`batch 超过上限 ${BATCH_MAX}`, 'BATCH_TOO_LARGE', 400)
  }
  const normalized = childOps.map(child =>
    normalizeOperation({ ...child, roomKey: op.roomKey })
  )
  const allInserts =
    normalized.length >= 2 &&
    normalized.every(child => normalizeType(child.type) === 'node.insert')
  if (allInserts && typeof store.insertMany === 'function') {
    return applyInsertBulk(store, normalized, Number(options.version) || 0, op.roomKey)
  }
  const events = []
  const affected = []
  const inverses = []
  const skipped = []
  let appliedCount = 0
  let last = { result: {} }
  for (let i = 0; i < normalized.length; i++) {
    try {
      last = await applyDirect(store, normalized[i], options)
      appliedCount += 1
      if (last.event) {
        events.push(last.event)
        affected.push(...(last.event.affectedUids || []))
      }
      if (last.inversePayload) inverses.push(last.inversePayload)
    } catch (err) {
      if (err && err.code === 'REPLACE_CONFLICT') {
        skipped.push({
          uid: (normalized[i].payload && normalized[i].payload.uid) || '',
          code: err.code
        })
        continue
      }
      throw err
    }
  }
  return {
    result: {
      count: appliedCount,
      skipped: skipped.length,
      skippedItems: skipped,
      batchId: op.payload && op.payload.batchId
    },
    inversePayload: {
      type: 'node.batch',
      payload: { ops: inverses.reverse(), batchId: op.payload && op.payload.batchId }
    },
    event: {
      type: 'batch.applied',
      payload: {
        count: appliedCount,
        skipped: skipped.length,
        skippedItems: skipped,
        events,
        resnapshot: false,
        batchId: op.payload && op.payload.batchId
      },
      affectedUids: unique(affected)
    }
  }
}

async function applyDirect(store, raw, options = {}) {
  const op = normalizeOperation(raw)
  const type = normalizeType(op.type)
  const version = Number(options.version) || 0
  const targetUid = op.targetId || (op.payload && op.payload.uid) || ''
  collabTrace('6.applier.sql', {
    traceId: op.traceId || (op.payload && op.payload.traceId),
    type,
    targetUid,
    version
  })
  let applied
  if (type === 'node.batch') applied = await applyBatch(store, op, options)
  else if (type === 'node.insert') applied = await applyInsert(store, op, version)
  else if (type === 'node.delete') applied = await applyDelete(store, op, version)
  else if (type === 'node.restore') applied = await applyRestore(store, op, version)
  else if (type === 'map.meta.update') applied = await applyMeta(store, op, version)
  else if (type === 'node.update' || type === 'node.move' || type === 'node.reorder') {
    applied = await applyUpdate(store, op, version)
  } else {
    const err = new Error('不支持的操作类型: ' + type)
    err.code = 'UNSUPPORTED_OPERATION'
    err.statusCode = 400
    throw err
  }
  collabTrace('6.applier.done', {
    type,
    targetUid,
    version,
    affected: applied && applied.affectedUids
  })
  return applied
}

function isDirectType(type) {
  return DIRECT_TYPES.has(normalizeType(type))
}

module.exports = {
  DIRECT_TYPES,
  applyDirect,
  isDirectType,
  dataFields
}
