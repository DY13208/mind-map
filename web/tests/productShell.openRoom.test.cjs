const assert = require('assert')
const fs = require('fs')
const path = require('path')
const Vue = require('vue')
const VueRouter = require('vue-router')
Vue.use(VueRouter)

const source = fs.readFileSync(path.join(__dirname, '../src/pages/ProductShell/FilesPage.vue'), 'utf8')
const body = source.split('    async openRoom(room) {')[1].split('    async createRoom() {')[0]
const makeOpen = new Function('roomService', 'isNavigationFailure', 'NavigationFailureType', 'userMessageFromError',
  'return async function(room) {' + body.trim().replace(/,$/, ''))
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

async function main() {
  let requests = 0
  let pushes = 0
  const request = deferred()
  const errors = []
  const context = {
    $route: { path: '/files/folder/example' },
    $router: { push: async () => { pushes++ } },
    $message: { error: message => errors.push(message) },
    openingRoom: false
  }
  const open = makeOpen({ markOpened: () => { requests++; return request.promise } },
    VueRouter.isNavigationFailure, VueRouter.NavigationFailureType, error => error.message)
  const first = open.call(context, { roomKey: 'room-example' })
  await open.call(context, { roomKey: 'room-example' })
  assert.equal(requests, 1, 'Repeated clicks must share one open operation')
  request.resolve()
  await first
  assert.equal(pushes, 1)
  assert.equal(context.openingRoom, false)

  const slow = deferred()
  const slowOpen = makeOpen({ markOpened: () => slow.promise },
    VueRouter.isNavigationFailure, VueRouter.NavigationFailureType, error => error.message)
  const pending = slowOpen.call(context, { id: 'room-example' })
  context.$route = { path: '/files/recent' }
  slow.resolve()
  await pending
  assert.equal(pushes, 1, 'A stale request must not navigate after the user leaves')

  // Exercise the real router's cancellation and duplicate errors.
  const router = new VueRouter({ mode: 'abstract', routes: [
    { path: '/files/folder/example' }, { path: '/' }, { path: '/files/recent' }
  ] })
  await router.push('/files/folder/example')
  let release
  router.beforeEach((to, from, next) => {
    if (to.query.room) release = next
    else next()
  })
  context.$router = router
  const navigating = open.call(context, { roomKey: 'room-example' })
  await Promise.resolve()
  await router.push('/files/recent')
  release()
  await navigating
  assert.deepStrictEqual(errors, [])
  assert.equal(router.currentRoute.path, '/files/recent')
  context.$router = { push: () => router.push('/files/recent') }
  await open.call(context, { roomKey: 'room-example' })
  assert.deepStrictEqual(errors, [])

  context.$router = { push: async () => { throw new Error('Chunk load failed') } }
  await open.call(context, { roomKey: 'room-example' })
  assert.deepStrictEqual(errors, ['Chunk load failed'])
  assert.equal(context.openingRoom, false)
  console.log('Room opening navigation tests passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
