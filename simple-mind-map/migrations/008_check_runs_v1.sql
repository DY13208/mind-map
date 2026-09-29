-- CPD inspection history is stored separately from execution ledgers.
-- Keep every read room-scoped and bind reports to the exact chain/source versions.
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
