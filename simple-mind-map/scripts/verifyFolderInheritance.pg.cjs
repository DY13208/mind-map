// Disposable local PostgreSQL only; never reads application DB configuration.
process.env.MIND_MAP_SKIP_ROOT_ENV = '1'
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { Pool } = require('pg')
const acl = require('../bin/roomAcl')
const { createFileSystem, createPgFileStore, initFileSystemSchema, handleFileSystemApi } = require('../bin/fileSystem')
const { withInheritanceTransaction } = require('../bin/fileSystem/folderInheritance')

const container = 'mindmap-folder-inherit-' + Date.now()
const docker = args => execFileSync('docker', args, { encoding: 'utf8', windowsHide: true }).trim()

async function main() {
  assert.match(docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']), /^(npipe:|unix:)/)
  let pool
  docker(['run', '-d', '--rm', '--name', container, '-p', '127.0.0.1::5432', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:16-alpine'])
  try {
    for (let i = 0; ; i++) {
      try { docker(['exec', container, 'pg_isready', '-U', 'postgres']); break } catch (err) {
        if (i === 30) throw err
        await new Promise(resolve => setTimeout(resolve, 300))
      }
    }
    const port = Number(docker(['port', container, '5432/tcp']).split(':').pop())
    pool = new Pool({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres' })
    for (let i = 0; ; i++) {
      try { await pool.query('select 1'); break } catch (err) {
        if (i === 30) throw err
        await new Promise(resolve => setTimeout(resolve, 300))
      }
    }
    await pool.query(`create table rooms(room_key text primary key, title text, nodes jsonb,
      team_id text, version int default 0, created_at timestamptz default now(), updated_at timestamptz default now());
      create table room_tombstones(room_key text primary key);
      create table wecom_users(user_id text primary key, corp_id text, wecom_userid text, name text,
        avatar text, departments jsonb default '[]');`)
    await initFileSystemSchema(pool)
    await acl.initSchema(pool)
    const store = createPgFileStore(pool)
    const fs = createFileSystem({ store })
    const [root, child, empty, target] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()]
    for (const [id, parent] of [[root, null], [child, root], [empty, child], [target, null]]) {
      await pool.query('insert into folders(id,parent_id,name,created_by) values($1::uuid,$2,$1::text,\'owner\')', [id, parent])
    }
    for (const [key, folder] of [['existing', root], ['nested', child], ['unrelated', target]]) {
      await pool.query("insert into rooms(room_key,folder_id,owner_id) values($1,$2,'owner')", [key, folder])
      await store.insertMember({ room_key: key, user_id: 'owner', role: 'owner' })
    }
    const api = async (method, folder, body, user = '') => {
      const res = { writeHead(code) { this.code = code }, end(data) { this.body = JSON.parse(String(data)) } }
      await handleFileSystemApi({ method, url: `/api/folders/${folder}/members${user ? '/' + user : ''}`, authUser: { id: 'owner', corpId: 'test' } }, res, { engine: fs, body })
      assert.equal(res.code, 200, JSON.stringify(res.body))
    }
    const member = async (key, user) => (await pool.query('select * from room_members where room_key=$1 and user_id=$2', [key, user])).rows[0]
    await api('POST', root, { userId: 'reader', role: 'viewer' })
    assert.equal((await member('existing', 'reader')).role, 'viewer')
    assert.equal((await member('nested', 'reader')).role, 'viewer')
    assert.equal(await member('unrelated', 'reader'), undefined)
    assert.ok((await fs.listFolders({ userId: 'reader' })).list.some(f => f.id === empty), 'empty descendants are navigable')
    await api('PATCH', root, { role: 'editor' }, 'reader')
    assert.equal((await member('nested', 'reader')).role, 'editor')
    await api('POST', child, { userId: 'reader', role: 'viewer' })
    await api('DELETE', root, {}, 'reader')
    assert.equal(await member('existing', 'reader'), undefined)
    assert.equal((await member('nested', 'reader')).role, 'viewer', 'remaining child grant survives')
    await store.insertMember({ room_key: 'nested', user_id: 'reader', role: 'editor' })
    await api('DELETE', child, {}, 'reader')
    assert.equal((await member('nested', 'reader')).role, 'editor', 'direct grant survives revocation')
    assert.equal((await member('nested', 'reader')).folder_role, null)
    await pool.query("insert into wecom_users(user_id,corp_id,wecom_userid) values('bulk-user','test','bulk-user')")
    await api('POST', root, { userIds: ['bulk-user'], role: 'viewer' }, 'bulk')
    assert.equal((await member('existing', 'bulk-user')).role, 'viewer', 'bulk grant reaches existing files')
    assert.equal((await member('nested', 'bulk-user')).role, 'viewer', 'bulk grant reaches descendants')
    await api('DELETE', root, {}, 'bulk-user')
    assert.equal(await member('nested', 'bulk-user'), undefined)

    await api('POST', root, { userId: 'manager', role: 'manager' })
    assert.equal((await member('nested', 'manager')).role, 'editor', 'folder manager cannot become file owner/manager')
    await acl.setMember(pool, 'nested', 'manager', 'viewer', 'owner')
    await api('PATCH', root, { role: 'editor' }, 'manager')
    assert.equal((await member('nested', 'manager')).role, 'viewer', 'file override remains authoritative')
    await acl.removeMember(pool, 'nested', 'manager', '', 'owner')
    assert.equal((await member('nested', 'manager')).role, 'editor', 'removing override follows inheritance')
    await assert.rejects(acl.removeMember(pool, 'nested', 'manager', '', 'owner'), { code: 'INHERITED_PERMISSION' })

    await withInheritanceTransaction(store, async (db, refresh) => {
      await db.query('update rooms set folder_id=$1 where room_key=\'nested\'', [target])
      await refresh({ roomKey: 'nested' })
    })
    assert.equal(await member('nested', 'manager'), undefined, 'moving out removes inherited grants')
    assert.equal((await member('nested', 'reader')).role, 'editor')

    // Startup reconciliation covers grants created before this feature, and
    // a repeated startup must not rewrite timestamps or promote old direct roles.
    await store.setFolderMember(root, 'old-share', 'viewer')
    await withInheritanceTransaction(store, async (db, refresh) => refresh({}))
    assert.equal((await member('existing', 'old-share')).role, 'viewer')
    const before = await member('existing', 'old-share')
    await acl.initSchema(pool)
    await withInheritanceTransaction(store, async (db, refresh) => refresh({}))
    assert.deepEqual(await member('existing', 'old-share'), before)
    await assert.rejects(withInheritanceTransaction(store, async (db, refresh) => {
      await store.removeFolderMember(root, 'old-share', db)
      await refresh({ folderId: root })
      throw new Error('rollback')
    }), /rollback/)
    assert.equal((await member('existing', 'old-share')).role, 'viewer', 'grant and materialized ACL roll back together')

    // A personal file moving into a team root must lose its old folder grants;
    // moving a whole folder preserves its own grants but loses former ancestors.
    const teamSpace = require('../bin/teamSpace')
    await pool.query(`create table teams(id text primary key, corp_id text, name text, owner_id text,
      deleted_at timestamptz, updated_at timestamptz default now());
      create table team_members(team_id text, corp_id text, user_id text, role text);
      insert into teams(id,corp_id,name,owner_id) values('team','test','Test','owner');
      insert into team_members values('team','test','owner','owner');`)
    const who = { userId: 'owner', corpId: 'test' }
    await teamSpace.assignRoom(pool, who, 'team', 'existing')
    assert.equal(await member('existing', 'old-share'), undefined)
    await pool.query("update rooms set folder_id=$1 where room_key='nested'", [empty])
    await store.setFolderMember(root, 'ancestor-only', 'viewer')
    await store.setFolderMember(child, 'kept-child', 'editor')
    await withInheritanceTransaction(store, async (db, refresh) => refresh({}))
    await teamSpace.assignFolder(pool, who, 'team', child)
    assert.equal(await member('nested', 'ancestor-only'), undefined)
    assert.equal((await member('nested', 'kept-child')).role, 'editor')
    assert.equal((await member('nested', 'reader')).role, 'editor')

    console.log('PASS: PostgreSQL grant/update/revoke/bulk, descendants, navigation, direct shares, overrides, moves/team assignment, startup, rollback')
  } finally {
    if (pool) await pool.end()
    docker(['rm', '-f', container])
  }
}
main().catch(err => { console.error(err); process.exitCode = 1 })
