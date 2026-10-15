-- The generation belongs to the database, including same-revision repairs.
-- Statement transition tables cover all SQL writers, including older binaries.
-- Apply atomically before enabling COLLAB_NODE_COUNT_CACHE_WRITERS_READY.
set local lock_timeout = '5s';
alter table rooms add column if not exists node_counts_generation bigint not null default 0;
create sequence if not exists room_node_counts_generation_seq as bigint;
-- Never repeat a stamp when a deleted room key is later recreated. ALTER
-- TABLE above holds the rooms lock while synchronizing older counter values.
select setval('room_node_counts_generation_seq',
  greatest(last_value, coalesce((select max(node_counts_generation) from rooms), 0)), true)
from room_node_counts_generation_seq;
-- Stable bounded previews need the UID tie-breaker even when positions collide.
create index if not exists room_nodes_parent_position_uid_idx
on room_nodes(room_key, parent_uid, position, uid) where deleted_at is null;

create or replace function advance_room_node_counts_generation()
returns trigger language plpgsql as $$
begin
  if TG_OP = 'INSERT' then
    update rooms r set node_counts_generation = nextval('room_node_counts_generation_seq')
    from (select distinct room_key from changed_new) affected
    where r.room_key = affected.room_key;
  elsif TG_OP = 'DELETE' then
    update rooms r set node_counts_generation = nextval('room_node_counts_generation_seq')
    from (select distinct room_key from changed_old) affected
    where r.room_key = affected.room_key;
  else
    update rooms r set node_counts_generation = nextval('room_node_counts_generation_seq')
    from (select room_key from changed_old union select room_key from changed_new) affected
    where r.room_key = affected.room_key;
  end if;
  return null;
end;
$$;

drop trigger if exists room_node_counts_generation_insert on room_nodes;
create trigger room_node_counts_generation_insert after insert on room_nodes
referencing new table as changed_new for each statement
execute function advance_room_node_counts_generation();
drop trigger if exists room_node_counts_generation_update on room_nodes;
create trigger room_node_counts_generation_update after update on room_nodes
referencing old table as changed_old new table as changed_new for each statement
execute function advance_room_node_counts_generation();
drop trigger if exists room_node_counts_generation_delete on room_nodes;
create trigger room_node_counts_generation_delete after delete on room_nodes
referencing old table as changed_old for each statement
execute function advance_room_node_counts_generation();
