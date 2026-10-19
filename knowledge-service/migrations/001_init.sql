-- File knowledge library. Objects live only in schema "knowledge".
-- This script must not alter mind-map tables, indexes, or extensions.

create schema if not exists knowledge;

create table if not exists knowledge.schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);

create table if not exists knowledge.files (
  id uuid primary key,
  owner_user_id text not null,
  org_id text not null default '',
  file_name text not null,
  mime_type text not null default '',
  byte_size bigint not null,
  content_hash text not null,
  storage_key text not null,
  status text not null,
  latest_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint knowledge_files_status_chk check (
    status in ('uploaded', 'queued', 'processing', 'ready', 'partial', 'failed')
  )
);

create index if not exists knowledge_files_owner_updated_idx
  on knowledge.files (owner_user_id, updated_at desc, id desc);

create table if not exists knowledge.file_versions (
  id uuid primary key,
  file_id uuid not null references knowledge.files (id) on delete cascade,
  owner_user_id text not null,
  version integer not null,
  content_hash text not null,
  storage_key text not null,
  byte_size bigint not null,
  status text not null,
  error_message text not null default '',
  attempts integer not null default 0,
  report jsonb not null default '{}'::jsonb,
  parser text not null default '',
  parser_version text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (file_id, version),
  constraint knowledge_file_versions_status_chk check (
    status in ('uploaded', 'queued', 'processing', 'ready', 'partial', 'failed')
  )
);

create unique index if not exists knowledge_versions_owner_hash_uq
  on knowledge.file_versions (owner_user_id, content_hash);

create index if not exists knowledge_versions_file_idx
  on knowledge.file_versions (file_id, version desc);

create table if not exists knowledge.documents (
  id uuid primary key,
  file_version_id uuid not null unique references knowledge.file_versions (id) on delete cascade,
  file_id uuid not null references knowledge.files (id) on delete cascade,
  parser text not null,
  parser_version text not null default '',
  raw_document jsonb not null,
  plain_text text not null default '',
  block_count integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists knowledge_documents_file_idx
  on knowledge.documents (file_id, created_at desc);

create table if not exists knowledge.blocks (
  id uuid primary key,
  document_id uuid not null references knowledge.documents (id) on delete cascade,
  file_id uuid not null,
  block_key text not null,
  parent_block_key text,
  ordinal integer not null,
  kind text not null,
  text text not null default '',
  raw jsonb not null default '{}'::jsonb,
  source jsonb not null default '{}'::jsonb,
  unique (document_id, block_key)
);

create index if not exists knowledge_blocks_file_kind_idx
  on knowledge.blocks (file_id, kind, ordinal);

create index if not exists knowledge_blocks_document_ordinal_idx
  on knowledge.blocks (document_id, ordinal);

create table if not exists knowledge.grants (
  file_id uuid not null references knowledge.files (id) on delete cascade,
  user_id text not null,
  role text not null,
  granted_by text not null default '',
  created_at timestamptz not null default now(),
  primary key (file_id, user_id),
  constraint knowledge_grants_role_chk check (role in ('owner', 'reader'))
);

create index if not exists knowledge_grants_user_idx
  on knowledge.grants (user_id, file_id);

create table if not exists knowledge.jobs (
  id uuid primary key,
  file_version_id uuid not null unique references knowledge.file_versions (id) on delete cascade,
  status text not null,
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  run_after timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text not null default '',
  last_error text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint knowledge_jobs_status_chk check (
    status in ('pending', 'running', 'succeeded', 'failed')
  )
);

create index if not exists knowledge_jobs_pending_idx
  on knowledge.jobs (run_after, created_at)
  where status = 'pending';

create table if not exists knowledge.audit (
  id bigserial primary key,
  user_id text not null default '',
  action text not null,
  file_id uuid,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists knowledge_audit_file_idx
  on knowledge.audit (file_id, created_at desc);

create table if not exists knowledge.api_tokens (
  token_hash text primary key,
  user_id text not null,
  org_id text not null default '',
  label text not null default '',
  created_at timestamptz not null default now(),
  expires_at timestamptz
);

create index if not exists knowledge_api_tokens_user_idx
  on knowledge.api_tokens (user_id);
