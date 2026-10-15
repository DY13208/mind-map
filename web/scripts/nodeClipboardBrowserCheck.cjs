const assert = require('node:assert/strict')
const http = require('node:http')
const path = require('node:path')
const esbuild = require('../node_modules/esbuild')
const { chromium } = require('../../simple-mind-map/node_modules/@playwright/test')

async function main() {
  const repo = path.resolve(__dirname, '../..')
  const bundle = await esbuild.build({
    stdin: { resolveDir: repo, contents: `
      import MindMap from './simple-mind-map/index.js'
      import { readSmmClipboardHtml } from './simple-mind-map/src/utils/copyOutline.js'
      const leaf = {data:{uid:'leaf',text:'子主题1',hyperlink:'https://example.com/source',
        attachmentId:'source-file',attachmentName:'品牌趋势10.13.html',attachmentStatus:'ready',note:'保留备注'},children:[]}
      const branch = {data:{uid:'branch',text:'分支主题1',expand:true},children:[
        {data:{uid:'child',text:'子主题1'},children:[leaf]},
        {data:{uid:'sibling',text:'子主题2'},children:[]}]}
      window.map = new MindMap({el:document.getElementById('map'),data:{data:{uid:'root',text:'根节点'},
        children:location.hash==='#source'?[branch,{...leaf,data:{...leaf.data,uid:'empty',text:''}}]:[]},fit:true})
      window.select = uid => {map.execCommand('CLEAR_ACTIVE_NODE');map.renderer.findNodeByUid(uid).active()}
      window.copy = async (uid, native) => {
        select(uid)
        const clipboard = navigator.clipboard
        if(native) Object.defineProperty(navigator,'clipboard',{configurable:true,value:undefined})
        try { await map.renderer.copy() }
        finally { if(native) Object.defineProperty(navigator,'clipboard',{configurable:true,value:clipboard}) }
      }
      window.read = async () => {
        const items=await navigator.clipboard.read()
        const item=items[0]
        const text=item.types.includes('text/plain')?await (await item.getType('text/plain')).text():''
        const html=item.types.includes('text/html')?await (await item.getType('text/html')).text():''
        return {text,payload:readSmmClipboardHtml(html)}
      }
      window.paste = async () => {select('root');await map.renderer.paste()}
      window.ready=true
    ` }, bundle: true, write: false, platform: 'browser', external: ['buffer'], logLevel: 'warning'
  })
  const server = http.createServer((req, res) => {
    if (req.url === '/test.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(bundle.outputFiles[0].contents) }
    else res.end('<style>#map{width:1000px;height:600px}</style><div id="map"></div><script src="/test.js"></script>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let browser
  try {
    browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' })
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
    const source = await context.newPage()
    const destination = await context.newPage()
    const errors = []
    for (const page of [source, destination]) page.on('pageerror', error => errors.push(error.message))
    const origin = `http://127.0.0.1:${server.address().port}`
    await source.goto(origin + '/#source')
    await destination.goto(origin)
    for (const page of [source, destination]) await page.waitForFunction(() => window.ready && !map.renderer.isRendering)
    for (const native of [false, true]) {
      for (const uid of ['branch', 'leaf', 'empty']) {
        await source.bringToFront()
        await source.evaluate(({uid,native}) => copy(uid,native), {uid,native})
        const copied = await source.evaluate(() => read())
        assert.equal(copied.text.replace(/\r\n/g, '\n'), uid === 'branch' ? '分支主题1\n\t子主题1\n\t\t子主题1\n\t子主题2' : uid === 'leaf' ? '子主题1' : '')
        assert.equal(copied.payload.simpleMindMap, true, 'browser preserves hidden HTML metadata')
        await destination.bringToFront()
        await destination.evaluate(() => paste())
        await destination.waitForFunction(() => !map.renderer.isRendering)
        const pasted = await destination.evaluate(() => map.getData().children.slice(-1)[0])
        const leaf = uid === 'branch' ? pasted.children[0].children[0] : pasted
        assert.equal(leaf.data.attachmentId, 'source-file', 'fresh editor page retains attachment')
        assert.equal(leaf.data.hyperlink, 'https://example.com/source', 'fresh editor page retains hyperlink')
        assert.equal(leaf.data.note, '保留备注')
      }
    }
    assert.deepEqual(errors, [])
    console.log('PASS browser clipboard: plain titles, hidden HTML, single leaf/subtree, modern/native copy, fresh-page paste with attachments and links')
  } finally {
    if (browser) await browser.close()
    await new Promise(resolve => server.close(resolve))
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
