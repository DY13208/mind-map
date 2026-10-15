const assert = require('node:assert/strict')
const { test } = require('node:test')
const { randomUUID } = require('node:crypto')
const isolation = require('../../tests/performance/isolation.cjs')
isolation.configureIsolatedEnvironment()
const { createPgStore } = require('../bin/collabV2/directStore')
const { applyDirect } = require('../bin/collabV2/directApplier')

test('Real PG UID-only restore revives tombstone fields, parent and original middle position atomically', async () => {
  await isolation.withIsolatedPg(async pool => {
    const roomKey = 'performance-history-uid-' + randomUUID()
    const client = await pool.connect()
    try {
      await client.query('begin')
      await client.query("insert into rooms(room_key,title,cos_key,nodes,version) values($1,'Synthetic restore','test/'||$1,'{}'::jsonb,0)", [roomKey])
      await client.query(`insert into room_nodes(room_key,uid,parent_uid,position,data,is_root,node_version)
        values($1,'root',null,'00000000','{"uid":"root","text":"Root"}'::jsonb,true,0),
              ($1,'left','root','00000000','{"uid":"left","text":"Left"}'::jsonb,false,0),
              ($1,'middle','root','00000001','{"uid":"middle","text":"Middle","note":"preserved"}'::jsonb,false,0),
              ($1,'right','root','00000002','{"uid":"right","text":"Right"}'::jsonb,false,0)`, [roomKey])
      const store = createPgStore(client, roomKey)
      await applyDirect(store, { type: 'node.delete', payload: { uid: 'middle' } }, { version: 1 })
      assert.equal(await store.getLive('middle'), null)
      const restored = await applyDirect(store, { type: 'node.restore', payload: { uid: 'middle' } }, { version: 2 })
      const row = await store.getLive('middle')
      assert.equal(row.parent_uid, 'root')
      assert.equal(row.position, '00000001')
      assert.equal(row.data.note, 'preserved')
      assert.equal(row.node_version, 2)
      assert.deepEqual((await store.listChildren('root')).map(row => row.uid), ['left', 'middle', 'right'])
      assert.equal(restored.event.payload.uid, 'middle')
      await client.query('commit')
      const persisted = await pool.query('select parent_uid,position,data,deleted_at,node_version from room_nodes where room_key=$1 and uid=\'middle\'', [roomKey])
      assert.equal(persisted.rows[0].deleted_at, null)
      assert.equal(persisted.rows[0].position, '00000001')
      assert.equal(persisted.rows[0].data.note, 'preserved')
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
      await pool.query('delete from rooms where room_key=$1', [roomKey])
    }
  })
})
