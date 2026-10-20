/* eslint-env node */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const source = fs.readFileSync(
  path.join(__dirname, '../src/pages/ProductShell/FilesPage.vue'),
  'utf8'
)

function methodBody(signature, nextSignature) {
  const start = source.indexOf(signature)
  assert.notEqual(start, -1, `Missing method: ${signature}`)
  const end = source.indexOf(nextSignature, start)
  assert.notEqual(end, -1, `Missing method boundary: ${nextSignature}`)
  const segment = source.slice(start, end)
  const bodyStart = segment.indexOf('{')
  const bodyEnd = segment.lastIndexOf('},')
  assert.ok(bodyStart >= 0 && bodyEnd > bodyStart, `Could not read ${signature}`)
  return segment.slice(bodyStart + 1, bodyEnd)
}

async function main() {
  const navigateBody = methodBody(
    'async navigateToEditor(room, state, sourceRoute = this.$route) {',
    '    async restoreReturnPosition() {'
  )
  const navigateToEditor = new Function(
    `return async function(room, state, sourceRoute) {${navigateBody}\n}`
  )()

  const sourceRoute = {
    path: '/files/folder/folder-1',
    query: { team: 'team-1', shell: 'full' }
  }
  const editorLocation = {
    path: '/',
    query: {
      room: 'room-1',
      returnTo: '/files/folder/folder-1?team=team-1',
      shell: 'full',
      nav: '0123456789abcdef0123456789abcdef'
    }
  }
  const calls = []
  const context = {
    $route: sourceRoute,
    $router: {
      async replace(location) {
        calls.push(['replace', location])
        context.$route = { ...location }
      },
      async push(location) {
        calls.push(['push', location])
      }
    },
    editorLocation: () => editorLocation,
    _isDestroyed: false
  }
  await navigateToEditor.call(context, { roomKey: 'room-1' }, {}, sourceRoute)
  assert.equal(calls.length, 2)
  assert.equal(calls[0][0], 'replace')
  assert.equal(calls[0][1].path, sourceRoute.path)
  assert.equal(calls[0][1].query.team, 'team-1')
  assert.equal(calls[0][1].query.shell, 'full')
  assert.equal(calls[0][1].query.nav, editorLocation.query.nav)
  assert.equal(calls[1][0], 'push')
  assert.equal(calls[1][1], editorLocation)

  const staleCalls = []
  const staleContext = {
    ...context,
    $route: sourceRoute,
    $router: {
      async replace() {
        staleContext.$route = { path: '/files/recent', query: {} }
      },
      async push(location) {
        staleCalls.push(location)
      }
    }
  }
  await navigateToEditor.call(staleContext, { roomKey: 'room-1' }, {}, sourceRoute)
  assert.equal(staleCalls.length, 0, 'Do not open the editor after the user leaves the source list')

  const restoreBody = methodBody(
    'restoreNavigationState() {',
    '    captureCurrentListState() {'
  )
  const restoreNavigationState = new Function(
    'readReturnContext',
    'restoreListState',
    `return function() {${restoreBody}\n}`
  )(
    () => ({ roomKey: 'room-1', returnTo: '/files/folder/folder-1', state: {} }),
    () => ({
      search: 'needle',
      roleFilter: 'editor',
      sort: 'title',
      page: 3,
      limit: 50,
      view: 'list',
      scroll: { top: 700, left: 0 }
    })
  )
  let loaded
  const restoreContext = {
    $route: { path: '/files/folder/folder-1', query: { nav: 'nav' } },
    $nextTick(callback) { callback() },
    load(options) { loaded = options },
    _isDestroyed: false
  }
  restoreNavigationState.call(restoreContext)
  assert.equal(restoreContext.search, 'needle')
  assert.equal(restoreContext.roleFilter, 'editor')
  assert.equal(restoreContext.sort, 'title')
  assert.equal(restoreContext.page, 3)
  assert.equal(restoreContext.limit, 50)
  assert.equal(restoreContext.view, 'list')
  assert.equal(restoreContext.returnStatePending, true)
  assert.deepEqual(loaded, { reset: true, keepPage: true })

  const routeWatchBody = methodBody(
    "    '$route'(to, from) {",
    '    search() {'
  )
  const routeWatcher = new Function(
    'isShellOnlyRouteChange',
    `return function(to, from) {${routeWatchBody}\n}`
  )(() => false)
  let restoredAfterRouteChange = 0
  let resetAfterRouteChange = 0
  routeWatcher.call({
    restoreNavigationState() { restoredAfterRouteChange++ },
    resetPage() { resetAfterRouteChange++ }
  }, { path: '/files/folder/folder-1', query: { nav: 'nav-1' } }, { path: '/' })
  assert.equal(restoredAfterRouteChange, 1, 'Real route changes restore the matching list context')
  assert.equal(resetAfterRouteChange, 0, 'Route changes must not discard a valid return context')

  const resetBody = methodBody(
    '    resetPage() {',
    '    restoreNavigationState() {'
  )
  const resetPage = new Function(
    'clearTimeout',
    `return function() {${resetBody}\n}`
  )(() => {})
  const resetContext = {
    highlightTimer: 123,
    returnContext: { roomKey: 'stale-room' },
    returnStatePending: true,
    restoringListState: true,
    highlightRoomKey: 'stale-room',
    mode: 'files',
    clearSelection() {},
    load(options) { loaded = options }
  }
  resetPage.call(resetContext)
  assert.equal(resetContext.returnContext, null)
  assert.equal(resetContext.returnStatePending, false)
  assert.equal(resetContext.restoringListState, false)
  assert.equal(resetContext.highlightRoomKey, '')
  assert.deepEqual(loaded, { reset: true, keepPage: true })

  const importBody = methodBody(
    '    async onImported(result) {',
    '    renameRoomInline(room, name) {'
  )
  const onImported = new Function(
    'withShell',
    `return async function(result) {${importBody}\n}`
  )((location, route) => ({ ...location, query: { ...location.query, shell: route.query.shell } }))
  const importedRoom = { roomKey: 'imported-room', folderId: 'folder-1' }
  const importCalls = []
  const importContext = {
    $route: sourceRoute,
    filesBasePath: '/files',
    selectedTeamId: 'team-1',
    load: async options => importCalls.push(['load', options]),
    navigateToEditor: async room => importCalls.push(['editor', room]),
    $router: { push: location => importCalls.push(['folder', location]) }
  }
  await onImported.call(importContext, { mode: 'single', room: importedRoom })
  assert.deepEqual(importCalls, [
    ['load', { reset: true, keepPage: true }], ['editor', importedRoom]
  ], 'Single import uses the same editor navigation and retains the source page')
  importCalls.length = 0
  await onImported.call(importContext, { mode: 'folder', folderId: 'new-folder' })
  assert.deepEqual(importCalls[1], ['folder', {
    path: '/files/folder/new-folder', query: { team: 'team-1', shell: 'full' }
  }], 'Folder import retains entry, team, and presentation without opening an unrelated editor')

  console.log('FilesPage return navigation tests passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
