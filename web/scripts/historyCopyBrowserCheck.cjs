const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const esbuild = require('../node_modules/esbuild')
const compiler = require('../node_modules/vue-template-compiler')
const less = require('../node_modules/less')
let chromium
try { ({ chromium } = require('playwright')) }
catch (error) { ({ chromium } = require('../../simple-mind-map/node_modules/@playwright/test')) }

async function main() {
  const repo = path.resolve(__dirname, '../..')
  const bundle = await esbuild.build({
    stdin: { resolveDir: repo, contents: `
      import Vue from './web/node_modules/vue/dist/vue.esm.js'
      import ElementUI from './web/node_modules/element-ui'
      import MindMap from './simple-mind-map/index.js'
      import Preview from './web/src/pages/ProductShell/components/HistoryMapPreview.vue'
      Vue.use(ElementUI)
      window.notices = []
      Vue.prototype.$message = {
        success: text => notices.push(text), warning: text => notices.push(text), error: text => notices.push(text)
      }
      const tree = {data:{uid:'root',text:'旧版根'},children:[]}
      for(let i=0;i<60;i++) tree.children.push({data:{uid:'b'+i,text:'旧分支 '+i,expand:false},children:[
        {data:{uid:'leaf'+i,text:'旧叶子 '+i,note:'完整备注',attachmentId:'history-file',attachmentName:'历史附件'},children:[]}
      ]})
      tree.children[0].data.associativeLineTargets=['leaf0','b1']
      window.source = JSON.stringify(tree)
      window.host = new Vue({data:{tree},render(h){return h(Preview,{ref:'preview',props:{tree:this.tree,roomKey:'test-room'}})}}).$mount('#preview')
      window.preview = host.$refs.preview
      window.current = new MindMap({el:document.getElementById('current'),data:{data:{uid:'now',text:'当前根'},children:[]},historyCopyRoomKey:'test-room',fit:true})
      window.clipText = ''
      window.clipDenied = false
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{
        writeText:async text=>{if(clipDenied) throw Error('denied');clipText=text},
        read:async()=>{if(clipDenied) throw Error('denied');return clipText?[{types:['text/plain'],getType:async()=>new Blob([clipText])}]:[]}
      }})
      document.execCommand = () => false
      window.point = uid => {const node=preview._preview.renderer.findNodeByUid(uid);const r=node.group.node.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}}
      window.ready = true
    ` },
    bundle: true, write: false, platform: 'browser',
    define: { 'process.env.NODE_ENV': '"test"' },
    alias: { 'simple-mind-map': path.join(repo, 'simple-mind-map'), '@': path.join(repo, 'web/src') },
    nodePaths: [path.join(repo, 'web/node_modules')], loader: { '.css': 'empty' },
    plugins: [{ name: 'vue', setup(build) {
      build.onLoad({ filter: /\.vue$/ }, async args => {
        const parsed = compiler.parseComponent(fs.readFileSync(args.path, 'utf8'))
        const css = (await less.render(parsed.styles.map(style=>style.content.replace(/\/deep\//g,' ')).join('\n'))).css
        return { contents: parsed.script.content.replace('export default', 'const component =') +
          '\ncomponent.template = ' + JSON.stringify(parsed.template.content) +
          '\nconst style=document.createElement("style");style.textContent='+JSON.stringify(css)+';document.head.appendChild(style);\nexport default component',
        resolveDir: path.dirname(args.path), loader: 'js' }
      })
    } }]
  })
  const server = http.createServer((req, res) => {
    if (req.url === '/test.js') { res.setHeader('Content-Type','application/javascript'); res.end(bundle.outputFiles[0].contents) }
    else if(req.url.startsWith('/fonts/')) {const font=path.join(repo,'web/node_modules/element-ui/lib/theme-chalk/fonts',path.basename(req.url.split('?')[0]));res.end(fs.existsSync(font)?fs.readFileSync(font):'')}
    else res.end('<style>'+fs.readFileSync(path.join(repo,'web/node_modules/element-ui/lib/theme-chalk/index.css'),'utf8')+'</style><style>body{font-family:Arial,"Microsoft YaHei",sans-serif}#preview{width:1150px;height:650px}#current{width:800px;height:300px}</style><div id="preview"></div><div id="current"></div><script src="/test.js"></script>')
  })
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
  const browser = await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL || 'msedge'})
  try {
    const page = await browser.newPage({viewport:{width:1280,height:1050}})
    const errors=[]
    page.on('pageerror', error=>errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    try { await page.waitForFunction(()=>window.ready && preview._preview && !preview._preview.renderer.isRendering) }
    catch(error){throw new Error(error.message+'; page errors: '+errors.join('; '))}
    await page.evaluate(()=>preview._preview.renderer.goTargetNode('b0'))
    let point = await page.evaluate(()=>point('b0'))
    await page.mouse.click(point.x,point.y)
    await page.waitForFunction(()=>preview.selection.branchCount===1)
    await page.keyboard.press('Control+c')
    await page.waitForFunction(()=>!!window.clipText)
    const copied = await page.evaluate(()=>JSON.parse(clipText).data)
    assert.equal(copied.length,1)
    assert.equal(copied[0].children[0].data.note,'完整备注')
    assert.equal(copied[0].children[0].data.attachmentId,'history-file')
    assert.deepEqual(copied[0].data.associativeLineTargets,['leaf0'])
    assert.equal(await page.evaluate(()=>JSON.stringify(host.tree)===source),true)
    // 真实历史副本走现有粘贴路径，两次粘贴均为新节点。
    await page.evaluate(async()=>{current.renderer.root.active();await current.renderer.paste()})
    await page.waitForFunction(()=>!current.renderer.isRendering)
    await page.evaluate(async()=>{current.execCommand('CLEAR_ACTIVE_NODE');current.renderer.root.active();await current.renderer.paste()})
    try { await page.waitForFunction(()=>current.renderer.renderTree.children.length===2,{},{timeout:5000}) }
    catch(error){throw new Error(error.message+'; paste state: '+JSON.stringify(await page.evaluate(()=>({children:current.renderer.renderTree.children.map(n=>({uid:n.data.uid,text:n.data.text,count:n.children.length})),active:current.renderer.activeNodeList.map(n=>n.getData('uid')),clipText,errors:notices}))))}
    const ids=await page.evaluate(()=>current.renderer.renderTree.children.map(n=>n.data.uid))
    assert.notEqual(ids[0],ids[1]);assert.ok(!ids.includes('b0'))
    assert.equal(await page.evaluate(()=>current.renderer.renderTree.children.every(n=>n.data.associativeLineTargets[0]===n.children[0].data.uid)),true)
    // 剪贴板权限拒绝时保留完整同房间副本；外部内容仍优先。
    await page.evaluate(()=>{clipDenied=true;clipText='';preview.onNodeActive(null,[preview._preview.renderer.findNodeByUid('b1')])})
    await page.getByText('复制选中分支',{exact:true}).click()
    await page.waitForFunction(()=>notices.some(t=>t.includes('系统剪贴板不可用')))
    await page.evaluate(async()=>{current.execCommand('CLEAR_ACTIVE_NODE');current.renderer.root.active();await current.renderer.paste()})
    await page.waitForFunction(()=>current.renderer.renderTree.children.length===3)
    assert.equal(await page.evaluate(()=>current.renderer.renderTree.children[2].data.text),'旧分支 1')
    await page.evaluate(async()=>{clipDenied=false;clipText='外部最新内容';current.execCommand('CLEAR_ACTIVE_NODE');current.renderer.root.active();await current.renderer.paste()})
    await page.waitForFunction(()=>current.renderer.renderTree.children.length===4)
    assert.equal(await page.evaluate(()=>current.renderer.renderTree.children[3].data.text),'外部最新内容')
    // 加载更多占位和只读写操作不改变历史。
    await page.evaluate(()=>{const p=preview._preview;p.execCommand('REMOVE_NODE');p.execCommand('INSERT_CHILD_NODE');p.execCommand('PASTE_NODE',[]);preview.onNodeActive(null,[p.renderer.findNodeByUid('__history_preview_more__')])})
    assert.equal(await page.evaluate(()=>preview.selection.branchCount),0)
    await page.evaluate(()=>preview.onNodeActive(null,[preview._preview.renderer.root]))
    await page.getByText('复制选中分支',{exact:true}).click()
    await page.waitForFunction(()=>JSON.parse(clipText).data[0].children.length===60)
    assert.equal(await page.evaluate(()=>JSON.parse(clipText).data[0].children.some(n=>n.data.uid==='__history_preview_more__')),false)
    const dir=path.join(repo,'output/playwright/history-phase1')
    fs.mkdirSync(dir,{recursive:true})
    await page.screenshot({path:path.join(dir,'history-copy.png'),fullPage:true})
    await page.evaluate(()=>preview.teardown())
    assert.equal(await page.evaluate(()=>{const event=new KeyboardEvent('keydown',{bubbles:true,cancelable:true,ctrlKey:true,key:'c'});preview.$refs.canvas.dispatchEvent(event);return event.defaultPrevented}),false)
    assert.deepEqual(errors,[])
    console.log('PASS: real selection/shortcut copy, complete folded subtree, fresh paste IDs, clipboard denial fallback, external clipboard priority and readonly writes')
  } finally { await browser.close();await new Promise(resolve=>server.close(resolve)) }
}
main().catch(error=>{console.error(error);process.exitCode=1})
