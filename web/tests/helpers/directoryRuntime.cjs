// Executes the production SFC scripts and services. Only cosmetic child
// components, identity storage and the HTTP transport are test boundaries.
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const root = path.resolve(__dirname, '../..')
const webRequire = createRequire(path.join(root, 'package.json'))
const babel = webRequire('@babel/core')
const compiler = webRequire('vue-template-compiler')
const Vue = webRequire('vue')

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function room(key, revision = 1) {
  return {
    id: key, roomKey: key, title: key, revision,
    folderId: null, folderName: '根目录',
    createdAt: '2026-10-13T00:00:00.000Z',
    updatedAt: `2026-10-13T00:00:${String(revision).padStart(2, '0')}.000Z`,
    contentUpdatedAt: `2026-10-13T00:00:${String(revision).padStart(2, '0')}.000Z`,
    owner: { id: 'owner', name: 'Owner', avatar: '' },
    role: 'owner', roleLabel: '所有者', favorite: false, collaborators: [],
    canView: true, canEdit: true, canManage: true
  }
}

function createDirectoryRuntime({ overrides = {} } = {}) {
  const modules = new Map()
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const storageValues = new Map()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => storageValues.has(key) ? storageValues.get(key) : null,
    setItem: (key, value) => storageValues.set(key, String(value)),
    removeItem: key => storageValues.delete(key)
  } })
  let identity = { id: 'owner', corpId: 'test-corp' }
  const cosmetic = { default: { render(h) { return h('span') } } }
  function load(filename) {
    if (!path.extname(filename)) filename += '.js'
    filename = path.normalize(filename)
    if (overrides[filename]) return overrides[filename]
    if (modules.has(filename)) return modules.get(filename).exports
    if (filename === path.join(root, 'src/utils/auth.js')) {
      return { getCurrentUser: () => identity }
    }
    const module = { exports: {} }
    modules.set(filename, module)
    let source = fs.readFileSync(filename, 'utf8')
    if (filename.endsWith('.vue')) source = compiler.parseComponent(source).script.content
    const { code } = babel.transformSync(source, {
      filename, babelrc: false, configFile: false,
      plugins: [webRequire.resolve('@babel/plugin-transform-modules-commonjs')]
    })
    const requireFromSource = name => {
      let target
      if (name.startsWith('@/')) target = path.join(root, 'src', name.slice(2))
      else if (name.startsWith('.')) target = path.resolve(path.dirname(filename), name)
      else if (name.startsWith('simple-mind-map/')) target = path.resolve(root, '..', name)
      else return webRequire(name)
      if (target.endsWith('.vue') &&
          !target.endsWith('/RoomCard.vue') && !target.endsWith('/MindMapPreview.vue')) return cosmetic
      return load(target)
    }
    new Function('require', 'module', 'exports', code)(requireFromSource, module, module.exports)
    return module.exports
  }
  const services = {
    room: load(path.join(root, 'src/services/roomService.js')).default,
    team: load(path.join(root, 'src/services/teamService.js')).default,
    http: load(path.join(root, 'src/services/productHttp.js'))
  }
  const card = load(path.join(root, 'src/pages/ProductShell/components/RoomCard.vue')).default
  const cards = []
  function makeCard(data) {
    const vm = new Vue({ ...card, propsData: { room: data } })
    cards.push(vm)
    return vm
  }
  return {
    Vue, services, load, makeCard,
    setIdentity(value) { identity = value },
    destroy() {
      cards.forEach(vm => { if (!vm._isDestroyed) vm.$destroy() })
      if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor)
      else delete globalThis.localStorage
    }
  }
}

module.exports = { createDirectoryRuntime, deferred, room, Vue, root }
