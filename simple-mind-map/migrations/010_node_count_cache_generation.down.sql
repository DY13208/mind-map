-- First disable COLLAB_NODE_COUNT_CACHE and COLLAB_NODE_COUNT_CACHE_WRITERS_READY
-- on every reader. In-flight snapshots must drain before applying this rollback.
set local lock_timeout = '5s';
drop trigger if exists room_node_counts_generation_insert on room_nodes;
drop trigger if exists room_node_counts_generation_update on room_nodes;
drop trigger if exists room_node_counts_generation_delete on room_nodes;
drop function if exists advance_room_node_counts_generation();
drop sequence if exists room_node_counts_generation_seq;
drop index if exists room_nodes_parent_position_uid_idx;
alter table rooms drop column if exists node_counts_generation;
