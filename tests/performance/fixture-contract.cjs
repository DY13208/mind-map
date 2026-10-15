const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { makeTree, inspectTree } = require('./fixtures.cjs')
const path = require('node:path')
const repo = path.resolve(__dirname, '../..')

for (const shape of ['balanced', 'wide', 'deep']) {
  for (const size of [1, 1000, 5000, 10000]) {
    const actual = inspectTree(makeTree(size, { shape }))
    assert.equal(actual.count, size)
    assert.equal(actual.edges, size - 1)
  }
}

for (const file of [
  'tests/performance/fixture-contract.cjs',
  'simple-mind-map/test/nodeUidRead.test.js',
  'simple-mind-map/test/performanceBackendHarness.js',
  'web/tests/cardPreviewQueue.test.cjs',
  'simple-mind-map/e2e/performance/renderer.spec.cjs'
]) {
  const result = spawnSync('git', ['check-ignore', '--no-index', '--quiet', file], { cwd: repo, encoding: 'utf8' })
  assert.equal(result.status, 1, `planned regression test is ignored: ${file}`)
}
console.log('PASS fixture sizes/UIDs/parent edges and planned regression-test tracking')
