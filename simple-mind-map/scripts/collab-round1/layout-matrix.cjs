// Disposable pages only; never changes a user's saved layout preference.
const fs = require('fs'), path = require('path'), http = require('http')
const { performance } = require('perf_hooks')
const { createHash } = require('crypto')
const { execFileSync } = require('child_process')
const { summarize } = require('./metrics.cjs')
const root = path.resolve(__dirname, '../../..')
const outputRoot = 'D:/mind-map-collab-round1-results'
const runDir = path.join(outputRoot, 'layout-' + new Date().toISOString().replace(/[:.]/g, '-'))
const esbuild = require(path.join(root, 'web/node_modules/esbuild'))
const { chromium } = require(path.join(root, 'simple-mind-map/node_modules/playwright'))
const rows = []
const timeoutMs = 45000
const sizes = process.argv.includes('--deep-only') ? [1000] : [100,300,600,1000]
const shapes = process.argv.includes('--deep-only') ? ['deep'] : ['wide','deep','mixed']
function fixture(size, shape) {
  const nodes = Array.from({ length: size }, (_, i) => ({ data: { uid: `layout-${i}`, text: `Node ${i}`, expand: true }, children: [] }))
  for (let i = 1; i < size; i++) nodes[shape === 'wide' ? 0 : shape === 'deep' ? i - 1 : Math.floor((i - 1) / 8)].children.push(nodes[i])
  return nodes[0]
}
function fixtureJson(size, shape) {
  if (shape !== 'deep') return JSON.stringify(fixture(size, shape))
  // Windows Node's JSON.stringify can overflow on a valid 1000-node chain.
  // Serialize iteratively; the browser still receives the identical fixture.
  let serialized = ''
  for (let i = size - 1; i >= 0; i--) {
    const data = JSON.stringify({ uid: `layout-${i}`, text: `Node ${i}`, expand: true })
    serialized = `{"data":${data},"children":[${serialized}]}`
  }
  return serialized
}
async function main() {
  fs.mkdirSync(runDir, { recursive: true })
  await esbuild.build({ entryPoints: [path.join(__dirname, 'layout-entry.js')], bundle: true,
    outfile: path.join(runDir, 'layout.js'), format: 'iife', platform: 'browser', target: 'chrome120',
    loader: { '.svg': 'dataurl', '.png': 'dataurl', '.jpg': 'dataurl' }, define: { 'process.env.NODE_ENV': '"production"' } })
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({ sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    bundleHash: createHash('sha256').update(fs.readFileSync(path.join(runDir, 'layout.js'))).digest('hex'),
    sizes, shapes, repeats: 3, timeoutMs,
    measurement: 'doLayout entry through callback; excludes paint', preferenceChange: 'disposable test instances only' }, null, 2))
  const server = http.createServer((req, res) => {
    if (req.url === '/layout.js') { res.setHeader('Content-Type', 'application/javascript'); fs.createReadStream(path.join(runDir, 'layout.js')).pipe(res); return }
    res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><meta charset="utf-8"><div id="map" style="width:1400px;height:900px"></div><script src="/layout.js"></script>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  try {
    for (const size of sizes) for (const shape of shapes) for (let repeat = 0; repeat < 3; repeat++) for (const compact of (repeat % 2 ? [true, false] : [false, true])) {
      const start = performance.now()
      let browser, timer, sample = { size, shape, repeat, compact, ok: false }
      const file = path.join(runDir, 'layout.jsonl')
      fs.appendFileSync(file, JSON.stringify({ kind: 'attempt_started', ...sample }) + '\n')
      try {
        browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true })
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
        let rejectPageError
        const pageError = new Promise((_, reject) => { rejectPageError = reject })
        page.on('pageerror', error => rejectPageError(new Error('PAGE_ERROR:' + error.message)))
        await page.goto(url)
        const operation = page.evaluate(({ fixtureJson, compact }) => new Promise((resolve, reject) => {
          const data = JSON.parse(fixtureJson)
          let mm
          window.__COLLAB_PERF_OBSERVER__ = event => {
            if (event.kind !== 'layout') return
            if (!mm) { reject(new Error('SYNCHRONOUS_LAYOUT_OBSERVER')); return }
            resolve({ layout: event, renderedNodes: Object.keys(mm.renderer.nodeCache).length, preferenceAfter: mm.opt.compactLayout })
          }
          mm = new window.Round1MindMap({ el: document.getElementById('map'), data,
            layout: 'logicalStructure', compactLayout: compact, fit: false,
            errorHandler: (code, error) => reject(new Error(`${code}:${error && error.message || 'unknown'}`)) })
        }), { fixtureJson: fixtureJson(size, shape), compact })
        const result = await Promise.race([operation, pageError, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('LAYOUT_TIMEOUT')), timeoutMs) })])
        if (!result.layout || result.layout.visibleNodes !== size || result.renderedNodes !== size || result.preferenceAfter !== compact) throw new Error('LAYOUT_INVARIANT_FAILED')
        sample = { ...sample, ok: true, elapsedMs: result.layout.elapsedMs, wallMs: performance.now() - start, ...result }
      } catch (error) { sample = { ...sample, elapsedMs: performance.now() - start, code: error.message, censored: error.message === 'LAYOUT_TIMEOUT' } }
      finally { clearTimeout(timer); if (browser) await browser.close().catch(() => {}) }
      rows.push(sample); fs.appendFileSync(file, JSON.stringify({ kind: 'sample', ...sample }) + '\n')
      console.log(JSON.stringify({ size, shape, repeat, compact, ok: sample.ok, ms: Math.round(sample.elapsedMs), code: sample.code }))
      fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify({ complete: false, timeoutMs,
        groups: [...new Set(rows.map(x => `${x.size}/${x.shape}/${x.compact}`))].map(key => ({ key, ...summarize(rows.filter(x => `${x.size}/${x.shape}/${x.compact}` === key)) })), rawDirectory: runDir }, null, 2))
    }
    const summary = JSON.parse(fs.readFileSync(path.join(runDir, 'summary.json'))); summary.complete = true
    summary.warning = '3 samples per group: P95/P99 equal to maximum; not enough evidence for a production threshold'
    fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2))
  } finally { await new Promise(resolve => server.close(resolve)) }
  console.log('rawDirectory=' + runDir)
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
