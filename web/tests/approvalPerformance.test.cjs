const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const compiler = require('vue-template-compiler')
const babel = require('@babel/core')
const Vue = require('vue')
global.window = { dispatchEvent() {}, removeEventListener() {} }

function load(name, service) {
  const source = compiler.parseComponent(fs.readFileSync(path.resolve(__dirname, '../src/components', name + '.vue'), 'utf8'))
  assert.deepEqual(compiler.compile(source.template.content).errors, [])
  const code = babel.transformSync(source.script.content, {
    babelrc: false, configFile: false, plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
  }).code
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', code)(id => {
    if (id === '@/services/leaveService') return { __esModule: true, default: service }
    return {}
  }, mod, mod.exports)
  return new (Vue.extend(mod.exports.default))({ propsData: { userId: 'requester' } })
}
const row = revision => ({
  id: 'request', revision, requester_id: 'requester', status: 'pending',
  template: { agentInput: true, kind: 'generic', fields: [] }, report: {},
  steps: [{ criteria: [] }], fields: {}, history: [], canDecide: true
})
const tick = () => new Promise(resolve => setImmediate(resolve))

test('opening approval details reads once and does not start automatic AI work', async () => {
  let reads = 0
  const vm = load('LeaveRequestDialog', { get: async () => { reads++; return row(1) } })
  vm.analyze = () => assert.fail('opening a record must not start an AI request')
  await vm.open({ requestId: 'request' })
  assert.equal(reads, 1)
  assert.equal(vm.row.revision, 1)
  assert.equal(vm.loading, false)
  assert.equal(vm.tab, 'flow')
  vm.$destroy()
})

test('approval action refreshes once, including conflict recovery', async () => {
  const priorWindow = global.window
  global.window = { dispatchEvent() {}, removeEventListener() {} }
  try {
    let reads = 0
    const service = { get: async () => { reads++; return row(2) }, act: async () => {} }
    const vm = load('LeaveRequestDialog', service)
    vm.row = row(1)
    await vm.act('decide', { decision: 'approve' })
    assert.equal(reads, 1)
    service.act = async () => { throw new Error('revision conflict') }
    service.get = async () => { reads++; return row(3) }
    await vm.act('decide', { decision: 'approve' })
    assert.equal(reads, 2, 'recovery reuses the GET response instead of reading it again')
    assert.equal(vm.row.revision, 3)
    vm.$destroy()
  } finally { global.window = priorWindow }
})

test('list is usable while notices or read receipts are still pending, and already-read notices are not marked again', async () => {
  let resolveNotices, resolveSeen, seenIds
  const vm = load('LeaveInbox', {
    list: async () => ({ list: [{ id: 'visible' }], total: 1 }),
    notices: () => new Promise(resolve => { resolveNotices = resolve }),
    seen: ids => { seenIds = ids; return new Promise(resolve => { resolveSeen = resolve }) }
  })
  await vm.load()
  assert.equal(vm.loading, false)
  assert.equal(vm.items[0].id, 'visible')
  resolveNotices({ list: [{ id: 'old', seen_at: 'yesterday' }, { id: 'new', seen_at: null }] })
  await tick()
  assert.deepEqual(seenIds, ['new'])
  assert.equal(vm.loading, false)
  vm.sequence++ // Closing the panel makes the late read receipt irrelevant.
  resolveSeen()
  await tick()
  clearTimeout(vm.refreshTimer)
})

test('a burst of change notifications schedules one inbox reload', async () => {
  const vm = load('LeaveInbox', {})
  let reads = 0
  vm.load = async () => { reads++ }
  vm.scheduleLoad()
  vm.scheduleLoad()
  vm.scheduleLoad()
  await new Promise(resolve => setTimeout(resolve, 110))
  assert.equal(reads, 1)
})
