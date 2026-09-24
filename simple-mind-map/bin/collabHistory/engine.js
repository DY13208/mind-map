const { randomUUID } = require('crypto')
const { historyConfig } = require('./config')
const {
  toBusinessTree,
  canonicalMetadata,
  historyChecksum,
  nodeCount,
  assertTreeValid,
  cloneJson
} = require('./canonical')
const { replayOperations } = require('./replayer')
const { historyError } = require('./errors')
const { createTreeCache } = require('./treeCache')
const { formatVersionTime } = require('./versionTime')

function genesisEmptyTree() {
  return {
    root: { isRoot: true, data: { uid: 'root', text: '未命名' }, children: [] }
  }
}

function pigeonholeCompleteFromGenesis(currentRevision, stats) {
  const current = Number(currentRevision || 0)
  const count = Number(stats && stats.count ? stats.count : 0)
  const min = stats && stats.min != null ? Number(stats.min) : null
  const max = stats && stats.max != null ? Number(stats.max) : null
  if (current <= 0) return count === 0
  if (min !== 1) return false
  if (max !== current) return false
  if (count !== current) return false
  return true
}

function uniqEditors(list) {
  return Array.from(
    new Set((list || []).map(item => String(item || '').trim()).filter(Boolean))
  )
}

function dedicatedSummary(kind) {
  return { kind, inserted: 0, updated: 0, deleted: 0, moved: 0, restored: 0 }
}

const SUMMARY_ALGORITHM_VERSION = 2
const OPERATION_ENVELOPE_KEYS = new Set([
  'uid',
  'expected',
  'baseRevision',
  'traceId',
  'clientSeq'
])

function nodeUpdateData(operation) {
  const payload = (operation && operation.payload) || operation || {}
  return payload.patch || payload.data || payload
}

function businessUpdateKeys(operation) {
  return Object.keys(nodeUpdateData(operation)).filter(
    key => !OPERATION_ENVELOPE_KEYS.has(key)
  )
}

function plainRichText(value) {
  return String(value == null ? '' : value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*/g, '\n')
    .trim()
}

function isEquivalentRichTextNormalization(operation, inverse) {
  const keys = businessUpdateKeys(operation)
  if (!keys.length || !keys.every(key => key === 'text' || key === 'richText')) return false
  const next = nodeUpdateData(operation)
  const previous = nodeUpdateData(inverse)
  if (next.richText !== true || previous.richText === true) return false
  if (!Object.prototype.hasOwnProperty.call(next, 'text')) return false
  if (!Object.prototype.hasOwnProperty.call(previous, 'text')) return false
  return plainRichText(next.text) === plainRichText(previous.text)
}

function shouldCountNodeUpdate(operation, inverse) {
  const keys = businessUpdateKeys(operation)
  if (!keys.length || keys.every(key => key === 'childCount')) return false
  return !isEquivalentRichTextNormalization(operation, inverse)
}

function batchInverseFor(child, inverseOps, index) {
  const uid = nodeUpdateData(child).uid
  if (uid) {
    const matched = inverseOps.find(item => nodeUpdateData(item).uid === uid)
    if (matched) return matched
  }
  return inverseOps[inverseOps.length - 1 - index] || null
}

function createHistoryEngine(options = {}) {
  const store = options.store
  const config = historyConfig(options.config || {})
  const treeCache = createTreeCache({
    maxEntries: config.treeCacheMaxEntries,
    maxNodes: config.treeCacheMaxNodes
  })
  const versionChecksums = new Map()
  const roomTail = new Map()

  function enqueueRoom(roomKey, fn) {
    const key = String(roomKey || '')
    const prev = roomTail.get(key) || Promise.resolve()
    const curr = prev.then(fn, fn)
    roomTail.set(key, curr.catch(() => {}))
    return curr
  }

  async function runWithStore(preferred, fn) {
    if (preferred) return fn(preferred)
    if (store.withTx) return store.withTx(fn)
    return fn(store)
  }

  async function createCheckpoint(roomKey, input = {}) {
    const run = async tx => {
      const live = input.state || (await tx.getLiveState(roomKey))
      const revision = Number(input.revision != null ? input.revision : live.revision)
      if (
        !input.state &&
        input.revision != null &&
        Number(live.revision) !== revision
      ) {
        return null
      }
      const tree = toBusinessTree(input.tree || live.nodes)
      const metadata = canonicalMetadata(input.metadata || live.metadata)
      assertTreeValid(tree)
      const checksum = historyChecksum(tree, metadata)
      const existing = await tx.latestCheckpointAt(roomKey, revision)
      if (existing && Number(existing.revision) === revision) return existing
      const stats = tx.operationStats
        ? await tx.operationStats(roomKey)
        : { count: (await tx.listOperations(roomKey, 0, revision)).length }
      return tx.insertCheckpoint({
        id: randomUUID(),
        room_key: roomKey,
        revision,
        tree_snapshot: tree,
        metadata_snapshot: metadata,
        created_at: new Date().toISOString(),
        created_by: input.createdBy || '',
        reason: input.reason || 'THRESHOLD',
        operation_count: Number(
          input.operationCount != null ? input.operationCount : stats.count || 0
        ),
        snapshot_version: config.snapshotVersion,
        checksum,
        node_count: nodeCount(tree)
      })
    }
    return runWithStore(input.tx, run)
  }

  async function auditHistoryCoverage(roomKey, tx = store) {
    const live = await tx.getLiveState(roomKey)
    const stats = tx.operationStats
      ? await tx.operationStats(roomKey)
      : { min: null, max: null, count: 0 }
    const earliest = tx.earliestCheckpoint
      ? await tx.earliestCheckpoint(roomKey)
      : await tx.latestCheckpointAt(roomKey, Number(live.revision || 0))
    return {
      roomKey,
      currentRevision: Number(live.revision || 0),
      operationMinRevision: stats.min,
      operationMaxRevision: stats.max,
      operationCount: Number(stats.count || 0),
      hasCheckpoint: !!earliest,
      operationHistoryCompleteFromGenesis: pigeonholeCompleteFromGenesis(
        live.revision,
        stats
      )
    }
  }

  async function getHistoryCoverage(roomKey, tx = store) {
    const live = await tx.getLiveState(roomKey)
    const earliest = tx.earliestCheckpoint
      ? await tx.earliestCheckpoint(roomKey)
      : null
    const start = earliest ? Number(earliest.revision) : Number(live.revision || 0)
    return {
      historyStartRevision: start,
      earliestAvailableRevision: start,
      latestRevision: Number(live.revision || 0),
      currentRevision: Number(live.revision || 0),
      completeFromRevision: start
    }
  }

  async function createInitialVersion(tx, roomKey, live, createdBy) {
    return createVersion(roomKey, {
      revision: Number(live.revision || 0),
      type: 'AUTO',
      name: '初始版本',
      createdBy,
      source: 'room_initial',
      source_kind: 'room_initial',
      summary: dedicatedSummary('initial'),
      summary_status: 'na',
      skipEnsure: true,
      tx
    })
  }

  async function ensureHistoryBaseline(roomKey, input = {}) {
    const run = async tx => {
      const existing = tx.earliestCheckpoint
        ? await tx.earliestCheckpoint(roomKey)
        : null
      if (existing) return existing
      const live = await tx.getLiveState(roomKey)
      const stats = tx.operationStats
        ? await tx.operationStats(roomKey)
        : { min: null, max: null, count: 0 }
      const pigeon = pigeonholeCompleteFromGenesis(live.revision, stats)
      if (pigeon && Number(live.revision) > 0) {
        try {
          const ops = await tx.listOperations(roomKey, 0, live.revision)
          const replayed = await replayOperations(genesisEmptyTree(), {}, ops, {
            requireContinuous: true,
            fromRevision: 0
          })
          const tree = toBusinessTree(replayed.tree)
          const metadata = canonicalMetadata(replayed.metadata)
          const liveTree = toBusinessTree(live.nodes)
          const liveMeta = canonicalMetadata(live.metadata)
          if (historyChecksum(tree, metadata) === historyChecksum(liveTree, liveMeta)) {
            const checkpoint = await tx.insertCheckpoint({
              id: randomUUID(),
              room_key: roomKey,
              revision: 0,
              tree_snapshot: toBusinessTree(genesisEmptyTree()),
              metadata_snapshot: {},
              created_at: new Date().toISOString(),
              created_by: input.createdBy || '',
              reason: 'ROOM_INITIAL',
              operation_count: 0,
              snapshot_version: config.snapshotVersion,
              checksum: historyChecksum(toBusinessTree(genesisEmptyTree()), {}),
              node_count: nodeCount(toBusinessTree(genesisEmptyTree()))
            })
            await createInitialVersion(tx, roomKey, { revision: 0 }, input.createdBy)
            return checkpoint
          }
        } catch (error) {
          // Older rooms can have a continuous operation sequence that predates
          // Collab V2's replay assumptions. Keep the current durable tree as
          // the history baseline instead of making the entire history view fail.
          console.warn(
            '[history] cannot replay room genesis; bootstrapping current state',
            roomKey,
            error && error.code ? error.code : error && error.message
          )
        }
      }
      const reason =
        input.reason ||
        (Number(live.revision) === 0 ? 'ROOM_INITIAL' : 'HISTORY_BOOTSTRAP')
      const checkpoint = await createCheckpoint(roomKey, {
        state: live,
        revision: Number(live.revision || 0),
        createdBy: input.createdBy || '',
        reason,
        operationCount: stats.count,
        tx
      })
      if (reason === 'ROOM_INITIAL') {
        await createInitialVersion(tx, roomKey, live, input.createdBy)
      }
      return checkpoint
    }
    if (input.tx) return run(input.tx)
    if (input.locked) return run(store)
    return store.withRoomLock(roomKey, tx => run(tx))
  }

  async function getRoomStateAtRevision(roomKey, targetRevision, options = {}) {
    const target = Number(targetRevision)
    if (!Number.isFinite(target) || target < 0) {
      throw historyError('BAD_REVISION', 'invalid targetRevision', 400)
    }
    const tx = options.tx || store
    if (!options.skipEnsure) {
      await ensureHistoryBaseline(roomKey, {
        locked: !!options.locked,
        tx: options.tx
      })
    }
    const coverage = await getHistoryCoverage(roomKey, tx)
    if (target < Number(coverage.earliestAvailableRevision)) {
      throw historyError(
        'HISTORY_REVISION_UNAVAILABLE',
        'revision is before history baseline',
        409
      )
    }
    const checkpoint = await tx.latestCheckpointAt(roomKey, target)
    if (!checkpoint) {
      throw historyError(
        'HISTORY_REVISION_UNAVAILABLE',
        'no reliable checkpoint for this revision',
        409
      )
    }
    if (checkpoint.checksum) {
      const actual = historyChecksum(
        checkpoint.tree_snapshot,
        checkpoint.metadata_snapshot
      )
      if (actual !== checkpoint.checksum) {
        throw historyError('CHECKPOINT_CORRUPTED', 'checkpoint checksum mismatch', 409)
      }
    }
    const baseTree = checkpoint.tree_snapshot
    const baseMeta = checkpoint.metadata_snapshot
    const from = Number(checkpoint.revision)
    const ops = from < target ? await tx.listOperations(roomKey, from, target) : []
    let replayed
    try {
      replayed = await replayOperations(baseTree, baseMeta, ops, {
        requireContinuous: true,
        fromRevision: from,
        lookup: {
          getOperation: id => tx.getOperation(roomKey, id),
          listAfter: version => tx.listOperations(roomKey, version, target)
        }
      })
    } catch (error) {
      if (error && error.code) throw error
      throw historyError(
        'HISTORY_REPLAY_FAILED',
        'historical reconstruction failed: ' + (error && error.message),
        409
      )
    }
    const tree = toBusinessTree(replayed.tree)
    const metadata = canonicalMetadata(replayed.metadata)
    assertTreeValid(tree)
    return {
      roomKey,
      revision: target,
      tree,
      metadata,
      checkpointRevision: from,
      operationCount: ops.length,
      checksum: historyChecksum(tree, metadata),
      readOnly: true,
      viewingHistory: true,
      earliestAvailableRevision: coverage.earliestAvailableRevision,
      currentRevision: coverage.currentRevision,
      completeFromRevision: coverage.completeFromRevision
    }
  }

  async function getLegacyState(roomKey, version, tx = store) {
    if (!tx.getLegacySnapshot) {
      throw historyError(
        'HISTORY_REVISION_UNAVAILABLE',
        'legacy snapshot store unavailable',
        409
      )
    }
    const snap = await tx.getLegacySnapshot(roomKey, version.id)
    if (!snap || snap.tree_snapshot == null) {
      throw historyError(
        'HISTORY_REVISION_UNAVAILABLE',
        'legacy snapshot content missing',
        409
      )
    }
    const tree = toBusinessTree(snap.tree_snapshot)
    const metadata = canonicalMetadata(snap.metadata_snapshot || {})
    if (snap.checksum) {
      const actual = historyChecksum(tree, metadata)
      if (actual !== snap.checksum) {
        throw historyError('CHECKPOINT_CORRUPTED', 'legacy snapshot checksum mismatch', 409)
      }
    }
    try {
      assertTreeValid(tree)
    } catch (error) {
      throw historyError(
        'HISTORY_REVISION_UNAVAILABLE',
        'legacy snapshot tree is not restorable',
        409
      )
    }
    const coverage = await getHistoryCoverage(roomKey, tx)
    return {
      roomKey,
      revision: null,
      tree,
      metadata,
      checkpointRevision: 0,
      operationCount: 0,
      checksum: historyChecksum(tree, metadata),
      readOnly: true,
      viewingHistory: true,
      availability: version.availability || 'partial',
      ...coverage
    }
  }

  async function summarizeRange(roomKey, fromRevision, toRevision, tx = store) {
    const ops = await tx.listOperations(roomKey, fromRevision, toRevision)
    const summary = {
      kind: 'edits',
      inserted: 0,
      updated: 0,
      deleted: 0,
      moved: 0,
      restored: 0,
      metadataChanged: false,
      replaced: false
    }
    ops.forEach(op => {
      const type = String(op.operation_type || op.type || '')
      if (type === 'node.insert') summary.inserted += 1
      else if (type === 'node.update') {
        if (shouldCountNodeUpdate(op, op.inverse_payload)) summary.updated += 1
      }
      else if (type === 'node.delete') summary.deleted += 1
      else if (type === 'node.move' || type === 'node.reorder') summary.moved += 1
      else if (type === 'node.restore') summary.restored += 1
      else if (type === 'map.meta.update' || type === 'map.update') {
        summary.metadataChanged = true
      } else if (type === 'map.replace') summary.replaced = true
      else if (type === 'node.batch') {
        const inner = (op.payload && op.payload.ops) || []
        const inverseOps =
          (op.inverse_payload && op.inverse_payload.payload && op.inverse_payload.payload.ops) ||
          []
        inner.forEach((child, index) => {
          const ct = String(child.type || '')
          if (ct === 'node.insert') summary.inserted += 1
          else if (ct === 'node.update') {
            if (shouldCountNodeUpdate(child, batchInverseFor(child, inverseOps, index))) {
              summary.updated += 1
            }
          }
          else if (ct === 'node.delete') summary.deleted += 1
          else if (ct === 'node.move') summary.moved += 1
        })
      }
    })
    return summary
  }

  async function persistSummary(tx, roomKey, row) {
    const type = String(row.type || '').toUpperCase()
    const kindMap = {
      IMPORT: 'import',
      PRE_RESTORE: 'pre_restore',
      RESTORE: 'restore',
      LEGACY: 'legacy'
    }
    if (kindMap[type] || row.source_kind === 'room_initial') {
      const summary = dedicatedSummary(kindMap[type] || 'initial')
      if (tx.updateVersionMeta) {
        await tx.updateVersionMeta(roomKey, row.id, {
          summary,
          summary_status: 'na'
        })
      }
      row.summary = summary
      row.summary_status = 'na'
      return row
    }
    if (row.revision == null || !tx.previousVisibleVersion) {
      row.summary_status = row.summary_status || 'pending'
      return row
    }
    try {
      const prev = await tx.previousVisibleVersion(roomKey, row)
      const from = prev && prev.revision != null ? Number(prev.revision) : 0
      const summary = {
        ...(await summarizeRange(roomKey, from, Number(row.revision), tx)),
        algorithmVersion: SUMMARY_ALGORITHM_VERSION
      }
      if (tx.updateVersionMeta) {
        await tx.updateVersionMeta(roomKey, row.id, {
          summary,
          summary_status: 'ready'
        })
      }
      row.summary = summary
      row.summary_status = 'ready'
    } catch (err) {
      row.summary_status = 'pending'
    }
    return row
  }

  async function createVersion(roomKey, input = {}) {
    const tx = input.tx || store
    if (!input.skipEnsure) {
      await ensureHistoryBaseline(roomKey, {
        createdBy: input.createdBy,
        locked: !!input.locked,
        tx: input.tx
      })
    }
    const live = await tx.getLiveState(roomKey)
    const revision =
      input.revision === null
        ? null
        : Number(input.revision != null ? input.revision : live.revision)
    if (revision != null && revision > Number(live.revision)) {
      throw historyError('BAD_REVISION', 'version revision cannot exceed current', 400)
    }
    const coverage = await getHistoryCoverage(roomKey, tx)
    if (
      revision != null &&
      revision < Number(coverage.earliestAvailableRevision)
    ) {
      throw historyError(
        'HISTORY_REVISION_UNAVAILABLE',
        'revision is before history baseline',
        409
      )
    }
    const checkpoint =
      revision == null ? null : await tx.latestCheckpointAt(roomKey, revision)
    const type = String(input.type || 'MANUAL').toUpperCase()
    const editors = uniqEditors(
      input.editors || (input.createdBy ? [input.createdBy] : [])
    )
    const row = await tx.insertVersion({
      id: input.id || randomUUID(),
      room_key: roomKey,
      revision,
      checkpoint_revision: checkpoint
        ? Number(checkpoint.revision)
        : coverage.earliestAvailableRevision,
      name: String(input.name || ''),
      description: String(input.description || ''),
      type,
      created_by: input.createdBy || '',
      created_at: input.created_at || new Date().toISOString(),
      source: input.source || 'api',
      hidden: false,
      summary: input.summary || {},
      summary_status: input.summary_status || 'pending',
      editors,
      source_kind: input.source_kind || '',
      availability: input.availability || 'readable',
      legacy_source: input.legacy_source || ''
    })
    await tx.insertAudit({
      room_key: roomKey,
      action: 'VERSION_CREATE',
      version_id: row.id,
      target_revision: revision,
      from_revision: revision,
      new_revision: live.revision,
      user_id: input.createdBy || '',
      detail: { type: row.type, name: row.name }
    })
    return persistSummary(tx, roomKey, row)
  }

  async function maybeAutoVersion(roomKey, revision, createdBy, now = Date.now()) {
    if (!config.autoVersionOnCheckpoint) return null
    const last = await store.lastAutoVersionAt(roomKey)
    if (last && now - last < config.autoVersionMinMs) return null
    return createVersion(roomKey, {
      revision,
      type: 'AUTO',
      name: '自动保存 ' + formatVersionTime(now),
      createdBy,
      source: 'checkpoint',
      source_kind: 'checkpoint'
    })
  }

  async function scheduleAutoJob(roomKey, operation, now = Date.now()) {
    if (!store.upsertAutoJob) return null
    const type = String(operation.operation_type || operation.type || '')
    const reason = (operation.payload && operation.payload.reason) || ''
    if (type === 'map.replace' && reason === 'VERSION_RESTORE') return null
    const revision = Number(operation.version || operation.serverRevision || 0)
    if (!revision) return null
    const lastAuto = await store.lastAutoVersionAt(roomKey)
    let dueAt = now + Number(config.autoVersionIdleMs)
    if (lastAuto) {
      const forceAt = lastAuto + Number(config.autoVersionMinMs)
      if (forceAt < dueAt) dueAt = Math.max(now, forceAt)
    }
    await store.upsertAutoJob({
      room_key: roomKey,
      last_revision: revision,
      last_activity_at: new Date(now).toISOString(),
      due_at: new Date(dueAt).toISOString(),
      editors: uniqEditors([operation.actor_id || operation.actorId || ''])
    })
    return dueAt
  }

  async function processDueAutoJobs(now = Date.now()) {
    if (!store.claimDueAutoJobs) return []
    const jobs = await store.claimDueAutoJobs(
      now,
      8,
      'history-worker',
      config.autoJobMaxAttempts
    )
    const created = []
    for (const job of jobs) {
      try {
        const live = await store.getLiveState(job.room_key)
        const revision = Math.min(
          Number(job.last_revision || 0),
          Number(live.revision || 0)
        )
        if (!revision && Number(live.revision) === 0) {
          await store.completeAutoJob(job.room_key, 0)
          continue
        }
        const row = await createVersion(job.room_key, {
          revision,
          type: 'AUTO',
          name: '自动保存 ' + formatVersionTime(now),
          createdBy: (job.editors && job.editors[0]) || '',
          editors: job.editors || [],
          source: 'auto',
          source_kind: 'auto'
        })
        await store.completeAutoJob(job.room_key, revision)
        created.push(row)
      } catch (error) {
        if (store.failAutoJob) await store.failAutoJob(job.room_key, error)
      }
    }
    return created
  }

  async function latestCapturedRevision(roomKey, tx = store) {
    if (tx.latestVisibleRevision) {
      const value = await tx.latestVisibleRevision(roomKey)
      if (value != null) return Number(value)
    }
    const listed = await tx.listVersions(roomKey, { limit: 50 })
    let max = null
    ;(listed.versions || []).forEach(row => {
      if (row.revision == null || row.revision === '') return
      const n = Number(row.revision)
      if (!Number.isFinite(n)) return
      if (max == null || n > max) max = n
    })
    return max
  }

  async function flushPendingAutoVersion(roomKey, input = {}) {
    return enqueueRoom(roomKey, async () => {
      const live = await store.getLiveState(roomKey)
      const revision = Number(live.revision || 0)
      const captured = await latestCapturedRevision(roomKey)
      if (captured != null && revision <= Number(captured)) {
        if (store.completeAutoJob) await store.completeAutoJob(roomKey, revision)
        return null
      }
      if (!revision && captured == null) {
        if (store.completeAutoJob) await store.completeAutoJob(roomKey, 0)
        return null
      }
      const row = await createVersion(roomKey, {
        revision,
        type: 'AUTO',
        name: '自动保存 ' + formatVersionTime(Date.now()),
        createdBy: input.userId || '',
        editors: input.editors || (input.userId ? [input.userId] : []),
        source: input.source || 'flush',
        source_kind: 'auto'
      })
      if (store.completeAutoJob) await store.completeAutoJob(roomKey, revision)
      return row
    })
  }

  async function maybeCheckpointAfterOp(roomKey, operation) {
    const type = String(operation.operation_type || operation.type || '')
    const revision = Number(operation.version || operation.serverRevision || 0)
    if (
      type === 'map.replace' &&
      store.hasAtomicMapReplaceHistory &&
      (await store.hasAtomicMapReplaceHistory(
        roomKey,
        revision,
        operation.operation_id || operation.operationId
      ))
    ) {
      const checkpoint = store.latestCheckpointAt
        ? await store.latestCheckpointAt(roomKey, revision)
        : null
      if (config.autoVersionOnCheckpoint) {
        await maybeAutoVersion(roomKey, revision, operation.actor_id || '')
      }
      return checkpoint
    }
    const has = store.hasAnyCheckpoint ? await store.hasAnyCheckpoint(roomKey) : false
    if (!has) {
      return ensureHistoryBaseline(roomKey, {
        createdBy: operation.actor_id || ''
      })
    }
    const lastRev = store.latestCheckpointRevision
      ? await store.latestCheckpointRevision(roomKey)
      : null
    const heavy = type === 'map.replace'
    const since = lastRev == null ? revision : revision - Number(lastRev)
    const payloadReason = (operation.payload && operation.payload.reason) || ''
    const reason = heavy
      ? payloadReason || 'IMPORT'
      : since >= config.checkpointEvery
        ? 'THRESHOLD'
        : ''
    if (!reason) return null
    const checkpoint = await createCheckpoint(roomKey, {
      revision,
      createdBy: operation.actor_id || '',
      reason: reason === 'VERSION_RESTORE' ? 'VERSION_RESTORE' : reason
    })
    if (reason === 'IMPORT') {
      await createVersion(roomKey, {
        revision,
        type: 'IMPORT',
        name: '导入',
        createdBy: operation.actor_id || '',
        source: 'import',
        source_kind: 'import',
        summary: dedicatedSummary('import'),
        summary_status: 'na'
      })
    }
    if (
      config.autoVersionOnCheckpoint &&
      (reason === 'THRESHOLD' || reason === 'IMPORT' || reason === 'VERSION_RESTORE')
    ) {
      await maybeAutoVersion(roomKey, revision, operation.actor_id || '')
    }
    return checkpoint
  }

  async function restoreVersion(roomKey, input = {}) {
    const key = input.idempotencyKey ? String(input.idempotencyKey).slice(0, 180) : ''
    if (key && store.getRestoreIdempotency) {
      const existing = await store.getRestoreIdempotency(roomKey, key)
      if (existing) return existing
    }
    await ensureHistoryBaseline(roomKey, { createdBy: input.userId || '' })
    const version = input.versionId
      ? await store.getVersion(roomKey, input.versionId)
      : null
    if (input.versionId && !version) {
      throw historyError('VERSION_NOT_FOUND', 'version not found', 404)
    }
    if (version && version.availability === 'unreadable') {
      throw historyError(
        'HISTORY_REVISION_UNAVAILABLE',
        'version content cannot be reconstructed',
        409
      )
    }
    const isLegacy =
      version &&
      (String(version.type).toUpperCase() === 'LEGACY' || version.revision == null)
    const targetRevision = isLegacy
      ? null
      : Number(
          version
            ? version.revision
            : input.targetRevision != null
              ? input.targetRevision
              : NaN
        )
    if (!isLegacy && !Number.isFinite(targetRevision)) {
      throw historyError('BAD_REVISION', 'restore target is missing', 400)
    }
    const historical = isLegacy
      ? await getLegacyState(roomKey, version)
      : await getRoomStateAtRevision(roomKey, targetRevision)

    const result = await store.withRoomLock(roomKey, async tx => {
      const capture = typeof store.capture === 'function' ? store.capture() : null
      try {
        if (key && tx.getRestoreIdempotency) {
          const again = await tx.getRestoreIdempotency(roomKey, key)
          if (again) return again
        }
        const live = await tx.getLiveState(roomKey)
        const currentRevision = Number(live.revision)
        if (
          input.expectedCurrentRevision != null &&
          Number(input.expectedCurrentRevision) !== currentRevision
        ) {
          throw historyError(
            'RESTORE_CONFLICT',
            'concurrent restore or stale current revision',
            409
          )
        }
        const coverage = await getHistoryCoverage(roomKey, tx)
        if (
          !isLegacy &&
          targetRevision < Number(coverage.earliestAvailableRevision)
        ) {
          throw historyError(
            'HISTORY_REVISION_UNAVAILABLE',
            'restore target is before history baseline',
            409
          )
        }
        const pre = await createCheckpoint(roomKey, {
          state: live,
          revision: currentRevision,
          createdBy: input.userId || '',
          reason: 'PRE_RESTORE',
          tx
        })
        const preVersion = await createVersion(roomKey, {
          revision: currentRevision,
          type: 'PRE_RESTORE',
          name: input.preName || '恢复前 ' + formatVersionTime(Date.now()),
          description: '恢复前自动备份',
          createdBy: input.userId || '',
          source: 'restore',
          source_kind: 'pre_restore',
          skipEnsure: true,
          locked: true,
          tx
        })
        const newRevision = currentRevision + 1
        await tx.setLiveState(roomKey, {
          revision: newRevision,
          nodes: historical.tree,
          metadata: historical.metadata,
          restoreEpochRevision: newRevision
        })
        const restoreOp = {
          room_key: roomKey,
          version: newRevision,
          operation_id: randomUUID(),
          actor_id: input.userId || '',
          client_id: input.clientId || '',
          operation_type: 'map.replace',
          payload: {
            reason: 'VERSION_RESTORE',
            fullTreeReason: 'VERSION_RESTORE',
            restore: true,
            fromRevision: targetRevision,
            preRestoreRevision: currentRevision,
            versionId: version && version.id
          },
          event: {
            type: 'map.replaced',
            payload: {
              resnapshot: true,
              reason: 'VERSION_RESTORE',
              fullTreeReason: 'VERSION_RESTORE',
              fromRevision: targetRevision,
              newRevision
            }
          },
          inverse_payload: null
        }
        await tx.appendOperation(restoreOp)
        const post = await createCheckpoint(roomKey, {
          revision: newRevision,
          tree: historical.tree,
          metadata: historical.metadata,
          state: {
            revision: newRevision,
            nodes: historical.tree,
            metadata: historical.metadata
          },
          createdBy: input.userId || '',
          reason: 'VERSION_RESTORE',
          tx
        })
        const restoreVersionRow = await createVersion(roomKey, {
          revision: newRevision,
          type: 'RESTORE',
          name: input.name || '恢复到 ' + formatVersionTime(version && version.created_at || Date.now()),
          description: input.description || '',
          createdBy: input.userId || '',
          source: 'restore',
          source_kind: 'restore',
          skipEnsure: true,
          locked: true,
          tx
        })
        await tx.insertAudit({
          room_key: roomKey,
          action: 'VERSION_RESTORE',
          version_id: restoreVersionRow.id,
          target_revision: targetRevision,
          from_revision: currentRevision,
          new_revision: newRevision,
          user_id: input.userId || '',
          detail: {
            preRestoreVersionId: preVersion.id,
            preCheckpointId: pre && pre.id,
            postCheckpointId: post && post.id
          }
        })
        const payload = {
          ok: true,
          fromRevision: currentRevision,
          targetRevision,
          newRevision,
          preRestoreVersionId: preVersion.id,
          restoreVersionId: restoreVersionRow.id,
          operation: restoreOp,
          tree: historical.tree,
          metadata: historical.metadata,
          earliestAvailableRevision: coverage.earliestAvailableRevision,
          currentRevision: newRevision,
          completeFromRevision: coverage.completeFromRevision
        }
        if (key && tx.putRestoreIdempotency) {
          await tx.putRestoreIdempotency(roomKey, key, payload)
        }
        return payload
      } catch (error) {
        if (capture && typeof store.restoreCapture === 'function') {
          store.restoreCapture(capture)
        }
        throw error
      }
    })
    try {
      if (store.kind === 'pg') {
        const storage = require('../storage')
        if (typeof storage.invalidateRoomCache === 'function') {
          storage.invalidateRoomCache(roomKey)
        }
        const pool = typeof storage.getPool === 'function' ? storage.getPool() : null
        if (pool) {
          await require('../knowledge/sourceChanges').recordLegacySave(pool, roomKey)
        }
      }
    } catch (err) {
      /* index update is best-effort after durable restore */
    }
    return result
  }

  async function onCommitted(event) {
    const roomKey = event.roomKey
    const operation = event.operation || {}
    if (!roomKey || !operation) return null
    return enqueueRoom(roomKey, async () => {
      if (store.kind !== 'pg') {
        const live = await store.getLiveState(roomKey)
        if (event.nodes) live.nodes = event.nodes
        if (event.metadata) live.metadata = event.metadata
        if (Number(event.version) > 0) live.revision = Number(event.version)
        await store.setLiveState(roomKey, live)
        if (operation.operation_id && store.appendOperation) {
          const exists = await store.getOperation(roomKey, operation.operation_id)
          if (!exists) {
            await store.appendOperation({
              room_key: roomKey,
              version: Number(operation.version || event.version),
              operation_id: operation.operation_id,
              actor_id: operation.actor_id || '',
              client_id: operation.client_id || '',
              operation_type: operation.operation_type,
              payload: operation.payload || {},
              event: operation.event || {},
              inverse_payload: operation.inverse_payload || null
            })
          }
        }
      }
      const checkpoint = await maybeCheckpointAfterOp(roomKey, {
        ...operation,
        version: operation.version || event.version
      })
      await scheduleAutoJob(roomKey, {
        ...operation,
        version: operation.version || event.version
      })
      return checkpoint
    })
  }

  async function hydrateEditors(rows, tx = store) {
    const ids = []
    rows.forEach(row => {
      const fromEditors = (row.editors || []).map(item =>
        item && typeof item === 'object' ? item.userId || item.user_id : item
      )
      uniqEditors([row.created_by, ...fromEditors]).forEach(id => ids.push(id))
    })
    const names = tx.resolveUserNames ? await tx.resolveUserNames(ids) : {}
    return rows.map(row => {
      const fromEditors = (row.editors || []).map(item =>
        item && typeof item === 'object' ? item.userId || item.user_id : item
      )
      const editors = uniqEditors([...fromEditors, row.created_by]).map(userId => ({
        userId,
        name: names[userId] || userId
      }))
      return {
        ...row,
        editors,
        created_by_name: names[row.created_by] || row.created_by || ''
      }
    })
  }

  async function listVersions(roomKey, query) {
    await ensureHistoryBaseline(roomKey)
    const listed = await store.listVersions(roomKey, query)
    const coverage = await getHistoryCoverage(roomKey)
    const refreshed = await Promise.all(
      (listed.versions || []).map(row => {
        const summary = row.summary || {}
        const needsRefresh =
          row.summary_status === 'pending' ||
          (row.summary_status === 'ready' &&
            Number(summary.algorithmVersion || 0) < SUMMARY_ALGORITHM_VERSION)
        return needsRefresh ? persistSummary(store, roomKey, row) : row
      })
    )
    const versions = await hydrateEditors(refreshed)
    return { ...listed, versions, ...coverage }
  }

  async function hideVersion(roomKey, id, userId) {
    const hidden = await store.hideVersion(roomKey, id)
    if (hidden) {
      await store.insertAudit({
        room_key: roomKey,
        action: 'VERSION_HIDE',
        version_id: id,
        user_id: userId || '',
        detail: { name: hidden.name, type: hidden.type }
      })
    }
    return hidden
  }

  async function getVersionTree(roomKey, versionId) {
    const row = await store.getVersion(roomKey, versionId)
    if (!row) throw historyError('VERSION_NOT_FOUND', 'version not found', 404)
    if (row.availability === 'unreadable') {
      throw historyError(
        'HISTORY_REVISION_UNAVAILABLE',
        'version content cannot be reconstructed',
        409
      )
    }
    const isLegacy =
      String(row.type).toUpperCase() === 'LEGACY' || row.revision == null
    const cacheKey = row.id
    const knownChecksum = versionChecksums.get(cacheKey)
    if (knownChecksum) {
      const cached = treeCache.get(cacheKey, knownChecksum)
      if (cached) return cached
    }
    const historical = isLegacy
      ? await getLegacyState(roomKey, row)
      : await getRoomStateAtRevision(roomKey, row.revision)
    const checksum = historical.checksum
    versionChecksums.set(cacheKey, checksum)
    const hit = treeCache.get(cacheKey, checksum)
    if (hit) return hit
    const summaryIsCurrent =
      row.summary && Number(row.summary.algorithmVersion || 0) >= SUMMARY_ALGORITHM_VERSION
    const summary =
      row.summary_status === 'na' || (row.summary_status === 'ready' && summaryIsCurrent)
        ? row.summary
        : await persistSummary(store, roomKey, row).then(item => item.summary)
    const payload = {
      ...historical,
      version: row,
      summary,
      checksum
    }
    treeCache.set(cacheKey, checksum, payload, nodeCount(historical.tree))
    return payload
  }

  return {
    config,
    store,
    treeCache,
    createCheckpoint,
    ensureHistoryBaseline,
    auditHistoryCoverage,
    getHistoryCoverage,
    getRoomStateAtRevision,
    getLegacyState,
    summarizeRange,
    createVersion,
    restoreVersion,
    maybeCheckpointAfterOp,
    scheduleAutoJob,
    processDueAutoJobs,
    flushPendingAutoVersion,
    onCommitted,
    listVersions,
    presentVersions: hydrateEditors,
    getVersion: (roomKey, id, options) => store.getVersion(roomKey, id, options),
    hideVersion,
    getVersionTree,
    listAudit: roomKey => store.listAudit(roomKey)
  }
}

module.exports = { createHistoryEngine, pigeonholeCompleteFromGenesis, formatVersionTime }
