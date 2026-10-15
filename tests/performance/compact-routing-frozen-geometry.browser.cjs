const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const cp = require('node:child_process')
const crypto = require('node:crypto')
const { createRequire } = require('node:module')
const { createHarness, repo } = require('./engine-harness.cjs')
const webRequire = createRequire(path.join(repo, 'web/package.json'))
const babel = webRequire('@babel/core')
const sourcePath = path.join(repo, 'simple-mind-map/src/layouts/CompactStructure.js')
const base = 'd5793106098afe8a2ff9bbb60193bc25e5e45f88'

// Compile the actual production source (current and frozen Git base). Relative
// imports resolve against the same live modules, so both classes run on the
// real engine. No routing model is copied or rewritten.
function compile(source) {
  return babel.transformSync(source, { filename: sourcePath, babelrc: false, configFile: false,
    plugins: [({ types: t }) => ({ visitor: {
      ImportDeclaration(p) {
        if (p.node.source.value.startsWith('.')) p.node.source.value = path.resolve(path.dirname(sourcePath), p.node.source.value)
      }
    } })] }).code
}

const contents = `
import './tests/performance/renderer-browser-entry.js'
import CompactStructure from './simple-mind-map/src/layouts/CompactStructure.js'
import BeforeCompact from 'compact-routing-before-source'
const liveMethod = CompactStructure.prototype.assignConnectorLanes
const frozenMethod = BeforeCompact.prototype.assignConnectorLanes

function round(value) { return Math.round(value * 1000) / 1000 }
function snapshot(mm) {
  return {
    coordinates: rendererFixture.coordinates(mm),
    paths: Array.from(mm.lineDraw.node.querySelectorAll('path')).map(path => path.getAttribute('d')),
    buses: Array.from(mm.renderer.layout.busXByNode || []).map(([node, x]) => [node.getData('uid'), round(x)]),
    arms: Array.from(mm.renderer.layout.armOffsetsByNode || []).map(([node, offsets]) => [node.getData('uid'), offsets])
  }
}
function leaf(uid, children = [], extras = {}) {
  return { data: { uid, text: uid, expand: true, fontFamily: 'Arial', ...extras }, children }
}
function wide(k) {
  return { data: { uid: 'root', text: 'Root', expand: true, fontFamily: 'Arial' }, children:
    Array.from({ length: k }, (_, i) => leaf('b' + i, [leaf('b' + i + 'l0'), leaf('b' + i + 'l1')])) }
}
function floating(k) {
  const data = wide(k)
  data.children[1].data.isFloating = true
  data.children[1].data.customLeft = 900
  data.children[1].data.customTop = 120
  data.children[4].data.isFloating = true
  data.children[4].data.customLeft = 940
  data.children[4].data.customTop = 520
  data.children[4].children[0].data.customLeft = 1120
  data.children[4].children[0].data.customTop = 470
  return data
}
function custom(k) {
  const data = wide(k)
  data.children[2].data.customLeft = 880
  data.children[2].data.customTop = 180
  data.children[5].data.expand = false
  data.children[6].children[0].data.customLeft = 700
  data.children[6].children[0].data.customTop = 240
  return data
}
// Dense nested tree with overlapping vertical spans, so connector arms must
// route around non-endpoint nodes at two depths.
function collision() {
  const data = { data: { uid: 'root', text: 'Root', expand: true, fontFamily: 'Arial' }, children: [] }
  for (let i = 0; i < 8; i++) {
    const branch = leaf('c' + i, [])
    for (let j = 0; j < 3; j++) {
      const child = leaf('c' + i + 'x' + j, [leaf('c' + i + 'x' + j + 'y0'), leaf('c' + i + 'x' + j + 'y1')])
      if (j === 1) { child.data.customLeft = 620 + i * 10; child.data.customTop = 90 + i * 70 }
      branch.children.push(child)
    }
    data.children.push(branch)
  }
  return data
}
async function run(method, factory, options = {}) {
  CompactStructure.prototype.assignConnectorLanes = method
  let mm
  try {
    mm = await rendererFixture.create(factory(), { layout: 'logicalStructure', compactLayout: true, openPerformance: false, ...options })
    if (mm.renderer.layout.constructor.name !== 'CompactStructure') throw new Error('real compact layout not selected')
    return snapshot(mm)
  } finally {
    if (mm) mm.destroy()
    CompactStructure.prototype.assignConnectorLanes = liveMethod
  }
}
window.frozenGeometry = { async compare() {
  const scenarios = [
    ['wide-20', () => wide(20), {}],
    ['floating-12', () => floating(12), {}],
    ['custom-12', () => custom(12), {}],
    ['collision-8', () => collision(), {}],
    ['collision-lineStyle', () => collision(), { themeConfig: { nodeUseLineStyle: true } }],
    ['floating-expandBtn', () => floating(10), { alwaysShowExpandBtn: true, notShowExpandBtn: false }]
  ]
  const rows = []
  for (const [scenario, factory, options] of scenarios) {
    rows.push({ scenario, frozen: await run(frozenMethod, factory, options), current: await run(liveMethod, factory, options) })
  }
  return rows
} }
`

test('compact connector routing keeps frozen coordinates/paths for floating, custom and collision fixtures', async () => {
  const phase = process.env.PERF_TDD_PHASE || 'green'
  const runId = process.env.PERF_TDD_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID()
  const destination = path.join(repo, 'work/performance-tdd', phase, 'frontend')
  fs.mkdirSync(destination, { recursive: true })
  const output = path.join(destination, 'compact-routing-frozen-geometry-' + runId + '.json')
  if (fs.existsSync(output)) throw new Error('refusing to overwrite existing evidence: ' + output)
  let before
  try { before = cp.execFileSync('git', ['show', base + ':simple-mind-map/src/layouts/CompactStructure.js'], { cwd: repo, encoding: 'utf8' }) }
  catch (error) { throw new Error('BASELINE_UNAVAILABLE: fetch the real base commit before running this test', { cause: error }) }
  const current = fs.readFileSync(sourcePath, 'utf8')
  const harness = await createHarness({ contents, stubs: {
    [sourcePath]: compile(current),
    'compact-routing-before-source': compile(before)
  } })
  const report = { base, runId, browser: harness.browser.version(), phase,
    sourceSha256: crypto.createHash('sha256').update(current).digest('hex'), startedAt: new Date().toISOString(), rows: [] }
  try {
    const rows = await harness.page.evaluate(() => window.frozenGeometry.compare())
    assert.deepEqual(harness.errors, [], 'browser exceptions are infrastructure failures')
    report.rows = rows
    for (const row of rows) {
      assert.deepEqual(row.current, row.frozen, row.scenario + ': compact routing geometry changed against the frozen base')
    }
    report.status = 'GREEN_CONFIRMED'
  } catch (error) {
    report.status = error instanceof assert.AssertionError ? 'REGRESSION_FAILED' : 'BLOCKED_ENV'
    report.error = error.stack || String(error)
    throw error
  } finally {
    report.finishedAt = new Date().toISOString()
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
    console.log('COMPACT_ROUTING_FROZEN_GEOMETRY ' + output + ' status=' + report.status)
    for (const row of report.rows) console.log('  ' + row.scenario + ' paths=' + row.current.paths.length)
    await harness.close()
  }
})
