// One transactional, restart-safe conversion. Never run the old container ACL
// backfills after this: removed file members must stay removed.
async function migrateIndependentFileAcl(db) {
  const { sqlResolveMemberRole } = require('./roomAcl')
  const scopedEffective = sqlResolveMemberRole(
    'm.direct_role', 'm.team_role', 'm.folder_role', 'm.role', 'm.override_role', 'm.acl_v2'
  )
  // Very old rows only have a summary role. Match resolveMemberRole's
  // fallback, without resurrecting an empty V2 override as a grant.
  const effective = `case when not coalesce(m.acl_v2, false)
    and coalesce(m.direct_role, m.team_role, m.folder_role, '') = ''
    then m.role else ${scopedEffective} end`
  await db.query(`
    create table if not exists room_acl_migrations (
      name text primary key,
      completed_at timestamptz not null default now()
    )
  `)
  // DO is one transaction even when db is a pool. An xact-scoped lock also
  // serializes startup across replicas without relying on connection affinity.
  await db.query(`
    do $independent_acl$
    begin
      perform pg_advisory_xact_lock(hashtext('room-acl-independent-v1'));
      if exists (select 1 from room_acl_migrations where name = 'independent-v1') then
        return;
      end if;
      lock table room_members in share row exclusive mode;
      create table if not exists room_members_independent_backup (
        room_key text not null,
        user_id text not null,
        member_data jsonb not null,
        backed_up_at timestamptz not null default now(),
        primary key (room_key, user_id)
      );
      insert into room_members_independent_backup(room_key, user_id, member_data)
        select m.room_key, m.user_id, to_jsonb(m) from room_members m
        on conflict (room_key, user_id) do nothing;

      -- Snapshot the effective role, including viewer overrides under inherited
      -- editor grants. Clearing container sources afterwards must not promote it.
      update room_members m set
        role = ${effective},
        direct_role = ${effective},
        direct_role_archive = coalesce(m.direct_role_archive, m.direct_role),
        folder_role = null,
        team_role = null,
        override_role = null,
        acl_v2 = false,
        source = 'direct_share',
        source_folder_id = null,
        source_team_id = null,
        updated_at = now()
      where ${effective} in ('owner', 'manager', 'editor', 'viewer');

      -- Unusable legacy rows are backed up above, never converted into grants.
      delete from room_members m where ${effective} is null;

      -- Recover the known creator when old data omitted the owner ACL. Do not
      -- regrant access to historical writers on every application restart.
      insert into room_members(room_key, user_id, role, direct_role, source)
        select r.room_key, r.owner_id, 'owner', 'owner', 'direct_share'
        from rooms r
        where nullif(btrim(r.owner_id), '') is not null
          and r.owner_id not in ('anonymous', 'mcp-service')
          and not exists (
            select 1 from room_members m where m.room_key = r.room_key and m.role = 'owner'
          )
        on conflict (room_key, user_id) do update set
          role = 'owner', direct_role = 'owner', override_role = null,
          acl_v2 = false, source = 'direct_share', updated_at = now();

      -- Keep malformed ownerless files closed until an administrator repairs
      -- ownership. Their previous grants remain recoverable in the backup.
      delete from room_members m where not exists (
        select 1 from room_members owner
        where owner.room_key = m.room_key and owner.role = 'owner'
      );

      insert into room_acl_migrations(name) values ('independent-v1');
    end
    $independent_acl$
  `)
}

module.exports = { migrateIndependentFileAcl }
