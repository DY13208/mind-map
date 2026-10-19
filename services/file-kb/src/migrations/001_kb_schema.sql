-- File KB phase 1 schema. Every object lives in schema kb.
-- Never references or alters mind-map tables (room_nodes, collab v2, node permissions ...).
-- Runs as kb_app (owner of schema kb) inside one transaction (see src/migrate.js).

create table if not exists kb.folders (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null,
  team_id text,
  parent_id uuid references kb.folders (id) on delete restrict,
  name text not null check (length(name) between 1 and 255),
  path text not null default '/',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists kb_folders_owner_parent_idx on kb.folders (owner_id, parent_id) where deleted_at is null;
create index if not exists kb_folders_team_idx on kb.folders (team_id) where team_id is not null and deleted_at is null;

create table if not exists kb.files (
  id uuid primary key default gen_random_uuid(),
  folder_id uuid references kb.folders (id) on delete set null,
  owner_id text not null,
  team_id text,
  name text not null check (length(name) between 1 and 255),
  mime text not null default '',
  size bigint not null check (size >= 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  storage_key text not null,
  status text not null default 'pending',
  status_detail text,
  parse_version integer not null default 0,
  current_run_id uuid,
  error text,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint kb_files_status_chk check (
    status in ('pending', 'parsing', 'structuring', 'done', 'partial', 'failed')
  )
);
create index if not exists kb_files_owner_updated_idx on kb.files (owner_id, updated_at desc, id desc) where deleted_at is null;
create index if not exists kb_files_folder_idx on kb.files (folder_id) where deleted_at is null;
create index if not exists kb_files_team_idx on kb.files (team_id) where team_id is not null and deleted_at is null;
create index if not exists kb_files_status_idx on kb.files (status) where deleted_at is null;
-- content-addressed dedupe per owner scope (team or user)
create unique index if not exists kb_files_scope_sha_uq
  on kb.files (coalesce(team_id, ''), owner_id, sha256) where deleted_at is null;

create table if not exists kb.parse_runs (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references kb.files (id) on delete cascade,
  docling_task_id text,
  options jsonb not null default '{}'::jsonb,
  status text not null default 'queued',
  error text,
  raw_json_key text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  constraint kb_parse_runs_status_chk check (
    status in ('queued', 'running', 'done', 'partial', 'failed', 'superseded')
  )
);
create index if not exists kb_parse_runs_file_idx on kb.parse_runs (file_id, created_at desc);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'kb_files_current_run_fk') then
    alter table kb.files add constraint kb_files_current_run_fk
      foreign key (current_run_id) references kb.parse_runs (id) on delete set null;
  end if;
end $$;

create table if not exists kb.blocks (
  id bigserial primary key,
  run_id uuid not null references kb.parse_runs (id) on delete cascade,
  file_id uuid not null references kb.files (id) on delete cascade,
  seq integer not null,
  type text not null,
  text text not null default '',
  page integer,
  bbox jsonb,
  sheet text,
  cell_range text,
  heading_path text[],
  tsv tsvector generated always as (to_tsvector('simple'::regconfig, coalesce(text, ''))) stored,
  unique (run_id, seq)
);
create index if not exists kb_blocks_file_idx on kb.blocks (file_id, run_id, seq);
create index if not exists kb_blocks_tsv_idx on kb.blocks using gin (tsv);

create table if not exists kb.fields (
  id bigserial primary key,
  file_id uuid not null references kb.files (id) on delete cascade,
  run_id uuid not null references kb.parse_runs (id) on delete cascade,
  sheet text not null default '',
  col_index integer not null check (col_index >= 0),
  name text not null,
  inferred_type text not null default 'text',
  unit text,
  constraint kb_fields_type_chk check (inferred_type in ('text', 'int', 'numeric', 'date', 'bool')),
  unique (run_id, sheet, col_index)
);
create index if not exists kb_fields_file_idx on kb.fields (file_id);

create table if not exists kb.records (
  id bigserial primary key,
  file_id uuid not null references kb.files (id) on delete cascade,
  run_id uuid not null references kb.parse_runs (id) on delete cascade,
  sheet text not null default '',
  row_index integer not null check (row_index >= 0),
  data jsonb not null default '{}'::jsonb,
  sku text,
  price numeric,
  stock integer,
  record_date date,
  unique (run_id, sheet, row_index)
);
create index if not exists kb_records_file_idx on kb.records (file_id, run_id);
create index if not exists kb_records_sku_idx on kb.records (sku) where sku is not null;
create index if not exists kb_records_price_idx on kb.records (price) where price is not null;
create index if not exists kb_records_stock_idx on kb.records (stock) where stock is not null;
create index if not exists kb_records_date_idx on kb.records (record_date) where record_date is not null;
create index if not exists kb_records_data_gin on kb.records using gin (data jsonb_path_ops);

create table if not exists kb.jobs (
  id bigserial primary key,
  file_id uuid not null references kb.files (id) on delete cascade,
  run_id uuid references kb.parse_runs (id) on delete cascade,
  kind text not null,
  state text not null default 'queued',
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  run_after timestamptz not null default now(),
  locked_by text,
  locked_until timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint kb_jobs_kind_chk check (kind in ('parse', 'structure', 'index')),
  constraint kb_jobs_state_chk check (state in ('queued', 'running', 'done', 'failed', 'cancelled'))
);
-- only one active job per (file, kind): concurrent re-parse requests collapse
create unique index if not exists kb_jobs_active_uq on kb.jobs (file_id, kind) where state in ('queued', 'running');
create index if not exists kb_jobs_pick_idx on kb.jobs (run_after, id) where state = 'queued';
create index if not exists kb_jobs_lease_idx on kb.jobs (locked_until) where state = 'running';

create table if not exists kb.acl (
  id bigserial primary key,
  file_id uuid references kb.files (id) on delete cascade,
  folder_id uuid references kb.folders (id) on delete cascade,
  principal_type text not null,
  principal_id text not null,
  role text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  constraint kb_acl_target_chk check ((file_id is null) <> (folder_id is null)),
  constraint kb_acl_principal_chk check (principal_type in ('user', 'team')),
  constraint kb_acl_role_chk check (role in ('viewer', 'editor'))
);
create unique index if not exists kb_acl_uq
  on kb.acl (coalesce(file_id::text, ''), coalesce(folder_id::text, ''), principal_type, principal_id);
create index if not exists kb_acl_principal_idx on kb.acl (principal_type, principal_id);

create table if not exists kb.mcp_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  name text not null default '',
  token_prefix text not null,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  scopes text[] not null default array['kb:read']::text[],
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz
);
create index if not exists kb_mcp_tokens_user_idx on kb.mcp_tokens (user_id) where revoked_at is null;

create table if not exists kb.audit (
  id bigserial primary key,
  actor text not null,
  action text not null,
  target text,
  at timestamptz not null default now(),
  meta jsonb not null default '{}'::jsonb
);
create index if not exists kb_audit_at_idx on kb.audit (at desc);
create index if not exists kb_audit_actor_idx on kb.audit (actor, at desc);
