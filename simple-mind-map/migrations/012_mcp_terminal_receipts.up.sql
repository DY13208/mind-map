-- Persists only the terminal response for MCP node.batch requests that made
-- no changes. The original request body and failed intent are never stored.
-- Apply explicitly before enabling MCP node.batch; ordinary requests do not
-- create or migrate this table.
set lock_timeout = '2s';
create table if not exists mcp_terminal_receipts (
  room_key text not null references rooms(room_key) on delete cascade,
  operation_id uuid not null,
  principal_id text not null check (principal_id <> ''),
  request_digest text not null check (request_digest like 'sha256:%'),
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  current_revision bigint not null check (current_revision >= 0),
  created_at timestamptz not null default now(),
  primary key (room_key, operation_id)
);
reset lock_timeout;
