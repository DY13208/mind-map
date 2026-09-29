const { assertHistoryPgTestEnvironment } = require('./historyPgSafety')
assertHistoryPgTestEnvironment()
const assert = require('assert').strict
const { Client } = require('pg')
const { createPgHistoryStore } = require('../bin/collabHistory/pgStore')

async function main() {
  const client = new Client({ connectionTimeoutMillis: 8000 })
  try {
    await client.connect()
    await client.query('begin')
    await client.query('set local statement_timeout = 15000')
    await client.query(`create temp table room_versions (
      room_key text, id uuid primary key, revision bigint, created_at timestamptz,
      hidden boolean, type text, source_kind text
    )`)
    await client.query('create temp table room_operations (room_key text, version bigint, actor_id text)')
    await client.query('create temp table room_operations_archive (room_key text, version bigint, actor_id text)')
    const ids = [1, 2, 3].map(n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0'))
    for (let i = 0; i < ids.length; i++) {
      await client.query(`insert into room_versions values ($1,$2,$3,$4,$5,'AUTO','auto')`,
        ['test', ids[i], i * 2, new Date(Date.UTC(2026, 8, 29, 0, 0, i)), i === 1])
    }
    await client.query(`insert into room_operations values
      ('test',1,' alice '),('test',2,'bob'),('test',4,''),('other',1,'outsider')`)
    await client.query("insert into room_operations_archive values ('test',3,'alice')")
    let queries = 0
    const store = createPgHistoryStore({ query(...args) { queries++; return client.query(...args) } })
    const predecessors = await store.listVersionPredecessors('test', [
      { id: ids[0], revision: 0, created_at: new Date(Date.UTC(2026, 8, 29)) },
      { id: ids[2], revision: 4, created_at: new Date(Date.UTC(2026, 8, 29, 0, 0, 2)) }
    ])
    assert.equal(queries, 1, 'one predecessor query for the whole page')
    assert.equal(predecessors.find(row => row.id === ids[0]).previous, null)
    assert.equal(predecessors.find(row => row.id === ids[2]).previous.id, ids[1])
    assert.equal(predecessors.find(row => row.id === ids[2]).previous.hidden, true)
    const ranges = [
      { id: 'all', fromRevision: 0, toRevision: 4 },
      { id: 'archived', fromRevision: 2, toRevision: 3 },
      { id: 'empty', fromRevision: 4, toRevision: 4 }
    ]
    let actors = await store.listOperationActors('test', ranges)
    assert.equal(queries, 2, 'one actor query for all ranges')
    assert.deepEqual(actors.find(row => row.id === 'all'), { id: 'all', editors: ['alice', 'bob'], complete: true })
    assert.deepEqual(actors.find(row => row.id === 'archived'), { id: 'archived', editors: ['alice'], complete: true })
    assert.deepEqual(actors.find(row => row.id === 'empty'), { id: 'empty', editors: [], complete: true })
    await client.query("insert into room_operations_archive values ('test',2,'bob')")
    actors = await store.listOperationActors('test', [ranges[0]])
    assert.deepEqual(actors[0], { id: 'all', editors: [], complete: false }, 'duplicate revisions must not yield trusted attribution')
    await client.query("delete from room_operations_archive where room_key='test'")
    actors = await store.listOperationActors('test', [ranges[0]])
    assert.deepEqual(actors[0], { id: 'all', editors: [], complete: false }, 'missing revisions must not yield trusted attribution')
    assert.deepEqual(await store.listOperationActors('test', []), [])
    assert.deepEqual(await store.listVersionPredecessors('test', []), [])
    console.log('PASS: PostgreSQL batched attribution uses complete history, archived actors and hidden predecessors')
  } finally {
    await client.query('rollback').catch(() => {})
    await client.end()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
