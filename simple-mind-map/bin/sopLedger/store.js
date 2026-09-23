/**
 * SOP ledger relational mirror in mind_map Postgres.
 * Node JSON (data.sopLedger) remains the in-map display source;
 * these tables support cross-room query / boards / reports.
 */

function definitionId(roomKey, nodeUid) {
  return `${String(roomKey || '').trim()}:${String(nodeUid || '').trim()}`
}

function asText(value, max = 2000) {
  return String(value == null ? '' : value).slice(0, max)
}

function nodeTitle(node) {
  if (!node || typeof node !== 'object') return ''
  const data = node.data && typeof node.data === 'object' ? node.data : {}
  return asText(data.text || node.text || '', 200)
}

function normalizeLedger(ledger) {
  const src = ledger && typeof ledger === 'object' ? ledger : {}
  const freq =
    src.frequency && typeof src.frequency === 'object' ? src.frequency : {}
  const runs = Array.isArray(src.runs) ? src.runs : []
  const deliverables = Array.isArray(src.deliverables) ? src.deliverables : []
  return {
    frequency: {
      label: asText(freq.label || '未知', 64) || '未知',
      cron_hint: freq.cron_hint == null ? null : asText(freq.cron_hint, 128)
    },
    runs,
    deliverables
  }
}

function stripDPrefix(title) {
  return String(title || '')
    .replace(/^[Dd]\s*[：:]\s*/, '')
    .trim()
}

async function initSchema(db) {
  await db.query(`
    create table if not exists sop_definitions (
      id text primary key,
      room_key text not null,
      node_uid text not null,
      sop_code text not null default 'D',
      title text not null default '',
      frequency_label text not null default '未知',
      frequency_cron text,
      updated_at timestamptz not null default now(),
      created_at timestamptz not null default now(),
      constraint sop_definitions_room_node_uq unique (room_key, node_uid)
    )`)
  await db.query(`
    create index if not exists sop_definitions_room_updated_idx
      on sop_definitions(room_key, updated_at desc)`)
  await db.query(`
    create index if not exists sop_definitions_updated_idx
      on sop_definitions(updated_at desc)`)
  await db.query(`
    create table if not exists sop_runs (
      id text not null,
      room_key text not null,
      node_uid text not null,
      definition_id text not null references sop_definitions(id) on delete cascade,
      at_text text not null default '',
      result text not null default '',
      note text not null default '',
      actor text not null default '',
      created_at timestamptz not null default now(),
      primary key (room_key, node_uid, id)
    )`)
  await db.query(`
    create index if not exists sop_runs_definition_created_idx
      on sop_runs(definition_id, created_at desc)`)
  await db.query(`
    create index if not exists sop_runs_room_created_idx
      on sop_runs(room_key, created_at desc)`)
  await db.query(`
    create table if not exists sop_deliverables (
      id text not null,
      room_key text not null,
      node_uid text not null,
      definition_id text not null references sop_definitions(id) on delete cascade,
      name text not null default '',
      uri_or_path text not null default '',
      kind text not null default 'file',
      at_text text not null default '',
      sop_id text not null default '',
      sop_uid text not null default '',
      created_at timestamptz not null default now(),
      primary key (room_key, node_uid, id)
    )`)
  await db.query(`
    create index if not exists sop_deliverables_definition_created_idx
      on sop_deliverables(definition_id, created_at desc)`)
  await db.query(`
    create index if not exists sop_deliverables_room_created_idx
      on sop_deliverables(room_key, created_at desc)`)
}

async function removeNodeLedger(db, roomKey, nodeUid) {
  const key = String(roomKey || '').trim()
  const uid = String(nodeUid || '').trim()
  if (!key || !uid) return { removed: false }
  await db.query(
    `delete from sop_definitions where room_key = $1 and node_uid = $2`,
    [key, uid]
  )
  return { removed: true }
}

/**
 * Upsert definition + replace runs/deliverables for one node from sopLedger JSON.
 * Pass client (transaction) when available.
 */
async function upsertNodeLedger(db, roomKey, nodeUid, nodeOrLedger, options = {}) {
  const key = String(roomKey || '').trim()
  const uid = String(nodeUid || '').trim()
  if (!key || !uid) return { synced: false }

  let ledger = null
  let title = asText(options.title || '', 200)
  if (nodeOrLedger && nodeOrLedger.data && nodeOrLedger.data.sopLedger) {
    ledger = nodeOrLedger.data.sopLedger
    if (!title) title = nodeTitle(nodeOrLedger)
  } else if (nodeOrLedger && nodeOrLedger.sopLedger) {
    ledger = nodeOrLedger.sopLedger
    if (!title) title = nodeTitle(nodeOrLedger)
  } else if (
    nodeOrLedger &&
    (Array.isArray(nodeOrLedger.runs) ||
      Array.isArray(nodeOrLedger.deliverables) ||
      nodeOrLedger.frequency)
  ) {
    ledger = nodeOrLedger
  }

  if (!ledger) {
    await removeNodeLedger(db, key, uid)
    return { synced: true, removed: true }
  }

  const normalized = normalizeLedger(ledger)
  const id = definitionId(key, uid)
  const freqLabel = normalized.frequency.label || '未知'
  const freqCron = normalized.frequency.cron_hint
  const cleanTitle = stripDPrefix(title) || title

  await db.query(
    `insert into sop_definitions (
       id, room_key, node_uid, sop_code, title, frequency_label, frequency_cron, updated_at, created_at
     ) values ($1, $2, $3, 'D', $4, $5, $6, now(), now())
     on conflict (room_key, node_uid) do update set
       title = excluded.title,
       frequency_label = excluded.frequency_label,
       frequency_cron = excluded.frequency_cron,
       updated_at = now()`,
    [id, key, uid, cleanTitle, freqLabel, freqCron]
  )

  await db.query(
    `delete from sop_runs where room_key = $1 and node_uid = $2`,
    [key, uid]
  )
  await db.query(
    `delete from sop_deliverables where room_key = $1 and node_uid = $2`,
    [key, uid]
  )

  const runs = normalized.runs.slice(0, 200)
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i] || {}
    const runId =
      asText(run.id, 120) ||
      `run_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 7)}`
    let createdAt = new Date()
    if (run.createdAt) {
      const parsed = new Date(run.createdAt)
      if (!Number.isNaN(parsed.getTime())) createdAt = parsed
    }
    await db.query(
      `insert into sop_runs (
         id, room_key, node_uid, definition_id, at_text, result, note, actor, created_at
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (room_key, node_uid, id) do nothing`,
      [
        runId,
        key,
        uid,
        id,
        asText(run.at, 64),
        asText(run.result, 200),
        asText(run.note, 4000),
        asText(run.actor, 200),
        createdAt
      ]
    )
  }

  const deliverables = normalized.deliverables.slice(0, 400)
  for (let i = 0; i < deliverables.length; i++) {
    const item = deliverables[i] || {}
    const delId =
      asText(item.id, 120) ||
      `del_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 7)}`
    let createdAt = new Date()
    if (item.createdAt) {
      const parsed = new Date(item.createdAt)
      if (!Number.isNaN(parsed.getTime())) createdAt = parsed
    }
    await db.query(
      `insert into sop_deliverables (
         id, room_key, node_uid, definition_id, name, uri_or_path, kind, at_text, sop_id, sop_uid, created_at
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (room_key, node_uid, id) do nothing`,
      [
        delId,
        key,
        uid,
        id,
        asText(item.name, 300),
        asText(item.uri_or_path, 2000),
        asText(item.kind || 'file', 32) || 'file',
        asText(item.at, 64),
        asText(item.sop_id, 120),
        asText(item.sop_uid, 120),
        createdAt
      ]
    )
  }

  return {
    synced: true,
    definitionId: id,
    runs: runs.length,
    deliverables: deliverables.length
  }
}

/**
 * After a committed room operation, sync affected nodes that carry sopLedger.
 * Failures are logged and swallowed so collaboration write path stays healthy.
 */
async function syncAfterCommit(db, roomKey, committed) {
  try {
    const nodes =
      (committed && committed.nodes) ||
      (committed && committed.operation && committed.operation.nodes) ||
      null
    if (!nodes || typeof nodes !== 'object') return { synced: 0 }

    const command = committed.command || {}
    const event =
      committed.event ||
      (committed.operation && committed.operation.event) ||
      {}
    const payload = {
      ...((command && command.payload) || {}),
      ...((event && event.payload) || {})
    }
    const type = String(command.type || event.type || '')

    if (
      type === 'node.delete' ||
      type === 'node.deleted' ||
      event.type === 'node.deleted'
    ) {
      const uid = String(payload.uid || '')
      if (uid) await removeNodeLedger(db, roomKey, uid)
      return { synced: uid ? 1 : 0, removed: true }
    }

    // Full-tree writes: resync every node that still has a ledger.
    if (
      type === 'map.replace' ||
      type === 'batch.apply' ||
      type === 'map.update'
    ) {
      return backfillRoom(db, roomKey, nodes)
    }

    const uids = new Set()
    if (payload.uid) uids.add(String(payload.uid))
    if (Array.isArray(payload.affectedUids)) {
      payload.affectedUids.forEach(u => uids.add(String(u)))
    }
    if (Array.isArray(event.affectedUids)) {
      event.affectedUids.forEach(u => uids.add(String(u)))
    }

    const patch = payload.patch || payload.data || {}
    const changedFields = Array.isArray(payload.changedFields)
      ? payload.changedFields
      : Object.keys(patch || {})
    const touchesLedger =
      changedFields.includes('sopLedger') ||
      Object.prototype.hasOwnProperty.call(patch || {}, 'sopLedger')

    if (!uids.size && touchesLedger && payload.uid) {
      uids.add(String(payload.uid))
    }

    if (!uids.size) return { synced: 0 }

    let count = 0
    for (const uid of uids) {
      const node = nodes[uid]
      if (!node) continue
      const hasLedger = !!(node.data && node.data.sopLedger)
      if (!hasLedger && !touchesLedger) continue
      await upsertNodeLedger(db, roomKey, uid, node)
      count += 1
    }
    return { synced: count }
  } catch (err) {
    console.warn(
      '[sopLedger] syncAfterCommit failed',
      err && err.message ? err.message : err
    )
    return { synced: 0, error: String((err && err.message) || err) }
  }
}

async function backfillRoom(db, roomKey, nodes) {
  const key = String(roomKey || '').trim()
  if (!key || !nodes || typeof nodes !== 'object') {
    return { roomKey: key, definitions: 0 }
  }
  let definitions = 0
  for (const uid of Object.keys(nodes)) {
    const node = nodes[uid]
    if (!node || !node.data || !node.data.sopLedger) continue
    await upsertNodeLedger(db, key, uid, node)
    definitions += 1
  }
  return { roomKey: key, definitions }
}

function definitionDto(row) {
  if (!row) return null
  return {
    id: row.id,
    roomKey: row.room_key,
    nodeUid: row.node_uid,
    sopCode: row.sop_code || 'D',
    title: row.title || '',
    frequency: {
      label: row.frequency_label || '未知',
      cron_hint: row.frequency_cron || null
    },
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : row.updated_at,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : row.created_at,
    latestRunAt: row.latest_run_at || null,
    latestRunResult: row.latest_run_result || null,
    runCount: Number(row.run_count || 0),
    deliverableCount: Number(row.deliverable_count || 0)
  }
}

async function listDefinitions(db, options = {}) {
  const limit = Math.min(500, Math.max(1, Number(options.limit) || 100))
  const roomKey = String(options.roomKey || '').trim()
  const q = String(options.q || '').trim()
  const params = []
  const where = []
  if (roomKey) {
    params.push(roomKey)
    where.push(`d.room_key = $${params.length}`)
  }
  if (q) {
    params.push(`%${q}%`)
    where.push(`(d.title ilike $${params.length} or d.node_uid ilike $${params.length})`)
  }
  params.push(limit)
  const sql = `
    select d.*,
      (select count(*)::int from sop_runs r where r.definition_id = d.id) as run_count,
      (select count(*)::int from sop_deliverables x where x.definition_id = d.id) as deliverable_count,
      (select r.at_text from sop_runs r where r.definition_id = d.id
         order by r.created_at desc limit 1) as latest_run_at,
      (select r.result from sop_runs r where r.definition_id = d.id
         order by r.created_at desc limit 1) as latest_run_result
    from sop_definitions d
    ${where.length ? `where ${where.join(' and ')}` : ''}
    order by d.updated_at desc
    limit $${params.length}`
  const res = await db.query(sql, params)
  return res.rows.map(definitionDto)
}

async function getDefinitionDetail(db, roomKey, nodeUid) {
  const key = String(roomKey || '').trim()
  const uid = String(nodeUid || '').trim()
  if (!key || !uid) return null
  const defRes = await db.query(
    `select * from sop_definitions where room_key = $1 and node_uid = $2 limit 1`,
    [key, uid]
  )
  const def = defRes.rows[0]
  if (!def) return null
  const runs = await db.query(
    `select * from sop_runs where room_key = $1 and node_uid = $2
     order by created_at desc limit 200`,
    [key, uid]
  )
  const dels = await db.query(
    `select * from sop_deliverables where room_key = $1 and node_uid = $2
     order by created_at desc limit 400`,
    [key, uid]
  )
  return {
    ...definitionDto(def),
    runs: runs.rows.map(r => ({
      id: r.id,
      at: r.at_text,
      result: r.result,
      note: r.note,
      actor: r.actor,
      createdAt:
        r.created_at instanceof Date
          ? r.created_at.toISOString()
          : r.created_at
    })),
    deliverables: dels.rows.map(d => ({
      id: d.id,
      name: d.name,
      uri_or_path: d.uri_or_path,
      kind: d.kind,
      at: d.at_text,
      sop_id: d.sop_id,
      sop_uid: d.sop_uid,
      createdAt:
        d.created_at instanceof Date
          ? d.created_at.toISOString()
          : d.created_at
    }))
  }
}

module.exports = {
  initSchema,
  definitionId,
  upsertNodeLedger,
  removeNodeLedger,
  syncAfterCommit,
  backfillRoom,
  listDefinitions,
  getDefinitionDetail,
  normalizeLedger
}
