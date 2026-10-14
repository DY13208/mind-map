// Isolated browser E2E harness: real request/ACL/SSE code and a disposable schema.
const assert = require('assert/strict'),
  fs = require('fs'),
  path = require('path'),
  http = require('http')
assert.equal(process.env.PERMISSION_TEST_DISPOSABLE, '1')
assert.equal(process.env.MIND_MAP_SKIP_ROOT_ENV, '1')
assert.ok(process.env.PGDATABASE && process.env.PGPORT)
const { Client, Pool } = require('../../simple-mind-map/node_modules/pg')
const acl = require('../../simple-mind-map/bin/roomAcl'),
  access = require('../../simple-mind-map/bin/accessRequests'),
  events = require('../../simple-mind-map/bin/accessRequestEvents')
const esbuild = require('esbuild'),
  compiler = require('vue-template-compiler'),
  { compileStyle } = require('@vue/component-compiler-utils'),
  less = require('less')
const root = path.resolve(__dirname, '..'),
  room = 'room-access-demo',
  schema = 'access_demo_' + process.pid
async function main() {
  const admin = new Client()
  await admin.connect()
  await admin.query(`create schema ${schema}`)
  const pool = new Pool({ options: `-c search_path=${schema}` })
  await pool.query(`create table rooms(room_key text primary key,owner_id text,folder_id text,deleted_at timestamptz,updated_at timestamptz default now(),title text);
 create table room_tombstones(room_key text primary key);create table folder_members(folder_id text,user_id text,role text,created_at timestamptz,updated_at timestamptz);
 create table wecom_users(user_id text primary key,wecom_userid text,corp_id text,name text,avatar text);
 insert into rooms(room_key,owner_id,title) values('${room}','demo-owner','公司模型 · 项目规划');
 insert into wecom_users values('demo-owner','wx-owner','demo-corp','李继兵',''),('demo-applicant','wx-applicant','demo-corp','林佳敏 Jasmine',''),('demo-colleague','wx-colleague','demo-corp','周文祐 Jojo',''),('demo-colleague2','wx-colleague2','demo-corp','徐健 Simon','');`)
  await acl.initSchema(pool)
  await access.initSchema(pool)
  await acl.ensureOwner(pool, room, 'demo-owner')
  const reqFor = id => ({
    forceAcl: true,
    authUser: { id, corpId: 'demo-corp' }
  })
  await access.requestAccess(pool, reqFor('demo-colleague'), {
    roomKey: room,
    role: 'editor',
    reason: '负责项目实施计划，希望补充里程碑与验收标准。'
  })
  await access.requestAccess(pool, reqFor('demo-colleague2'), {
    roomKey: room,
    role: 'viewer',
    reason: '查看本周评审资料，确认预算与交付安排。'
  })
  if (process.env.ACCESS_DEMO_MANY_REQUESTS === '1') {
    for (let index = 1; index <= 23; index++) {
      const id = `demo-page-${index}`
      await pool.query(
        `insert into wecom_users values($1,$1,'demo-corp',$2,'')`,
        [id, `分页验证成员 ${index}`]
      )
      const item = await access.requestAccess(pool, reqFor(id), {
        roomKey: room,
        role: index % 2 ? 'viewer' : 'editor',
        reason: '分页验证用申请'
      })
      await pool.query(
        `update room_access_requests set created_at=now()-interval '1 day' where id=$1`,
        [item.id]
      )
    }
  }
  let compiled
  const template = `<main><header class="demoHeader"><a href="/owner">所有者视角</a><a href="/applicant">申请人视角</a><span>隔离测试环境 · 不连接线上数据</span><button v-if="owner" @click="disconnect">模拟通知断线</button><button v-if="!owner" @click="revoke">恢复未授权测试状态</button></header><aside v-if="owner || allowed" class="demoSidebar"><div class="demoBrand">WCPD <small>团队协作空间</small></div><span class="workspaceLabel">工作空间</span><div class="sideItem"><i class="el-icon-document" /> 我的脑图</div><div class="sideItem"><i class="el-icon-folder" /> 公司资料</div><div class="sideItem"><i class="el-icon-user" /> 团队协作</div><Trigger/><div class="demoProfile">{{owner?'李继兵 · 文件所有者':'林佳敏 · 申请人'}}</div></aside><section v-if="owner" class="demoWorkspace"><span class="eyebrow">团队文件 / 公司资料</span><h1>公司模型 · 项目规划</h1><p>消息中心可查看访问申请，并配置对应权限。</p><div class="workspaceCard"><i class="el-icon-document"/><div><strong>项目规划与实施方案</strong><p>由李继兵管理 · 本地协作验证</p></div><el-button @click="openCenter">查看访问申请</el-button></div></section><Denied v-else-if="ready && !allowed" room-key="${room}" @back="back"/><section v-else-if="ready" class="demoWorkspace grantedWorkspace"><span class="grantedIcon"><i class="el-icon-check"/></span><h1>已获得{{grantLabel}}权限</h1><p>「公司模型 · 项目规划」已可以访问。</p><el-button type="primary" @click="openResults">查看审批结果</el-button></section><Center :user-id="userId" :floating="false"/></main>`
  const ctx = await esbuild.context({
    stdin: {
      resolveDir: root,
      contents: `import Vue from 'vue/dist/vue.esm.js';import ElementUI from 'element-ui';import 'element-ui/lib/theme-chalk/index.css';import Center from './src/components/AccessNotifications.vue';import Trigger from './src/components/AccessNotificationTrigger.vue';import Denied from './src/pages/Edit/components/AccessDeniedPanel.vue';import {openNotifications,roleText} from './src/services/accessNotificationState';Vue.use(ElementUI);const owner=location.pathname!='/applicant',actor=owner?'owner':'applicant',base='/actor/'+actor;new Vue({components:{Center,Trigger,Denied},data:()=>({owner,userId:owner?'demo-owner':'demo-applicant',allowed:false,ready:false,grantLabel:''}),async created(){const data=await(await fetch(base+'/fixture/access')).json();this.allowed=data.canView;this.grantLabel=roleText(data.role);this.ready=true},methods:{openCenter(){openNotifications('requests')},openResults(){openNotifications('results')},async disconnect(){await fetch(base+'/fixture/disconnect',{method:'POST'})},async revoke(){await fetch(base+'/fixture/revoke',{method:'POST'});location.reload()},back(){location.href='/owner'}},template:${JSON.stringify(
        template
      )}}).$mount('#app')`
    },
    bundle: true,
    write: false,
    outdir: 'access-demo',
    platform: 'browser',
    define: { 'process.env.NODE_ENV': '"test"' },
    alias: { '@': path.join(root, 'src') },
    loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' },
    plugins: [
      {
        name: 'access-sfc',
        setup(build) {
          build.onEnd(result => {
            if (!result.errors.length) compiled = result
          })
          build.onLoad({ filter: /src\/utils\/auth\.js$/ }, () => ({
            contents:
              'export const getCurrentUser=()=>({id:location.pathname==="/applicant"?"demo-applicant":"demo-owner"})',
            loader: 'js'
          }))
          build.onLoad({ filter: /src\/utils\/runtimeConfig\.js$/ }, () => ({
            contents:
              'export const getRuntimeConfig=()=>({collabApi:location.origin+"/actor/"+(location.pathname==="/applicant"?"applicant":"owner")})',
            loader: 'js'
          }))
          build.onResolve({ filter: /\?access-style$/ }, a => ({
            path: a.path.slice(0, -'?access-style'.length),
            namespace: 'access-style'
          }))
          build.onLoad({ filter: /.*/, namespace: 'access-style' }, async a => {
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
                    id: 'data-v-access-demo',
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
                JSON.stringify(a.path + '?access-style') +
                ';' +
                parsed.script.content.replace(
                  'export default',
                  'const component='
                ) +
                ';component.template=' +
                JSON.stringify(parsed.template.content) +
                ';component._scopeId="data-v-access-demo";export default component',
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
  const streams = new Map()
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local'),
      match = url.pathname.match(/^\/actor\/(owner|applicant)(\/.*)$/)
    const json = (data, status = 200) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8'
      })
      res.end(JSON.stringify(data))
    }
    try {
      if (match) {
        const id = match[1] === 'owner' ? 'demo-owner' : 'demo-applicant'
        const request = reqFor(id),
          pathname = match[2]
        let raw = ''
        if (req.method !== 'GET') for await (const chunk of req) raw += chunk
        const body = raw ? JSON.parse(raw) : {}
        if (pathname === '/fixture/access') {
          const a = await acl.getAccess(pool, room, id)
          return json({ ...acl.accessSummary(a.role), role: a.role })
        }
        if (pathname === '/fixture/disconnect') {
          for (const response of streams.get(id) || []) response.end()
          return json({ ok: true })
        }
        if (pathname === '/fixture/revoke') {
          if ((await acl.getAccess(pool, room, id)).role)
            await acl.removeMember(pool, room, id, '', 'demo-owner')
          return json({ ok: true })
        }
        if (pathname === '/api/notifications/access-requests/events') {
          if (!streams.has(id)) streams.set(id, new Set())
          streams.get(id).add(res)
          res.on('close', () => streams.get(id).delete(res))
          events.stream(pool, Object.assign(req, request), res, id)
          return
        }
        if (pathname === '/api/notifications/access-requests')
          return json(
            await access.listInbox(
              pool,
              request,
              Object.fromEntries(url.searchParams)
            )
          )
        if (pathname === '/api/notifications/access-results')
          return json(
            await access.listResults(
              pool,
              request,
              Object.fromEntries(url.searchParams)
            )
          )
        if (pathname === '/api/notifications/access-results/seen')
          return json(await access.markSeen(pool, request, body.ids))
        if (pathname === '/api/access-requests' && req.method === 'POST')
          return json({ item: await access.requestAccess(pool, request, body) })
        if (pathname === '/api/access-requests/mine')
          return json({
            item: await access.mine(
              pool,
              request,
              url.searchParams.get('roomKey')
            )
          })
        const decision = pathname.match(/^\/api\/access-requests\/([^/]+)$/)
        if (decision)
          return json({
            item: await access.decide(
              pool,
              request,
              decision[1],
              body.decision,
              body
            )
          })
        return json({ error: '未找到测试接口' }, 404)
      }
      if (url.pathname === '/demo.js' || url.pathname === '/demo.css') {
        const ext = url.pathname.endsWith('.css') ? '.css' : '.js'
        res.writeHead(200, {
          'Content-Type': ext === '.css' ? 'text/css' : 'application/javascript'
        })
        res.end(compiled.outputFiles.find(f => f.path.endsWith(ext)).contents)
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>访问申请与实时审批 · 本地验证</title><link rel="stylesheet" href="/demo.css"><style>body{margin:0;color:#253b2f;background:#f7f9f8;font-family:system-ui}.demoHeader{height:48px;display:flex;align-items:center;gap:14px;padding:0 20px;background:white;border-bottom:1px solid #e4eae6;font-size:12px;position:relative;z-index:1}.demoHeader a{color:#547461;text-decoration:none}.demoHeader span{color:#8b9d91;flex:1}.demoHeader button{border:1px solid #dce6df;background:white;border-radius:5px;padding:5px;color:#708476;cursor:pointer}.demoSidebar{position:fixed;top:49px;bottom:0;width:192px;background:white;border-right:1px solid #e3eae6;padding:26px 18px;box-sizing:border-box}.demoBrand{font-size:22px;font-weight:700;margin-bottom:42px}.demoBrand small{display:block;font-size:10px;color:#93a297;margin-top:5px}.workspaceLabel{font-size:10px;color:#94a499;margin-left:12px}.sideItem{padding:14px 12px;display:flex;gap:12px;font-size:13px;color:#6b8173}.demoProfile{position:absolute;bottom:22px;font-size:11px;color:#7d9284}.demoWorkspace{margin:72px 56px 0 248px}.demoWorkspace h1{font-size:28px;letter-spacing:-.7px}.demoWorkspace p{font-size:14px;color:#829488;line-height:1.6}.eyebrow{font-size:11px;color:#92a598}.workspaceCard{display:flex;align-items:center;gap:20px;padding:25px;background:white;border:1px solid #e3ebe5;border-radius:12px;max-width:700px;margin-top:40px}.workspaceCard>i{font-size:32px;color:#4e7c61}.workspaceCard>div{flex:1}.workspaceCard p{font-size:12px;margin-bottom:0}.grantedWorkspace{text-align:center;margin-top:170px}.grantedIcon{display:inline-grid;place-items:center;width:60px;height:60px;background:#e5f3e9;border-radius:50%;color:#22805a;font-size:32px}.accessDenied{min-height:calc(100vh - 49px)!important}@media(max-width:700px){.demoHeader{flex-wrap:wrap;height:auto;min-height:48px;padding:8px 12px;gap:8px}.demoHeader span{display:none}.demoSidebar{width:64px;padding:20px 8px}.demoBrand{font-size:12px}.demoBrand small,.workspaceLabel,.sideItem,.demoProfile{display:none}.demoWorkspace{margin:40px 20px 0 84px}.demoWorkspace h1{font-size:22px}.workspaceCard{flex-direction:column;align-items:flex-start}.notificationButton span{display:none!important}}</style><div id="app"></div><script src="/demo.js"></script>'
      )
    } catch (error) {
      json({ error: error.message, code: error.code }, error.statusCode || 500)
    }
  })
  await new Promise(resolve => server.listen(4323, '127.0.0.1', resolve))
  console.log(
    'Access request E2E: http://127.0.0.1:4323/owner and /applicant; schema ' +
      schema
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
  process.on('SIGTERM', cleanup)
  process.on('SIGINT', cleanup)
}
main().catch(e => {
  console.error(e)
  process.exitCode = 1
})
