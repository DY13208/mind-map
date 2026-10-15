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

// The live router indexes each layout component by its cached `left` once per
// depth. Between that index and a query, `assignConnectorLanes` can only move
// children to the right (`route.childLeft += shift` with a positive shift), so
// cached left <= live left and the cached-left prefix is a conservative
// superset of nodes that can satisfy the strict `segment > left` predicate.
// This test forces real child shifts (probe injected into the live source) and
// then requires the routed geometry to still equal the frozen Git base.
function compile(source, { probe = false } = {}) {
  const plugins = [({ types: t }) => ({ visitor: {
    ImportDeclaration(p) {
      if (p.node.source.value.startsWith('.')) p.node.source.value = path.resolve(path.dirname(sourcePath), p.node.source.value)
    }
  } })]
  if (probe) {
    plugins.push(({ types: t }) => ({ visitor: {
      ExpressionStatement(p) {
        const expression = p.node.expression
        if (!t.isAssignmentExpression(expression, { operator: '+=' })) return
        if (!t.isMemberExpression(expression.left) || expression.left.computed) return
        if (!t.isIdentifier(expression.left.property, { name: 'childLeft' })) return
        p.insertBefore(t.expressionStatement(t.assignmentExpression('=',
          t.memberExpression(t.identifier('window'), t.identifier('__compactShifts')),
          t.binaryExpression('+',
            t.logicalExpression('||',
              t.memberExpression(t.identifier('window'), t.identifier('__compactShifts')),
              t.numericLiteral(0)),
            t.numericLiteral(1)))))
      }
    } }))
  }
  return babel.transformSync(source, { filename: sourcePath, babelrc: false, configFile: false, plugins }).code
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
// Custom positions pull several siblings into the same vertical band so later
// routes must widen their connector gap (positive child shift).
function overlappingBands() {
  const data = { data: { uid: 'root', text: 'Root', expand: true, fontFamily: 'Arial' }, children: [] }
  for (let i = 0; i < 12; i++) {
    const branch = leaf('o' + i, [leaf('o' + i + 'l0'), leaf('o' + i + 'l1'), leaf('o' + i + 'l2')])
    if (i % 2 === 0) { branch.data.customLeft = 360 + i * 12; branch.data.customTop = 40 + i * 46 }
    if (i % 3 === 0) branch.children[1].data.customLeft = 620 + i * 24
    data.children.push(branch)
  }
  return data
}
// Two parents whose connectors share the same Y band; the later bus lane has
// to move its children right because every free lane crosses an earlier arm.
function sameBand() {
  const data = { data: { uid: 'root', text: 'Root', expand: true, fontFamily: 'Arial' }, children: [] }
  for (let i = 0; i < 20; i++) {
    const branch = leaf('s' + i, [leaf('s' + i + 'x0'), leaf('s' + i + 'x1')])
    branch.data.customTop = 300
    branch.data.customLeft = 300 + i * 20
    data.children.push(branch)
  }
  return data
}
async function run(method, factory, options = {}) {
  CompactStructure.prototype.assignConnectorLanes = method
  window.__compactShifts = 0
  let mm
  try {
    mm = await rendererFixture.create(factory(), { layout: 'logicalStructure', compactLayout: true, openPerformance: false, ...options })
    if (mm.renderer.layout.constructor.name !== 'CompactStructure') throw new Error('real compact layout not selected')
    return { golden: snapshot(mm), shifts: window.__compactShifts }
  } finally {
    if (mm) mm.destroy()
    CompactStructure.prototype.assignConnectorLanes = liveMethod
  }
}
window.compactShift = { async compare() {
  const scenarios = [
    ['wide-40', () => wide(40), {}],
    ['overlapping-bands', () => overlappingBands(), {}],
    ['same-band', () => sameBand(), {}],
    ['overlapping-expandBtn', () => overlappingBands(), { alwaysShowExpandBtn: true, notShowExpandBtn: false }],
    ['overlapping-lineStyle', () => overlappingBands(), { themeConfig: { nodeUseLineStyle: true } }]
  ]
  const rows = []
  for (const [scenario, factory, options] of scenarios) {
    const frozen = await run(frozenMethod, factory, options)
    const current = await run(liveMethod, factory, options)
    rows.push({ scenario, frozen: frozen.golden, current: current.golden, currentShifts: current.shifts })
  }
  return rows
} }
`

test('compact routing stays frozen-equivalent after forced positive child shifts', async () => {
  const phase = process.env.PERF_TDD_PHASE || 'green'
  const runId = process.env.PERF_TDD_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID()
  const destination = path.join(repo, 'work/performance-tdd', phase, 'frontend')
  fs.mkdirSync(destination, { recursive: true })
  const output = path.join(destination, 'compact-routing-shift-' + runId + '.json')
  if (fs.existsSync(output)) throw new Error('refusing to overwrite existing evidence: ' + output)
  let before
  try { before = cp.execFileSync('git', ['show', base + ':simple-mind-map/src/layouts/CompactStructure.js'], { cwd: repo, encoding: 'utf8' }) }
  catch (error) { throw new Error('BASELINE_UNAVAILABLE: fetch the real base commit before running this test', { cause: error }) }
  const current = fs.readFileSync(sourcePath, 'utf8')
  const harness = await createHarness({ contents, stubs: {
    [sourcePath]: compile(current, { probe: true }),
    'compact-routing-before-source': compile(before)
  } })
  const report = { base, runId, browser: harness.browser.version(), phase,
    sourceSha256: crypto.createHash('sha256').update(current).digest('hex'), startedAt: new Date().toISOString(), rows: [] }
  try {
    const rows = await harness.page.evaluate(() => window.compactShift.compare())
    assert.deepEqual(harness.errors, [], 'browser exceptions are infrastructure failures')
    report.rows = rows
    for (const row of rows) {
      assert.deepEqual(row.current, row.frozen, row.scenario + ': compact routing geometry changed against the frozen base')
    }
    assert.ok(rows.some(row => row.currentShifts > 0),
      'no scenario forced a positive child shift; the cached-left broad-phase invariant is not exercised after mutation')
    report.status = 'GREEN_CONFIRMED'
  } catch (error) {
    report.status = error instanceof assert.AssertionError ? 'REGRESSION_FAILED' : 'BLOCKED_ENV'
    report.error = error.stack || String(error)
    throw error
  } finally {
    report.finishedAt = new Date().toISOString()
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
    console.log('COMPACT_ROUTING_SHIFT ' + output + ' status=' + report.status)
    for (const row of report.rows) console.log('  ' + row.scenario + ' shifts=' + row.currentShifts + ' paths=' + row.current.paths.length)
    await harness.close()
  }
})
