-- History V2: user-visible versions, auto jobs, restore idempotency, legacy snapshot map.
-- Runtime startup also applies this schema via bin/collabHistory/migrate.js.
--
-- Backup before applying:
--   pg_dump -Fc -d "$DATABASE_URL" -f mind_map_history_pre_v2.dump
--
-- Apply:
--   restart collab server (initHistorySchema / migrateHistorySchema)
--   or: node -e "require('./simple-mind-map/bin/loadEnv'); require('./simple-mind-map/bin/storage').initSchema().then(()=>process.exit(0))"
--
-- Rollback:
--   stop collab writes; restore dump:
--     pg_restore -d "$DATABASE_URL" --clean --if-exists mind_map_history_pre_v2.dump
--   Do not drop room_versions_legacy.
--
-- Standalone:
--   node simple-mind-map/bin/migrateHistory.js

alter table rooms add column if not exists restore_epoch_revision bigint not null default 0;

create table if not exists history_schema_state (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

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
);

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
);

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
);

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
);

create table if not exists room_restore_idempotency (
  room_key text not null,
  idempotency_key text not null,
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (room_key, idempotency_key)
);

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
);

create index if not exists room_versions_room_created_idx
  on room_versions(room_key, created_at desc, id desc)
  where hidden = false;

create unique index if not exists room_versions_auto_rev_uq
  on room_versions(room_key, revision)
  where type = 'AUTO' and revision is not null and hidden = false;

create index if not exists room_history_audit_room_idx
  on room_history_audit(room_key, created_at desc);

create index if not exists room_history_auto_jobs_due_idx
  on room_history_auto_jobs(due_at)
  where status = 'pending';

