-- Four-level ACL on schema kb. Does not touch any other schema.
alter table kb.files add column if not exists inherit_acl boolean not null default true;
alter table kb.folders add column if not exists inherit_acl boolean not null default true;

alter table kb.acl drop constraint if exists kb_acl_role_chk;
alter table kb.acl add constraint kb_acl_role_chk check (role in ('owner', 'manager', 'editor', 'viewer'));

create table if not exists kb.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 255),
  created_by text not null,
  created_at timestamptz not null default now()
);

create table if not exists kb.team_members (
  team_id uuid not null references kb.teams (id) on delete cascade,
  user_id text not null,
  created_at timestamptz not null default now(),
  primary key (team_id, user_id)
);
create index if not exists kb_team_members_user_idx on kb.team_members (user_id);

alter table kb.mcp_tokens add column if not exists scope_folder_ids uuid[];

create or replace function kb.role_rank(r text) returns integer
language sql immutable as $$
  select case r
    when 'owner' then 4
    when 'manager' then 3
    when 'editor' then 2
    when 'viewer' then 1
    else 0
  end
$$;

create or replace function kb.role_name(n integer) returns text
language sql immutable as $$
  select case n
    when 4 then 'owner'
    when 3 then 'manager'
    when 2 then 'editor'
    when 1 then 'viewer'
    else null
  end
$$;

-- Self first, then ancestors. inherit_acl = false keeps the resource and stops.
create or replace function kb.resource_chain(kind text, rid uuid)
returns table(depth integer, target_kind text, target_id uuid)
language plpgsql stable as $$
declare
  fid uuid;
  pid uuid;
  inh boolean;
  d integer := 0;
  guard integer := 0;
begin
  if kind = 'file' then
    select folder_id, inherit_acl into fid, inh
      from kb.files where id = rid and deleted_at is null;
    if not found then return; end if;
    depth := 0; target_kind := 'file'; target_id := rid; return next;
    if not inh then return; end if;
    d := 1;
  else
    fid := rid;
    d := 0;
  end if;
  while fid is not null and guard < 64 loop
    select parent_id, inherit_acl into pid, inh
      from kb.folders where id = fid and deleted_at is null;
    if not found then return; end if;
    depth := d; target_kind := 'folder'; target_id := fid; return next;
    if not inh then return; end if;
    fid := pid;
    d := d + 1;
    guard := guard + 1;
  end loop;
end
$$;

-- A direct grant on the resource replaces every inherited grant for that subject.
create or replace function kb.subject_role(kind text, rid uuid, ptype text, pid text)
returns text
language plpgsql stable as $$
declare
  r text;
  rec record;
begin
  select a.role into r
    from kb.resource_chain(kind, rid) c
    join kb.acl a on (
      (c.target_kind = 'file' and a.file_id = c.target_id) or
      (c.target_kind = 'folder' and a.folder_id = c.target_id)
    )
   where c.depth = 0 and a.principal_type = ptype and a.principal_id = pid
   limit 1;
  if found then return r; end if;
  for rec in
    select a.role
      from kb.resource_chain(kind, rid) c
      join kb.acl a on (
        (c.target_kind = 'file' and a.file_id = c.target_id) or
        (c.target_kind = 'folder' and a.folder_id = c.target_id)
      )
     where c.depth > 0 and a.principal_type = ptype and a.principal_id = pid
     order by c.depth asc
     limit 1
  loop
    return rec.role;
  end loop;
  return null;
end
$$;

-- Owner anchor always wins. Otherwise the max of the user and each KB team.
create or replace function kb.effective_role(kind text, rid uuid, uid text)
returns text
language plpgsql stable as $$
declare
  owner text;
  best integer := 0;
  tm record;
begin
  if kind = 'file' then
    select owner_id into owner from kb.files where id = rid and deleted_at is null;
  elsif kind = 'folder' then
    select owner_id into owner from kb.folders where id = rid and deleted_at is null;
  else
    return null;
  end if;
  if owner is null then return null; end if;
  if owner = uid then return 'owner'; end if;
  best := kb.role_rank(kb.subject_role(kind, rid, 'user', uid));
  for tm in select team_id from kb.team_members where user_id = uid loop
    best := greatest(best, kb.role_rank(kb.subject_role(kind, rid, 'team', tm.team_id::text)));
  end loop;
  return kb.role_name(best);
end
$$;

-- null scope means no extra narrowing. A set scope never widens access.
create or replace function kb.folder_in_scope(fid uuid, scope uuid[])
returns boolean
language plpgsql stable as $$
declare
  cur uuid := fid;
  parent uuid;
  guard integer := 0;
begin
  if scope is null then return true; end if;
  if fid is null or cardinality(scope) = 0 then return false; end if;
  while cur is not null and guard < 64 loop
    if cur = any(scope) then return true; end if;
    select parent_id into parent from kb.folders where id = cur and deleted_at is null;
    if not found then return false; end if;
    cur := parent;
    guard := guard + 1;
  end loop;
  return false;
end
$$;
