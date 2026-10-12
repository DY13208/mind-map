const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const vm = require('node:vm')
const source = fs.readFileSync(require.resolve('../src/pages/Edit/components/Toolbar.vue'), 'utf8')
const slice = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)))
const methods = vm.runInNewContext(`({
${slice('    async returnToParentMap() {', '    /** 主动提交文本编辑')}
${slice('    async saveBeforeMapNavLeave() {', '    /** 上级脑图要能被当前用户访问')}
})`, {
  console: { warn() {}, error() {} },
  MAP_NAV_SAVE_WAIT_MS: 15000,
  window: { history: { state: {} } },
  getMapNavContext: () => ({ parent: { room: 'main' } }),
  markMapNavViewRestore() {}
})
function fixture() {
  const calls = []
  const context = {
    ...methods,
    isReadonly: false,
    currentRoomKey: () => 'sub',
    prepareReload: async () => { calls.push('commit text and persist queue'); return { ok: true } },
    flushLocalFileNow: async () => calls.push('flush local file'),
    collabSyncPending: () => ({ pending: false }),
    collabSaveTrouble: () => '',
    collabLiveStatus: () => ({}),
    waitForCollabSaved: async () => true,
    verifyMapNavParentAccess: async () => { calls.push('check access'); return true },
    traverseBackToParentMap: async () => calls.push('navigate'),
    refreshMapNavContext() {},
    $t: key => key,
    $message: { warning: msg => calls.push(msg) },
    $confirm: () => { throw new Error('must never ask to discard unsaved changes') }
  }
  return { context, calls }
}

test('return commits pending text and local file before access check and navigation, without confirmation', async () => {
  const { context, calls } = fixture()
  await context.returnToParentMap()
  assert.deepEqual(calls, ['commit text and persist queue', 'flush local file', 'check access', 'navigate'])
  assert.equal(context.mapNavReturning, false)
})

test('wait for server acknowledgement before returning; double click does not duplicate navigation', async () => {
  const { context, calls } = fixture()
  let pending = true
  let acknowledge
  context.collabSyncPending = () => ({ pending })
  context.mindMap = { cooperate: { collabV2Adapter: { retryPending: async () => calls.push('send queue') } } }
  context.waitForCollabSaved = () => new Promise(resolve => { acknowledge = () => { pending = false; resolve(true) } })
  const returning = context.returnToParentMap()
  for (let i = 0; i < 6; i++) await Promise.resolve()
  assert.equal(context.mapNavReturning, true)
  assert.ok(calls.includes('send queue'))
  assert.ok(!calls.includes('navigate'))
  await context.returnToParentMap()
  acknowledge()
  await returning
  assert.equal(calls.filter(call => call === 'navigate').length, 1)
})

test('timeout or save rejection preserves current child map with a non-modal message', async () => {
  for (const failure of ['pending', 'prepare', 'local', 'rejected', 'confirmation']) {
    const { context, calls } = fixture()
    if (failure === 'pending') {
      context.collabSyncPending = () => ({ pending: true })
      context.waitForCollabSaved = async () => false
    }
    if (failure === 'prepare') context.prepareReload = async () => ({ ok: true, timeout: true })
    if (failure === 'local') context.flushLocalFileNow = async () => { throw new Error('disk write failed') }
    if (failure === 'rejected') context.collabSaveTrouble = () => 'failed'
    if (failure === 'confirmation') context.collabLiveStatus = () => ({ saveState: 'requires_confirmation' })
    await context.returnToParentMap()
    assert.ok(!calls.includes('navigate'), failure)
    assert.ok(calls.includes('toolbar.mapNavSaveFailed'), failure)
    assert.equal(context.mapNavReturning, false, failure)
  }
})

test('read-only idle view does not run write scans and can return while offline', async () => {
  const { context, calls } = fixture()
  context.isReadonly = true
  context.collabSaveTrouble = () => 'offline'
  await context.returnToParentMap()
  assert.deepEqual(calls, ['check access', 'navigate'])
})

test('if user changes map during save, the old return does not navigate away from the new map', async () => {
  const { context, calls } = fixture()
  let room = 'sub'
  context.currentRoomKey = () => room
  context.prepareReload = async () => { room = 'other'; return { ok: true } }
  await context.returnToParentMap()
  assert.ok(!calls.includes('navigate'))
})
