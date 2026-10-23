'use strict'
// Reuse the native MCP/HTTP/PG isolated fixture; run only the text-edit regression.
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const fixture = path.join(__dirname, 'mcp-guards-browser.cjs')
let source = fs.readFileSync(fixture, 'utf8')
source = source.replace("'mcp-guards-seed.cjs'", "'text-edit-seed.cjs'")
source = source.replace("scope: '3 real browsers, owned 10000-node room, native MCP and product backend; test-only identity endpoint; loopback traffic only'", "scope: 'One native browser, owned small room in ephemeral PostgreSQL, native MCP/HTTP/Socket; synthetic test identity; loopback only'")
source = source.replace("for (const actor of ['owner', 'editor-a', 'editor-b'])", "for (const actor of ['owner'])")
const start = source.indexOf('  const converge = async revision => {')
const end = source.indexOf('\nmain().catch(error =>')
const focused = async function () {
  const { page } = clients[0]
  const flags = ['scopedRemoteLineRender', 'canvasTextMeasure', 'scopedRemoteGeometry', 'deferDraftCopy', 'analyticEdgeBounds', 'lazyOffscreenPaint']
  const bind = async () => page.waitForFunction(`(() => { const mm = (${mapInBrowser.toString()})(); if(mm) window.__guardMM=mm; return mm && mm.renderer.root && !mm.renderer.isRendering && mm.cooperate.collabV2Adapter.getStatus().phase==='LIVE'; })()`)
  const snapshot = () => page.evaluate(() => {
    const mm = __guardMM, e = mm.richText && mm.richText.showTextEdit ? mm.richText : mm.renderer.textEdit
    return { open: e.showTextEdit, flags: mm.opt.performanceFlags, uid: (e.node || e.currentNode)?.getData('uid'), session: e.editSessionId && mm.cooperate.getEditSession(e.editSessionId), status: mm.cooperate.collabV2Adapter.getStatus() }
  })
  for (const rich of [true, false]) for (const enabled of [false, true]) {
    await clients[0].context.addInitScript(rich => localStorage.setItem('SIMPLE_MIND_MAP_LOCAL_CONFIG', JSON.stringify({enableAi:false,showNavigator:false,openNodeRichText:rich})),rich)
    await page.goto(origin + '/?room=' + roomKey + '&perfFlags=' + (enabled ? flags.join(',') : 'none') + '&perfDiagnostics=1')
    await bind()
    await page.evaluate(() => {
      window.__textTrace = []
      const c = __guardMM.cooperate, submit = c.submitV2.bind(c)
      c.submitV2 = async (type, payload) => {
        __textTrace.push({ phase: 'submit', type, payload })
        try { const result = await submit(type, payload); __textTrace.push({ phase: 'ack', type, result }); return result }
        catch (error) { __textTrace.push({ phase: 'error', type, code: error.code }); throw error }
      }
    })
    // Select the root through its real SVG and insert using the normal shortcut.
    await page.waitForTimeout(500)
    const center = await page.evaluate(() => { const r=__guardMM.renderer.root._textData.node.node.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2} })
    await page.mouse.click(center.x, center.y)
    await page.waitForFunction(() => __guardMM.renderer.activeNodeList.some(n=>n.getData('uid')==='root'))
    await page.keyboard.press('Tab')
    await page.waitForFunction(() => __guardMM.renderer.textEdit.isShowTextEdit()).catch(async error => { await page.screenshot({path:path.join(OUT,'insert-failure.png')}); throw error })
    const before = await snapshot(), uid = before.uid
    const text = '节点文字持久化-' + (enabled ? 'all-on' : 'all-off') + '-' + Date.now()
    const selector = await page.evaluate(() => __guardMM.richText?.showTextEdit ? '.smm-richtext-node-edit-wrap .ql-editor' : '.smm-node-edit-wrap')
    await page.locator(selector).fill(text)
    await page.waitForFunction(() => __textTrace.some(row => row.phase === 'ack' && row.type === 'node.insert'))
    const afterInsert = await snapshot()
    const other = await page.evaluate(() => { const r=__guardMM.renderer.root._textData.node.node.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2} })
    await page.mouse.click(other.x, other.y)
    await page.waitForFunction(() => !__guardMM.renderer.textEdit.isShowTextEdit(), null, { timeout: 5000 }).catch(() => {})
    if (!process.argv.includes('--repro')) await page.waitForFunction(() => __guardMM.cooperate.collabV2Adapter.getStatus().pendingCount === 0)
    const afterClick = await snapshot()
    const trace = await page.evaluate(() => __textTrace)
    await page.reload()
    await bind()
    await page.waitForTimeout(700)
    const persisted = await query(uid)
    await page.waitForFunction(uid => !!__guardMM.renderer.findNodeByUid(uid)?._textData?.node?.node?.isConnected, uid)
    const refreshed = await page.evaluate(uid => {const n=__guardMM.renderer.findNodeByUid(uid);return {text:n.getData('text'),dom:n._textData.node.node.textContent,sessions:__guardMM.cooperate.listEditSessions(),status:__guardMM.cooperate.collabV2Adapter.getStatus()}},uid)
    await page.screenshot({path:path.join(OUT, (rich?'rich-':'plain-')+(enabled?'all-on':'all-off')+'-after-refresh.png')})
    const row = { rich, enabled, uid, text, before, afterInsert, afterClick, trace, persisted, refreshed }
    report.checks.push(row)
    console.log(JSON.stringify({enabled, open:afterClick.open, afterInsert:afterInsert.session, persisted}))
    if (!process.argv.includes('--repro')) {
      assert.equal(afterClick.open, false, 'clicking another node closes editor')
      assert.ok(trace.some(row => row.phase === 'ack' && row.type === 'node.update' && row.result.ok !== false), 'text update ACK')
      assert.equal(trace.filter(row => row.phase === 'submit' && row.type === 'node.update').length,1,'one click submits text exactly once')
      assert.equal(refreshed.sessions.length,0,'no duplicate-write conflict drafts after refresh')
      assert.equal(refreshed.status.pendingCount,0)
      assert.ok(JSON.stringify(persisted).includes(text), 'MCP after F5 must read saved text')
      assert.ok(refreshed.text.includes(text) && refreshed.dom.includes(text), 'refreshed model and visible SVG must retain text')
      for (const flag of flags) assert.equal(!!before.flags[flag],enabled, 'actual performance flag '+flag)
    }
  }
  report.passed = !report.checks.some(row => row.afterClick?.open)
}
source = source.slice(0, start) + '\n  await (' + focused.toString() + ')()\n}\n' + source.slice(end)
const runtime = new Module(fixture, module)
runtime.filename = fixture
runtime.paths = module.paths
runtime._compile(source, fixture)

