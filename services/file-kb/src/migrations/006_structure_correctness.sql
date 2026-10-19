set local lock_timeout = '5s';
set local statement_timeout = '30s';
-- Forward-only correction: 005 used the wrong legacy constraint name.
-- Inspect columns, not an assumed generated name. No data is deleted/reparsed.
do $$ declare old record; begin
  for old in
    select c.conname from pg_constraint c
    where c.conrelid = 'kb.fields'::regclass and c.contype = 'u'
      and (select array_agg(a.attname::text order by k.ordinality)
           from unnest(c.conkey) with ordinality k(attnum, ordinality)
           join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum)
          = array['run_id','sheet','col_index']::text[]
  loop execute format('alter table kb.fields drop constraint %I', old.conname); end loop;
end $$;
alter table kb.records add column if not exists table_index integer not null default 0;
alter table kb.records add column if not exists cell_range text;

-- Dirty cells do not abort a whole numeric/date query.
create or replace function kb.try_numeric(v text) returns numeric
language plpgsql immutable as $$ begin
  if v !~ '^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$' then return null; end if;
  return v::numeric;
exception when invalid_text_representation or numeric_value_out_of_range then return null; end $$;
create or replace function kb.try_date(v text) returns date
language plpgsql immutable as $$ begin
  if v !~ '^\d{4}-\d{2}-\d{2}$' then return null; end if;
  return v::date;
exception when invalid_datetime_format or datetime_field_overflow then return null; end $$;
