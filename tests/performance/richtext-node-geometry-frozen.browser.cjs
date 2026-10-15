'use strict'
// Frozen-geometry guard for the RichText/node-layout fix. It bundles the real
// engine twice: once from live source and once with the pre-change nodeLayout.js
// and MindMapNode.js injected from tests/performance/fixtures/richtext-before/
// (self-contained, with provenance.json), then compares per-node model coordinates
// and exact SVG group markup (transform, foreignObject size, shape transform,
// nested groups).
//
// Covered: truly plain (RichText not registered), multiline, icon, bottom tag,
// image in all four placements, prefix/postfix fallback, rich text, a node with
// an existing rotate+skew across a product translate plus a repeated no-drift
// render, and explicit DOM removal followed by product reattach.
//
// Missing fixtures => BLOCKED_ENV. Never classifies harness timeouts as product RED.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { createRequire } = require('node:module')
const { createHarness, resolveSource, repo } = require('./engine-harness.cjs')
const webRequire = createRequire(path.join(repo, 'web/package.json'))
const babel = webRequire('@babel/core')

const nodeLayoutPath = path.join(repo, 'simple-mind-map/src/core/render/node/nodeLayout.js')
const mindMapNodePath = path.join(repo, 'simple-mind-map/src/core/render/node/MindMapNode.js')
const fixtureDir = path.join(__dirname, 'fixtures/richtext-before')
const fixtureFiles = {
  [nodeLayoutPath]: path.join(fixtureDir, 'nodeLayout.before.js'),
  [mindMapNodePath]: path.join(fixtureDir, 'MindMapNode.before.js')
}
const entry = path.join(__dirname, 'richtext-geometry-browser-entry.js')

// Rewrite relative import specifiers to fully-resolved filenames so they match
// the stub keys. Bare packages are left alone: the harness fixture-boundary
// loader resolves them from the stubbed module's original directory, so the same
// svg.js/quill copy/ESM entry is used as the real source would use.
function compile (source, filePath) {
  return babel.transformSync(source, { filename: filePath, babelrc: false, configFile: false,
    plugins: [({ types: t }) => ({ visitor: {
      ImportDeclaration (p) {
        if (p.node.source.value.startsWith('.')) p.node.source.value = resolveSource(path.resolve(path.dirname(filePath), p.node.source.value))
      }
    } })] }).code
}
function ownedChromePids () {
  try {
    return execFileSync('ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' }).split('\n')
      .map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/))
      .filter(row => row && Number(row[2]) === process.pid && row[3].endsWith('/Google Chrome'))
      .map(row => Number(row[1]))
  } catch { return [] }
}
async function boundedClose (harness) {
  const owned = ownedChromePids()
  await Promise.race([harness.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 8000))])
  for (const pid of owned) { try { process.kill(pid, 'SIGKILL') } catch {} }
}
function matrixParts (transform) {
  const match = transform && transform.match(/matrix\(([^)]+)\)/)
  return match ? match[1].split(',').map(Number) : null
}

test('rich/plain/multiline/icon/image/tag/prefix/transform/reattach geometry matches frozen pre-change source', { timeout: 150000 }, async () => {
  const phase = process.env.PERF_TDD_PHASE || 'green'
  const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID()
  const output = path.join(repo, 'work/performance-tdd', phase, 'frontend', 'richtext-node-geometry-frozen-' + runId + '.json')
  if (fs.existsSync(output)) throw new Error('refusing to overwrite existing evidence: ' + output)
  for (const file of Object.values(fixtureFiles)) {
    if (!fs.existsSync(file)) { const error = new Error('frozen pre-change fixture missing: ' + file); error.code = 'BASELINE_UNAVAILABLE'; throw error }
  }
  const frozenNodeLayout = fs.readFileSync(fixtureFiles[nodeLayoutPath], 'utf8')
  const frozenMindMapNode = fs.readFileSync(fixtureFiles[mindMapNodePath], 'utf8')
  const liveNodeLayout = fs.readFileSync(nodeLayoutPath, 'utf8')
  const liveMindMapNode = fs.readFileSync(mindMapNodePath, 'utf8')
  // Prove the frozen reference really is the pre-change source for both files
  // and that it maps onto the live import specifier (otherwise parity is vacuous).
  assert.ok(frozenNodeLayout.includes('this.shapeNode.translate(halfBorderWidth, halfBorderWidth)'), 'frozen nodeLayout must contain the original shapeNode.translate')
  assert.ok(frozenNodeLayout.includes('textContentNested.bbox()'), 'frozen nodeLayout must contain the original direct bbox')
  assert.ok(frozenNodeLayout.includes('textContentNested.translate(translateX, translateY)'), 'frozen nodeLayout must contain the original textContent translate')
  assert.ok(frozenMindMapNode.includes('this.nodeDraw.has(this.group)'), 'frozen MindMapNode must contain the original has() membership check')
  assert.ok(liveNodeLayout.includes('translateWithoutBbox'), 'live nodeLayout must contain the bbox-free translate')
  assert.ok(liveMindMapNode.includes('this.group.node.parentNode !== this.nodeDraw.node'), 'live MindMapNode must contain the O(1) membership check')
  assert.notEqual(frozenNodeLayout, liveNodeLayout, 'frozen and live nodeLayout must differ')
  assert.notEqual(frozenMindMapNode, liveMindMapNode, 'frozen and live MindMapNode must differ')
  assert.equal(resolveSource(path.resolve(path.dirname(mindMapNodePath), './nodeLayout')), nodeLayoutPath, 'frozen MindMapNode nodeLayout import must map to the stub key')
  const stubs = {}
  for (const [livePath, frozenPath] of Object.entries(fixtureFiles)) stubs[livePath] = compile(fs.readFileSync(frozenPath, 'utf8'), livePath)
  assert.ok(stubs[mindMapNodePath].includes(nodeLayoutPath), 'compiled frozen MindMapNode must import the absolute nodeLayout stub key')

  const live = await createHarness({ entry })
  const frozen = await createHarness({ entry, stubs })
  const report = { scope: 'live vs frozen pre-change source: per-node coordinates and exact SVG group markup for plain/multiline/icon/image/tag/prefix/rich/transform/reattach',
    runId, phase, sourceRoot: repo, browser: live.browser.version(), startedAt: new Date().toISOString(),
    liveBundleHash: live.bundleHash, frozenBundleHash: frozen.bundleHash, rows: [] }
  try {
    for (const scenario of ['plain', 'extras', 'rich', 'empty-edges', 'wrap-zero', 'transform', 'reattach']) {
      const livePage = await live.newPage()
      const frozenPage = await frozen.newPage()
      await Promise.all([livePage.waitForFunction(() => !!window.rtGeometry), frozenPage.waitForFunction(() => !!window.rtGeometry)])
      const liveResult = await livePage.evaluate(name => window.rtGeometry.scenario(name), scenario)
      const frozenResult = await frozenPage.evaluate(name => window.rtGeometry.scenario(name), scenario)
      await livePage.close(); await frozenPage.close()
      if (scenario === 'plain' || scenario === 'extras') {
        assert.equal(liveResult.allPlain, true, scenario + ': plain fixtures must not be normalized into richText')
        report.rows.push({ scenario, liveNodes: Object.keys(liveResult.geometry).length, frozenNodes: Object.keys(frozenResult.geometry).length, allPlain: true })
        assert.deepEqual(liveResult.geometry, frozenResult.geometry, scenario + ': node geometry differs from frozen pre-change source')
      } else if (scenario === 'transform') {
        const afterParts = matrixParts(liveResult.after)
        const beforeParts = matrixParts(liveResult.before)
        assert.deepEqual(afterParts.slice(0, 4), beforeParts.slice(0, 4), 'transform: matrix a/b/c/d must be preserved across product translate')
        assert.ok(Math.abs(afterParts[1]) > 0.1 || Math.abs(afterParts[2]) > 0.1, 'transform: rotate/skew must remain non-identity')
        assert.deepEqual(liveResult.first, liveResult.second, 'transform: repeated product render must not drift')
        report.rows.push({ scenario, liveNodes: Object.keys(liveResult.first).length, before: liveResult.before, after: liveResult.after })
        assert.deepEqual(liveResult.first, frozenResult.first, 'transform: first geometry differs from frozen source')
        assert.deepEqual(liveResult.second, frozenResult.second, 'transform: second geometry differs from frozen source')
      } else if (scenario === 'reattach') {
        assert.equal(liveResult.detached, true, 'reattach: explicit removal must detach the saved group')
        assert.equal(liveResult.sameNode, true, 'reattach: product must reattach the same saved DOM group')
        assert.equal(liveResult.attached, true, 'reattach: group must be a child of nodeDraw after render')
        report.rows.push({ scenario, liveNodes: Object.keys(liveResult.geometry).length, detached: true, sameNode: true, attached: true })
        assert.deepEqual(liveResult.geometry, frozenResult.geometry, 'reattach: reattached geometry differs from frozen source')
      } else if (scenario === 'empty-edges' || scenario === 'wrap-zero') {
        report.rows.push({ scenario, liveNodes: Object.keys(liveResult.geometry).length, textAutoWrapWidth: liveResult.textAutoWrapWidth })
        assert.deepEqual(liveResult.geometry, frozenResult.geometry, scenario + ': degenerate rich geometry differs from frozen source')
      } else {
        report.rows.push({ scenario, liveNodes: Object.keys(liveResult.geometry).length, frozenNodes: Object.keys(frozenResult.geometry).length })
        assert.deepEqual(liveResult.geometry, frozenResult.geometry, scenario + ': node geometry differs from frozen pre-change source')
      }
    }
    assert.deepEqual(live.errors, [], 'live browser errors: ' + live.errors.join('; '))
    assert.deepEqual(frozen.errors, [], 'frozen browser errors: ' + frozen.errors.join('; '))
    report.status = 'GREEN_CONFIRMED'
  } catch (error) {
    report.status = error.code === 'BASELINE_UNAVAILABLE' ? 'BLOCKED_ENV'
      : error instanceof assert.AssertionError ? 'REGRESSION_FAILED' : 'BLOCKED_ENV'
    report.error = error.stack || String(error)
    report.liveErrors = live.errors
    report.frozenErrors = frozen.errors
    throw error
  } finally {
    report.finishedAt = new Date().toISOString()
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
    console.log('RICHTEXT_NODE_GEOMETRY_FROZEN ' + output + ' status=' + report.status)
    for (const row of report.rows) console.log('  ' + JSON.stringify(row))
    await boundedClose(live)
    await boundedClose(frozen)
  }
})
