-- Run outside an explicit transaction because DROP INDEX CONCURRENTLY requires it.
set lock_timeout = '2s';
drop index concurrently if exists room_operations_archive_operation_id_idx;
reset lock_timeout;
