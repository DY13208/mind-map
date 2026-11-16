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
      const summaryOwner = {data:{uid:'summary-owner',text:'待归纳',generalization:[{
        uid:'summary',text:'概要',expand:true,children:[
          {data:{uid:'summary-a',text:'概要子节点 A',customTextWidth:175,customLeft:10},children:[]},
          {data:{uid:'summary-b',text:'概要子节点 B'},children:[
            {data:{uid:'summary-b-child',text:'后代',customLeft:20,customTop:30},children:[]}]},
          {data:{uid:'summary-c',text:'概要子节点 C',customLeft:40,customTop:50},children:[]}
        ]
      }]},children:[]}
      const destinationBranch = {data:{uid:'target',text:'目标分支'},children:[
        {data:{uid:'existing',text:'已有子节点'},children:[]}]}
      window.map = new MindMap({el:document.getElementById('map'),data:{data:{uid:'root',text:'根节点'},
        children:location.hash==='#source'?[branch,summaryOwner,{...leaf,data:{...leaf.data,uid:'empty',text:''}}]:[destinationBranch]},fit:true})
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
      window.paste = async (uid = 'root') => {select(uid);await map.renderer.paste()}
      window.copyMultiple = async uids => {
        map.execCommand('CLEAR_ACTIVE_NODE')
        map.renderer.activeMultiNode(uids.map(uid => map.renderer.findNodeByUid(uid)))
        await map.renderer.copy()
      }
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

    await source.bringToFront()
    await source.evaluate(() => copyMultiple(['sibling', 'child']))
    const ordinaryCopy = await source.evaluate(() => read())
    assert.deepEqual(ordinaryCopy.payload.data.map(node => node.data.text), ['子主题1', '子主题2'])
    await destination.bringToFront()
    await destination.evaluate(() => paste())
    await destination.waitForFunction(() => !map.renderer.isRendering)
    assert.deepEqual(await destination.evaluate(() => map.getData().children.slice(-2).map(node => node.data.text)), ['子主题1', '子主题2'])

    await source.bringToFront()
    await source.evaluate(() => copyMultiple(['summary-c', 'summary-b-child', 'summary-b', 'summary-a']))
    const summaryCopy = await source.evaluate(() => read())
    const copiedNodes = summaryCopy.payload.data
    const summaryTitles = ['概要子节点 A', '概要子节点 B', '概要子节点 C']
    assert.deepEqual(copiedNodes.map(node => node.data.text), summaryTitles)
    assert.equal(copiedNodes[0].data.customTextWidth, 175)
    assert.equal(copiedNodes[1].children[0].data.text, '后代')
    for (const { data } of [...copiedNodes, copiedNodes[1].children[0]]) {
      assert.equal(data.customLeft, undefined)
      assert.equal(data.customTop, undefined)
    }
    assert.equal(await source.evaluate(() => map.renderer.findNodeByUid('summary-a').getData('customLeft')), 10)
    await destination.bringToFront()
    await destination.evaluate(() => paste('target'))
    await destination.waitForFunction(() => !map.renderer.isRendering)
    const pasted = await destination.evaluate(() => {
      const target = map.renderer.findNodeByUid('target')
      const geometry = (node, index) => {
        const path = node.parent._lines[index].node
        const end = path.getPointAtLength(path.getTotalLength())
        return {
          text: node.getData('text'), left: node.left, top: node.top,
          right: node.left + node.width, bottom: node.top + node.height,
          lineEndsAtNode: Math.abs(end.x - node.left) < 0.1 &&
            Math.abs(end.y - (node.top + node.height / 2)) < 0.1,
          children: node.children.map(geometry)
        }
      }
      return { targetRight: target.left + target.width, children: target.children.map(geometry) }
    })
    assert.deepEqual(pasted.children.map(node => node.text), ['已有子节点', ...summaryTitles])
    const [, first, middle, last] = pasted.children
    assert.ok(first.left > pasted.targetRight && first.left === middle.left && middle.left === last.left)
    assert.ok(first.bottom < middle.top && middle.bottom < last.top)
    assert.ok(middle.children[0].left > middle.right)
    assert.ok([...pasted.children, ...middle.children].every(node => node.lineEndsAtNode))

    assert.deepEqual(errors, [])
    console.log('PASS browser clipboard: attachments, links, native copy, cross-page paste, and summary branch order and positioning')
  } finally {
    if (browser) await browser.close()
    await new Promise(resolve => server.close(resolve))
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
