async function initHistorySchema(db) {
  if (!db || typeof db.query !== 'function') return
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
      revision bigint not null,
      checkpoint_revision bigint not null default 0,
      name text not null default '',
      description text not null default '',
      type text not null default 'MANUAL',
      created_by text not null default '',
      created_at timestamptz not null default now(),
      source text not null default 'api',
      hidden boolean not null default false
    )
  `)
  await db.query(`
    create index if not exists room_versions_room_created_idx
    on room_versions(room_key, created_at desc)
    where hidden = false
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
    create index if not exists room_history_audit_room_idx
    on room_history_audit(room_key, created_at desc)
  `)
}

module.exports = { initHistorySchema }
