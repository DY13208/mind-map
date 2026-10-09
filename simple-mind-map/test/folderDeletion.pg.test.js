// Uses session-local temporary tables; never mutates application tables.
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { Pool } = require('pg')
const storage = require('../bin/storage')
const { createFileSystem, createPgFileStore } = require('../bin/fileSystem')

async function main() {
  const pool = new Pool({ ...storage.getPool().options, connectionTimeoutMillis: 3000, query_timeout: 10000 })
  let client
  try {
    client = await pool.connect()
    await client.query(`create temporary table folders (
      id uuid primary key, parent_id uuid references folders(id) on delete restrict,
      name text, created_by text, team_id text, deleted_at timestamptz,
      updated_at timestamptz default now());
      create temporary table rooms (
        room_key text primary key, folder_id uuid references folders(id) on delete restrict,
        owner_id text, team_id text, title text, nodes jsonb, version int default 7,
        updated_at timestamptz default now(), deleted_at timestamptz, deleted_by text,
        deleted_from_folder_id uuid);
      create temporary table room_tombstones (room_key text primary key);
      create temporary table folder_members (
        folder_id uuid references folders(id) on delete cascade, user_id text, role text,
        created_at timestamptz default now(), updated_at timestamptz default now());
      create temporary table wecom_users (user_id text, name text, avatar text, wecom_userid text);
      create temporary table room_members (
        room_key text, user_id text, role text not null, direct_role text, team_role text,
        folder_role text, source text, source_team_id text, source_folder_id uuid,
        updated_at timestamptz default now(), primary key(room_key, user_id));`)
    await client.query(`create unique index folder_delete_root_names on folders(lower(name))
      where parent_id is null and deleted_at is null;
      create unique index folder_delete_child_names on folders(parent_id,lower(name))
      where parent_id is not null and deleted_at is null;`)
    const adapter = { query: (...args) => client.query(...args), connect: async () => ({
      query: (...args) => client.query(...args), release() {}
    }) }
    const store = createPgFileStore(adapter)
    const fs = createFileSystem({ store })
    const seed = async () => {
      const ids = [randomUUID(), randomUUID(), randomUUID()]
      for (let i = 0; i < 3; i++) await client.query(
        'insert into folders(id, name, parent_id, created_by) values($1,$2,$3,$4)',
        [ids[i], i === 1 ? 'shared-child-name' : ['source', 'child', 'target'][i] + ids[i], i === 1 ? ids[0] : null, 'owner'])
      const keys = [randomUUID(), randomUUID()]
      for (let i = 0; i < 2; i++) {
        await client.query(`insert into rooms(room_key, folder_id, owner_id, nodes)
          values($1,$2,'owner','{"root":{"text":"preserved"}}')`, [keys[i], ids[i]])
        await client.query(`insert into room_members(room_key,user_id,role,direct_role,source)
          values($1,'owner','owner','owner','direct_share')`, [keys[i]])
      }
      return { source: ids[0], child: ids[1], target: ids[2], keys }
    }
    let f = await seed()
    const adminFolders = await fs.listFolders({ userId: 'super-admin', bypass: true })
    assert.ok(adminFolders.list.every(folder => folder.canManage), 'super-admin must see folder delete/rename actions')
    const ownerFolders = await fs.listFolders({ userId: 'owner' })
    assert.ok(ownerFolders.list.every(folder => folder.canManage), 'owners retain folder management')
    const otherFolders = await fs.listFolders({ userId: 'unrelated-user' })
    assert.equal(otherFolders.list.length, 0, 'ordinary unrelated users cannot list private folders')
    let preview = await fs.previewFolderDeletion(f.source, { userId: 'owner' })
    assert.equal(preview.roomCount, 2)
    await fs.deleteFolderContents(f.source, { userId: 'owner', action: 'move', revision: preview.revision, targetFolderId: f.target })
    assert.equal((await client.query('select parent_id from folders where id=$1', [f.child])).rows[0].parent_id, f.target)
    assert.equal((await client.query('select folder_id from rooms where room_key=$1', [f.keys[0]])).rows[0].folder_id, f.target)
    assert.equal((await client.query('select folder_id from rooms where room_key=$1', [f.keys[1]])).rows[0].folder_id, f.child)
    f = await seed()
    // Deleting a subtree must not temporarily reparent its children to root,
    // where a same-name folder can legitimately exist.
    await client.query(`insert into folders(id,name,created_by) values($1,'shared-child-name','owner')`, [randomUUID()])
    preview = await fs.previewFolderDeletion(f.source, { userId: 'owner' })
    const finish = store.finishFolderDeletion
    store.finishFolderDeletion = async (...args) => { await finish(...args); throw new Error('rollback check') }
    await assert.rejects(fs.deleteFolderContents(f.source, { userId: 'owner', action: 'trash', revision: preview.revision }), /rollback check/)
    assert.equal((await client.query('select deleted_at from rooms where room_key=$1', [f.keys[0]])).rows[0].deleted_at, null)
    assert.equal((await client.query('select id from folders where id=$1', [f.source])).rows.length, 1)
    store.finishFolderDeletion = finish
    await fs.deleteFolderContents(f.source, { userId: 'owner', action: 'trash', revision: preview.revision })
    assert.equal((await client.query('select id from folders where id=any($1::uuid[])', [[f.source, f.child]])).rows.length, 0)
    const rooms = (await client.query('select * from rooms where room_key=any($1::text[])', [f.keys])).rows
    assert.ok(rooms.every(r => r.deleted_at && !r.folder_id && r.version === 7))
    assert.ok(rooms.every(r => r.nodes.root.text === 'preserved'))
    console.log('PostgreSQL temporary-table folder move, recursive trash, FK and rollback checks passed')
  } finally {
    // Destroy this connection so temporary tables cannot reach another caller.
    if (client) client.release(true)
    await pool.end()
    await storage.getPool().end()
  }
}
main().catch(error => { console.error(error.code || error.message); process.exitCode = 1 })
