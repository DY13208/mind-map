-- Assistant chat sessions (same mind_map Postgres — do NOT use Yiran/Cognee/OpenClaw DBs).
-- Runtime startup also applies this schema idempotently in bin/chatSessions/store.js.
--
-- OpenClaw gateway state stays in its own volume; only product-shell visible
-- conversations are stored here for audit / cross-device sync.
--
-- Apply:
--   psql "$DATABASE_URL" -f simple-mind-map/migrations/006_chat_sessions_v1.sql
-- Or restart collab server (initSchema creates the tables automatically).
--
-- Rollback:
--   drop table if exists chat_messages;
--   drop table if exists chat_sessions;

create table if not exists chat_sessions (
  id text primary key,
  user_id text not null,
  wecom_userid text not null default '',
  corp_id text not null default '',
  title text not null default '新对话',
  active boolean not null default false,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists chat_sessions_user_updated_idx
  on chat_sessions(user_id, updated_at desc)
  where deleted_at is null;

create table if not exists chat_messages (
  id text primary key,
  session_id text not null references chat_sessions(id) on delete cascade,
  role text not null default 'user',
  content text not null default '',
  status text not null default '',
  extra jsonb not null default '{}'::jsonb,
  sort_index integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_session_sort_idx
  on chat_messages(session_id, sort_index asc, created_at asc);
