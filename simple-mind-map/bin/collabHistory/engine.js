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

function err(code, message, status) {
  const e = new Error(message)
  e.code = code
  e.statusCode = status || 400
  return e
}

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

function createHistoryEngine(options = {}) {
  const store = options.store
  const config = historyConfig(options.config || {})

  async function createCheckpoint(roomKey, input = {}) {
    const live = input.state || (await store.getLiveState(roomKey))
    const revision = Number(input.revision != null ? input.revision : live.revision)
    const tree = toBusinessTree(input.tree || live.nodes)
    const metadata = canonicalMetadata(input.metadata || live.metadata)
    assertTreeValid(tree)
    const checksum = historyChecksum(tree, metadata)
    const existing = await store.latestCheckpointAt(roomKey, revision)
    if (existing && Number(existing.revision) === revision) return existing
    const stats = store.operationStats
      ? await store.operationStats(roomKey)
      : { count: (await store.listOperations(roomKey, 0, revision)).length }
    return store.insertCheckpoint({
      id: randomUUID(),
      room_key: roomKey,
      revision,
      tree_snapshot: tree,
      metadata_snapshot: metadata,
      created_at: new Date().toISOString(),
      created_by: input.createdBy || '',
      reason: input.reason || 'THRESHOLD',
      operation_count: Number(input.operationCount != null ? input.operationCount : stats.count || 0),
      snapshot_version: config.snapshotVersion,
      checksum,
      node_count: nodeCount(tree)
    })
  }

  async function auditHistoryCoverage(roomKey) {
    const live = await store.getLiveState(roomKey)
    const stats = store.operationStats
      ? await store.operationStats(roomKey)
      : { min: null, max: null, count: 0 }
    const earliest = store.earliestCheckpoint
      ? await store.earliestCheckpoint(roomKey)
      : await store.latestCheckpointAt(roomKey, Number(live.revision || 0))
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

  async function getHistoryCoverage(roomKey) {
    const live = await store.getLiveState(roomKey)
    const earliest = store.earliestCheckpoint
      ? await store.earliestCheckpoint(roomKey)
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

  async function ensureHistoryBaseline(roomKey, input = {}) {
    const run = async () => {
      const existing = store.earliestCheckpoint
        ? await store.earliestCheckpoint(roomKey)
        : null
      if (existing) return existing
      const live = await store.getLiveState(roomKey)
      const stats = store.operationStats
        ? await store.operationStats(roomKey)
        : { min: null, max: null, count: 0 }
      const pigeon = pigeonholeCompleteFromGenesis(live.revision, stats)
      if (pigeon && Number(live.revision) > 0) {
        const ops = await store.listOperations(roomKey, 0, live.revision)
        const replayed = await replayOperations(genesisEmptyTree(), {}, ops)
        const tree = toBusinessTree(replayed.tree)
        const metadata = canonicalMetadata(replayed.metadata)
        const liveTree = toBusinessTree(live.nodes)
        const liveMeta = canonicalMetadata(live.metadata)
        if (historyChecksum(tree, metadata) === historyChecksum(liveTree, liveMeta)) {
          return store.insertCheckpoint({
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
        }
      }
      const reason =
        input.reason ||
        (Number(live.revision) === 0 ? 'ROOM_INITIAL' : 'HISTORY_BOOTSTRAP')
      return createCheckpoint(roomKey, {
        state: live,
        revision: Number(live.revision || 0),
        createdBy: input.createdBy || '',
        reason,
        operationCount: stats.count
      })
    }
    if (input.locked) return run()
    return store.withRoomLock(roomKey, run)
  }

  async function getRoomStateAtRevision(roomKey, targetRevision, options = {}) {
    const target = Number(targetRevision)
    if (!Number.isFinite(target) || target < 0) {
      throw err('BAD_REVISION', 'invalid targetRevision', 400)
    }
    if (!options.skipEnsure) {
      await ensureHistoryBaseline(roomKey, { locked: !!options.locked })
    }
    const coverage = await getHistoryCoverage(roomKey)
    if (target < Number(coverage.earliestAvailableRevision)) {
      throw err(
        'HISTORY_REVISION_UNAVAILABLE',
        'revision is before history baseline',
        409
      )
    }
    const checkpoint = await store.latestCheckpointAt(roomKey, target)
    if (!checkpoint) {
      throw err(
        'HISTORY_REVISION_UNAVAILABLE',
        'no reliable checkpoint for this revision',
        409
      )
    }
    if (checkpoint.checksum) {
      const actual = historyChecksum(checkpoint.tree_snapshot, checkpoint.metadata_snapshot)
      if (actual !== checkpoint.checksum) {
        throw err('CHECKPOINT_CORRUPTED', 'checkpoint checksum mismatch', 409)
      }
    }
    const baseTree = checkpoint.tree_snapshot
    const baseMeta = checkpoint.metadata_snapshot
    const from = Number(checkpoint.revision)
    const ops = from < target ? await store.listOperations(roomKey, from, target) : []
    const replayed = await replayOperations(baseTree, baseMeta, ops)
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

  async function summarizeRange(roomKey, fromRevision, toRevision) {
    const ops = await store.listOperations(roomKey, fromRevision, toRevision)
    const summary = {
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
      else if (type === 'node.update') summary.updated += 1
      else if (type === 'node.delete') summary.deleted += 1
      else if (type === 'node.move' || type === 'node.reorder') summary.moved += 1
      else if (type === 'node.restore') summary.restored += 1
      else if (type === 'map.meta.update' || type === 'map.update') summary.metadataChanged = true
      else if (type === 'map.replace') summary.replaced = true
      else if (type === 'node.batch') {
        const inner = (op.payload && op.payload.ops) || []
        inner.forEach(child => {
          const ct = String(child.type || '')
          if (ct === 'node.insert') summary.inserted += 1
          else if (ct === 'node.update') summary.updated += 1
          else if (ct === 'node.delete') summary.deleted += 1
          else if (ct === 'node.move') summary.moved += 1
        })
      }
    })
    return summary
  }

  async function createVersion(roomKey, input = {}) {
    if (!input.skipEnsure) {
      await ensureHistoryBaseline(roomKey, {
        createdBy: input.createdBy,
        locked: !!input.locked
      })
    }
    const live = await store.getLiveState(roomKey)
    const revision = Number(input.revision != null ? input.revision : live.revision)
    if (revision > Number(live.revision)) {
      throw err('BAD_REVISION', 'version revision cannot exceed current', 400)
    }
    const coverage = await getHistoryCoverage(roomKey)
    if (revision < Number(coverage.earliestAvailableRevision)) {
      throw err(
        'HISTORY_REVISION_UNAVAILABLE',
        'revision is before history baseline',
        409
      )
    }
    const checkpoint = await store.latestCheckpointAt(roomKey, revision)
    const row = await store.insertVersion({
      id: randomUUID(),
      room_key: roomKey,
      revision,
      checkpoint_revision: checkpoint ? Number(checkpoint.revision) : coverage.earliestAvailableRevision,
      name: String(input.name || ''),
      description: String(input.description || ''),
      type: String(input.type || 'MANUAL').toUpperCase(),
      created_by: input.createdBy || '',
      created_at: new Date().toISOString(),
      source: input.source || 'api',
      hidden: false
    })
    await store.insertAudit({
      room_key: roomKey,
      action: 'VERSION_CREATE',
      version_id: row.id,
      target_revision: revision,
      from_revision: revision,
      new_revision: live.revision,
      user_id: input.createdBy || '',
      detail: { type: row.type, name: row.name }
    })
    return row
  }

  async function maybeAutoVersion(roomKey, revision, createdBy, now = Date.now()) {
    if (!config.autoVersionOnCheckpoint) return null
    const last = await store.lastAutoVersionAt(roomKey)
    if (last && now - last < config.autoVersionMinMs) return null
    return createVersion(roomKey, {
      revision,
      type: 'AUTO',
      name: '自动版本 r' + revision,
      createdBy,
      source: 'checkpoint'
    })
  }

  async function maybeCheckpointAfterOp(roomKey, operation) {
    const type = String(operation.operation_type || operation.type || '')
    const revision = Number(operation.version || operation.serverRevision || 0)
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
    const reason = heavy
      ? (operation.payload && operation.payload.reason) || 'IMPORT'
      : since >= config.checkpointEvery
        ? 'THRESHOLD'
        : ''
    if (!reason) return null
    const checkpoint = await createCheckpoint(roomKey, {
      revision,
      createdBy: operation.actor_id || '',
      reason: reason === 'VERSION_RESTORE' ? 'VERSION_RESTORE' : reason
    })
    if (reason === 'THRESHOLD' || reason === 'IMPORT' || reason === 'VERSION_RESTORE') {
      await maybeAutoVersion(roomKey, revision, operation.actor_id || '')
    }
    return checkpoint
  }

  async function restoreVersion(roomKey, input = {}) {
    return store.withRoomLock(roomKey, async () => {
      const capture = typeof store.capture === 'function' ? store.capture() : null
      try {
        await ensureHistoryBaseline(roomKey, {
          locked: true,
          createdBy: input.userId || ''
        })
        const live = await store.getLiveState(roomKey)
        const currentRevision = Number(live.revision)
        if (
          input.expectedCurrentRevision != null &&
          Number(input.expectedCurrentRevision) !== currentRevision
        ) {
          throw err('RESTORE_CONFLICT', 'concurrent restore or stale current revision', 409)
        }
        const version = input.versionId
          ? await store.getVersion(roomKey, input.versionId)
          : null
        if (input.versionId && !version) throw err('VERSION_NOT_FOUND', 'version not found', 404)
        const targetRevision = Number(
          input.targetRevision != null
            ? input.targetRevision
            : version
              ? version.revision
              : live.revision
        )
        const coverage = await getHistoryCoverage(roomKey)
        if (targetRevision < Number(coverage.earliestAvailableRevision)) {
          throw err(
            'HISTORY_REVISION_UNAVAILABLE',
            'restore target is before history baseline',
            409
          )
        }
        const historical = await getRoomStateAtRevision(roomKey, targetRevision, {
          skipEnsure: true,
          locked: true
        })
        const pre = await createCheckpoint(roomKey, {
          state: live,
          revision: currentRevision,
          createdBy: input.userId || '',
          reason: 'PRE_RESTORE'
        })
        const preVersion = await createVersion(roomKey, {
          revision: currentRevision,
          type: 'RESTORE',
          name: input.preName || 'Restore 前 r' + currentRevision,
          description: 'pre-restore checkpoint of current live state',
          createdBy: input.userId || '',
          source: 'restore',
          skipEnsure: true,
          locked: true
        })
        const newRevision = currentRevision + 1
        await store.setLiveState(roomKey, {
          revision: newRevision,
          nodes: historical.tree,
          metadata: historical.metadata
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
        await store.appendOperation(restoreOp)
        const post = await createCheckpoint(roomKey, {
          revision: newRevision,
          tree: historical.tree,
          metadata: historical.metadata,
          createdBy: input.userId || '',
          reason: 'VERSION_RESTORE'
        })
        const restoreVersionRow = await createVersion(roomKey, {
          revision: newRevision,
          type: 'RESTORE',
          name: input.name || 'Restore r' + targetRevision,
          description: input.description || '',
          createdBy: input.userId || '',
          source: 'restore',
          skipEnsure: true,
          locked: true
        })
        await store.insertAudit({
          room_key: roomKey,
          action: 'VERSION_RESTORE',
          version_id: restoreVersionRow.id,
          target_revision: targetRevision,
          from_revision: currentRevision,
          new_revision: newRevision,
          user_id: input.userId || '',
          detail: {
            preRestoreVersionId: preVersion.id,
            preCheckpointId: pre.id,
            postCheckpointId: post.id
          }
        })
        return {
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
      } catch (error) {
        if (capture && typeof store.restoreCapture === 'function') {
          store.restoreCapture(capture)
        }
        throw error
      }
    })
  }

  async function onCommitted(event) {
    const roomKey = event.roomKey
    const operation = event.operation || {}
    if (!roomKey || !operation) return null
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
    return maybeCheckpointAfterOp(roomKey, {
      ...operation,
      version: operation.version || event.version
    })
  }

  async function listVersions(roomKey, query) {
    await ensureHistoryBaseline(roomKey)
    const listed = await store.listVersions(roomKey, query)
    const coverage = await getHistoryCoverage(roomKey)
    return { ...listed, ...coverage }
  }

  return {
    config,
    store,
    createCheckpoint,
    ensureHistoryBaseline,
    auditHistoryCoverage,
    getHistoryCoverage,
    getRoomStateAtRevision,
    summarizeRange,
    createVersion,
    restoreVersion,
    maybeCheckpointAfterOp,
    onCommitted,
    listVersions,
    getVersion: (roomKey, id) => store.getVersion(roomKey, id),
    hideVersion: (roomKey, id) => store.hideVersion(roomKey, id),
    listAudit: roomKey => store.listAudit(roomKey)
  }
}

module.exports = { createHistoryEngine, pigeonholeCompleteFromGenesis }
