-- Enables bounded idempotency lookups for MCP operations moved to the archive.
-- Apply explicitly before enabling MCP operation-id deduplication in production.
-- Run outside an explicit transaction because CREATE INDEX CONCURRENTLY requires it.
set lock_timeout = '2s';
create index concurrently if not exists room_operations_archive_operation_id_idx
  on room_operations_archive(room_key, operation_id);
reset lock_timeout;
