-- Node attachments / extracted knowledge for AI context.
-- Runtime startup also applies this schema idempotently in bin/nodeKnowledge/store.js.
--
-- Apply:
--   psql "$DATABASE_URL" -f simple-mind-map/migrations/002_node_attachments.sql
-- Or restart collab server (initSchema creates the table automatically).
--
-- Rollback:
--   drop table if exists node_attachments;

create table if not exists node_attachments (
  id text primary key,
  room_key text not null,
  node_uid text not null default '',
  content_hash text not null,
  file_name text not null default '',
  mime_type text not null default '',
  byte_size integer not null default 0,
  cos_key text,
  status text not null default 'pending',
  error_message text not null default '',
  extracted_text text not null default '',
  extracted_chars integer not null default 0,
  source_kind text not null default 'attachment',
  created_by text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint node_attachments_status_chk
    check (status in ('pending', 'processing', 'ready', 'failed')),
  constraint node_attachments_room_hash_uq unique (room_key, content_hash)
);

create index if not exists node_attachments_room_updated_idx
  on node_attachments(room_key, updated_at desc);

create index if not exists node_attachments_room_node_idx
  on node_attachments(room_key, node_uid);
