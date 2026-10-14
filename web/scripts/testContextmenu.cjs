const assert = require('assert')
const fs = require('fs')
const vm = require('vm')
const cp = require('child_process')
const compiler = require('vue-template-compiler')
const path = require('path')
const root = path.resolve(__dirname, '../..')
const file = 'web/src/pages/Edit/components/Contextmenu.vue'
const source = fs.readFileSync(path.join(root, file), 'utf8')
const original = cp.execFileSync('git', ['show', `HEAD:${file}`], { encoding: 'utf8', cwd: root })
const parsed = compiler.parseComponent(source)
const compiled = compiler.compile(parsed.template.content)
assert.deepStrictEqual(compiled.errors, [])
const context = { MenuIcon: {}, mapState: () => ({}), mapMutations: () => ({}), window: { innerWidth: 800, innerHeight: 600 }, navigator: { clipboard: null } }
const script = parsed.script.content.replace(/^import .*$/gm, '').replace('export default', 'component =')
vm.runInNewContext(script, context)
const component = context.component
const instance = { ...component.data(), ...component.methods, $nextTick: fn => fn(), $refs: { submenuRef: { getBoundingClientRect: () => ({ width: 284, height: 380 }) }, contextmenuRef: { getBoundingClientRect: () => ({ width: 284, height: 550 }) } } }
instance.openSubmenu('content', { currentTarget: { getBoundingClientRect: () => ({ left: 500, right: 784, top: 550 }) } })
assert.equal(instance.submenuLeft, 216)
assert.equal(instance.submenuTop, 210)
instance.openSubmenu('structure', { currentTarget: { getBoundingClientRect: () => ({ left: 10, right: 294, top: 10 }) } })
assert.equal(instance.submenuLeft, 294)
assert.equal(instance.submenuTop, 10)
assert.deepStrictEqual(JSON.parse(JSON.stringify(instance.getShowPosition(790, 590))), { x: 486, y: 40 })
instance.isShow = true
instance.$el = { contains: target => target === 'inside' }
instance.onOutsidePointer({ target: 'inside' })
assert(instance.isShow)
instance.onOutsidePointer({ target: 'outside' })
assert(!instance.isShow)
instance.isShow = true
instance.onMenuKeydown({ key: 'Escape', stopPropagation() {} })
assert(!instance.isShow)
assert.equal(instance.activeSubmenu, '')
const oldComponent = compiler.parseComponent(original)
const oldContext = { ...context }
vm.runInNewContext(oldComponent.script.content.replace(/^import .*$/gm, '').replace('export default', 'component ='), oldContext)
for (const [key, fn] of Object.entries(oldContext.component.methods)) {
  if (['show', 'showSelectionMenu', 'hide', 'getShowPosition'].includes(key)) continue
  assert.equal(component.methods[key].toString().replace(/\r/g, ''), fn.toString().replace(/\r/g, ''), `Business handler changed: ${key}`)
}
const clicks = template => [...template.matchAll(/@click="([^"]+)"/g)].map(m => m[1]).sort()
// All original leaf handlers survive exactly once; category controls are separate.
assert.deepStrictEqual(clicks(parsed.template.content), clicks(oldComponent.template.content))
const primary = parsed.template.content.split(/<div\s+v-if="activeSubmenu"/)[0]
for (const marker of ['INSERT_CHILD_NODE', "exec('INSERT_NODE'", 'UNEXPAND_ALL', 'EXPAND_ALL', '@click="shareNode"', '@click="copyNodeForAi"']) assert(primary.includes(marker), marker)
assert(!primary.includes('INSERT_PARENT_NODE'))
assert(!primary.includes('REMOVE_CURRENT_NODE'))
assert(!source.includes('mindMap.render('))
console.log('PASS: Vue compilation, preserved leaf actions/business handlers, six primary actions, submenu viewport positioning, outside click, Escape, no map rendering.')


// Shortcut registration and routing reuse the existing node handlers.
const bindings = new Map()
const removed = []
const calls = []
const selectedNode = { uid: 'selected' }
const contextNode = { uid: 'context' }
const shortcutInstance = {
  ...component.methods,
  mindMap: {
    renderer: { activeNodeList: [] },
    keyCommand: {
      addShortcut: (key, handler) => bindings.set(key, handler),
      removeShortcut: (key, handler) => removed.push([key, handler])
    }
  },
  collectSelectedNodes: node => [node],
  exec: command => calls.push([command, shortcutInstance.node]),
  shareNode: () => calls.push(['share', shortcutInstance.node]),
  copyNodeForAi: () => calls.push(['sop', shortcutInstance.node]),
  $bus: { $off() {} },
  isShow: false
}
component.mounted.call(shortcutInstance)
assert.deepStrictEqual([...bindings.keys()], ['Control+Alt+c', 'Control+Alt+e', 'Control+Alt+s', 'Control+Alt+a'])
for (const handler of bindings.values()) handler()
assert.equal(calls.length, 0, 'No selection must not trigger a whole-map operation')
shortcutInstance.mindMap.renderer.activeNodeList = [selectedNode]
for (const handler of bindings.values()) handler()
assert.deepStrictEqual(calls.map(([command]) => command), ['UNEXPAND_ALL', 'EXPAND_ALL', 'share', 'sop'])
assert(calls.every(([, node]) => node === selectedNode))
shortcutInstance.isShow = true
shortcutInstance.type = 'node'
shortcutInstance.node = contextNode
bindings.get('Control+Alt+s')()
assert.equal(calls[calls.length - 1][1], contextNode)
context.document = { removeEventListener() {} }
context.window.removeEventListener = () => {}
component.beforeDestroy.call(shortcutInstance)
assert.equal(removed.length, 4)
assert(removed.every(([key, handler]) => bindings.get(key) === handler))
for (const dir of ['simple-mind-map/src', 'web/src']) {
  const files = cp.execFileSync('rg', ['--files', dir], { cwd: root, encoding: 'utf8' }).trim().split(/\r?\n/)
  for (const fileName of files.filter(f => /\.(js|vue)$/.test(f) && !f.endsWith('Contextmenu.vue'))) {
    const content = fs.readFileSync(path.join(root, fileName), 'utf8')
    for (const key of bindings.keys()) assert(!content.includes(`addShortcut('${key}'`), `Shortcut collision in ${fileName}`)
  }
}
console.log('PASS: four shortcut bindings, selected/right-click target, no-selection guard, handler reuse, teardown and existing binding collision checks.')
