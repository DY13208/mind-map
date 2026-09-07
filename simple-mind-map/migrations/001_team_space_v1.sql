-- Team Space V1. Runtime startup also applies this schema idempotently in bin/teamSpace.js.
create table if not exists teams (
  id text primary key,
  corp_id text not null,
  name text not null,
  description text not null default '',
  source_type text not null default 'custom',
  source_id text,
  owner_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint teams_source_type_chk check (source_type in ('custom', 'wecom_department'))
);

create index if not exists teams_corp_updated_idx on teams(corp_id, updated_at desc)
  where deleted_at is null;

create table if not exists team_members (
  team_id text not null references teams(id) on delete cascade,
  corp_id text not null,
  user_id text not null,
  wecom_userid text not null default '',
  role text not null check (role in ('owner', 'admin', 'member')),
  joined_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (team_id, user_id)
);

create index if not exists team_members_corp_user_idx on team_members(corp_id, user_id);

alter table rooms add column if not exists team_id text;
create index if not exists rooms_team_updated_idx on rooms(team_id, updated_at desc)
  where team_id is not null;

alter table room_members add column if not exists source text not null default 'direct_share';
alter table room_members add column if not exists source_team_id text;
alter table room_members add column if not exists direct_role text;
alter table room_members add column if not exists team_role text;
update room_members set source = 'direct_share' where source is null;
update room_members
set direct_role = role
where direct_role is null and source = 'direct_share';
update room_members
set team_role = role
where team_role is null and source = 'team';
create index if not exists room_members_team_source_idx on room_members(source, source_team_id)
  where source = 'team';

alter table wecom_users add column if not exists corp_id text not null default '';
alter table wecom_users add column if not exists wecom_userid text not null default '';
alter table wecom_users add column if not exists position text not null default '';
update wecom_users set wecom_userid = user_id where wecom_userid = '';
create index if not exists wecom_users_corp_name_idx on wecom_users(corp_id, name, user_id);
create unique index if not exists wecom_users_corp_wecom_userid_uq
  on wecom_users(corp_id, wecom_userid);
create unique index if not exists wecom_users_corp_user_id_uq
  on wecom_users(corp_id, user_id);
create unique index if not exists teams_id_corp_uq
  on teams(id, corp_id);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'team_members_team_corp_fk') then
    alter table team_members add constraint team_members_team_corp_fk
      foreign key (team_id, corp_id) references teams(id, corp_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'team_members_user_corp_fk') then
    alter table team_members add constraint team_members_user_corp_fk
      foreign key (corp_id, user_id) references wecom_users(corp_id, user_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'team_members_wecom_identity_fk') then
    alter table team_members add constraint team_members_wecom_identity_fk
      foreign key (corp_id, wecom_userid) references wecom_users(corp_id, wecom_userid);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'teams_owner_corp_fk') then
    alter table teams add constraint teams_owner_corp_fk
      foreign key (corp_id, owner_id) references wecom_users(corp_id, user_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'rooms_team_fk') then
    alter table rooms add constraint rooms_team_fk
      foreign key (team_id) references teams(id);
  end if;
end
$$;
