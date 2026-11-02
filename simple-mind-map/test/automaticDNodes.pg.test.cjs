// Explicit isolated QA config only; never loads project .env or business data.
process.env.MIND_MAP_SKIP_ROOT_ENV = '1'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { randomUUID } = require('node:crypto')
const { spawn } = require('node:child_process')
const { Pool } = require('pg')
const { listAutomaticDNodes, encodeCursor } = require('../bin/automaticDNodes')
const { issueMcpUserToken } = require('../bin/mcpUserToken')

assert(process.env.AUTOMATIC_D_TEST_CONFIG, 'Provide AUTOMATIC_D_TEST_CONFIG for a disposable local QA database')
const config = JSON.parse(fs.readFileSync(process.env.AUTOMATIC_D_TEST_CONFIG, 'utf8'))
assert.equal(config.pg.host, '127.0.0.1')
assert.match(config.pg.database, /^mind_map_(?:touch_qa|automatic_d_test)_\d+$/)
assert.equal(new URL(config.api).hostname, '127.0.0.1', 'Use a loopback QA API')
const pool = new Pool(config.pg)
const prefix = 'auto-discovery-' + randomUUID(), reader = { id: prefix + '-reader', bypass: false }
let child
const room = name => prefix + '-' + name

async function seedRoom(name, nodes, owner = 'owner', options = {}) {
  const key = room(name)
  await pool.query(`insert into rooms(room_key,title,cos_key,version,nodes,deleted_at)
    values($1,$2,'isolated-test',7,$3,$4)`, [key, name, options.legacy || null, options.trash ? new Date() : null])
  if (owner) await pool.query(`insert into room_members(room_key,user_id,role,direct_role) values($1,$2,'owner','owner')`, [key, owner])
  if (options.legacy) return
  for (const [uid, text, deleted, note] of [['root', '项目根节点'], ...nodes]) {
    await pool.query(`insert into room_nodes(room_key,uid,parent_uid,position,data,is_root,node_version,deleted_at)
      values($1,$2,$3,'00000000',$4,$5,7,$6)`, [key, uid, uid === 'root' ? null : 'root', { uid, text, ...(note ? { note } : {}) }, uid === 'root', deleted ? new Date() : null])
  }
}

async function collect(actor, limit = 2) {
  const items = [], cursors = new Set()
  let cursor, page
  do {
    page = await listAutomaticDNodes(pool, actor, { limit, cursor })
    assert(page.items.length <= limit)
    items.push(...page.items)
    if (page.has_more) { assert(page.next_cursor); assert(!cursors.has(page.next_cursor)); cursors.add(page.next_cursor) }
    cursor = page.next_cursor
  } while (page.has_more)
  assert.equal(page.next_cursor, null)
  assert.equal(new Set(items.map(x => JSON.stringify([x.room_key, x.uid]))).size, items.length)
  return { items, page }
}

async function rpc(url, token, method, params, session = {}) {
  session.counter = (session.counter || 0) + 1
  const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}`, ...(session.id ? { 'mcp-session-id': session.id } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: session.counter, method, params }) })
  session.id = res.headers.get('mcp-session-id') || session.id
  const text = await res.text()
  assert.equal(res.status, 200, text)
  const payload = text.startsWith('data:') || text.includes('\ndata:') ? JSON.parse(text.split('\n').find(x => x.startsWith('data:')).slice(5)) : JSON.parse(text)
  assert(payload.result, text)
  return payload.result
}

async function main() {
  const positive = [
    ['a', 'D：自动日报'], ['b', 'd: 自动检查'], ['c', '<p>D：自<strong>动</strong>同步</p>'],
    ['d', '• 【 D：自动补全 】'], ['e', 'D：非自动整理'], ['f', '\u00a0D：\u3000自动空白'],
    ['g', '<p>&nbsp;D&nbsp;:&nbsp;自动&amp;邮件</p>']
  ]
  await seedRoom('visible', [...positive, ['step', 'D1：自动步骤'], ['step2', 'D2: 自动步骤'], ['ordinary', '自动任务'],
    ['a-role', 'A：自动任务'], ['note-only', 'D：普通目标', false, '自动'], ['deleted', 'D：自动已删除', true]], reader.id)
  await seedRoom('private', [['secret', 'D：自动私密']], prefix + '-other')
  await seedRoom('trash', [['t', 'D：自动回收站']], reader.id, { trash: true })
  await seedRoom('tomb', [['t', 'D：自动永久删除']], reader.id)
  await pool.query('insert into room_tombstones(room_key) values($1)', [room('tomb')])
  await seedRoom('legacy', [], reader.id, { legacy: { lroot: { isRoot: true, data: { uid: 'lroot', text: '历史根' }, children: ['l1'] }, l1: { data: { uid: 'l1', text: 'D：自动旧格式' }, children: [] } } })
  await seedRoom('inherited', [['i', 'D：自动继承授权']])
  await pool.query(`insert into room_members(room_key,user_id,role,team_role,acl_v2) values($1,$2,'viewer','viewer',true)`, [room('inherited'), reader.id])
  await seedRoom('stale-acl', [['s', 'D：自动残留角色']])
  await pool.query(`insert into room_members(room_key,user_id,role,acl_v2) values($1,$2,'viewer',true)`, [room('stale-acl'), reader.id])
  // Same UID in another map must remain a distinct candidate.
  await seedRoom('second', [['a', 'D：自动另一个项目']], reader.id)
  const expected = [...positive.map(x => `${room('visible')}/${x[0]}`), `${room('legacy')}/l1`, `${room('inherited')}/i`, `${room('second')}/a`].sort()
  const all = await collect(reader)
  assert.deepEqual(all.items.filter(x => x.room_key.startsWith(prefix)).map(x => `${x.room_key}/${x.uid}`).sort(), expected)
  assert.equal(all.page.complete, true)
  for (const item of all.items) { assert.equal(String(item.room_version), '7'); assert(!('data' in item)); assert(!('note' in item)); assert(item.text.length <= 1024) }
  console.log('PASS matching, rich text, legacy JSON, ACL, deletion, same UID across rooms, complete pagination')

  const first = await listAutomaticDNodes(pool, reader, { limit: 1 })
  await assert.rejects(listAutomaticDNodes(pool, reader, { cursor: first.next_cursor + 'x' }), { code: 'INVALID_CURSOR' })
  await assert.rejects(listAutomaticDNodes(pool, { id: 'another', bypass: false }, { cursor: first.next_cursor }), { code: 'INVALID_CURSOR' })
  const expired = JSON.parse(Buffer.from(first.next_cursor.split('.')[0], 'base64url').toString())
  await assert.rejects(listAutomaticDNodes(pool, reader, { cursor: encodeCursor({ ...expired, expires: 1 }) }), { code: 'INVALID_CURSOR' })
  for (const limit of [-1, 0, 201, 1.5, 'invalid']) await assert.rejects(listAutomaticDNodes(pool, reader, { limit }), { code: 'INVALID_LIMIT' })
  await assert.rejects(listAutomaticDNodes(pool, { id: '', bypass: false }), { statusCode: 401 })
  const service = await collect({ id: 'mcp-service', bypass: true }, 200)
  assert(service.items.some(x => x.room_key === room('private')))
  console.log('PASS invalid/tampered/cross-user cursors, bounds, anonymous denial and service scope')

  // Losing access between pages must take effect immediately, despite a valid cursor.
  await pool.query('delete from room_members where room_key=$1 and user_id=$2', [room('second'), reader.id])
  await pool.query(`insert into room_members(room_key,user_id,role,direct_role) values($1,'replacement-owner','owner','owner')`, [room('second')])
  const resumed = await listAutomaticDNodes(pool, reader, { limit: 200, cursor: first.next_cursor })
  assert(!resumed.items.some(x => x.room_key === room('second')))
  console.log('PASS permission revocation between pages')

  // A stale JSON snapshot must not resurrect table-deleted nodes.
  await seedRoom('deleted-table', [['gone', 'D：自动曾存在', true]], reader.id)
  await pool.query('update room_nodes set deleted_at=now() where room_key=$1', [room('deleted-table')])
  await pool.query('update rooms set nodes=$2 where room_key=$1', [room('deleted-table'), { gone: { data: { uid: 'gone', text: 'D：自动陈旧快照' } } }])
  assert(!(await collect(reader)).items.some(x => x.room_key === room('deleted-table')))
  await pool.query(`insert into rooms(room_key,title,cos_key,nodes) values($1,'COS-only','isolated-test',null)`, [room('unindexed')])
  const incomplete = await collect(reader)
  assert.equal(incomplete.page.complete, false)
  assert(incomplete.page.coverage.unindexed_room_count > 0)
  assert(incomplete.page.coverage.unindexed_room_keys_sample.includes(room('unindexed')))
  assert(incomplete.page.incomplete_reason)
  await pool.query('delete from rooms where room_key=$1', [room('unindexed')])
  console.log('PASS no resurrection and explicit incomplete coverage for COS-only maps')

  // Real HTTP API + MCP initialize/tools/list/tools/call, with user-bound credentials.
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
  const token = config.mcpToken, bound = issueMcpUserToken(reader.id, token)
  const denied = await fetch(config.api + '/api/automation/d-nodes')
  assert.equal(denied.status, 401)
  const apiPage = await fetch(config.api + '/api/automation/d-nodes?limit=1', { headers: { Authorization: `Bearer ${bound}` } })
  assert.equal(apiPage.status, 200)
  assert.equal((await apiPage.json()).items.length, 1)
  child = spawn(process.execPath, ['bin/mcpServer.mjs', '--http'], { cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, MIND_MAP_SKIP_ROOT_ENV: '1', MIND_MAP_API: config.api, MCP_HOST: '127.0.0.1', MCP_PORT: String(port), MCP_TOKEN: token }, stdio: ['ignore', 'ignore', 'pipe'] })
  let log = ''; child.stderr.on('data', x => { log += x })
  for (let i = 0; i < 100; i++) {
    try { await fetch(`http://127.0.0.1:${port}/health`); break } catch (_) { await new Promise(resolve => setTimeout(resolve, 100)) }
  }
  assert.equal(child.exitCode, null, log)
  const url = `http://127.0.0.1:${port}/mcp`, session = {}
  const initialized = await rpc(url, bound, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'automatic-d-regression', version: '1' } }, session)
  assert.match(initialized.instructions, /list_automatic_d_nodes/)
  const tools = await rpc(url, bound, 'tools/list', {}, session)
  assert(tools.tools.some(x => x.name === 'list_automatic_d_nodes'))
  assert.equal(tools.tools.find(x => x.name === 'list_automatic_d_nodes').annotations.readOnlyHint, true)
  const listed = await rpc(url, bound, 'tools/call', { name: 'list_automatic_d_nodes', arguments: { limit: 1 } }, session)
  assert(!listed.isError, JSON.stringify(listed))
  const page = JSON.parse(listed.content[0].text)
  assert.equal(page.items.length, 1)
  assert(page.has_more && page.next_cursor)
  const target = page.items[0]
  const read = await rpc(url, bound, 'tools/call', { name: 'query_nodes', arguments: { room_key: target.room_key, selector: { type: 'uid', value: target.uid }, scope: 'subtree', page_size: 50 } }, session)
  assert(!read.isError, JSON.stringify(read))
  assert(JSON.parse(read.content[0].text).items.some(x => x.uid === target.uid))
  const continued = await rpc(url, bound, 'tools/call', { name: 'list_automatic_d_nodes', arguments: { limit: 200, cursor: page.next_cursor } }, session)
  const next = JSON.parse(continued.content[0].text)
  assert(!next.items.some(x => x.room_key === room('private')))
  assert(!next.items.some(x => x.room_key === page.items[0].room_key && x.uid === page.items[0].uid))
  const badCursor = await rpc(url, bound, 'tools/call', { name: 'list_automatic_d_nodes', arguments: { cursor: 'tampered-cursor' } }, session)
  assert.equal(badCursor.isError, true)
  assert.equal(badCursor.structuredContent.code, 'INVALID_CURSOR')
  assert.equal(badCursor.structuredContent.restart_from_first_page, true)
  console.log('PASS real HTTP and MCP discovery, user credentials, continuation and permission isolation')

  await seedRoom('large', [], reader.id)
  await pool.query(`insert into room_nodes(room_key,uid,parent_uid,data,node_version)
    select $1,'bulk-'||lpad(i::text,6,'0'),'root',jsonb_build_object('text',case when i%400=0 then 'D：自动批量候选' else '普通节点'||i end),7
    from generate_series(1,50000) i`, [room('large')])
  await pool.query('analyze room_nodes')
  let query
  const measuredPool = { connect: async () => {
    const client = await pool.connect()
    return { query(sql, params) { if (sql.startsWith('with visible_rooms')) query = { sql, params }; return client.query(sql, params) }, release() { client.release() } }
  } }
  const measured = await listAutomaticDNodes(measuredPool, reader, { limit: 50 })
  assert.equal(measured.items.length, 50)
  const explained = await pool.query('explain (analyze, buffers, format json) ' + query.sql, query.params)
  assert.match(JSON.stringify(explained.rows), /room_nodes_automatic_d_idx/)
  console.log('PASS 50,000-node query uses partial index; SQL execution ms:', explained.rows[0]['QUERY PLAN'][0]['Execution Time'])
}

main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  if (child) child.kill('SIGTERM')
  // This database is disposable; delete only this run's fixtures.
  await pool.query('delete from room_members where room_key like $1', [prefix + '%']).catch(() => {})
  await pool.query('delete from room_tombstones where room_key like $1', [prefix + '%']).catch(() => {})
  await pool.query('delete from rooms where room_key like $1', [prefix + '%']).catch(() => {})
  await pool.end()
})
