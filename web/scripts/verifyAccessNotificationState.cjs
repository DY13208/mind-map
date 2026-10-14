const assert = require('assert/strict'),
  path = require('path'),
  Module = require('module'),
  esbuild = require('esbuild'),
  fs = require('fs'),
  compiler = require('vue-template-compiler')
async function main() {
  require('vue') // Initialize Vue for Node before installing the browser stubs.
  const root = path.resolve(__dirname, '..'),
    messages = [],
    deferred = []
  global.__accessMessages = messages
  const listeners = new Map(),
    storage = new Map()
  global.window = {
    location: {
      origin: 'http://local',
      hostname: 'local',
      host: 'local',
      protocol: 'http:'
    },
    sessionStorage: {
      getItem: k => storage.get(k) || null,
      setItem: (k, v) => storage.set(k, v)
    },
    setInterval: () => 1,
    clearInterval: () => {},
    addEventListener: (k, v) => listeners.set(k, v),
    removeEventListener: k => listeners.delete(k)
  }
  global.document = {
    hidden: false,
    addEventListener: (k, v) => listeners.set(k, v),
    removeEventListener: k => listeners.delete(k)
  }
  const streams = []
  global.EventSource = class {
    constructor(url) {
      this.url = url
      this.handlers = {}
      this.closed = false
      streams.push(this)
    }
    addEventListener(type, cb) {
      this.handlers[type] = cb
    }
    close() {
      this.closed = true
    }
  }
  const result = await esbuild.build({
    stdin: {
      resolveDir: root,
      contents:
        "export * from './src/services/accessNotificationState';export {setProductHttp} from './src/services/productHttp';export {default as Center} from './src/components/AccessNotifications.vue';"
    },
    bundle: true,
    external: ['vue'],
    write: false,
    format: 'cjs',
    platform: 'node',
    alias: { '@': path.join(root, 'src') },
    plugins: [
      {
        name: 'notification-test',
        setup(build) {
          build.onLoad({ filter: /\.vue$/ }, args => ({
            contents: compiler.parseComponent(
              fs.readFileSync(args.path, 'utf8')
            ).script.content,
            resolveDir: path.dirname(args.path),
            loader: 'js'
          }))
          build.onResolve({ filter: /^element-ui$/ }, () => ({
            path: 'notification',
            namespace: 'stub'
          }))
          build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
            contents:
              'export const Notification=options=>global.__accessMessages.push(options)',
            loader: 'js'
          }))
        }
      }
    ]
  })
  const mod = new Module(__filename, module)
  mod.paths = module.paths
  mod._compile(result.outputFiles[0].text, __filename)
  const {
    state,
    startNotifications,
    stopNotifications,
    refreshNotifications,
    setProductHttp,
    openNotifications,
    Center
  } = mod.exports
  setProductHttp(url => new Promise(resolve => deferred.push({ url, resolve })))
  startNotifications('old-user')
  assert.equal(streams.length, 1)
  assert.equal(deferred.length, 2)
  stopNotifications()
  assert.equal(streams[0].closed, true)
  startNotifications('current-user')
  stopNotifications('old-user')
  assert.equal(
    streams[1].closed,
    false,
    'Destroying an old provider must not stop the new identity'
  )
  assert.equal(streams.length, 2)
  const row = {
    id: 'request',
    requester_name: 'Test colleague',
    title: '项目',
    updated_at: '2026-10-14',
    requested_role: 'editor'
  }
  deferred[0].resolve({ list: [{ ...row, id: 'private-old-user' }], total: 1 })
  deferred[1].resolve({ list: [], total: 0, unread: 0 })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(
    state.items.length,
    0,
    'Late response from the previous user must not leak'
  )
  deferred[2].resolve({ list: [row], total: 1 })
  deferred[3].resolve({ list: [], total: 0, unread: 0 })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(state.items[0].id, 'request')
  assert.equal(messages.length, 1)
  streams[1].onerror()
  assert.equal(state.connected, false)
  streams[1].handlers.ready()
  assert.equal(state.connected, true)
  deferred[4].resolve({ list: [row], total: 1 })
  deferred[5].resolve({
    list: [
      {
        id: 'result',
        status: 'approved',
        title: '项目',
        granted_role: 'manager',
        requested_role: 'viewer',
        decided_at: 'now'
      }
    ],
    total: 1,
    unread: 1
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(
    messages.length,
    2,
    'Reconnect does not duplicate the original request toast'
  )
  assert.match(messages[1].message, /可管理/)
  const again = refreshNotifications()
  deferred[6].resolve({ list: [row], total: 1 })
  deferred[7].resolve({ list: [], total: 0, unread: 0 })
  await again
  assert.equal(messages.length, 2)
  const component = new (require('vue').extend(Center))({
    propsData: { userId: 'current-user' }
  })
  state.activeTab = 'requests'
  component.changePage(2)
  assert.match(deferred[8].url, /offset=20/)
  deferred[8].resolve({ list: [row], total: 25 })
  deferred[9].resolve({ list: [], total: 0, unread: 0 })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(state.page, 2)
  openNotifications('results')
  assert.equal(state.visible, true)
  assert.equal(state.activeTab, 'results')
  stopNotifications()
  assert.equal(streams[1].closed, true)
  assert.equal(listeners.size, 0)
  assert.equal(state.items.length, 0)
  component.$destroy()
  console.log(
    'Notification state checks passed: identity isolation, stale reads, realtime reconnect, durable refresh, toast deduplication, actual granted role, lifecycle cleanup'
  )
}
main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
