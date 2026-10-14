// Run only against an explicit disposable PostgreSQL database. All fixtures and
// schema migration checks are enclosed in a transaction that is rolled back.
const assert = require('assert/strict')
const { Client } = require('../simple-mind-map/node_modules/pg')
const acl = require('../simple-mind-map/bin/roomAcl')
const { handleFileSystemApi } = require('../simple-mind-map/bin/fileSystem/http')
async function main() {
  assert.equal(process.env.PERMISSION_TEST_DISPOSABLE, '1', 'Set PERMISSION_TEST_DISPOSABLE=1 for a disposable DB')
  assert.ok(process.env.PGDATABASE && process.env.PGPORT, 'Explicit PGDATABASE and PGPORT required')
  const db = new Client(); await db.connect()
  try {
    await db.query('begin')
    const schema = 'permission_check_' + process.pid
    await db.query(`create schema ${schema}`)
    await db.query(`set local search_path to ${schema}`)
    await db.query(`create table rooms(room_key text primary key, owner_id text, folder_id text, deleted_at timestamptz, updated_at timestamptz default now());
      create table room_tombstones(room_key text primary key);
      create table folder_members(folder_id text, user_id text, role text, created_at timestamptz default now(), updated_at timestamptz default now(), primary key(folder_id,user_id));
      create table wecom_users(user_id text, wecom_userid text, corp_id text, name text, avatar text, departments jsonb default '[]');
      create table room_members(room_key text references rooms(room_key), user_id text, role text not null,
        created_at timestamptz default now(), updated_at timestamptz default now(), primary key(room_key,user_id),
        constraint room_members_role_chk check(role in ('owner','editor','viewer')));
      insert into rooms(room_key,owner_id,folder_id) values('test-room','owner','folder');
      insert into room_members(room_key,user_id,role) values('test-room','owner','owner');`)
    await acl.initSchema(db)
    await acl.initSchema(db) // Existing deployments and repeated startup.
    await acl.setMember(db,'test-room','manager','manager','owner')
    await acl.setMember(db,'test-room','editor','editor','owner')
    await acl.setMember(db,'test-room','viewer','viewer','owner')
    await db.query("insert into folder_members(folder_id,user_id,role) values('folder','manager','manager')")
    await acl.initSchema(db)
    assert.equal((await acl.getAccess(db,'test-room','manager')).role,'manager','Restart migration must preserve a direct manager grant')
    for (const id of ['manager','editor','viewer']) {
      for (const action of ['view','edit','manage']) {
        const allowed = id==='manager' || action==='view' || (id==='editor'&&action==='edit')
        const request = {forceAcl:true,authUser:{id}}
        if (allowed) await acl.assertRoomAccess(db,request,'test-room',action)
        else await assert.rejects(acl.assertRoomAccess(db,request,'test-room',action),e=>e.statusCode===403)
      }
    }
    await acl.setMember(db,'test-room','guest','viewer','manager')
    await acl.setMember(db,'test-room','guest','editor','manager')
    await assert.rejects(acl.setMember(db,'test-room','guest','owner','manager'),e=>e.code==='OWNER_REQUIRED')
    await assert.rejects(acl.setMember(db,'test-room','owner','editor','manager'),e=>e.code==='OWNER_REQUIRED')
    await assert.rejects(acl.removeMember(db,'test-room','owner','','manager'),e=>e.code==='OWNER_REQUIRED')
    await assert.rejects(acl.transferOwnership({query:db.query.bind(db)},'test-room','guest','manager'),e=>e.statusCode===403)
    await acl.removeMember(db,'test-room','guest','','manager')
    await acl.setFolderRole(db,'test-room','inherited','manager','folder')
    assert.equal((await acl.getAccess(db,'test-room','inherited')).role,'editor','Folder manager must retain inherited editor semantics')
    await acl.setFolderRole(db,'test-room','manager','viewer','folder')
    assert.equal((await acl.getAccess(db,'test-room','manager')).role,'manager','Inherited access cannot demote direct manager')
    await acl.removeMember(db,'test-room','manager','','owner')
    assert.equal((await acl.getAccess(db,'test-room','manager')).role,'viewer','Removing direct access preserves inherited viewer')
    // Check parity of SQL and JS role composition for all existing grant sources.
    for(const direct of [null,'viewer','editor','manager','owner']) for(const team of [null,'viewer','editor']) for(const folder of [null,'viewer','editor','manager']) {
      const sql=`select ${acl.sqlEffectiveRole('$1::text','$2::text','$3::text')} as role`
      assert.equal((await db.query(sql,[direct,team,folder])).rows[0].role,acl.effectiveRole(direct,team,folder)||null)
    }
    await db.query(`insert into rooms(room_key,owner_id,folder_id) values('bulk-room','owner','bulk-folder');
      insert into folder_members(folder_id,user_id,role,updated_at) values('bulk-folder','manager','manager','2020-01-01'),('bulk-folder','editor','viewer','2020-01-01');
      insert into wecom_users(user_id,wecom_userid,corp_id,name) values('owner','wx-owner','corp','Owner'),('manager','wx-manager','corp','Manager'),('editor','wx-editor','corp','Editor'),('new','wx-new','corp','New');`)
    await acl.ensureOwner(db,'bulk-room','owner')
    const store = {kind:'pg',query:db.query.bind(db),withTx:fn=>fn(db),getFolder:async()=>({id:'bulk-folder',created_by:'owner'}),listFolderMembers:async id=>(await db.query('select * from folder_members where folder_id=$1',[id])).rows}
    const req={url:'/api/folders/bulk-folder/members/bulk',method:'POST',authUser:{id:'owner',corpId:'corp'}}
    const body={userIds:['wx-owner','wx-manager','wx-editor','wx-new','wx-new'],role:'manager',onlyChanges:true}
    const call=async()=>{const res={writeHead(code){this.code=code},end(data){this.body=JSON.parse(data)}};await handleFileSystemApi(req,res,{engine:{store},body});assert.equal(res.code,200,JSON.stringify(res.body));return res.body}
    const first=await call();assert.equal(first.changed,2);assert.equal(first.unchanged,1)
    assert.equal((await acl.getAccess(db,'bulk-room','new')).role,'editor')
    const repeat=await call();assert.equal(repeat.changed,0);assert.equal(repeat.unchanged,3)
    assert.equal((await db.query("select extract(year from updated_at)::int as year from folder_members where folder_id='bulk-folder' and user_id='manager'")).rows[0].year,2020)
    assert.equal((await acl.getAccess(db,'bulk-room','owner')).role,'owner')
    await acl.transferOwnership({query:db.query.bind(db)},'test-room','editor','owner')
    assert.equal((await acl.getAccess(db,'test-room','editor')).role,'owner')
    assert.equal((await acl.getAccess(db,'test-room','owner')).role,'editor')
    console.log('Permission ACL PostgreSQL checks passed: migration, role matrix, ownership guards, inheritance, SQL/JS parity, actual bulk changes and duplicate suppression')
  } finally { await db.query('rollback'); await db.end() }
}
main().catch(error=>{console.error(error);process.exitCode=1})
