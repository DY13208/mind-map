-- Folder-inherited room ACL. Runtime startup also applies this schema idempotently in bin/roomAcl.js.
-- Backup overlapping grants, backfill folder_role, and migrate exact non-owner folder-inherited direct shares.

alter table room_members add column if not exists folder_role text;
alter table room_members add column if not exists source_folder_id text;

create table if not exists room_members_folder_mig_backup (
  room_key text not null,
  user_id text not null,
  role text,
  direct_role text,
  team_role text,
  folder_role text,
  source text,
  source_team_id text,
  source_folder_id text,
  created_at timestamptz,
  updated_at timestamptz,
  folder_id text,
  backed_up_at timestamptz not null default now(),
  primary key (room_key, user_id)
);

-- Snapshot rows that currently overlap a folder membership (idempotent via PK).
insert into room_members_folder_mig_backup (
  room_key, user_id, role, direct_role, team_role, folder_role, source,
  source_team_id, source_folder_id, created_at, updated_at, folder_id
)
select
  m.room_key,
  m.user_id,
  m.role,
  m.direct_role,
  m.team_role,
  m.folder_role,
  m.source,
  m.source_team_id,
  m.source_folder_id,
  m.created_at,
  m.updated_at,
  r.folder_id::text
from room_members m
join rooms r on r.room_key = m.room_key
join folder_members fm
  on fm.folder_id = r.folder_id and fm.user_id = m.user_id
where r.folder_id is not null
  and r.deleted_at is null
on conflict (room_key, user_id) do nothing;

-- Exact historical folder inheritance: non-owner direct_role matches folder member role → move to folder_role.
update room_members m
set
  folder_role = fm.role,
  source_folder_id = r.folder_id::text,
  direct_role = null,
  role = case
    when coalesce(m.team_role, '') = 'owner' or fm.role = 'owner' then 'owner'
    when coalesce(m.team_role, '') = 'editor' or fm.role = 'editor' then 'editor'
    when coalesce(m.team_role, '') = 'viewer' or fm.role = 'viewer' then 'viewer'
    else fm.role
  end,
  source = case
    when m.team_role is not null then 'team'
    else 'folder'
  end,
  updated_at = now()
from rooms r
join folder_members fm on fm.folder_id = r.folder_id
where m.room_key = r.room_key
  and fm.user_id = m.user_id
  and r.folder_id is not null
  and r.deleted_at is null
  and m.role <> 'owner'
  and coalesce(m.direct_role, '') <> 'owner'
  and m.direct_role is not null
  and m.direct_role = fm.role
  and m.folder_role is null;

-- Backfill current folder permissions without clearing direct/team grants.
insert into room_members (
  room_key, user_id, role, direct_role, team_role, folder_role, source, source_folder_id
)
select
  r.room_key,
  fm.user_id,
  fm.role,
  null,
  null,
  fm.role,
  'folder',
  r.folder_id::text
from rooms r
join folder_members fm on fm.folder_id = r.folder_id
where r.folder_id is not null
  and r.deleted_at is null
on conflict (room_key, user_id) do update set
  folder_role = excluded.folder_role,
  source_folder_id = excluded.source_folder_id,
  role = case
    when room_members.direct_role = 'owner'
      or room_members.team_role = 'owner'
      or excluded.folder_role = 'owner' then 'owner'
    when room_members.direct_role = 'editor'
      or room_members.team_role = 'editor'
      or excluded.folder_role = 'editor' then 'editor'
    when room_members.direct_role = 'viewer'
      or room_members.team_role = 'viewer'
      or excluded.folder_role = 'viewer' then 'viewer'
    else coalesce(
      room_members.direct_role,
      room_members.team_role,
      excluded.folder_role
    )
  end,
  source = case
    when room_members.direct_role is not null then 'direct_share'
    when room_members.team_role is not null then 'team'
    else 'folder'
  end,
  updated_at = now();

create index if not exists room_members_folder_source_idx
  on room_members(source_folder_id)
  where source_folder_id is not null;
