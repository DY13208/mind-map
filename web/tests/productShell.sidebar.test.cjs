const assert = require('assert').strict
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const babel = require('@babel/core')
const { parseComponent } = require('vue-template-compiler')

const filename = path.resolve(
  __dirname,
  '../src/pages/ProductShell/components/ProductShellLayout.vue'
)
const source = parseComponent(fs.readFileSync(filename, 'utf8')).script.content
const { code } = babel.transformSync(source, {
  babelrc: false,
  configFile: false,
  plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
})

function setup({ small = false, saved = null, storageBlocked = false } = {}) {
  let currentSmall = small
  let stored = saved
  const listeners = new Map()
  const module = { exports: {} }
  const context = {
    module,
    exports: module.exports,
    require: () => ({ getProfile: async () => ({ name: 'QA' }) }),
    localStorage: {
      getItem() {
        if (storageBlocked) throw Error('blocked')
        return stored
      },
      setItem(key, value) {
        if (storageBlocked) throw Error('blocked')
        stored = value
      }
    },
    window: {
      matchMedia: () => ({ matches: currentSmall }),
      addEventListener: (name, listener) => listeners.set(name, listener),
      removeEventListener: (name, listener) => {
        if (listeners.get(name) === listener) listeners.delete(name)
      }
    }
  }
  vm.runInNewContext(code, context)
  const component = module.exports.default
  const state = component.data()
  for (const [name, method] of Object.entries(component.methods))
    state[name] = method.bind(state)
  component.mounted.call(state)
  return {
    state,
    saved: () => stored,
    resize(value) {
      currentSmall = value
      listeners.get('resize')()
    },
    destroy() {
      component.beforeDestroy.call(state)
      assert.equal(listeners.size, 0)
    }
  }
}

const desktop = setup()
assert.equal(desktop.state.sidebarCollapsed, false)
desktop.resize(true)
assert.equal(desktop.state.sidebarCollapsed, true)
desktop.resize(false)
assert.equal(desktop.state.sidebarCollapsed, false)
desktop.state.setSidebarCollapsed(true)
assert.equal(desktop.saved(), 'true')
desktop.resize(false)
assert.equal(
  desktop.state.sidebarCollapsed,
  true,
  'Manual preference survives resize'
)
desktop.destroy()

const restored = setup({ saved: 'true' })
assert.equal(restored.state.sidebarCollapsed, true)
restored.state.setSidebarCollapsed(false)
assert.equal(restored.saved(), 'false')
restored.destroy()

const mobile = setup({ small: true, saved: 'invalid' })
assert.equal(mobile.state.sidebarCollapsed, true)
mobile.state.setSidebarCollapsed(false)
assert.equal(mobile.state.sidebarCollapsed, false)
mobile.destroy()

const blocked = setup({ storageBlocked: true })
assert.doesNotThrow(() => blocked.state.setSidebarCollapsed(true))
assert.equal(blocked.state.sidebarCollapsed, true)
blocked.destroy()
console.log('Product shell sidebar state tests passed')
