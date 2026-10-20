// Real Vue components + HTTP handlers + PostgreSQL in a disposable schema.
// Only authentication and AI availability are fixtures. No production data/calls.
const assert = require('node:assert/strict')
const fs = require('node:fs'),
  path = require('node:path'),
  http = require('node:http')
const { execFileSync } = require('node:child_process'),
  { randomUUID } = require('node:crypto')
const { Client, Pool } = require('../../simple-mind-map/node_modules/pg')
const service = require('../../simple-mind-map/bin/leaveWorkflow/service')
const handler = require('../../simple-mind-map/bin/leaveWorkflow/http')
const acl = require('../../simple-mind-map/bin/roomAcl')
const core = require('../../simple-mind-map/bin/leaveWorkflow/core')
const esbuild = require('esbuild'),
  compiler = require('vue-template-compiler')
const { compileStyle } = require('@vue/component-compiler-utils'),
  less = require('less')
const root = path.resolve(__dirname, '..')
const actors = {
  applicant: '王晓 · 申请人',
  manager: '陈宁 · 部门负责人',
  ssc: '季翔 · SSC',
  owner: '流程管理员',
  ceo: '总经理',
  vp: '副总',
  hr: '人事组',
  replacement: '李林 · 工作替补人'
}
let cleanupOnFailure
async function main() {
  assert.equal(process.env.LEAVE_TEST_DISPOSABLE, '1')
  const container = process.env.LEAVE_TEST_DB_CONTAINER
  assert.ok(container && /test|preview/.test(container))
  const info = JSON.parse(
    execFileSync('docker', ['inspect', container], { encoding: 'utf8' })
  )[0]
  const env = Object.fromEntries(
    info.Config.Env.map(s => [
      s.slice(0, s.indexOf('=')),
      s.slice(s.indexOf('=') + 1)
    ])
  )
  const config = {
    host: '127.0.0.1',
    port: Number(info.NetworkSettings.Ports['5432/tcp'][0].HostPort),
    database: env.POSTGRES_DB || env.POSTGRES_USER || 'postgres',
    user: env.POSTGRES_USER || 'postgres',
    password: env.POSTGRES_PASSWORD
  }
  const admin = new Client(config)
  await admin.connect()
  const schema = 'leave_demo_' + process.pid,
    pool = new Pool({ ...config, options: '-c search_path=' + schema })
  await admin.query(`create schema ${schema}`)
  cleanupOnFailure = async () => {
    await pool.end()
    await admin.query(`drop schema if exists ${schema} cascade`)
    await admin.end()
  }
  const reqFor = id => ({ forceAcl: true, authUser: { id, corpId: 'demo' } })
  await pool.query(`create table rooms(room_key text primary key,owner_id text,folder_id text,deleted_at timestamptz,updated_at timestamptz default now(),title text);
    create table room_tombstones(room_key text primary key); create table folder_members(folder_id text,user_id text,role text,created_at timestamptz,updated_at timestamptz);
    create table wecom_users(user_id text primary key,wecom_userid text,corp_id text,name text,departments jsonb default '[1]');
    create table room_nodes(room_key text,uid text,parent_uid text,position text,data jsonb,deleted_at timestamptz,primary key(room_key,uid));
    create table node_attachments(id text primary key,room_key text,node_uid text,content_hash text,file_name text,status text,extracted_text text);`)
  for (const [id, name] of Object.entries(actors))
    await pool.query(
      "insert into wecom_users(user_id,wecom_userid,corp_id,name) values($1,$1,'demo',$2)",
      [id, name]
    )
  await pool.query(
    "insert into rooms(room_key,owner_id,title) values($1,'owner','公司模型'),('personal','applicant','个人工作')",
    [service.SOURCE.roomKey]
  )
  await acl.initSchema(pool)
  await acl.ensureOwner(pool, service.SOURCE.roomKey, 'owner')
  await acl.ensureOwner(pool, 'personal', 'applicant')
  await acl.setMember(
    pool,
    service.SOURCE.roomKey,
    'applicant',
    'viewer',
    'owner'
  )
  await service.initSchema(pool)
  const nodes = structuredClone(
    require('../../scripts/fixtures/leave-template-verified.json')
  )
  const child = (uid, text) =>
    nodes.find(n => n.parent_uid === uid && core.label(n.data.text) === text)
  const cfg = child(service.SOURCE.nodeUid, '审批配置'),
    cc = child(cfg.uid, '抄送')
  for (const [parent, role, id] of [
    [cfg.uid, '部门负责人', 'manager'],
    [cfg.uid, 'SSC', 'ssc'],
    ...['总经理', '副总', '人事组', '部门负责人'].map((r, i) => [
      cc.uid,
      r,
      ['ceo', 'vp', 'hr', 'manager'][i]
    ])
  ])
    nodes.push({
      uid: randomUUID(),
      parent_uid: child(parent, role).uid,
      position: 'A',
      data: { text: '账号：' + id }
    })
  for (const n of nodes)
    await pool.query(
      'insert into room_nodes(room_key,uid,parent_uid,position,data) values($1,$2,$3,$4,$5)',
      [service.SOURCE.roomKey, n.uid, n.parent_uid, n.position, n.data]
    )
  await pool.query(
    "insert into room_nodes values('personal','anchor',null,'A','{\"text\":\"待登记事项\"}',null)"
  )
  const tpl = await service.template(pool, reqFor('owner'))
  await service.publish(pool, reqFor('owner'), {
    expectedFingerprint: tpl.fingerprint,
    operationId: randomUUID()
  })
  // The harness writer persists node commands; the production writer additionally broadcasts.
  const writer = async (room, command) => {
    const p = command.payload
    if (command.type === 'node.insert')
      await pool.query(
        'insert into room_nodes(room_key,uid,parent_uid,position,data) values($1,$2,$3,$4,$5) on conflict do nothing',
        [room, p.uid, p.parentUid, 'A', { text: p.text, ...p.data }]
      )
    else
      await pool.query(
        'update room_nodes set data=data || $3::jsonb where room_key=$1 and uid=$2',
        [room, p.uid, p.patch]
      )
  }
  let compiled
  const ctx = await esbuild.context({
    stdin: {
      resolveDir: path.join(__dirname, 'fixtures'),
      contents: fs.readFileSync(
        path.join(__dirname, 'fixtures/leaveWorkflowDemoApp.js'),
        'utf8'
      )
    },
    bundle: true,
    write: false,
    outdir: 'leave-demo',
    platform: 'browser',
    external: ['buffer'],
    define: { 'process.env.NODE_ENV': '"test"' },
    alias: {
      '@': path.join(root, 'src'),
      vue: fs.realpathSync(require.resolve('vue/dist/vue.esm.js'))
    },
    loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' },
    plugins: [
      {
        name: 'leave-demo',
        setup(build) {
          build.onEnd(r => {
            if (!r.errors.length) compiled = r
          })
          build.onLoad({ filter: /src\/utils\/runtimeConfig\.js$/ }, () => ({
            contents:
              'export const getRuntimeConfig=()=>({collabApi:location.origin+"/actor/"+(location.pathname.slice(1)||"applicant")})',
            loader: 'js'
          }))
          build.onLoad({ filter: /src\/utils\/agentChat\.js$/ }, () => ({
            contents:
              'export const checkAiBackend=async()=>({ok:false});export const streamChat=async()=>({content:""})',
            loader: 'js'
          }))
          build.onResolve({ filter: /\?leave-style$/ }, a => ({
            path: a.path.slice(0, -12),
            namespace: 'leave-style'
          }))
          build.onLoad({ filter: /.*/, namespace: 'leave-style' }, async a => {
            const parsed = compiler.parseComponent(
              fs.readFileSync(a.path, 'utf8')
            )
            let css = ''
            for (const style of parsed.styles) {
              const raw = (
                await less.render(style.content, { filename: a.path })
              ).css
              css += style.scoped
                ? compileStyle({
                    source: raw,
                    filename: a.path,
                    id: 'data-v-leave-demo',
                    scoped: true
                  }).code
                : raw
            }
            return { contents: css, loader: 'css', watchFiles: [a.path] }
          })
          build.onLoad({ filter: /\.vue$/ }, a => {
            const parsed = compiler.parseComponent(
              fs.readFileSync(a.path, 'utf8')
            )
            return {
              contents:
                'import ' +
                JSON.stringify(a.path + '?leave-style') +
                ';' +
                parsed.script.content.replace(
                  'export default',
                  'const component='
                ) +
                ';component.template=' +
                JSON.stringify(parsed.template.content) +
                ';component._scopeId="data-v-leave-demo";export default component',
              resolveDir: path.dirname(a.path),
              loader: 'js',
              watchFiles: [a.path]
            }
          })
        }
      }
    ]
  })
  await ctx.rebuild()
  await ctx.watch()
  const sendJson = (res, code, data) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(data))
  }
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://local'),
        hit = url.pathname.match(/^\/actor\/([^/]+)(\/.*)$/)
      if (hit) {
        if (!actors[hit[1]])
          return sendJson(res, 401, { error: '测试身份无效' })
        Object.assign(req, reqFor(hit[1]))
        url.pathname = hit[2]
        if (
          url.pathname.includes('/attachments?') ||
          url.pathname.match(/\/api\/files\/.+\/attachments$/)
        )
          return sendJson(res, 200, { attachments: [] })
        const readBody = async r => {
          let raw = ''
          for await (const c of r) raw += c
          return raw ? JSON.parse(raw) : {}
        }
        if (url.pathname.startsWith('/fixture/')) {
          if (hit[1] !== 'applicant')
            return sendJson(res, 403, { error: '仅测试申请人可编辑' })
          if (url.pathname === '/fixture/node' && req.method === 'POST') {
            const node = await readBody(req)
            if (
              typeof node.uid !== 'string' ||
              !/^[a-zA-Z0-9_-]{1,80}$/.test(node.uid) ||
              typeof node.text !== 'string' ||
              node.text.length > 3000
            )
              return sendJson(res, 400, { error: '无效节点' })
            if (
              node.uid !== 'anchor' &&
              !(
                await pool.query(
                  "select uid from room_nodes where room_key='personal' and uid=$1 and deleted_at is null",
                  [node.parentUid]
                )
              ).rows.length
            )
              return sendJson(res, 400, { error: '父节点不存在' })
            await pool.query(
              "insert into room_nodes(room_key,uid,parent_uid,position,data) values('personal',$1,$2,'Z',$3) on conflict(room_key,uid) do update set data=room_nodes.data || excluded.data",
              [
                node.uid,
                node.uid === 'anchor' ? null : node.parentUid,
                { text: node.text }
              ]
            )
            return sendJson(res, 200, { ok: true })
          }
          if (url.pathname === '/fixture/tree' && req.method === 'GET') {
            const nodes = (
              await pool.query(
                "select uid,parent_uid,data from room_nodes where room_key='personal' and deleted_at is null order by position,uid limit 500"
              )
            ).rows
            const make = uid => {
              const row = nodes.find(n => n.uid === uid)
              return {
                data: { ...row.data, uid },
                children: nodes
                  .filter(n => n.parent_uid === uid)
                  .map(n => make(n.uid))
              }
            }
            return sendJson(res, 200, { tree: make('anchor') })
          }
          return sendJson(res, 404, { error: '测试接口不存在' })
        }
        if (
          await handler.handle(req, res, {
            url,
            db: pool,
            writer,
            readBody,
            sendJson
          })
        )
          return
        return sendJson(res, 404, { error: '测试接口不存在' })
      }
      if (['/demo.js', '/demo.css'].includes(url.pathname)) {
        const css = url.pathname.endsWith('.css')
        res.writeHead(200, {
          'Content-Type': css ? 'text/css' : 'application/javascript'
        })
        return res.end(
          compiled.outputFiles.find(f => f.path.endsWith(css ? '.css' : '.js'))
            .contents
        )
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WCPD 请假闭环验证</title><link rel="stylesheet" href="/demo.css"><style>body{margin:0;background:#f5f7fa;color:#243247;font-family:system-ui}nav{padding:16px 5vw;display:flex;flex-wrap:wrap;gap:24px;background:#fff;border-bottom:1px solid #e5eaf0}a{color:#4b6c95;text-decoration:none}header{padding:36px 5vw 20px}header h1{font-size:28px}header p,header small{color:#7c8a9d;font-size:13px}.workspace{margin:0 5vw 40px;background:white;border:1px solid #e4e9f0;border-radius:16px;max-width:1100px}</style><div id="app"></div><script src="/demo.js"></script>'
      )
    } catch (e) {
      sendJson(res, e.statusCode || 500, { error: e.message, code: e.code })
    }
  })
  await new Promise(resolve =>
    server.listen(
      Number(process.env.LEAVE_DEMO_PORT) || 4330,
      '127.0.0.1',
      resolve
    )
  )
  console.log(
    'Leave E2E: http://127.0.0.1:' +
      server.address().port +
      '/applicant; isolated schema ' +
      schema +
      '; AI deliberately unavailable'
  )
  const cleanup = async () => {
    server.closeAllConnections()
    server.close()
    await ctx.dispose()
    await pool.end()
    await admin.query(`drop schema ${schema} cascade`)
    await admin.end()
    process.exit()
  }
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
}
main().catch(async e => {
  console.error(e.message)
  if (cleanupOnFailure) await cleanupOnFailure()
  process.exit(1)
})
