const crypto = require('crypto')
const { historyChecksum, toBusinessTree, canonicalMetadata, nodeCount } = require('./canonical')
const { historyError } = require('./errors')

const HISTORY_SCHEMA_VERSION = 2

function stableUuid(parts) {
  const hash = crypto
    .createHash('sha1')
    .update(String(parts.join('\0')))
    .digest()
  hash[6] = (hash[6] & 0x0f) | 0x50
  hash[8] = (hash[8] & 0x3f) | 0x80
  const hex = hash.slice(0, 16).toString('hex')
  return (
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-' +
    hex.slice(12, 16) +
    '-' +
    hex.slice(16, 20) +
    '-' +
    hex.slice(20, 32)
  )
}

async function tableColumns(db, name) {
  const res = await db.query(
    `select column_name, data_type, udt_name
     from information_schema.columns
     where table_schema = 'public' and table_name = $1`,
    [name]
  )
  return res.rows
}

function colMap(cols) {
  const map = new Map()
  cols.forEach(row => map.set(row.column_name, row))
  return map
}

function isUuidType(col) {
  if (!col) return false
  return /uuid/i.test(String(col.udt_name || col.data_type || ''))
}

function isCompatibleRoomVersions(cols) {
  if (!cols.length) return false
  const names = colMap(cols)
  if (names.has('version_no') && !names.has('checkpoint_revision')) return false
  if (!isUuidType(names.get('id'))) return false
  return names.has('revision') && names.has('room_key')
}

async function tableExists(db, name) {
  const res = await db.query(`select to_regclass($1) as reg`, ['public.' + name])
  return !!(res.rows[0] && res.rows[0].reg)
}

async function ensureHistoryMeta(db) {
  await db.query(`
    create table if not exists history_schema_state (
      key text primary key,
      value text not null,
      updated_at timestamptz not null default now()
    )
  `)
}

async function getSchemaVersion(db) {
  await ensureHistoryMeta(db)
  const res = await db.query(
    `select value from history_schema_state where key = 'schema_version'`
  )
  return res.rows[0] ? Number(res.rows[0].value) : 0
}

async function setSchemaVersion(db, version) {
  await ensureHistoryMeta(db)
  await db.query(
    `insert into history_schema_state(key, value, updated_at)
     values ('schema_version', $1, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [String(version)]
  )
}

async function createHistoryTables(db) {
  await db.query(`
    create table if not exists room_checkpoints (
      id uuid primary key,
      room_key text not null references rooms(room_key) on delete cascade,
      revision bigint not null,
      tree_snapshot jsonb not null,
      metadata_snapshot jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      created_by text not null default '',
      reason text not null default 'THRESHOLD',
      operation_count integer not null default 0,
      snapshot_version integer not null default 1,
      checksum text not null default '',
      node_count integer not null default 0,
      unique (room_key, revision)
    )
  `)
  await db.query(`
    create index if not exists room_checkpoints_room_rev_idx
    on room_checkpoints(room_key, revision desc)
  `)
  await db.query(`
    create table if not exists room_versions (
      id uuid primary key,
      room_key text not null references rooms(room_key) on delete cascade,
      revision bigint,
      checkpoint_revision bigint not null default 0,
      name text not null default '',
      description text not null default '',
      type text not null default 'MANUAL',
      created_by text not null default '',
      created_at timestamptz not null default now(),
      source text not null default 'api',
      hidden boolean not null default false,
      summary jsonb not null default '{}'::jsonb,
      summary_status text not null default 'pending',
      editors jsonb not null default '[]'::jsonb,
      source_kind text not null default '',
      availability text not null default 'readable',
      legacy_source text not null default ''
    )
  `)
  await db.query(`
    create table if not exists room_history_audit (
      id uuid primary key,
      room_key text not null,
      action text not null,
      version_id uuid,
      target_revision bigint,
      from_revision bigint,
      new_revision bigint,
      user_id text not null default '',
      created_at timestamptz not null default now(),
      detail jsonb not null default '{}'::jsonb
    )
  `)
  await db.query(`
    create table if not exists room_version_legacy_map (
      version_id uuid primary key references room_versions(id) on delete cascade,
      room_key text not null,
      source text not null,
      old_pk text not null,
      version_no bigint,
      tree_snapshot jsonb,
      metadata_snapshot jsonb not null default '{}'::jsonb,
      checksum text not null default '',
      created_at timestamptz,
      created_by text not null default '',
      unique (room_key, source, old_pk)
    )
  `)
  await db.query(`
    create table if not exists room_history_auto_jobs (
      room_key text primary key references rooms(room_key) on delete cascade,
      last_revision bigint not null default 0,
      last_activity_at timestamptz not null default now(),
      due_at timestamptz not null default now(),
      editors jsonb not null default '[]'::jsonb,
      status text not null default 'pending',
      attempts integer not null default 0,
      last_error text,
      locked_at timestamptz,
      locked_by text not null default ''
    )
  `)
  await db.query(`
    create table if not exists room_restore_idempotency (
      room_key text not null,
      idempotency_key text not null,
      result jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      primary key (room_key, idempotency_key)
    )
  `)
}

async function alterCompatibleRoomVersions(db) {
  await db.query(
    `alter table room_versions add column if not exists hidden boolean not null default false`
  )
  await db.query(
    `alter table room_versions add column if not exists summary jsonb not null default '{}'::jsonb`
  )
  await db.query(
    `alter table room_versions add column if not exists summary_status text not null default 'pending'`
  )
  await db.query(
    `alter table room_versions add column if not exists editors jsonb not null default '[]'::jsonb`
  )
  await db.query(
    `alter table room_versions add column if not exists source_kind text not null default ''`
  )
  await db.query(
    `alter table room_versions add column if not exists availability text not null default 'readable'`
  )
  await db.query(
    `alter table room_versions add column if not exists legacy_source text not null default ''`
  )
  await db.query(
    `alter table room_versions alter column revision drop not null`
  ).catch(() => {})
}

async function ensureIndexes(db) {
  await db.query(`
    create index if not exists room_versions_room_created_idx
    on room_versions(room_key, created_at desc, id desc)
    where hidden = false
  `)
  await db.query(`
    create unique index if not exists room_versions_auto_rev_uq
    on room_versions(room_key, revision)
    where type = 'AUTO' and revision is not null and hidden = false
  `)
  await db.query(`
    create index if not exists room_history_audit_room_idx
    on room_history_audit(room_key, created_at desc)
  `)
  await db.query(`
    create index if not exists room_history_auto_jobs_due_idx
    on room_history_auto_jobs(due_at)
    where status = 'pending'
  `)
}

async function ensureRoomEpoch(db) {
  await db.query(
    `alter table rooms add column if not exists restore_epoch_revision bigint not null default 0`
  )
}

function snapshotTree(raw) {
  try {
    return toBusinessTree(raw || {})
  } catch (err) {
    return raw || {}
  }
}

function snapshotMeta(raw) {
  try {
    return canonicalMetadata(raw || {})
  } catch (err) {
    return raw && typeof raw === 'object' ? raw : {}
  }
}

async function insertLegacyVersion(db, input) {
  const id = input.id
  await db.query(
    `insert into room_versions
       (id, room_key, revision, checkpoint_revision, name, description, type,
        created_by, created_at, source, hidden, summary, summary_status,
        editors, source_kind, availability, legacy_source)
     values ($1,$2,null,0,$3,$4,'LEGACY',$5,$6,'legacy',false,$7::jsonb,'na',
             $8::jsonb,'legacy',$9,$10)
     on conflict (id) do nothing`,
    [
      id,
      input.room_key,
      input.name || '旧版快照',
      input.description || '',
      input.created_by || '',
      input.created_at || new Date().toISOString(),
      JSON.stringify({ kind: 'legacy' }),
      JSON.stringify(input.editors || []),
      input.availability || 'readable',
      input.source
    ]
  )
  await db.query(
    `insert into room_version_legacy_map
       (version_id, room_key, source, old_pk, version_no, tree_snapshot,
        metadata_snapshot, checksum, created_at, created_by)
     values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10)
     on conflict (room_key, source, old_pk) do nothing`,
    [
      id,
      input.room_key,
      input.source,
      String(input.old_pk),
      input.version_no == null ? null : Number(input.version_no),
      JSON.stringify(input.tree || {}),
      JSON.stringify(input.metadata || {}),
      input.checksum || '',
      input.created_at || new Date().toISOString(),
      input.created_by || ''
    ]
  )
}

async function roomExists(db, roomKey) {
  const res = await db.query(`select 1 from rooms where room_key = $1`, [roomKey])
  return !!res.rows[0]
}

async function migrateLegacyRoomVersions(db, tableName) {
  const cols = colMap(await tableColumns(db, tableName))
  if (!cols.size) return { count: 0, source: tableName }
  const hasVersionNo = cols.has('version_no')
  const pk = cols.has('id') ? 'id' : hasVersionNo ? 'version_no' : null
  const res = await db.query(`select * from ${tableName}`)
  let count = 0
  for (const row of res.rows) {
    if (!(await roomExists(db, row.room_key))) continue
    const oldPk = pk ? row[pk] : JSON.stringify([row.room_key, row.created_at])
    const versionNo = hasVersionNo
      ? Number(row.version_no)
      : row.revision != null
        ? Number(row.revision)
        : null
    const tree = snapshotTree(row.tree_snapshot || row.nodes || row.content || {})
    const metadata = snapshotMeta(row.metadata_snapshot || row.metadata || {})
    const hasTheme = !!(metadata && metadata.theme)
    const checksum = historyChecksum(tree, metadata)
    const availability =
      !tree || !Object.keys(tree).length
        ? 'unreadable'
        : hasTheme
          ? 'readable'
          : 'partial'
    await insertLegacyVersion(db, {
      id: stableUuid([tableName, row.room_key, String(oldPk)]),
      room_key: row.room_key,
      source: tableName,
      old_pk: oldPk,
      version_no: Number.isFinite(versionNo) ? versionNo : null,
      name: row.name || '旧版快照',
      description: row.description || '',
      created_by: row.created_by || row.author || '',
      created_at: row.created_at,
      tree,
      metadata,
      checksum,
      availability,
      editors: row.created_by ? [row.created_by] : []
    })
    count += 1
  }
  return { count, source: tableName }
}

async function migrateRoomSnapshots(db) {
  if (!(await tableExists(db, 'room_snapshots'))) return { count: 0, source: 'room_snapshots' }
  const res = await db.query(
    `select s.room_key, s.version, s.nodes, s.created_at
     from room_snapshots s
     join rooms r on r.room_key = s.room_key`
  )
  let count = 0
  for (const row of res.rows) {
    const tree = snapshotTree(row.nodes || {})
    const metadata = {}
    const checksum = historyChecksum(tree, metadata)
    await insertLegacyVersion(db, {
      id: stableUuid(['room_snapshots', row.room_key, String(row.version)]),
      room_key: row.room_key,
      source: 'room_snapshots',
      old_pk: String(row.version),
      version_no: Number(row.version),
      name: '旧版快照',
      created_at: row.created_at,
      tree,
      metadata,
      checksum,
      availability: Object.keys(tree).length ? 'partial' : 'unreadable',
      editors: []
    })
    count += 1
  }
  return { count, source: 'room_snapshots' }
}

async function verifyLegacyCounts(db, expected) {
  const mapped = await db.query(
    `select source, count(*)::int as count from room_version_legacy_map group by source`
  )
  const bySource = {}
  mapped.rows.forEach(row => {
    bySource[row.source] = Number(row.count)
  })
  expected.forEach(item => {
    const got = bySource[item.source] || 0
    if (got < Number(item.count || 0)) {
      throw historyError(
        'HISTORY_MIGRATION_MISMATCH',
        `legacy map ${item.source} expected >= ${item.count}, got ${got}`,
        500
      )
    }
  })
  return bySource
}

async function migrateHistorySchema(db, options = {}) {
  if (!db || typeof db.query !== 'function') {
    return { ok: false, skipped: true }
  }
  const report = { renamed: false, mapped: [], schemaVersion: HISTORY_SCHEMA_VERSION }
  try {
    await ensureHistoryMeta(db)
    await ensureRoomEpoch(db)
    const cols = await tableColumns(db, 'room_versions')
    if (cols.length && !isCompatibleRoomVersions(cols)) {
      const legacyName = (await tableExists(db, 'room_versions_legacy'))
        ? 'room_versions_legacy_' + Date.now()
        : 'room_versions_legacy'
      await db.query(`alter table room_versions rename to ${legacyName}`)
      report.renamed = legacyName
      await createHistoryTables(db)
      report.mapped.push(await migrateLegacyRoomVersions(db, legacyName))
    } else {
      await createHistoryTables(db)
      if (cols.length) await alterCompatibleRoomVersions(db)
    }
    await ensureIndexes(db)
    report.mapped.push(await migrateRoomSnapshots(db))
    if (!options.skipVerify) await verifyLegacyCounts(db, report.mapped)
    await setSchemaVersion(db, HISTORY_SCHEMA_VERSION)
    report.ok = true
    return report
  } catch (error) {
    error.code = error.code || 'HISTORY_SCHEMA_INCOMPATIBLE'
    error.statusCode = error.statusCode || 500
    throw error
  }
}

async function assertHistoryWritable(db) {
  const version = await getSchemaVersion(db)
  if (Number(version) !== HISTORY_SCHEMA_VERSION) {
    throw historyError(
      'HISTORY_SCHEMA_INCOMPATIBLE',
      `history schema version ${version} != ${HISTORY_SCHEMA_VERSION}; run migrateHistorySchema and check upgrade docs`,
      503
    )
  }
}

module.exports = {
  HISTORY_SCHEMA_VERSION,
  stableUuid,
  migrateHistorySchema,
  assertHistoryWritable,
  getSchemaVersion,
  isCompatibleRoomVersions
}
