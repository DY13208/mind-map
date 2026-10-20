// Runs only in a disposable, network-isolated local PostgreSQL container.
process.env.MIND_MAP_SKIP_ROOT_ENV = '1'
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const acl = require('../bin/roomAcl')
const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
const container = 'codex-acl-startup-' + process.pid
function sql(text) {
  return execFileSync('docker', ['exec', '-i', container, 'psql', '-X', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'], { input: text, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}
const snapshot = () => JSON.parse(sql(`select coalesce(json_agg(m order by user_id),'[]') from room_members m`))
async function capture(fn) {
  const statements = []
  await fn({ query: async text => { statements.push(text); return { rows: [] } } })
  return statements.join(';\n') + ';'
}
async function main() {
  const endpoint = docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'])
  assert.match(endpoint, /^(npipe:|unix:)/, 'Refusing a remote Docker engine')
  docker(['run', '-d', '--rm', '--network', 'none', '--name', container, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:16-alpine'])
  try {
    for (let i = 0; ; i++) {
      try { docker(['exec', container, 'pg_isready', '-U', 'postgres']); break } catch (e) {
        if (i >= 30) throw e
        await new Promise(resolve => setTimeout(resolve, 300))
      }
    }
    sql(`create table rooms(room_key text primary key,folder_id text,deleted_at timestamptz);
      create table folder_members(folder_id text,user_id text,role text);
      create table room_members(room_key text not null references rooms, user_id text not null,role text not null,
        direct_role text,team_role text,folder_role text,override_role text,acl_v2 boolean not null default false,
        direct_role_archive text,source text default 'direct_share',source_team_id text,source_folder_id text,
        created_at timestamptz default now(),updated_at timestamptz default '2000-01-01',primary key(room_key,user_id));
      insert into rooms values('room','folder',null);
      insert into folder_members values
        ('folder','manager','editor'),('folder','viewer','editor'),('folder','editor','viewer'),
        ('folder','inherit','viewer'),('folder','legacy','editor'),('folder','owner','editor');
      insert into room_members(room_key,user_id,role,direct_role,folder_role,override_role,acl_v2,source) values
        ('room','manager','editor',null,'editor','manager',true,'folder'),
        ('room','viewer','editor',null,'editor','viewer',true,'folder'),
        ('room','editor','viewer',null,'viewer','editor',true,'folder'),
        ('room','inherit','editor',null,'viewer',null,true,'folder'),
        ('room','legacy','editor','editor',null,null,false,'direct_share'),
        ('room','owner','owner','owner','editor',null,false,'direct_share'),
        ('room','no-folder','manager',null,null,'viewer',true,'direct_share'),
        ('room','no-team','manager',null,null,'viewer',true,'team');`)
    const initial = snapshot()
    const startup = await capture(acl.initSchema)
    sql(startup)
    const first = snapshot()
    const byId = id => first.find(row => row.user_id === id)
    for (const [id, role] of [['manager','manager'],['viewer','viewer'],['editor','editor'],['inherit','viewer'],['legacy','editor'],['owner','owner']]) {
      assert.equal(byId(id).role, role, id + ' survives startup with correct summary')
      assert.equal(byId(id).role, acl.resolveMemberRole(byId(id)), id + ' agrees with authorization')
    }
    for (const row of initial) {
      assert.equal(byId(row.user_id).override_role, row.override_role, 'startup never changes overrides')
      assert.equal(byId(row.user_id).acl_v2, row.acl_v2, 'startup never changes ACL model')
    }
    assert.equal(byId('manager').source, 'override')
    assert.equal(byId('viewer').source, 'override')
    assert.equal(byId('inherit').source, 'inherit')
    assert.equal(byId('no-folder').direct_role, null, 'legacy backfill cannot manufacture a V2 direct grant')
    assert.equal(byId('no-team').team_role, null, 'legacy backfill cannot manufacture a V2 team grant')
    sql('select pg_sleep(0.02);' + startup)
    assert.deepEqual(snapshot(), first, 'repeated startup must not rewrite unchanged rows or timestamps')
    sql(`update folder_members set role='editor' where user_id='inherit'; update folder_members set role='viewer' where user_id='manager';` + startup)
    const changed = snapshot()
    assert.equal(changed.find(row => row.user_id === 'manager').role, 'manager', 'folder changes cannot downgrade explicit manager')
    assert.equal(changed.find(row => row.user_id === 'inherit').role, 'editor', 'inherit still follows folder changes')
    const staleRows = initial.filter(row => ['manager','viewer'].includes(row.user_id))
    const listed = await acl.listMembers({ query: async () => ({ rows: staleRows }) }, 'room')
    assert.deepEqual(listed.map(row => row.role).sort(), ['manager','viewer'], 'list reads through previously corrupted summaries')
    assert.equal(staleRows[0].role, initial.find(row => row.user_id === staleRows[0].user_id).role, 'list does not mutate stored grants')
    console.log('PASS: real PostgreSQL startup, repeat startup, folder changes, owner/legacy roles, V2 grant preservation, stale-summary reads')
  } finally {
    docker(['rm', '-f', container])
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
