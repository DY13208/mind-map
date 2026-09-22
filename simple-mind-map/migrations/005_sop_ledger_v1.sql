-- SOP ledger tables (same mind_map Postgres — do NOT use Yiran/Cognee/OpenClaw DBs).
-- Runtime startup also applies this schema idempotently in bin/sopLedger/store.js.
--
-- Dual-write: node data.sopLedger remains authoritative for in-map display;
-- these tables enable cross-room query / task boards / reports.
--
-- Apply:
--   psql "$DATABASE_URL" -f simple-mind-map/migrations/005_sop_ledger_v1.sql
-- Or restart collab server (initSchema creates the tables automatically).
--
-- Rollback:
--   drop table if exists sop_deliverables;
--   drop table if exists sop_runs;
--   drop table if exists sop_definitions;

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
);

create index if not exists sop_definitions_room_updated_idx
  on sop_definitions(room_key, updated_at desc);

create index if not exists sop_definitions_updated_idx
  on sop_definitions(updated_at desc);

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
);

create index if not exists sop_runs_definition_created_idx
  on sop_runs(definition_id, created_at desc);

create index if not exists sop_runs_room_created_idx
  on sop_runs(room_key, created_at desc);

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
);

create index if not exists sop_deliverables_definition_created_idx
  on sop_deliverables(definition_id, created_at desc);

create index if not exists sop_deliverables_room_created_idx
  on sop_deliverables(room_key, created_at desc);
