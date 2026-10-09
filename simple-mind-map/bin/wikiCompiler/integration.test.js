const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { randomUUID } = require('node:crypto')
const { WikiCompiler } = require('./index')
const { readableRooms } = require('./access')
const { roomBundles, loadRoomWiki } = require('../../../integrations/wiki-graph/server.cjs')

test('PostgreSQL: independent sync, contracts, attachment changes, deletes, recovery and live ACL',
  { skip: !process.env.WIKI_COMPILER_TEST_ENV_FILE }, async t => {
    const env = {}
    const text = await fs.readFile(process.env.WIKI_COMPILER_TEST_ENV_FILE, 'utf8')
    for (const line of text.split(/\r?\n/)) { const m = /^([A-Z_]+)=(.*)$/.exec(line.trim()); if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2') }
    const { Pool } = require('pg')
    const database = new Pool({ host: '127.0.0.1', port: Number(process.env.WIKI_COMPILER_TEST_PGPORT || 15432),
      user: env.PGUSER || 'postgres', password: env.PGPASSWORD, database: env.PGDATABASE || 'mind_map' })
    const schema = 'wiki_compiler_test_' + randomUUID().replace(/-/g, '')
    await database.query('create schema ' + schema)
    const pool = new Pool({ host: '127.0.0.1', port: Number(process.env.WIKI_COMPILER_TEST_PGPORT || 15432),
      user: env.PGUSER || 'postgres', password: env.PGPASSWORD, database: env.PGDATABASE || 'mind_map',
      options: '-c search_path=' + schema, max: 8 })
    let activeService
    t.after(async () => { await activeService?.stop(); await pool.end(); await database.query('drop schema ' + schema + ' cascade'); await database.end() })
    await pool.query(`create table rooms(room_key text primary key,title text,owner_id text,version bigint default 0,
      nodes jsonb default '{}',updated_at timestamptz default now(),deleted_at timestamptz);
      create table room_tombstones(room_key text primary key);
      create table room_nodes(room_key text,uid text,parent_uid text,position text,is_root boolean,data jsonb,deleted_at timestamptz);
      create table node_attachments(id text primary key,room_key text,node_uid text,file_name text,status text,
        extracted_text text,content_hash text,source_kind text);
      create table room_operations(room_key text,version bigint,operation_type text,payload jsonb,event jsonb,inverse_payload jsonb);
      create table room_members(room_key text,user_id text,role text);
      create table wecom_users(user_id text,wecom_userid text);`)
    const output = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-pg-'))
    t.after(() => fs.rm(output, { recursive: true, force: true }))
    const contracts = path.join(output, 'contracts'); await fs.mkdir(contracts)
    const runtimeEnv = { WIKI_COMPILER_OUTPUT_DIR: output, WIKI_COMPILER_CONTRACTS_DIR: contracts,
      KNOWLEDGE_COMPILER_ENABLED: 'false', DOCMOST_SYNC_ENABLED: 'false' }
    const logs = []
    const service = new WikiCompiler({ pool, env: runtimeEnv, log: msg => logs.push(msg) })
    await service.initialize()
    assert.equal((await pool.query("select to_regclass('knowledge_docmost_mappings') as table")).rows[0].table, null)
    await pool.query("insert into rooms(room_key,title,owner_id) values('company','公司模型','alice'),('private','个人','bob')")
    await pool.query("insert into room_members values('company','alice','owner'),('private','bob','owner')")
    const nodes = [
      ['root', null, '公司模型'], ['contracts', 'root', '合同'], ['buy', 'contracts', '采购'],
      ['template', 'buy', '模板'], ['field', 'template', '金额'], ['one', 'buy', '甲合同'],
      ['value', 'one', '金额'], ['number', 'value', '100'], ['other', 'root', '其他业务']
    ]
    for (const [i, [uid,parent,text]] of nodes.entries()) await pool.query(
      'insert into room_nodes(room_key,uid,parent_uid,position,is_root,data) values($1,$2,$3,$4,$5,$6)',
      ['company',uid,parent,String(i).padStart(3,'0'),uid==='root',JSON.stringify({text})])
    await pool.query("insert into room_nodes(room_key,uid,parent_uid,position,is_root,data) values('private','root',null,'0',true,'{\"text\":\"秘密预算\"}')")
    await fs.writeFile(path.join(contracts, 'supplement.json'), JSON.stringify({ category: '采购', contract: '乙合同', elements: { 金额: '200' } }))
    assert.deepEqual(await service.list(), ['company','private'])
    assert.equal(service.companyRoom, 'company')
    await service.scheduler.tick()
    let all = roomBundles(output, new Set(['company','private']))
    const company = all.find(b => b.roomId === 'company')
    assert.equal(company.topics.filter(x=>x.title==='采购').length, 1)
    assert.equal(company.topics.some(x=>x.title==='合同'), false)
    assert.match(company.topics.find(x=>x.title==='采购').markdown, /100/)
    assert.match(company.topics.find(x=>x.title==='采购').markdown, /200/)
    assert.equal(company.topics.some(x=>x.title==='其他业务'), true)
    const before = await fs.readFile(path.join(output,'rooms/company/current.json'),'utf8')
    await service.scheduler.tick()
    assert.equal(await fs.readFile(path.join(output,'rooms/company/current.json'),'utf8'), before)
    const allowed = await readableRooms(pool,'alice',{})
    assert.deepEqual([...allowed], ['company'])
    assert.equal(loadRoomWiki(output,allowed).topics.some(x=>x.roomId==='private'), false)
    await pool.query("insert into room_members values('private','alice','viewer')")
    assert.equal((await readableRooms(pool,'alice',{})).has('private'), true)
    await pool.query("delete from room_members where room_key='private' and user_id='alice'")
    assert.equal((await readableRooms(pool,'alice',{})).has('private'), false)
    await pool.query("insert into room_members values('company','charlie','owner'); delete from room_members where room_key='company' and user_id='alice'")
    assert.equal((await readableRooms(pool,'alice',{})).has('company'), false, 'revoked creator must not retain access through owner_id')
    await pool.query("insert into room_members values('company','alice','owner')")
    const otherSlug = company.topics.find(x=>x.title==='其他业务').slug
    await pool.query("update room_nodes set data='{\"text\":\"业务改名\",\"note\":\"最新备注\"}' where room_key='company' and uid='other'; update rooms set version=1,updated_at=now() where room_key='company'")
    await service.scheduler.tick()
    let updated = roomBundles(output,new Set(['company']))[0]
    assert.equal(updated.topics.find(x=>x.title==='业务改名').slug, otherSlug)
    assert.match(updated.topics.find(x=>x.title==='业务改名').markdown, /最新备注/)
    await pool.query("insert into node_attachments values('file','company','other','附件','ready','附件新知识','h1','upload')")
    await service.scheduler.tick()
    updated = roomBundles(output,new Set(['company']))[0]
    assert.match(updated.topics.find(x=>x.title==='业务改名').markdown, /附件新知识/)
    await fs.writeFile(path.join(contracts,'supplement.json'), JSON.stringify({category:'采购',contract:'乙合同',elements:{金额:'300'}}))
    await service.scheduler.tick()
    assert.match(roomBundles(output,new Set(['company']))[0].topics.find(x=>x.title==='采购').markdown, /300/)
    const good = await fs.readFile(path.join(output,'rooms/company/current.json'),'utf8')
    await fs.writeFile(path.join(contracts,'supplement.json'), '{bad')
    await service.scheduler.tick()
    assert.equal(await fs.readFile(path.join(output,'rooms/company/current.json'),'utf8'), good)
    assert.match(logs.join('\n'), /failed/)
    await fs.writeFile(path.join(contracts,'supplement.json'), JSON.stringify({category:'采购',contract:'乙合同',elements:{金额:'400'}}))
    const restarted = new WikiCompiler({pool,env:runtimeEnv,log:msg=>logs.push(msg)})
    await restarted.initialize(); await restarted.scheduler.tick()
    assert.match(roomBundles(output,new Set(['company']))[0].topics.find(x=>x.title==='采购').markdown, /400/)
    await pool.query("update room_nodes set deleted_at=now() where room_key='company' and uid='other'; update rooms set version=2,updated_at=now() where room_key='company'")
    await restarted.scheduler.tick()
    assert.equal(roomBundles(output,new Set(['company']))[0].topics.some(x=>x.slug===otherSlug), false)
    await pool.query("update rooms set deleted_at=now() where room_key='company'")
    assert.equal((await readableRooms(pool,'alice',{})).has('company'), false)
    await restarted.scheduler.tick()
    assert.equal(roomBundles(output,new Set(['company'])).length, 0)
    assert.equal(roomBundles(output,new Set(['private'])).length, 1)
    const { EventEmitter } = require('node:events')
    const events = new EventEmitter()
    activeService = restarted
    await restarted.start({ operationEvents: events })
    await restarted.scheduler.tick()
    const privateBefore = roomBundles(output,new Set(['private']))[0].sourceHash
    await pool.query("update room_nodes set data='{\"text\":\"自动通知更新\"}' where room_key='private'; update rooms set version=1,updated_at=now() where room_key='private'")
    events.emit('committed',{roomKey:'private'})
    const deadline = Date.now()+5000
    while (Date.now()<deadline && roomBundles(output,new Set(['private']))[0].sourceHash===privateBefore) await new Promise(resolve=>setTimeout(resolve,50))
    assert.notEqual(roomBundles(output,new Set(['private']))[0].sourceHash, privateBefore)
    assert.equal(restarted.scheduler.intervalMs, 300000)
    assert.equal(Object.keys(require.cache).some(file=>/[\\/]knowledge[\\/]index\.js$|[\\/]docmost[^\\/]*\.js$/.test(file)), false)
    await restarted.stop(); activeService = null

  })
