-- Only run after every application instance has stopped MCP write code that
-- depends on this table, including legacy writes. Disabling Direct alone is
-- insufficient. This removes idempotency for all-failed/no-op batches;
-- committed operations remain protected by room_operations and its archive.
set lock_timeout = '2s';
drop table if exists mcp_terminal_receipts;
reset lock_timeout;
