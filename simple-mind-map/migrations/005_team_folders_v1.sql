-- Team-scoped folders: personal folders keep team_id null.
alter table folders add column if not exists team_id text;

create index if not exists folders_team_id_idx
  on folders (team_id)
  where deleted_at is null and team_id is not null;

drop index if exists folders_root_name_uniq;
drop index if exists folders_parent_name_uniq;

create unique index if not exists folders_personal_root_name_uniq
  on folders (lower(name))
  where deleted_at is null and parent_id is null and team_id is null;

create unique index if not exists folders_personal_parent_name_uniq
  on folders (parent_id, lower(name))
  where deleted_at is null and parent_id is not null and team_id is null;

create unique index if not exists folders_team_root_name_uniq
  on folders (team_id, lower(name))
  where deleted_at is null and parent_id is null and team_id is not null;

create unique index if not exists folders_team_parent_name_uniq
  on folders (team_id, parent_id, lower(name))
  where deleted_at is null and parent_id is not null and team_id is not null;
