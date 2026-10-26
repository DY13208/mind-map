-- A link grants anonymous access to one original file. Raw tokens are never stored.
create table kb.direct_links (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references kb.files(id) on delete cascade,
  created_by text not null,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  scope_folder_ids uuid[],
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz
);
create index kb_direct_links_creator_idx on kb.direct_links(file_id, created_by, created_at desc);
