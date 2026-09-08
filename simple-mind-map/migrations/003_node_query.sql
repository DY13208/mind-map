-- Node query indexes for exact-name, parent/path-segment, and fuzzy lookup.
-- Runtime startup applies the same DDL idempotently in bin/storage.js.
--
-- Apply:
--   psql "$DATABASE_URL" -f simple-mind-map/migrations/003_node_query.sql
-- Or restart the collaboration server.
--
-- PostgreSQL computes the stored generated value for existing rows when the
-- column is first added. Re-running this migration leaves an existing column
-- and all indexes in place.

-- Fuzzy lookup is optional.  Exact UID/name/path retrieval remains available
-- when the deployment role cannot install extensions.
do $$
begin
  create extension if not exists pg_trgm;
exception
  when insufficient_privilege or undefined_file then
    raise notice 'pg_trgm is unavailable; fuzzy node lookup will be disabled';
end
$$;

alter table room_nodes
  add column if not exists search_name text
  generated always as (
    btrim(
      lower(
        regexp_replace(
          regexp_replace(
            regexp_replace(coalesce(data ->> 'text', ''), '<[^>]+>', ' ', 'g'),
            '&nbsp;',
            ' ',
            'gi'
          ),
          '[[:space:]]+',
          ' ',
          'g'
        )
      )
    )
  ) stored;

create index if not exists room_nodes_room_search_name_idx
  on room_nodes(room_key, search_name)
  where deleted_at is null;

create index if not exists room_nodes_parent_search_name_position_idx
  on room_nodes(room_key, parent_uid, search_name, position)
  where deleted_at is null;

do $$
begin
  if exists(select 1 from pg_extension where extname = 'pg_trgm') then
    execute 'create index if not exists room_nodes_search_name_trgm_idx
      on room_nodes using gin(search_name gin_trgm_ops)
      where deleted_at is null';
  else
    raise notice 'room_nodes_search_name_trgm_idx was skipped because pg_trgm is unavailable';
  end if;
end
$$;
