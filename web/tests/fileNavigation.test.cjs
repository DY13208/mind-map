const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const babel = require('@babel/core')

const repo = path.resolve(__dirname, '..')

function loadModule(relPath, dependencies = {}) {
  const filename = path.resolve(repo, relPath)
  const { code } = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
    babelrc: false,
    configFile: false,
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
  })
  const moduleRef = { exports: {} }
  new Function('require', 'module', 'exports', code)(
    request => {
      if (Object.prototype.hasOwnProperty.call(dependencies, request)) {
        return dependencies[request]
      }
      throw new Error(`Unexpected dependency: ${request}`)
    },
    moduleRef,
    moduleRef.exports
  )
  return moduleRef.exports
}

const shellMode = loadModule('src/utils/shellMode.js')
const roomLocationCalls = []
const roomLocation = {
  armSkipMyMapsRedirect: () => roomLocationCalls.push('skip-mymaps-redirect')
}
const navigation = loadModule('src/utils/fileNavigation.js', {
  './shellMode': shellMode,
  './roomLocation': roomLocation
})

function createStorage(seed = []) {
  const values = new Map(seed)
  return {
    get length() { return values.size },
    key(index) { return Array.from(values.keys())[index] || null },
    getItem(key) { return values.has(key) ? values.get(key) : null },
    setItem(key, value) { values.set(String(key), String(value)) },
    removeItem(key) { values.delete(key) },
    keys() { return Array.from(values.keys()) }
  }
}

const sourceRoute = (path, team) => ({
  path,
  query: team ? { team } : {}
})

test('returnTo only accepts known list routes and rejects external or unknown my-maps paths', () => {
  assert.equal(navigation.normalizeReturnTo('https://outside.invalid/path'), '')
  assert.equal(navigation.normalizeReturnTo('//outside.invalid/path'), '')
  assert.equal(navigation.normalizeReturnTo('/my-maps/unknown'), '')
  assert.equal(navigation.normalizeReturnTo('/my-maps/recent'), '')
  assert.equal(navigation.normalizeReturnTo('/files/folder/../admin'), '')
  assert.equal(
    navigation.normalizeReturnTo('/files/folder/folder-7?team=team-3'),
    '/files/folder/folder-7?team=team-3'
  )
})

test('a valid files source takes precedence over room ownership metadata', () => {
  const route = {
    path: '/',
    query: {
      room: 'room-current',
      shell: 'full',
      returnTo: '/files/folder/source-folder?team=source-team'
    }
  }
  const target = navigation.resolveReturnTarget({
    route,
    file: { folderId: 'owner-folder', teamId: 'owner-team' }
  })
  assert.equal(target.path, '/files/folder/source-folder')
  assert.deepEqual(target.query, { team: 'source-team', shell: 'full' })
})

test('a valid my-maps source takes precedence over room ownership metadata', () => {
  const route = {
    path: '/',
    query: {
      room: 'room-current',
      shell: 'focus',
      returnTo: '/my-maps/folder/source-folder?team=source-team'
    }
  }
  const target = navigation.resolveReturnTarget({
    route,
    file: { folderId: 'owner-folder', teamId: 'owner-team' }
  })
  assert.equal(target.path, '/my-maps/folder/source-folder')
  assert.deepEqual(target.query, { team: 'source-team', shell: 'focus' })
})

test('a source team root takes precedence over the room folder/team assignment', () => {
  const route = {
    path: '/',
    query: {
      room: 'room-current',
      shell: 'full',
      returnTo: '/files?team=source-team'
    }
  }
  const target = navigation.resolveReturnTarget({
    route,
    file: { folderId: 'owner-folder', teamId: 'owner-team' }
  })
  assert.equal(target.path, '/files')
  assert.deepEqual(target.query, { team: 'source-team', shell: 'full' })
})

test('without a source context, folderId and teamId resolve to the folder in the legacy my-maps shell', () => {
  const target = navigation.resolveReturnTarget({
    route: { path: '/', query: { room: 'legacy-room' } },
    file: { folderId: 'folder-8', teamId: 'team-8' }
  })
  assert.equal(target.path, '/my-maps/folder/folder-8')
  assert.deepEqual(target.query, { team: 'team-8', shell: 'focus' })
})

test('without source or folder context, old editor links return to the my-maps root', () => {
  const target = navigation.resolveReturnTarget({
    route: { path: '/', query: { room: 'legacy-room' } },
    file: { folderId: null, teamId: null }
  })
  assert.equal(target.path, '/my-maps')
  assert.deepEqual(target.query, { shell: 'focus' })
})

test('a direct file-folder fallback preserves team scope and explicit full-shell mode', () => {
  const target = navigation.resolveReturnTarget({
    route: { path: '/', query: { room: 'direct-room', shell: 'full' } },
    file: { folder_id: 'folder-9', team_id: 'team-9' }
  })
  assert.equal(target.path, '/files/folder/folder-9')
  assert.deepEqual(target.query, { team: 'team-9', shell: 'full' })
})

test('list snapshots are isolated by nav and remain readable after switching rooms inside the editor', () => {
  const storage = createStorage()
  const route = sourceRoute('/files/folder/folder-4', 'team-4')
  const first = navigation.createEditorLocation({
    route,
    room: 'room-first',
    folderName: '第一目录',
    storage,
    state: {
      search: 'first search', roleFilter: 'editor', sort: 'title',
      page: 4, limit: 50, view: 'list', scroll: { top: 321, left: 12 }
    }
  })
  const second = navigation.createEditorLocation({
    route,
    room: 'room-second',
    folderName: '第二目录',
    storage,
    state: {
      search: 'second search', roleFilter: 'viewer', sort: 'updatedAt',
      page: 2, limit: 10, view: 'card', scroll: { top: 654, left: 3 }
    }
  })
  assert.notEqual(first.query.nav, second.query.nav)

  const firstContext = navigation.readReturnContext(first, storage)
  const secondContext = navigation.readReturnContext(second, storage)
  assert.equal(firstContext.roomKey, 'room-first')
  assert.equal(firstContext.state.search, 'first search')
  assert.equal(firstContext.folderName, '第一目录')
  assert.equal(secondContext.roomKey, 'room-second')
  assert.equal(secondContext.state.search, 'second search')
  assert.equal(secondContext.folderName, '第二目录')

  const switchedRoomRoute = {
    path: '/',
    query: { ...first.query, room: 'room-opened-from-inside-editor' }
  }
  assert.equal(
    navigation.readReturnContext(switchedRoomRoute, storage).state.search,
    'first search',
    'Internal room switching must retain the originating list snapshot for this nav'
  )
  assert.equal(
    navigation.readReturnContext({
      path: '/',
      query: { ...first.query, nav: 'unrelated-navigation-token' }
    }, storage),
    null,
    'A different navigation id must not reuse this entry snapshot'
  )
})

test('snapshot capture and restore retain list filters and clamp the page to current results', () => {
  const snapshot = navigation.captureListState({
    search: '  planning  ', roleFilter: 'owner', sort: 'title',
    page: 9.8, limit: 10, view: 'list', scroll: { top: 888, left: 21 }
  })
  assert.deepEqual(snapshot, {
    search: '  planning  ', roleFilter: 'owner', sort: 'title',
    page: 9, limit: 10, view: 'list', scroll: { top: 888, left: 21 }
  })
  assert.deepEqual(navigation.restoreListState(snapshot, { total: 23 }), {
    ...snapshot,
    page: 3
  })
  assert.equal(navigation.clampListPage(8, 0, 20), 1)
  assert.equal(navigation.clampListPage(0, 51, 20), 1)
})

test('malformed and mismatched session snapshots degrade to no return context', () => {
  const nav = '1234567890abcdef1234567890abcdef'
  const route = {
    path: '/',
    query: {
      room: 'room-1', shell: 'focus', nav,
      returnTo: '/files/folder/folder-1'
    }
  }
  const malformed = createStorage([[`mind-map:file-nav:v1:${nav}`, '{broken json']])
  assert.equal(navigation.readReturnContext(route, malformed), null)

  const mismatched = createStorage([[`mind-map:file-nav:v1:${nav}`, JSON.stringify({
    version: 1, nav, roomKey: 'room-1', returnTo: '/files/folder/another-folder', createdAt: 1
  })]])
  assert.equal(navigation.readReturnContext(route, mismatched), null)
})

test('bounded session storage evicts old records and quota failures do not block editor navigation', () => {
  const prefix = 'mind-map:file-nav:v1:'
  const records = Array.from({ length: 50 }, (_, index) => {
    const nav = `old-navigation-${String(index).padStart(3, '0')}`
    return [`${prefix}${nav}`, JSON.stringify({ createdAt: index + 1 })]
  })
  const fullStorage = createStorage(records)
  const location = navigation.createEditorLocation({
    route: sourceRoute('/files', ''),
    room: 'new-room',
    storage: fullStorage,
    state: { page: 1 }
  })
  assert.equal(fullStorage.length, 50, 'The navigation record count stays bounded')
  assert.equal(fullStorage.getItem(`${prefix}old-navigation-000`), null)
  assert.ok(fullStorage.getItem(`${prefix}${location.query.nav}`))
  assert.ok(navigation.readReturnContext(location, fullStorage))

  const quotaStorage = {
    get length() { return 0 },
    key() { return null },
    getItem() { return null },
    setItem() { throw new Error('QuotaExceededError') },
    removeItem() {}
  }
  assert.doesNotThrow(() => {
    const degraded = navigation.createEditorLocation({
      route: sourceRoute('/files', ''), room: 'quota-room', storage: quotaStorage
    })
    assert.equal(degraded.path, '/')
    assert.equal(degraded.query.room, 'quota-room')
    assert.equal(degraded.query.returnTo, '/files')
    assert.equal(navigation.readReturnContext(degraded, quotaStorage), null)
  })
})

test('scroll capture and restore use the nearest scrollable container and clamp to its bounds', () => {
  const pane = {
    scrollTop: 73,
    scrollLeft: 12,
    scrollHeight: 600,
    clientHeight: 400,
    scrollWidth: 250,
    clientWidth: 200,
    parentElement: null
  }
  const root = { parentElement: pane }
  const docElement = {
    scrollTop: 900,
    scrollLeft: 800,
    scrollHeight: 2000,
    clientHeight: 700,
    scrollWidth: 1400,
    clientWidth: 900
  }
  const body = {}
  const document = {
    body,
    documentElement: docElement,
    scrollingElement: docElement
  }
  const window = {
    scrollY: 900,
    scrollX: 800,
    scrollTo() { throw new Error('Expected the inner list container to scroll') }
  }
  let computedStyleCalls = 0
  const environment = {
    document,
    window,
    getComputedStyle(element) {
      computedStyleCalls++
      assert.strictEqual(
        this,
        window,
        'getComputedStyle must be invoked with its owning window as this'
      )
      return element === pane
        ? { overflowY: 'auto', overflowX: 'hidden' }
        : { overflowY: 'visible', overflowX: 'visible' }
    }
  }

  assert.deepEqual(navigation.captureScrollPosition(root, environment), {
    top: 73, left: 12
  })
  assert.equal(computedStyleCalls, 2, 'Capture must probe computed style on the root and its scroll container')
  navigation.restoreScrollPosition({ top: 900, left: 500 }, root, environment)
  assert.equal(computedStyleCalls, 4, 'Restore must also probe computed style with the owning window receiver')
  assert.equal(pane.scrollTop, 200)
  assert.equal(pane.scrollLeft, 50)
})

test('returning to the my-maps root arms the existing router redirect bypass', async () => {
  roomLocationCalls.length = 0
  const pushes = []
  const router = { push: async target => pushes.push(target) }
  const target = await navigation.navigateToFileList(router, {
    route: { path: '/', query: { room: 'legacy-room' } },
    file: { folderId: null }
  })
  assert.equal(target.path, '/my-maps')
  assert.deepEqual(roomLocationCalls, ['skip-mymaps-redirect'])
  assert.equal(pushes.length, 1)
  assert.equal(pushes[0].path, '/my-maps')
})
