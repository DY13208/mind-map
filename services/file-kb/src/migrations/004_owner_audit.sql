-- owner_id is the only owner. ACL cannot store a second owner.
-- kb.audit is append-only at the database. kb_app can still drop this trigger;
-- that residual is recorded in the phase-4 report.

update kb.acl set role = 'manager' where role = 'owner';

alter table kb.acl drop constraint if exists kb_acl_role_chk;
alter table kb.acl add constraint kb_acl_role_chk check (role in ('manager', 'editor', 'viewer'));

alter table kb.mcp_tokens drop constraint if exists kb_mcp_tokens_scopes_chk;
alter table kb.mcp_tokens add constraint kb_mcp_tokens_scopes_chk
  check (scopes <@ array['kb:read', 'kb:write', 'kb:admin']::text[] and cardinality(scopes) > 0);

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
  if best > 3 then best := 3; end if;
  return kb.role_name(best);
end
$$;

create or replace function kb.reject_audit_mutation()
returns trigger
language plpgsql as $$
begin
  raise exception 'kb.audit is append-only' using errcode = '55000';
end
$$;

drop trigger if exists kb_audit_append_only on kb.audit;
create trigger kb_audit_append_only
  before update or delete on kb.audit
  for each row execute function kb.reject_audit_mutation();

drop trigger if exists kb_audit_no_truncate on kb.audit;
create trigger kb_audit_no_truncate
  before truncate on kb.audit
  for each statement execute function kb.reject_audit_mutation();
