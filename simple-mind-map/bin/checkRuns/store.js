'use strict'

const crypto = require('crypto')

const RUN_STATUSES = new Set([
  'passed',
  'needs_confirmation',
  'needs_supplement',
  'blocked',
  'failed',
  'stale'
])

const CREATE_SCHEMA_SQL = `
  create table if not exists check_runs (
    run_id uuid primary key,
    room_key text not null,
    node_uid text not null,
    actor_id text not null,
    request_id text not null,
    map_version text not null default '',
    chain_fingerprint text not null,
    rule_version text not null,
    status text not null check (status in ('passed','needs_confirmation','needs_supplement','blocked','failed','stale')),
    source_refs jsonb not null default '[]'::jsonb,
    selection jsonb not null default '{}'::jsonb,
    report jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    confirmed_at timestamptz,
    unique (room_key, actor_id, request_id)
  );
  create index if not exists check_runs_room_node_created_idx
    on check_runs(room_key, node_uid, created_at desc);
  create index if not exists check_runs_room_run_idx
    on check_runs(room_key, run_id);
`

function requireDb(db) {
  if (!db || typeof db.query !== 'function') {
    throw new Error('checkRuns requires a pg-compatible db.query')
  }
}

function safeJson(value, fallback) {
  if (value == null) return fallback
  if (typeof value === 'string') {
    try { return JSON.parse(value) } catch (_) { return fallback }
  }
  return value
}

function normalizeRow(row) {
  if (!row) return null
  return {
    runId: row.run_id,
    id: row.run_id,
    roomKey: row.room_key,
    nodeUid: row.node_uid,
    actorId: row.actor_id,
    requestId: row.request_id,
    mapVersion: row.map_version || '',
    chainFingerprint: row.chain_fingerprint,
    ruleVersion: row.rule_version,
    status: row.status,
    sourceRefs: safeJson(row.source_refs, []),
    selection: safeJson(row.selection, {}),
    report: safeJson(row.report, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    confirmedAt: row.confirmed_at || null
  }
}

function validateStatus(status) {
  if (!RUN_STATUSES.has(status)) throw new Error(`invalid check run status: ${status}`)
}

async function ensureSchema(db) {
  requireDb(db)
  await db.query(CREATE_SCHEMA_SQL)
}

async function createRun(db, run) {
  requireDb(db)
  validateStatus(run.status)
  const id = run.runId || crypto.randomUUID()
  const inserted = await db.query(
    `insert into check_runs (
       run_id, room_key, node_uid, actor_id, request_id, map_version,
       chain_fingerprint, rule_version, status, source_refs, selection, report
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb)
     on conflict (room_key, actor_id, request_id) do nothing
     returning *`,
    [
      id,
      String(run.roomKey),
      String(run.nodeUid),
      String(run.actorId),
      String(run.requestId),
      String(run.mapVersion || ''),
      String(run.chainFingerprint || ''),
      String(run.ruleVersion),
      run.status,
      JSON.stringify(run.sourceRefs || []),
      JSON.stringify(run.selection || {}),
      JSON.stringify(run.report || {})
    ]
  )
  if (inserted.rows && inserted.rows[0]) {
    return { run: normalizeRow(inserted.rows[0]), created: true }
  }
  const existing = await db.query(
    `select * from check_runs where room_key = $1 and actor_id = $2 and request_id = $3 limit 1`,
    [String(run.roomKey), String(run.actorId), String(run.requestId)]
  )
  return { run: normalizeRow(existing.rows && existing.rows[0]), created: false }
}

async function getRun(db, roomKey, runId) {
  requireDb(db)
  const result = await db.query(
    'select * from check_runs where room_key = $1 and run_id = $2 limit 1',
    [String(roomKey), String(runId)]
  )
  return normalizeRow(result.rows && result.rows[0])
}

async function getRunByRequest(db, roomKey, actorId, requestId) {
  requireDb(db)
  const result = await db.query(
    `select * from check_runs
      where room_key = $1 and actor_id = $2 and request_id = $3 limit 1`,
    [String(roomKey), String(actorId), String(requestId)]
  )
  return normalizeRow(result.rows && result.rows[0])
}

async function listRuns(db, { roomKey, nodeUid, limit = 30, offset = 0 }) {
  requireDb(db)
  const boundedLimit = Math.min(100, Math.max(1, Number(limit) || 30))
  const boundedOffset = Math.max(0, Number(offset) || 0)
  const values = [String(roomKey)]
  let where = 'room_key = $1'
  if (nodeUid) {
    values.push(String(nodeUid))
    where += ` and node_uid = $${values.length}`
  }
  values.push(boundedLimit, boundedOffset)
  const result = await db.query(
    `select * from check_runs where ${where}
       order by created_at desc limit $${values.length - 1} offset $${values.length}`,
    values
  )
  return (result.rows || []).map(normalizeRow)
}

async function updateRun(db, { roomKey, runId, status, sourceRefs, selection, report, chainFingerprint, mapVersion, confirmedAt, expectedSelectionState, expectedRevision }) {
  requireDb(db)
  if (status) validateStatus(status)
  const result = await db.query(
    `update check_runs set
       status = coalesce($3, status),
       source_refs = coalesce($4::jsonb, source_refs),
       selection = coalesce($5::jsonb, selection),
       report = coalesce($6::jsonb, report),
       chain_fingerprint = coalesce($7, chain_fingerprint),
       map_version = coalesce($8, map_version),
       confirmed_at = coalesce($9::timestamptz, confirmed_at),
       updated_at = now()
     where room_key = $1 and run_id = $2
       and ($10::text is null or selection->>'confirmationState' = $10)
       and ($11::int is null or coalesce((report->>'revision')::int, 1) = $11)
     returning *`,
    [
      String(roomKey),
      String(runId),
      status || null,
      sourceRefs == null ? null : JSON.stringify(sourceRefs),
      selection == null ? null : JSON.stringify(selection),
      report == null ? null : JSON.stringify(report),
      chainFingerprint == null ? null : String(chainFingerprint),
      mapVersion == null ? null : String(mapVersion),
      confirmedAt == null ? null : confirmedAt,
      expectedSelectionState == null ? null : String(expectedSelectionState),
      expectedRevision == null ? null : Number(expectedRevision)
    ]
  )
  return normalizeRow(result.rows && result.rows[0])
}

/** Keep report edits on one connection; the revision guard also protects custom adapters. */
async function editRun(db, roomKey, runId, callback) {
  requireDb(db)
  const connected = typeof db.connect === 'function'
  const client = connected ? await db.connect() : db
  try {
    if (connected) await client.query('begin')
    const result = await client.query('select * from check_runs where room_key=$1 and run_id=$2 for update', [String(roomKey), String(runId)])
    const run = normalizeRow(result.rows && result.rows[0])
    const updated = await callback(run, client)
    if (connected) await client.query('commit')
    return updated
  } catch (error) {
    if (connected) await client.query('rollback').catch(() => {})
    throw error
  } finally {
    if (connected) client.release()
  }
}

async function claimConfirmation(db, { roomKey, runId, candidateId, stage }) {
  requireDb(db)
  const selection = {
    candidateId: String(candidateId),
    stage: String(stage),
    confirmationState: 'processing'
  }
  const result = await db.query(
    `update check_runs set
       selection = coalesce(selection, '{}'::jsonb) || $3::jsonb,
       updated_at = now()
     where room_key = $1 and run_id = $2
       and status = 'needs_confirmation'
       and coalesce(selection->>'confirmationState', '') <> 'processing'
     returning *`,
    [String(roomKey), String(runId), JSON.stringify(selection)]
  )
  return normalizeRow(result.rows && result.rows[0])
}

module.exports = {
  RUN_STATUSES,
  CREATE_SCHEMA_SQL,
  ensureSchema,
  initSchema: ensureSchema,
  createRun,
  getRun,
  getRunByRequest,
  listRuns,
  updateRun,
  editRun,
  claimConfirmation,
  normalizeRow
}
