-- Header detection metadata. Low-confidence fields stay on a run that is not current
-- until a person confirms the mapping. table_index separates tables on one sheet.
alter table kb.fields add column if not exists table_index integer not null default 0;
alter table kb.fields add column if not exists header_row integer;
alter table kb.fields add column if not exists confidence real;
alter table kb.fields add column if not exists confirmed boolean not null default true;

alter table kb.fields drop constraint if exists kb_fields_run_id_sheet_col_index_key;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'kb_fields_run_sheet_table_col') then
    alter table kb.fields add constraint kb_fields_run_sheet_table_col unique (run_id, sheet, table_index, col_index);
  end if;
end $$;
