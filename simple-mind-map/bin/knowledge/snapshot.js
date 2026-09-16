const { affectedUids } = require('./changeTracker')
const { branchPath } = require('./utils')

// Strategy is intentionally separate from rendering; V1 uses first-level roots.
function partition(edges) {
  const byUid = new Map(edges.map(row => [row.uid, row]))
  const children = new Map(edges.map(row => [row.uid, []]))
  const roots = edges.filter(row => row.is_root)
  if (roots.length !== 1 && edges.length) throw new Error('Knowledge input needs exactly one root')
  for (const row of edges) if (row.parent_uid != null) {
    if (!children.has(row.parent_uid)) throw new Error('Knowledge input contains orphan nodes')
    children.get(row.parent_uid).push(row.uid)
  }
  for (const list of children.values()) list.sort((a, b) => {
    const pa = byUid.get(a).position || '', pb = byUid.get(b).position || ''
    return pa < pb ? -1 : pa > pb ? 1 : a < b ? -1 : a > b ? 1 : 0
  })
  const rootUid = roots[0]?.uid || null
  const branchRoots = rootUid ? children.get(rootUid) : []
  const owner = new Map()
  const stack = branchRoots.map(uid => [uid, uid])
  while (stack.length) {
    const [uid, branch] = stack.pop()
    if (owner.has(uid) || uid === rootUid) throw new Error('Knowledge input contains a cycle')
    owner.set(uid, branch)
    for (const child of children.get(uid)) stack.push([child, branch])
  }
  if (owner.size + (rootUid ? 1 : 0) !== edges.length) throw new Error('Knowledge input has unreachable nodes')
  return { byUid, children, rootUid, branchRoots, owner }
}

async function readSnapshot(pool, roomId, manifest, options = {}) {
  const db = options.snapshotClient || await pool.connect()
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await db.query("SET LOCAL statement_timeout = '30s'")
    await db.query("SET LOCAL idle_in_transaction_session_timeout = '30s'")
    // The first SELECT fixes the MVCC snapshot. The version and nodes below
    // necessarily see the SAME set of committed transactions.
    const meta = (await db.query(`select r.version, r.updated_at, r.title,
      (t.room_key is not null or r.deleted_at is not null) as deleted
      from rooms r left join room_tombstones t using(room_key) where r.room_key=$1`, [roomId])).rows[0]
    if (!meta || meta.deleted) { await db.query('COMMIT'); return { deleted: true, roomId } }
    const snapshotVersion = Number(meta.version)
    const sourceRevision = Number((await db.query('select revision from knowledge_source_state where room_key=$1', [roomId])).rows[0]?.revision || 0)
    if (options.afterVersionRead) await options.afterVersionRead(snapshotVersion)
    const last = Number(manifest?.lastCompiledVersion || 0)
    const lastSource = Number(manifest?.lastSourceRevision || 0)
    let full = !!options.force || !manifest || manifest.version !== 1 || manifest.exportContract !== 1
    let reason = full ? options.force ? 'forced' : 'initial_or_contract' : 'incremental'
    const affected = new Set()
    // Page operation payloads, keeping only affected IDs rather than all edits.
    let cursor = full ? snapshotVersion : last, gap = snapshotVersion < last
    while (cursor < snapshotVersion && !gap) {
      const page = (await db.query(`select version, operation_type, payload, event, inverse_payload
        from room_operations where room_key=$1 and version>$2 and version<=$3 order by version limit 500`, [roomId, cursor, snapshotVersion])).rows
      if (!page.length) { gap = true; break }
      for (const op of page) {
        if (Number(op.version) !== cursor + 1) { gap = true; break }
        cursor = Number(op.version)
        const ids = affectedUids(op)
        ids.forEach(uid => affected.add(uid))
        if (op.operation_type === 'map.replace' || (!ids.length && op.operation_type !== 'map.meta.update')) {
          full = true
          reason = op.operation_type === 'map.replace' ? 'map_replace' : 'unclassified_operation'
        }
      }
    }
    if (gap) { full = true; reason = 'operation_log_gap' }
    const sources = (await db.query(`select revision, uids, reason from knowledge_source_changes
      where room_key=$1 and revision>$2 and revision<=$3 order by revision`, [roomId, lastSource, sourceRevision])).rows
    let sourceCursor = lastSource
    for (const change of sources) {
      if (Number(change.revision) !== sourceCursor + 1) { full = true; reason = 'source_log_gap' }
      sourceCursor = Number(change.revision)
      if (change.reason === 'legacy_save' || change.uids.includes('*')) { full = true; reason = 'legacy_save' }
      if (!change.uids.some(Boolean)) { full = true; reason = 'unbound_source_change' }
      change.uids.filter(Boolean).forEach(uid => affected.add(uid))
    }
    if (sourceCursor !== sourceRevision) { full = true; reason = 'source_log_gap' }
    // Legacy saves can have an unchanged V2 version. A timestamp is a recovery
    // fallback, never part of semantic hashes and never the normal V2 tracker.
    if (manifest && snapshotVersion === last && sourceRevision === lastSource && String(meta.updated_at.toISOString()) !== manifest.sourceUpdatedAt) {
      full = true; reason = 'non_operation_save'
    }
    if (!full && cursor === last && sourceRevision === lastSource) {
      await db.query('COMMIT')
      return { roomId, snapshotVersion, sourceRevision, noChanges: true }
    }
    let edges = (await db.query(`select uid, parent_uid, position, is_root from room_nodes
      where room_key=$1 and deleted_at is null`, [roomId])).rows
    let legacy = false, legacyRows
    if (!edges.length) {
      const saved = (await db.query('select nodes from rooms where room_key=$1', [roomId])).rows[0]?.nodes
      // Only a missing node table uses the persisted legacy graph. Never read a
      // live Y.Doc or fall back from a partially valid authoritative node table.
      if (saved && Object.keys(saved).length) {
        legacy = true; full = true; reason = 'legacy_graph'
        const parents = new Map()
        for (const [uid, node] of Object.entries(saved)) for (const child of node.children || []) parents.set(child, uid)
        legacyRows = Object.entries(saved).map(([uid, node]) => ({ uid, parent_uid: parents.get(uid) || null,
          position: node.position || String(parents.has(uid) ? (saved[parents.get(uid)].children || []).indexOf(uid) : 0).padStart(8, '0'), is_root: !!node.isRoot, data: node.data || {} }))
        edges = legacyRows.map(({ data, ...row }) => row)
      }
    }
    const model = partition(edges)
    const branchSet = new Set(model.branchRoots)
    const changedRoots = new Set()
    if (full) model.branchRoots.forEach(uid => changedRoots.add(uid))
    else for (const uid of affected) {
      const current = model.owner.get(uid)
      const old = manifest.nodes?.[uid]?.documentRootUid
      if (current) changedRoots.add(current)
      if (old) changedRoots.add(old)
    }
    // Comparing inexpensive UID/parent metadata also catches new/deleted roots.
    for (const uid of model.branchRoots) if (!manifest?.documents?.[branchPath(uid)]) changedRoots.add(uid)
    for (const doc of Object.values(manifest?.documents || {})) if (doc.rootUid && !branchSet.has(doc.rootUid)) changedRoots.add(doc.rootUid)
    const wanted = edges.filter(row => row.uid === model.rootUid || branchSet.has(row.uid) || changedRoots.has(model.owner.get(row.uid))).map(row => row.uid)
    const wantedSet = new Set(wanted)
    const rows = legacy ? legacyRows.filter(row => wantedSet.has(row.uid)) : wanted.length ? (await db.query(`select uid, data from room_nodes
      where room_key=$1 and uid=any($2::text[]) and deleted_at is null`, [roomId, wanted])).rows : []
    const data = new Map(rows.map(row => [row.uid, row.data || {}]))
    const attachments = wanted.length ? (await db.query(`select id, node_uid, file_name, status, extracted_text, content_hash, source_kind
      from node_attachments where room_key=$1 and (node_uid=any($2::text[]) or id=any($3::text[])) order by id`,
    [roomId, wanted, rows.map(row => row.data?.attachmentId).filter(Boolean)])).rows : []
    // A formerly unbound attachment can later be referenced by attachmentId.
    // Its durable revision must invalidate the referencing node too.
    await db.query('COMMIT')
    return { roomId, snapshotVersion, sourceRevision, sourceUpdatedAt: meta.updated_at.toISOString(),
      full, reason, affectedUids: [...affected], changedRoots: [...changedRoots], model, data, attachments, legacy }
  } catch (err) { await db.query('ROLLBACK').catch(() => {}); throw err }
  finally { if (!options.snapshotClient) db.release() }
}
module.exports = { readSnapshot, partition }
