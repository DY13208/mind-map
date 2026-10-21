'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { isCollabTraceOn } = require('../src/utils/collabTraceSwitch.cjs')

const SRC = path.resolve(__dirname, '..')
const traceSource = fs.readFileSync(path.join(SRC, 'src/utils/collabTrace.js'), 'utf8')
const adapterSource = fs.readFileSync(path.join(SRC, 'bin/collabV2/adapter.js'), 'utf8')

function makeWindow({
  host = 'app.example.com',
  search = '',
  globalSetting,
  runtimeSetting,
  storageSetting,
  storageThrows = false
} = {}) {
  const target = {
    location: { hostname: host, search },
    __MIND_MAP_RUNTIME__: {}
  }
  if (globalSetting !== undefined) target.__COLLAB_V2_TRACE__ = globalSetting
  if (runtimeSetting !== undefined) target.__MIND_MAP_RUNTIME__.collabV2Trace = runtimeSetting
  Object.defineProperty(target, 'localStorage', {
    configurable: true,
    get() {
      if (storageThrows) throw new Error('storage unavailable')
      return {
        getItem(key) {
          assert.equal(key, 'COLLAB_V2_TRACE')
          return storageSetting == null ? null : storageSetting
        }
      }
    }
  })
  return target
}

function makeConsole() {
  const calls = []
  return {
    calls,
    info(...args) { calls.push(args) },
    warn(...args) { calls.push(args) },
    error(...args) { calls.push(args) }
  }
}

function loadCollabTrace(windowLike, consoleLike) {
  const importLine = /^import collabTraceSwitch from ['"]\.\/collabTraceSwitch\.cjs['"]\s*$/m
  assert.match(traceSource, importLine, 'collabTrace.js must use the shared CJS switch')
  const executable = traceSource
    .replace(importLine, 'const collabTraceSwitch = require("./collabTraceSwitch.cjs")')
    .replace(/^export\s+/gm, '') +
    '\nmodule.exports = { isCollabTraceOn, collabTrace, collabPersistSnapshot, setCollabTraceSnapshotProvider, subscribeCollabPerformance }'
  const module = { exports: {} }
  vm.runInNewContext(executable, {
    window: windowLike,
    console: consoleLike,
    module,
    require(id) {
      assert.equal(id, './collabTraceSwitch.cjs')
      return require('../src/utils/collabTraceSwitch.cjs')
    }
  }, { filename: 'src/utils/collabTrace.js', timeout: 1000 })
  return module.exports
}

function loadAdapterTrace(windowLike, consoleLike) {
  assert.match(
    adapterSource,
    /const \{ isCollabTraceOn \} = require\('\.\.\/\.\.\/src\/utils\/collabTraceSwitch\.cjs'\)/,
    'adapter.js must use the same shared CJS switch'
  )
  const start = adapterSource.indexOf('function adapterTrace(stage, detail) {')
  const end = adapterSource.indexOf('\nfunction sessionClientId()', start)
  assert.ok(start >= 0 && end > start, 'adapterTrace function must be extractable for focused testing')
  const executable = adapterSource.slice(start, end) + '\nadapterTrace'
  return vm.runInNewContext(executable, {
    window: windowLike,
    console: consoleLike,
    isCollabTraceOn,
    require(id) {
      assert.equal(id, './trace')
      return { collabTrace() {} }
    }
  }, { filename: 'bin/collabV2/adapter.js#adapterTrace', timeout: 1000 })
}

function assertSilentForBoth(windowFactory, label) {
  const windowForMain = windowFactory()
  const mainConsole = makeConsole()
  const main = loadCollabTrace(windowForMain, mainConsole)
  let snapshotCalls = 0
  const performanceStages = []
  main.setCollabTraceSnapshotProvider(() => {
    snapshotCalls += 1
    return { lastPushedCount: 50000 }
  })
  main.subscribeCollabPerformance(stage => performanceStages.push(stage))

  const snapshot = main.collabPersistSnapshot()
  assert.deepEqual(Object.keys(snapshot), [], `${label}: disabled persist snapshot should be empty`)
  main.collabTrace('test.disabled', { roomKey: 'room-test' })
  assert.equal(snapshotCalls, 0, `${label}: disabled tracing must not compute a snapshot`)
  assert.equal(windowForMain.__V2_TRACE_LOG__, undefined, `${label}: main trace must not allocate/write its ring`)
  assert.equal(mainConsole.calls.length, 0, `${label}: main trace must not write to console`)
  assert.deepEqual(performanceStages, ['test.disabled'], `${label}: performance listener remains independent`)

  const windowForAdapter = windowFactory()
  const adapterConsole = makeConsole()
  loadAdapterTrace(windowForAdapter, adapterConsole)('test.disabled', { roomKey: 'room-test' })
  assert.equal(windowForAdapter.__V2_TRACE_LOG__, undefined, `${label}: adapter trace must not allocate/write its ring`)
  assert.equal(adapterConsole.calls.length, 0, `${label}: adapter trace must not write to console`)
}

const defaultHosts = [
  ['localhost', 'local host'],
  ['127.0.0.1', 'loopback'],
  ['192.168.10.4', 'private 192.168 host'],
  ['10.4.0.8', 'private 10 host'],
  ['172.31.2.9', 'private 172 host'],
  ['app.example.com', 'public host']
]
for (const [host, label] of defaultHosts) {
  assert.equal(isCollabTraceOn(makeWindow({ host })), false, `${label}: tracing defaults off`)
  assertSilentForBoth(() => makeWindow({ host }), `${label}: both entry points`)
}

const disabledOverrides = [
  ['global false overrides localStorage true', { globalSetting: false, storageSetting: '1' }],
  ['global false overrides runtime true', { globalSetting: false, runtimeSetting: true }],
  ['global false overrides query true', { globalSetting: false, search: '?collabTrace=1' }],
  ['localStorage false overrides runtime and query true', { storageSetting: '0', runtimeSetting: true, search: '?collabTrace=1' }],
  ['runtime false overrides query true', { runtimeSetting: '0', search: '?collabTrace=1' }],
  ['query false disables tracing', { search: '?collabTrace=0' }]
]
for (const [label, settings] of disabledOverrides) {
  assert.equal(isCollabTraceOn(makeWindow(settings)), false, label)
  assertSilentForBoth(() => makeWindow(settings), label)
}

assert.equal(
  isCollabTraceOn(makeWindow({ globalSetting: true, storageSetting: '0', runtimeSetting: false, search: '?collabTrace=0' })),
  true,
  'global true takes precedence over lower-level false settings'
)

const explicitEnableSettings = [
  ['global', { globalSetting: true }],
  ['localStorage', { storageSetting: '1' }],
  ['runtime', { runtimeSetting: '1' }],
  ['query', { search: '?collabTrace=1' }]
]
for (const [source, settings] of explicitEnableSettings) {
  assert.equal(isCollabTraceOn(makeWindow(settings)), true, `${source}: explicit trace opt-in`)
}

const storageThrowsWithRuntimeOff = () => makeWindow({
  storageThrows: true,
  runtimeSetting: false,
  search: '?collabTrace=1'
})
assert.equal(isCollabTraceOn(storageThrowsWithRuntimeOff()), false, 'storage failure still honors runtime false')
assertSilentForBoth(storageThrowsWithRuntimeOff, 'storage exception with runtime false')

const storageThrowsWithQueryOn = () => makeWindow({ storageThrows: true, search: '?collabTrace=1' })
assert.equal(isCollabTraceOn(storageThrowsWithQueryOn()), true, 'storage failure falls through to query opt-in')

{
  const win = makeWindow({ storageSetting: '1' })
  const logs = makeConsole()
  const trace = loadCollabTrace(win, logs)
  let snapshotCalls = 0
  trace.setCollabTraceSnapshotProvider(() => {
    snapshotCalls += 1
    return { lastPushedCount: 10 }
  })
  trace.collabTrace('test.enabled', { type: 'node.update' })
  assert.equal(snapshotCalls, 1, 'explicitly enabled main trace computes its snapshot')
  assert.equal(win.__V2_TRACE_LOG__.length, 1, 'explicitly enabled main trace writes its ring')
  assert.equal(logs.calls.length, 1, 'explicitly enabled main trace writes to console')
}

{
  const win = makeWindow({ search: '?collabTrace=1' })
  const logs = makeConsole()
  loadAdapterTrace(win, logs)('test.enabled', { type: 'node.insert' })
  assert.equal(win.__V2_TRACE_LOG__.length, 1, 'explicitly enabled adapter trace writes its ring')
  assert.equal(logs.calls.length, 1, 'explicitly enabled adapter trace writes to console')
}

console.log('collabTraceSwitch.test.cjs: PASS')
