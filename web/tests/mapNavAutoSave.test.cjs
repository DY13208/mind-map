const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const parser = require('@babel/parser')
const generate = require('@babel/generator').default

function loadMethod(file, name, globals = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../src/pages/Edit/components', file), 'utf8')
  const script = source.match(/<script>([\s\S]*?)<\/script>/)[1]
  const ast = parser.parse(script, { sourceType: 'module' })
  const component = ast.program.body.find(node => node.type === 'ExportDefaultDeclaration').declaration
  const methods = component.properties.find(node => node.key && node.key.name === 'methods').value
  const method = methods.properties.find(node => node.key && node.key.name === name)
  return vm.runInNewContext(`({${generate(method).code}}).${name}`, {
    MAP_NAV_SAVE_WAIT_MS: 15000,
    console: { warn() {}, error() {} },
    clearTimeout,
    Date: { now: () => 1000 },
    withMapNavSaveDeadline: task => task(),
    ...globals
  })
}
const save = loadMethod('Toolbar.vue', 'saveBeforeMapNavLeave')
function makeContext(overrides = {}) {
  const events = []
  return {
    events,
    isReadonly: false,
    currentRoomKey: () => 'child',
    waitingWriteToLocalFile: false,
    collabLiveStatus: () => ({}),
    collabSyncPending: () => ({ pending: false }),
    prepareReload: async options => { events.push(['prepare', options.retryPending]); return { ok: true } },
    flushLocalFileNow: async () => { events.push('local-save') },
    waitForCollabSaved: async timeout => { events.push(['ack', timeout]); return true },
    collabBusyReason: () => '',
    $t: key => key,
    $message: { warning: message => events.push(['warning', message]) },
    $confirm: () => { throw new Error('Must not show a confirmation dialog') },
    ...overrides
  }
}

test('return saves edits and local file before waiting for server acknowledgement', async () => {
  const ctx = makeContext()
  assert.equal(await save.call(ctx), true)
  assert.deepEqual(ctx.events, [['prepare', true], 'local-save', ['ack', 15000]])
})
for (const [name, overrides] of [
  ['preparation failure', { prepareReload: async () => ({ ok: false }) }],
  ['preparation timeout', { prepareReload: async () => ({ ok: true, timeout: true }) }],
  ['local file write failure', { flushLocalFileNow: async () => { throw new Error('disk write failed') } }],
  ['server acknowledgement timeout', { waitForCollabSaved: async () => false }],
  ['remaining pending changes', { collabBusyReason: () => 'pending' }],
  ['SOP confirmation still required', { collabLiveStatus: () => ({ saveState: 'requires_confirmation' }) }]
]) {
  test(`${name} prevents return and shows a non-modal warning`, async () => {
    const ctx = makeContext(overrides)
    assert.equal(await save.call(ctx), false)
    assert.deepEqual(ctx.events.at(-1), ['warning', 'toolbar.mapNavSaveFailedTip'])
  })
}

test('idle readonly view returns without attempting to write', async () => {
  const ctx = makeContext({ isReadonly: true })
  assert.equal(await save.call(ctx), true)
  assert.deepEqual(ctx.events, [])
})

test('failed save never navigates or verifies parent access', async () => {
  const events = []
  const returnToParent = loadMethod('Toolbar.vue', 'returnToParentMap', {
    window: { history: { state: {} } },
    getMapNavContext: () => ({ parent: { room: 'parent' } })
  })
  await returnToParent.call({
    mapNavReturning: false,
    currentRoomKey: () => 'child',
    saveBeforeMapNavLeave: async () => false,
    verifyMapNavParentAccess: () => events.push('verify'),
    traverseBackToParentMap: () => events.push('navigate'),
    refreshMapNavContext: () => events.push('refresh')
  })
  assert.deepEqual(events, ['refresh'])
})

test('successful save restores parent view and navigates once; repeated clicks are ignored', async () => {
  const events = []
  let finishSave
  const returnToParent = loadMethod('Toolbar.vue', 'returnToParentMap', {
    window: { history: { state: {} } },
    getMapNavContext: () => ({ parent: { room: 'parent' } }),
    markMapNavViewRestore: room => events.push(['restore', room])
  })
  const ctx = {
    mapNavReturning: false,
    currentRoomKey: () => 'child',
    saveBeforeMapNavLeave: () => new Promise(resolve => { finishSave = resolve }),
    verifyMapNavParentAccess: async () => { events.push('verify'); return true },
    traverseBackToParentMap: async () => events.push('navigate'),
    refreshMapNavContext: () => events.push('refresh')
  }
  const first = returnToParent.call(ctx)
  await returnToParent.call(ctx)
  assert.deepEqual(events, [])
  finishSave(true)
  await first
  assert.deepEqual(events, ['verify', ['restore', 'parent'], 'navigate', 'refresh'])
  assert.equal(ctx.mapNavReturning, false)
})

test('save preparation commits the text editor, flushes collaboration, and retries pending commands', async () => {
  const events = []
  const prepare = loadMethod('Edit.vue', 'prepareReload')
  await prepare.call({
    commitOpenTextEdit: () => events.push('commit-text'),
    manualSave: () => events.push('save'),
    mindMap: { cooperate: {
      flushPendingForReload: async () => { events.push('flush'); return { ok: true } },
      collabV2Adapter: { retryPending: async () => events.push('retry') }
    } }
  }, result => events.push(['done', result.ok]), { retryPending: true })
  assert.deepEqual(events, ['commit-text', 'save', 'flush', 'retry', ['done', true]])
})


test('direct URL opens picker without saving; chosen target uses replace, never history.back', async () => {
  const events = []
  const go = loadMethod('Toolbar.vue', 'returnToParentMap', {
    window: { history: { state: {} } }, getMapNavContext: () => null,
    markMapNavViewRestore: room => events.push(['restore', room])
  })
  const ctx = {
    currentRoomKey: () => 'child', mapNavReturning: false,
    saveBeforeMapNavLeave: async () => { events.push('save'); return true },
    verifyMapNavParentAccess: async room => { events.push(['verify', room]); return true },
    replaceWithParentMap: async parent => events.push(['replace', parent.room]),
    traverseBackToParentMap: () => assert.fail('direct links cannot traverse history'),
    refreshMapNavContext() {}
  }
  await go.call(ctx)
  assert.equal(ctx.parentMapPickerVisible, true)
  assert.deepEqual(events, [])
  await go.call(ctx, { roomKey: 'parent', fromRoom: 'child' })
  assert.deepEqual(events, ['save', ['verify', 'parent'], ['restore', 'parent'], ['replace', 'parent']])
})

test('navigation during saving invalidates return even when the same room is reopened', async () => {
  const go = loadMethod('Toolbar.vue', 'returnToParentMap', {
    window: { history: { state: {} } }, getMapNavContext: () => ({ parent: { room: 'parent' } })
  })
  const ctx = {
    mapNavGeneration: 1, currentRoomKey: () => 'child',
    saveBeforeMapNavLeave: async () => { ctx.mapNavGeneration += 2; return true },
    verifyMapNavParentAccess: () => assert.fail('stale return'), refreshMapNavContext() {}
  }
  await go.call(ctx)
  assert.equal(ctx.mapNavReturning, false)
})

test('invalid historical target opens relation fallback and never navigates', async () => {
  const go = loadMethod('Toolbar.vue', 'returnToParentMap', {
    window: { history: { state: {} } }, getMapNavContext: () => ({ parent: { room: 'deleted' } })
  })
  const ctx = {
    currentRoomKey: () => 'child', saveBeforeMapNavLeave: async () => true,
    verifyMapNavParentAccess: async () => false, refreshMapNavContext() {}
  }
  await go.call(ctx)
  assert.equal(ctx.parentMapPickerVisible, true)
  assert.equal(ctx.mapNavReturning, false)
})

function pickerContext(api, overrides = {}) {
  const events = []
  const ctx = {
    visible: true, room: 'child', search: '', items: [], cursor: '', hasMore: false, loading: false,
    $emit: (name, value) => events.push([name, value]), events, ...overrides
  }
  for (const name of ['load', 'cancel', 'close', 'select']) {
    ctx[name] = loadMethod('ParentMapPicker.vue', name, {
      listParentMaps: api, AbortController, setTimeout
    }).bind(ctx)
  }
  return ctx
}

test('picker resolves unique complete result, keeps empty result, and never chooses a multi-page or searched result', async () => {
  for (const [response, search, selects] of [
    [{ list: [{ roomKey: 'parent', title: 'Parent' }], hasMore: false }, '', 1],
    [{ list: [], hasMore: false }, '', 0],
    [{ list: [{ roomKey: 'parent' }], hasMore: true, nextCursor: 'page2' }, '', 0],
    [{ list: [{ roomKey: 'parent' }], hasMore: false }, 'Parent', 0],
    [{ list: [{ roomKey: 'a' }, { roomKey: 'b' }], hasMore: false }, '', 0]
  ]) {
    const ctx = pickerContext(async () => response, { search })
    await ctx.load(true)
    assert.equal(ctx.events.filter(x => x[0] === 'select').length, selects)
    assert.equal(ctx.error, false)
    assert.equal(!!ctx.showMenu, selects === 0)
  }
})

test('picker merges pages without duplicates; loading guards double requests', async () => {
  let resolve, calls = 0
  const ctx = pickerContext(() => { calls++; return new Promise(done => { resolve = done }) }, {
    items: [{ roomKey: 'a' }], cursor: 'page2'
  })
  const pending = ctx.load(false)
  await ctx.load(false)
  assert.equal(calls, 1)
  resolve({ list: [{ roomKey: 'a' }, { roomKey: 'b' }], hasMore: false })
  await pending
  assert.deepEqual(Array.from(ctx.items, x => x.roomKey), ['a', 'b'])
  assert.equal(ctx.events.some(x => x[0] === 'select'), false)
})

test('query failure is an error, retry can resolve a unique parent', async () => {
  let fail = true
  const ctx = pickerContext(async () => {
    if (fail) throw new Error('network failure')
    return { list: [{ roomKey: 'parent' }], hasMore: false }
  })
  await ctx.load(true)
  assert.equal(ctx.error, true)
  assert.equal(ctx.events.some(x => x[0] === 'select'), false)
  fail = false
  await ctx.load(false)
  assert.equal(ctx.error, false)
  assert.equal(ctx.events.some(x => x[0] === 'select'), true)
})

for (const mode of ['close', 'room change', 'new search']) {
  test(`late query after ${mode} cannot populate or select a parent`, async () => {
    let resolve, signal
    const ctx = pickerContext((room, opts) => {
      signal = opts.signal
      return new Promise(done => { resolve = done })
    })
    const pending = ctx.load(true)
    if (mode === 'room change') ctx.room = 'new-room'
    else ctx.cancel()
    resolve({ list: [{ roomKey: 'parent' }], hasMore: false })
    await pending
    assert.deepEqual(ctx.items, [])
    assert.equal(ctx.events.some(x => x[0] === 'select'), false)
    if (mode !== 'room change') assert.equal(signal.aborted, true)
  })
}

test('the entire save sequence is bounded, including a stalled preparation', async () => {
  const babel = require('@babel/core')
  const source = fs.readFileSync(path.join(__dirname, '../src/utils/mapNavTrail.js'), 'utf8')
  const { code } = babel.transformSync(source, {
    babelrc: false, configFile: false, plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
  })
  const moduleRef = { exports: {} }
  new Function('module', 'exports', code)(moduleRef, moduleRef.exports)
  await assert.rejects(moduleRef.exports.withMapNavSaveDeadline(() => new Promise(() => {}), 20), /timed out/)
  assert.equal(await moduleRef.exports.withMapNavSaveDeadline(async () => true, 100), true)
})

test('replace navigation strips child positioning and establishes a fresh entry without a fake history trail', async () => {
  const events = []
  let room = 'child'
  const replace = loadMethod('Toolbar.vue', 'replaceWithParentMap', {
    ensureEntryNav: value => events.push(['entry', value])
  })
  await replace.call({
    currentRoomKey: () => room,
    $route: { query: { room: 'child', focus: 'child-node', shallowExpand: '2', other: 'kept' } },
    $router: { replace: async route => { events.push(['query', JSON.parse(JSON.stringify(route.query))]); room = route.query.room } }
  }, { room: 'parent' }, null)
  assert.deepEqual(events, [['query', { room: 'parent', other: 'kept' }], ['entry', 'parent']])
})

test('history landing requires both room and entry identity, then uses replace fallback after at most 3 seconds', async () => {
  for (const mode of ['correct', 'wrong identity', 'wrong room', 'timeout']) {
    const events = []
    const listeners = {}
    let timer
    const traverse = loadMethod('Toolbar.vue', 'traverseBackToParentMap', {
      MAP_NAV_BACK_TIMEOUT_MS: 3000,
      readEntryNav: () => ({ trail: [] }),
      roomFromLocation: () => mode === 'wrong room' ? 'unrelated' : 'parent',
      isParentEntry: () => mode !== 'wrong identity',
      setTimeout: (fn, ms) => { assert.equal(ms, 3000); timer = fn; return 1 },
      window: {
        history: { state: {}, back: () => events.push('back') },
        addEventListener: (name, handler) => { listeners[name] = handler },
        removeEventListener: name => delete listeners[name]
      }
    })
    const pending = traverse.call({ replaceWithParentMap: async () => events.push('replace') }, { room: 'parent' }, 'child')
    if (mode === 'timeout') timer(); else listeners.popstate()
    await pending
    assert.deepEqual(events, mode === 'correct' ? ['back'] : ['back', 'replace'])
    assert.equal(Object.keys(listeners).length, 0)
  }
})
