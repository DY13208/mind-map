set local lock_timeout = '5s';
set local statement_timeout = '30s';
-- Owners of an ancestor folder manage what others put inside it.
-- The ancestor walk is kb.resource_chain, so inherit_acl = false still cuts it
-- (same boundary as inherited ACL rows). Result is at least 'manager', never
-- 'owner': owner_id stays the single owner and transfer stays with it.
-- There are no deny rows; a lower direct grant cannot downgrade the floor.
create or replace function kb.ancestor_owner_floor(kind text, rid uuid, uid text)
returns integer
language sql stable as $$
  select case when exists (
    select 1
      from kb.resource_chain(kind, rid) c
      join kb.folders f on c.target_kind = 'folder' and f.id = c.target_id
     where c.depth > 0 and f.owner_id = uid and f.deleted_at is null
  ) then 3 else 0 end
$$;

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
  if best < 3 then best := greatest(best, kb.ancestor_owner_floor(kind, rid, uid)); end if;
  if best > 3 then best := 3; end if;
  return kb.role_name(best);
end
$$;

-- Folder upload resolves "same name under the same parent" without a full scan.
create index if not exists kb_folders_parent_name_idx on kb.folders (parent_id, name) where deleted_at is null;
