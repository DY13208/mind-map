-- Knowledge-base ACL. Does not alter mind-map tables.
-- Direct grant on a subject replaces inherited grants for that subject.
-- The caller's effective role is the highest role among the user subject and each team subject.
-- The resource owner_user_id is always owner and cannot be downgraded by an ACL row.
-- inherit_acl = false stops the walk at that resource; its own grants still apply.
-- There is no permission cache. Every check reads the current rows.

create table if not exists knowledge.folders (
  id uuid primary key,
  parent_id uuid,
  owner_user_id text not null,
  org_id text not null default '',
  name text not null,
  inherit_acl boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table knowledge.files add column if not exists folder_id uuid;
alter table knowledge.files add column if not exists inherit_acl boolean not null default true;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'knowledge_folders_parent_fk'
  ) then
    alter table knowledge.folders
      add constraint knowledge_folders_parent_fk
      foreign key (parent_id) references knowledge.folders (id) on delete restrict;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'knowledge_files_folder_fk'
  ) then
    alter table knowledge.files
      add constraint knowledge_files_folder_fk
      foreign key (folder_id) references knowledge.folders (id) on delete restrict;
  end if;
end
$$;

create index if not exists knowledge_folders_parent_idx
  on knowledge.folders (parent_id, name);
create index if not exists knowledge_files_folder_idx
  on knowledge.files (folder_id);

create table if not exists knowledge.teams (
  id text primary key,
  name text not null,
  owner_user_id text not null,
  created_at timestamptz not null default now()
);

create table if not exists knowledge.team_members (
  team_id text not null references knowledge.teams (id) on delete cascade,
  user_id text not null,
  created_at timestamptz not null default now(),
  primary key (team_id, user_id)
);

create index if not exists knowledge_team_members_user_idx
  on knowledge.team_members (user_id, team_id);

create table if not exists knowledge.acl (
  id uuid primary key,
  resource_type text not null,
  resource_id uuid not null,
  subject_type text not null,
  subject_id text not null,
  role text not null,
  granted_by text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (resource_type, resource_id, subject_type, subject_id),
  constraint knowledge_acl_resource_chk check (resource_type in ('file', 'folder')),
  constraint knowledge_acl_subject_chk check (subject_type in ('user', 'team')),
  constraint knowledge_acl_role_chk check (role in ('owner', 'manager', 'editor', 'viewer'))
);

create index if not exists knowledge_acl_resource_idx
  on knowledge.acl (resource_type, resource_id);

insert into knowledge.acl (id, resource_type, resource_id, subject_type, subject_id, role, granted_by)
select md5(file_id::text || ':' || user_id)::uuid, 'file', file_id, 'user', user_id,
       case when role = 'reader' then 'viewer' else role end,
       granted_by
from knowledge.grants
where role in ('owner', 'reader')
on conflict (resource_type, resource_id, subject_type, subject_id) do nothing;

alter table knowledge.audit add column if not exists resource_type text;
alter table knowledge.audit add column if not exists resource_id uuid;

alter table knowledge.api_tokens add column if not exists token_id uuid;
alter table knowledge.api_tokens add column if not exists scope_folder_ids uuid[];
alter table knowledge.api_tokens add column if not exists revoked_at timestamptz;

update knowledge.api_tokens
set token_id = (
  substr(md5(token_hash), 1, 8) || '-' ||
  substr(md5(token_hash), 9, 4) || '-' ||
  substr(md5(token_hash), 13, 4) || '-' ||
  substr(md5(token_hash), 17, 4) || '-' ||
  substr(md5(token_hash), 21, 12)
)::uuid
where token_id is null;

create unique index if not exists knowledge_api_tokens_id_uq
  on knowledge.api_tokens (token_id);

create or replace function knowledge.role_rank(p_role text)
returns integer
language sql
immutable
as $$
  select case p_role
    when 'viewer' then 1
    when 'editor' then 2
    when 'manager' then 3
    when 'owner' then 4
    else 0
  end
$$;

create or replace function knowledge.role_name(p_rank integer)
returns text
language sql
immutable
as $$
  select case
    when p_rank >= 4 then 'owner'
    when p_rank = 3 then 'manager'
    when p_rank = 2 then 'editor'
    when p_rank = 1 then 'viewer'
    else null
  end
$$;

create or replace function knowledge.subject_role(
  p_type text,
  p_id uuid,
  p_subject_type text,
  p_subject_id text
) returns text
language plpgsql
stable
as $$
declare
  v_direct text;
  v_inherit boolean;
  v_next uuid;
  v_parent uuid;
  v_folder_inherit boolean;
  v_role text;
begin
  select a.role into v_direct
  from knowledge.acl a
  where a.resource_type = p_type
    and a.resource_id = p_id
    and a.subject_type = p_subject_type
    and a.subject_id = p_subject_id
  limit 1;
  if v_direct is not null then
    return v_direct;
  end if;

  if p_type = 'file' then
    select inherit_acl, folder_id into v_inherit, v_next from knowledge.files where id = p_id;
  else
    select inherit_acl, parent_id into v_inherit, v_next from knowledge.folders where id = p_id;
  end if;
  if not found or not coalesce(v_inherit, false) then
    return null;
  end if;

  while v_next is not null loop
    select a.role into v_role
    from knowledge.acl a
    where a.resource_type = 'folder'
      and a.resource_id = v_next
      and a.subject_type = p_subject_type
      and a.subject_id = p_subject_id
    limit 1;
    if v_role is not null then
      return v_role;
    end if;
    select parent_id, inherit_acl into v_parent, v_folder_inherit
    from knowledge.folders where id = v_next;
    if not found or not coalesce(v_folder_inherit, false) then
      return null;
    end if;
    v_next := v_parent;
  end loop;
  return null;
end;
$$;

create or replace function knowledge.effective_role(p_user text, p_type text, p_id uuid)
returns text
language plpgsql
stable
as $$
declare
  v_owner text;
  v_best integer := 0;
  v_role text;
  v_team text;
begin
  if p_user is null or btrim(p_user) = '' or p_id is null then
    return null;
  end if;
  if p_type = 'file' then
    select owner_user_id into v_owner from knowledge.files where id = p_id;
  elsif p_type = 'folder' then
    select owner_user_id into v_owner from knowledge.folders where id = p_id;
  else
    return null;
  end if;
  if v_owner is null then
    return null;
  end if;
  if v_owner = p_user then
    return 'owner';
  end if;
  v_best := knowledge.role_rank(knowledge.subject_role(p_type, p_id, 'user', p_user));
  for v_team in select team_id from knowledge.team_members where user_id = p_user
  loop
    v_best := greatest(v_best, knowledge.role_rank(knowledge.subject_role(p_type, p_id, 'team', v_team)));
  end loop;
  return knowledge.role_name(v_best);
end;
$$;

create or replace function knowledge.resource_in_scope(p_type text, p_id uuid, p_folders uuid[])
returns boolean
language plpgsql
stable
as $$
declare
  v_folder uuid;
  v_guard integer := 0;
begin
  if p_folders is null then
    return true;
  end if;
  if p_type = 'folder' then
    v_folder := p_id;
  else
    select folder_id into v_folder from knowledge.files where id = p_id;
  end if;
  while v_folder is not null and v_guard < 64 loop
    if v_folder = any (p_folders) then
      return true;
    end if;
    select parent_id into v_folder from knowledge.folders where id = v_folder;
    v_guard := v_guard + 1;
  end loop;
  return false;
end;
$$;
