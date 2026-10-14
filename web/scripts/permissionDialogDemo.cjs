// Local-only UI fixture: production components/services and in-memory ACLs.
const fs = require('fs'), path = require('path'), http = require('http')
const esbuild = require('esbuild'), compiler = require('vue-template-compiler')
const { compileStyle } = require('@vue/component-compiler-utils')
const less = require('less'), root = path.resolve(__dirname, '..')
const names = ['周文祐 Jojo','徐健 Simon','林佳敏 Jasmine','刘欢 Joy','黄贤润 Henry','陈安','许芸','张宁','李思','王晨','何嘉','赵然','杨靖','郑文','吴怡','孙悦','宋书','郭岚','朱平','梁欣','许诚','谢琳','唐若','冯杰','罗琪','韩立','曹颖','陆川','蒋帆','丁一','沈书']
const contacts = names.map((name,i)=>({id:'id-'+i,userId:'wx-'+i,wecomUserId:'wx-'+i,name,departmentIds:[i<12?'1':i<22?'2':'3'],department:i<12?'总经办':i<22?'人事组':'技术组',position:'企业成员'}))
const owner={user_id:'local-owner',wecom_userid:'owner-wx',name:'李继兵',role:'owner'}
let members,writes=[],failNext=false
function reset(){members=Object.fromEntries(['folder','room','team'].map(type=>[type,[owner,...contacts.slice(0,19).map((c,i)=>{const role=type==='team'?(i%3===0?'admin':'member'):['manager','manager','viewer','editor','manager','editor','viewer'][i%7];return {user_id:c.id,wecom_userid:c.userId,name:c.name,department:c.department,role,...(type==='room'?{direct_role:i===3?null:role,folder_role:i===3?'editor':null}:{})}})]]));writes=[]}
reset()
async function main(){
 let compiled
 const ctx=await esbuild.context({
  stdin:{resolveDir:root,contents:`import Vue from 'vue/dist/vue.esm.js';import ElementUI from 'element-ui';import 'element-ui/lib/theme-chalk/index.css';import Dialog from './src/pages/ProductShell/components/ShareFolderDialog.vue';import {setProductHttp} from './src/services/productHttp';Vue.use(ElementUI);setProductHttp(async(path,options={})=>{const r=await fetch(path,options);const d=await r.json();if(!r.ok)throw new Error(d.error);return d});new Vue({data:()=>({visible:false,type:'folder',revision:0}),methods:{open(type){this.type=type;this.visible=true},async reset(){await fetch('/fixture/reset',{method:'POST'});this.visible=false;this.revision++},async fail(){await fetch('/fixture/fail',{method:'POST'});this.open('folder')}},template:'<main><nav aria-label="验证入口"><span>权限设置 · 本地验证</span><el-button @click="open(\\'folder\\')">文件夹权限</el-button><el-button @click="open(\\'room\\')">文件权限</el-button><el-button @click="open(\\'team\\')">团队权限</el-button><el-button @click="reset">重置测试数据</el-button><el-button @click="fail">模拟加载失败</el-button></nav><Dialog :key="revision" :visible.sync="visible" :resource-type="type" :folder="{id:\\'demo\\',name:\\'公司资料\\',owner:{id:\\'local-owner\\',name:\\'李继兵\\'}}" :room="{roomKey:\\'demo\\',title:\\'项目规划\\'}" :team="{id:\\'demo\\',name:\\'项目团队\\'}" /></main>',components:{Dialog}}).$mount('#app')`},
  bundle:true,write:false,outdir:'permission-demo',platform:'browser',define:{'process.env.NODE_ENV':'"test"'},alias:{'@':path.join(root,'src')},loader:{'.woff':'dataurl','.ttf':'dataurl','.woff2':'dataurl'},
  plugins:[{name:'permission-sfc',setup(build){
   build.onEnd(r=>{if(!r.errors.length)compiled=r})
   build.onLoad({filter:/src\/utils\/auth\.js$/},()=>({contents:'export const getCurrentUser=()=>({id:"local-owner"})',loader:'js'}))
   build.onResolve({filter:/\?permission-style$/},a=>({path:a.path.slice(0,-'?permission-style'.length),namespace:'permission-style'}))
   build.onLoad({filter:/.*/,namespace:'permission-style'},async a=>{const s=compiler.parseComponent(fs.readFileSync(a.path,'utf8'));let css='';for(const style of s.styles){const raw=(await less.render(style.content,{filename:a.path})).css;css+=style.scoped?compileStyle({source:raw,filename:a.path,id:'data-v-permission-fixture',scoped:true}).code:raw}return {contents:css,loader:'css',watchFiles:[a.path]}})
   build.onLoad({filter:/\.vue$/},a=>{const s=compiler.parseComponent(fs.readFileSync(a.path,'utf8'));return {contents:'import '+JSON.stringify(a.path+'?permission-style')+';'+s.script.content.replace('export default','const component=')+';component.template='+JSON.stringify(s.template.content)+';component._scopeId="data-v-permission-fixture";export default component',resolveDir:path.dirname(a.path),loader:'js',watchFiles:[a.path]}})
  }}]
 })
 await ctx.rebuild();await ctx.watch()
 const server=http.createServer(async(req,res)=>{
  const u=new URL(req.url,'http://localhost');res.setHeader('Content-Type','application/json; charset=utf-8');const send=(d,status=200)=>{res.writeHead(status);res.end(JSON.stringify(d))}
  if(u.pathname==='/fixture/reset'){reset();return send({ok:true})}if(u.pathname==='/fixture/fail'){failNext=true;return send({ok:true})}if(u.pathname==='/fixture/writes')return send(writes)
  if(u.pathname==='/api/wecom/departments')return send({list:[{id:1,name:'总经办',parentId:0},{id:2,name:'人事组',parentId:1},{id:3,name:'技术组',parentId:1}]})
  if(u.pathname==='/api/wecom/contacts'){const q=(u.searchParams.get('search')||'').toLowerCase(),dep=u.searchParams.get('departmentId'),offset=Number(u.searchParams.get('offset')||0),limit=Number(u.searchParams.get('limit')||100);const list=contacts.filter(c=>(!dep||c.departmentIds.includes(dep))&&(!q||[c.name,c.userId,c.id].join(' ').toLowerCase().includes(q)));return send({list:list.slice(offset,offset+limit),total:list.length})}
  const m=u.pathname.match(/^\/api\/(folders|files|teams)\/([^/]+)\/members(?:\/(.+))?$/)
  if(m){
   if(failNext){failNext=false;return send({error:'模拟：权限服务暂不可用'},503)}const type={folders:'folder',files:'room',teams:'team'}[m[1]],list=members[type];if(req.method==='GET')return send({list,canManage:true})
   let raw='';for await(const chunk of req)raw+=chunk;const b=raw?JSON.parse(raw):{};writes.push({method:req.method,path:u.pathname,body:b})
   const set=(id,role)=>{const c=contacts.find(c=>c.id===id||c.userId===id),existing=list.find(m=>m.user_id===id||m.wecom_userid===id);if(existing){existing.role=role;if(type==='room')existing.direct_role=role;return existing}const row={user_id:c?c.id:id,wecom_userid:c?c.userId:id,name:c?c.name:id,department:c?c.department:'',role};list.push(row);return row}
   if(m[3]==='bulk'){const ids=new Set(b.userIds||[]),deps=new Set(b.departmentIds||[]);if(b.includeChildren!==false&&deps.has('1')){deps.add('2');deps.add('3')}contacts.filter(c=>c.departmentIds.some(d=>deps.has(d))).forEach(c=>ids.add(c.userId));const canonical=new Set([...ids].map(id=>(contacts.find(c=>c.id===id||c.userId===id)||{id}).id));let changed=0,unchanged=0;for(const id of canonical){const old=list.find(m=>m.user_id===id);if(b.onlyChanges&&old&&old.role===b.role){unchanged++;continue}set(id,b.role);changed++}return send({list,changed,unchanged})}
   if(req.method==='DELETE'){members[type]=list.filter(row=>row.user_id!==decodeURIComponent(m[3]));return send({ok:true})}if(type==='team'&&Array.isArray(b.wecomUserIds)){b.wecomUserIds.forEach(id=>set(id,'member'));return send({list})}return send({list,...set(decodeURIComponent(m[3]||b.userId),String(b.role||'member').toLowerCase())})
  }
  if(u.pathname==='/demo.js'||u.pathname==='/demo.css'){const ext=u.pathname.endsWith('.css')?'.css':'.js';res.setHeader('Content-Type',ext==='.css'?'text/css':'application/javascript');res.end(compiled.outputFiles.find(f=>f.path.endsWith(ext)).contents);return}
  res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>权限弹窗本地验证</title><link rel="stylesheet" href="/demo.css"><style>body{margin:0;background:#f5f7f6;font-family:system-ui}nav{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:22px}nav>span{margin-right:16px;color:#334b41;font-weight:600}nav .el-button{margin:0}</style><div id="app"></div><script src="/demo.js"></script>')
 })
 server.listen(Number(process.env.PERMISSION_DEMO_PORT||4322),'127.0.0.1',()=>console.log('Permission dialog fixture: http://127.0.0.1:'+server.address().port))
}
main().catch(e=>{console.error(e);process.exitCode=1})
