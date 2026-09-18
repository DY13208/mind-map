-- Phase 1: Docmost page ownership mapping (Mind Map PostgreSQL SoT)
-- Do NOT write Docmost business tables for ownership.

create table if not exists knowledge_docmost_mappings (
  id bigserial primary key,
  room_id text not null,
  topic_key text not null,
  slot text not null check (slot in ('standard', 'human', 'ai')),
  owner text not null check (owner in ('mindmap', 'human', 'ai')),
  canonical_path text not null default '',
  docmost_space_id text not null default '',
  docmost_page_id text,
  content_hash text not null default '',
  last_synced_version text not null default '',
  title text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (room_id, topic_key, slot)
);

create index if not exists knowledge_docmost_mappings_room_idx
  on knowledge_docmost_mappings(room_id)
  where deleted_at is null;

create index if not exists knowledge_docmost_mappings_page_idx
  on knowledge_docmost_mappings(docmost_page_id)
  where deleted_at is null and docmost_page_id is not null;