const path = require('node:path')
const crypto = require('node:crypto')
const isolation = require('../../../tests/performance/isolation.cjs')

let production
function loadProduction() {
  if (production) return production
  isolation.configureIsolatedEnvironment()
  // Synthetic local auth configuration, never a copied .env or real credential.
  Object.assign(process.env, {
    WECOM_AUTH_ENABLED: '1', WECOM_CORP_ID: 'wwdirectoryfixture', WECOM_AGENT_ID: '1',
    WECOM_SECRET: 'synthetic-directory-test-only',
    WECOM_REDIRECT_URI: 'http://127.0.0.1:9/api/auth/wecom/callback',
    AUTH_SESSION_SECRET: 'synthetic-directory-session-only-'.repeat(2),
    MCP_TOKEN: 'synthetic-directory-mcp-only-'.repeat(2)
  })
  const storage = require('../../bin/storage')
  const acl = require('../../bin/roomAcl')
  const files = require('../../bin/fileSystem')
  const team = require('../../bin/teamSpace')
  production = { storage, acl, files, team }
  return production
}

const schemaSql = `
  create table rooms (
    room_key text primary key, title text, cos_key text, metadata jsonb default '{}',
    nodes jsonb default '{}', version int default 1, folder_id uuid, owner_id text,
    team_id text, created_at timestamptz, updated_at timestamptz, content_updated_at timestamptz,
    deleted_at timestamptz, deleted_by text, deleted_from_folder_id uuid);
  create table room_tombstones (room_key text primary key);
  create table room_members (room_key text, user_id text, role text, created_at timestamptz default now(),
    primary key(room_key,user_id));
  create table room_user_state (room_key text,user_id text,is_favorite boolean default false,
    last_opened_at timestamptz,updated_at timestamptz default now(),primary key(room_key,user_id));
  create table room_nodes (room_key text,uid text,parent_uid text,position text,data jsonb,
    is_root boolean,deleted_at timestamptz,primary key(room_key,uid));
  create index directory_parent_position on room_nodes(room_key,parent_uid,position) where deleted_at is null;
  create unique index directory_root on room_nodes(room_key) where is_root and deleted_at is null;
  create table node_shares (id uuid primary key,room_key text,root_uid text,role text,token_hash text,
    recipient_user_id text,recipient_user_ids text[],expires_at timestamptz,revoked_at timestamptz);
  create table teams (id text primary key,corp_id text,name text,owner_id text,
    description text default '',source_type text default 'custom',created_at timestamptz default now(),
    updated_at timestamptz default now(),deleted_at timestamptz);
  create table team_members (team_id text,corp_id text,user_id text,role text,primary key(team_id,user_id));
  create table folders (id uuid primary key,parent_id uuid,name text,team_id text,created_by text,
    created_at timestamptz default now(),updated_at timestamptz default now(),deleted_at timestamptz);
  create table wecom_users (corp_id text,user_id text,name text,avatar text default '',
    primary key(corp_id,user_id));
  create index directory_team_rooms on rooms(team_id,updated_at desc);
  create index directory_folder_rooms on rooms(folder_id);
`

async function withDirectoryDatabase(callback) {
  const p = loadProduction()
  return isolation.withIsolatedPg(async pool => {
    const client = await pool.connect()
    const schema = 'directory_' + crypto.randomUUID().replace(/-/g, '')
    const trace = []
    let afterQuery = null
    const adapter = {
      async query(sql, values) {
        const started = performance.now()
        const result = await client.query(sql, values)
        const statement = typeof sql === 'object' ? sql.text : String(sql)
        trace.push({ sql: statement, rows: result.rowCount, ms: performance.now() - started })
        if (afterQuery) await afterQuery(statement, result)
        return result
      },
      async connect() { return { query: (...args) => adapter.query(...args), release() {} } }
    }
    const originalGetPool = p.storage.getPool
    try {
      await client.query(`create schema "${schema}"`)
      await client.query(`set search_path to "${schema}", pg_catalog`)
      await client.query("set statement_timeout = '15s'")
      await client.query(schemaSql)
      await require("../../bin/nodeCountsGeneration").installNodeCountsGeneration(client)
      p.storage.getPool = () => adapter
      const store = p.files.createPgFileStore(adapter)
      const engine = p.files.createFileSystem({ store })
      return await callback({ ...p, client, pool, schema, adapter, store, engine, trace,
        afterQuery(fn) { afterQuery = fn },
        async secondClient() {
          const second = await pool.connect()
          await second.query(`set search_path to "${schema}", pg_catalog`)
          return second
        }
      })
    } finally {
      p.storage.getPool = originalGetPool
      await client.query('rollback').catch(() => {})
      await client.query(`set search_path to public, pg_catalog`)
      await client.query(`drop schema if exists "${schema}" cascade`)
      client.release(true)
    }
  })
}

async function seedPreview(f, { key = 'card-room', children = 65, grandChildren = 2 } = {}) {
  await f.client.query(`insert into rooms(room_key,title,cos_key,owner_id,created_at,updated_at,content_updated_at)
    values($1,'Card title','fixture','owner','2026-10-13','2026-10-13','2026-10-13')`, [key])
  await f.client.query(`insert into room_members(room_key,user_id,role) values($1,'owner','owner'),($1,'other-member','viewer')`, [key])
  await f.client.query(`insert into room_nodes(room_key,uid,parent_uid,position,data,is_root)
    values($1,'root',null,'000000',jsonb_build_object('text','VERSION-1'),true)`, [key])
  await f.client.query(`insert into room_nodes(room_key,uid,parent_uid,position,data,is_root)
    select $1,'c'||i,'root',lpad(i::text,8,'0'),jsonb_build_object('text','Child '||i),false
    from generate_series(1,$2::int) i`, [key, children])
  await f.client.query(`insert into room_nodes(room_key,uid,parent_uid,position,data,is_root)
    select $1,'c'||i||'-g'||j,'c'||i,lpad(j::text,8,'0'),jsonb_build_object('text','Grand '||i||'.'||j),false
    from generate_series(1,$2::int) i cross join generate_series(1,$3::int) j`, [key, children, grandChildren])
  return key
}

function response() {
  return { code: null, body: null, writeHead(code) { this.code = code },
    end(body) { this.body = JSON.parse(String(body)) } }
}

async function requestPreview(f, key, user = 'owner', headers = {}) {
  const req = { method: 'GET', url: `/api/files/${key}/card-preview`,
    authUser: { id: user, corpId: 'corp-a' }, forceAcl: true, headers }
  const res = response()
  req.roomAccess = await f.acl.assertRoomAccess(f.adapter, req, key, 'view')
  await f.files.handleFileSystemApi(req, res, { engine: f.engine })
  return { req, res }
}

module.exports = { withDirectoryDatabase, seedPreview, response, requestPreview, loadProduction }

const FOLDER_A = '11111111-1111-4111-8111-111111111111'
const FOLDER_B = '22222222-2222-4222-8222-222222222222'
async function seedTeamRooms(f, count = 60) {
  await f.client.query(`insert into wecom_users(corp_id,user_id,name) values
    ('corp-a','owner','创建者甲'),('corp-a','creator-b','创建者乙'),('corp-b','bob','Bob')`)
  await f.client.query(`insert into teams(id,corp_id,name,owner_id) values
    ('team-a','corp-a','Team A','owner'),('team-b','corp-b','Team B','bob')`)
  await f.client.query(`insert into team_members(team_id,corp_id,user_id,role) values
    ('team-a','corp-a','owner','owner'),('team-a','corp-a','reader','member'),('team-b','corp-b','bob','owner')`)
  await f.client.query(`insert into folders(id,name,team_id,created_by) values
    ($1,'目录甲','team-a','owner'),($2,'目录乙','team-a','owner')`, [FOLDER_A, FOLDER_B])
  await f.client.query(`insert into rooms(room_key,title,team_id,folder_id,owner_id,version,created_at,updated_at,content_updated_at)
    select 'a-'||lpad(i::text,greatest(4,length(i::text)),'0'),case when i%4=0 then 'Target' else 'Same title' end,'team-a',
      case when i%3=0 then $1::uuid when i%3=1 then $2::uuid else null end,
      case when i%2=0 then 'owner' else 'creator-b' end,i,
      '2026-10-12'::timestamptz + (i||' seconds')::interval,
      '2026-10-13'::timestamptz + ((i/3)||' seconds')::interval,
      '2026-10-13'::timestamptz + ((i/3)||' seconds')::interval
    from generate_series(1,$3::int) i`, [FOLDER_A, FOLDER_B, count])
  await f.client.query(`insert into room_members(room_key,user_id,role)
    select room_key,'owner',case when version%3=0 then 'owner' when version%3=1 then 'editor' else 'viewer' end
    from rooms where team_id='team-a'`)
  await f.client.query(`insert into rooms(room_key,title,team_id,owner_id,version,created_at,updated_at,deleted_at)
    values('deleted','Target','team-a','owner',1,now(),now(),now()),
      ('tombstoned','Target','team-a','owner',1,now(),now(),null),
      ('cross-corp','Target','team-b','bob',1,now(),now(),null)`)
  await f.client.query(`insert into room_tombstones(room_key) values('tombstoned')`)
}

module.exports.seedTeamRooms = seedTeamRooms
module.exports.FOLDER_A = FOLDER_A
module.exports.FOLDER_B = FOLDER_B
