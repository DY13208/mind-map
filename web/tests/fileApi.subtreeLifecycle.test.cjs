const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const babel = require('@babel/core')
const calls = []
let hold = true
const releases = []
const dependencies = {
  './fetchWithTimeout': { FetchTimeoutError: class extends Error {}, fetchWithTimeout: async url => {
    calls.push(url)
    if (hold) await new Promise(resolve => releases.push(resolve))
    return { ok: true, status: 200, json: async () => ({ total: 0, children: [] }) }
  } },
  './runtimeConfig': { getRuntimeConfig: () => ({ collabApi: 'http://isolated.test' }) },
  'simple-mind-map/src/utils/operationId': { createOperationId: () => 'test-operation' },
  'simple-mind-map/src/utils/collabTrace': { collabTrace() {}, collabPersistSnapshot() {} },
  '@/utils/importTree': { stringifyJsonOffMainThread: async data => JSON.stringify(data) }
}
const filename = path.join(__dirname, '../src/utils/fileApi.js')
const { code } = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
  babelrc: false, configFile: false, plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
})
const moduleRef = { exports: {} }
new Function('require', 'module', 'exports', code)(id => {
  assert.ok(dependencies[id], `unknown dependency ${id}`)
  return dependencies[id]
}, moduleRef, moduleRef.exports)
const { getFileSubtree } = moduleRef.exports
async function main() {
  const first = getFileSubtree('room', 'first')
  const second = getFileSubtree('room', 'second')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.length, 2)
  let current = true
  const queued = getFileSubtree('room', 'deleted', { isCurrent: () => current })
  const rejected = assert.rejects(queued, error => error.name === 'AbortError')
  current = false
  hold = false
  releases.splice(0).forEach(resolve => resolve())
  await Promise.all([first, second, rejected])
  assert.equal(calls.length, 2, 'invalidated queued subtree must never reach fetch')
  await getFileSubtree('room', 'restored', { priority: 'low', isCurrent: () => true })
  assert.equal(calls.length, 3, 'cancellation releases connection slot and does not activate API backoff')
  hold = true
  const a = getFileSubtree('room', 'same')
  const b = getFileSubtree('room', 'same')
  assert.equal(a, b, 'existing identical request single-flight remains intact')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.length, 4)
  releases.splice(0).forEach(resolve => resolve())
  await Promise.all([a, b])
  let oldCurrent = true
  const oldLifetime = getFileSubtree('room', 'delete-and-restore', { isCurrent: () => oldCurrent })
  await new Promise(resolve => setImmediate(resolve))
  oldCurrent = false
  const restoredLifetime = getFileSubtree('room', 'delete-and-restore', { isCurrent: () => true })
  assert.notEqual(oldLifetime, restoredLifetime, 'restored UID must not reuse a stale in-flight response')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.length, 6)
  releases.splice(0).forEach(resolve => resolve())
  await Promise.all([oldLifetime, restoredLifetime])
  console.log('fileApi subtree lifecycle: queued cancellation, slot recovery, no backoff and request dedupe passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
