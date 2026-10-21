const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const compiler = require('vue-template-compiler')
const load = require('./loadAttachmentUtils.cjs')
const viewport = load('editorViewport').default
const componentPath = path.resolve(__dirname, '../src/pages/Edit/components/MobileEditorControls.vue')
const parsed = compiler.parseComponent(fs.readFileSync(componentPath, 'utf8'))
assert.deepEqual(compiler.compile(parsed.template.content).errors, [])
assert(!parsed.template.content.includes('mobileEditorDock'), 'touch editor must not render a duplicate bottom menu')
assert(parsed.template.content.includes('direction="ltr"'), 'node actions open from the left')
const panels = ['nodeStyle', 'baseStyle', 'theme', 'structure', 'outline', 'setting'].map(value => ({ value, name: value }))
const context = { module: { exports: {} }, editorViewport: viewport, MobileEditorMenu: {}, openNotifications() {}, sidebarTriggerList: { zh: panels } }
vm.runInNewContext(parsed.script.content.replace(/^import .*$/gm, '').replace('export default', 'module.exports='), context)
const component = context.module.exports
const classes = new Set(), listeners = new Map()
context.document = { body: { classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) } } }
context.window = { visualViewport: { addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type) } }
function fixture() {
  const bus = new EventEmitter(); bus.$on = bus.on.bind(bus); bus.$off = bus.off.bind(bus); bus.$emit = bus.emit.bind(bus)
  const map = new EventEmitter(), commands = [], commits = []
  const selected = { isRoot: true, active() {} }
  Object.assign(map, { opt: {}, updateConfig(config) { Object.assign(this.opt, config) }, renderer: { activeNodeList: [selected] }, execCommand: command => commands.push(command), resize() {},
    command: { activeHistoryIndex: 1, history: ['initial', 'current'] }, cooperate: { collabV2Adapter: { getStatus: () => ({ undoDepth: 2, redoDepth: 0 }) } } })
  const instance = { ...component.data(), ...component.methods, isTouchEditor: true, mindMap: map, $bus: bus,
    $i18n: { locale: 'zh' }, $nextTick: callback => callback(), $store: { state: { isReadonly: false, activeSidebar: '', localConfig: { isDark: false } }, commit(name, value) { commits.push([name, value]); this.state.activeSidebar = value } } }
  for (const name of Object.keys(component.methods)) instance[name] = instance[name].bind(instance)
  for (const [name, fn] of Object.entries(component.computed)) Object.defineProperty(instance, name, { get: () => fn.call(instance) })
  component.mounted.call(instance)
  return { instance, map, bus, commands, commits, selected }
}
const f = fixture(), app = f.instance
assert.equal(app.activeNodes[0], f.selected, 'late mount keeps selected node')
assert.equal(app.canUndo, true, 'late mount keeps collaboration undo history')
f.bus.$emit('open_mobile_editor_sheet', 'node'); assert.equal(app.sheet, 'node')
f.bus.$emit('close_mobile_editor_sheet'); assert.equal(app.sheet, '', 'switching to file or settings closes node tools')
app.command('INSERT_CHILD_NODE'); assert.deepEqual(f.commands, ['INSERT_CHILD_NODE']); assert.equal(app.sheet, '')
app.panel('theme'); app.panel('theme'); assert.deepEqual(f.commits.slice(-2), [['setActiveSidebar', 'theme'], ['setActiveSidebar', '']])
app.activeNodes = []; app.history('BACK'); assert.equal(f.commands.at(-1), 'BACK', 'undo works without node selection')
app.command('REMOVE_NODE'); assert.equal(f.commands.length, 2, 'node changes require a selection')
app.activeNodes = [f.selected]; app.$store.state.isReadonly = true
app.command('INSERT_CHILD_NODE'); app.history('BACK'); assert.equal(f.commands.length, 2, 'readonly cannot mutate or undo')
app.$store.state.isReadonly = false
app.activeNodes = []; app.nodeDown(f.selected); const press = { handled: false }; app.longPress(press); assert.equal(press.handled, true); assert.equal(app.sheet, 'node'); assert.equal(app.activeNodes[0], f.selected, 'first long press seeds selection before batched node_active')
app.isPhoneReader = true; app.applyPhoneGestures(); assert.equal(f.map.opt.touchNodeDragEnabled, false, 'phone starts with canvas panning')
let contextNode; f.bus.$on('node_contextmenu', (event, node) => { contextNode = node })
app.nodeDown(f.selected); app.longPress({ clientX: 20, clientY: 30 }); assert.equal(contextNode, f.selected); assert.equal(app.sheet, '', 'phone long press opens existing context menu')
f.bus.removeAllListeners('node_contextmenu'); app.phoneNodeDragEnabled = true; app.applyPhoneGestures(); assert.equal(f.map.opt.touchNodeDragEnabled, true)
app.isPhoneReader = false; app.applyPhoneGestures(); assert.equal(f.map.opt.touchNodeDragEnabled, undefined, 'tablet restores original node gesture behavior')
app.beforeEdit(); assert.equal(classes.has('mobileNodeEditing'), true); app.afterEdit(); assert.equal(classes.size, 0)
app.isTouchEditor = false; app.sheet = 'more'; component.watch.isTouchEditor.call(app, false); assert.equal(app.sheet, '')
app.openSheet('node'); assert.equal(app.sheet, '', 'desktop cannot open a hidden touch menu')
app.collabHistory({ enabled: true, undoDepth: 0, redoDepth: 1 }); assert.equal(app.canUndo, false); assert.equal(app.canRedo, true)
app.collabHistory({ enabled: false }); assert.equal(app.canUndo, true); assert.equal(app.canRedo, false)
component.beforeDestroy.call(app); assert.equal(f.map.eventNames().length, 0); assert.equal(f.bus.eventNames().length, 0); assert.equal(listeners.size, 0)

const q = { isTouchEditor: false, _editorViewportQuery: { matches: true } }
viewport.methods.updateEditorViewport.call(q); assert.equal(q.isTouchEditor, true)
q._editorViewportQuery.matches = false; viewport.methods.updateEditorViewport.call(q); assert.equal(q.isTouchEditor, false)
console.log('PASS touch editor selection/history seeding, add/undo guards, readonly, panels, long press, keyboard state, responsive cleanup and event disposal')

const menuComponent = compiler.parseComponent(fs.readFileSync(path.resolve(__dirname, '../src/pages/Edit/components/MobileEditorMenu.vue'), 'utf8'))
assert.deepEqual(compiler.compile(menuComponent.template.content).errors, [])
const menuContext = { module: { exports: {} } }
vm.runInNewContext(menuComponent.script.content.replace('export default', 'module.exports='), menuContext)
const menuOptions = menuContext.module.exports, selected = []
const menu = { ...menuOptions.data(), ...menuOptions.methods, $emit: (name, key) => selected.push([name, key]), $nextTick: fn => fn(), $refs: { trigger: { focus() {} } } }
menu.open = true; menu.select('file'); assert.equal(menu.open, false); assert.deepEqual(selected, [['select', 'file']])
menu.open = true; menu.close(); assert.equal(menu.open, false)
assert.equal(menuOptions.computed.items.call(menu).length, 6)
const contextSource = compiler.parseComponent(fs.readFileSync(path.resolve(__dirname, '../src/pages/Edit/components/Contextmenu.vue'), 'utf8')).script.content
const contextMenuScope = { MenuIcon: {}, mapState: () => ({}), mapMutations: () => ({}) }
vm.runInNewContext(contextSource.replace(/^import[\s\S]*?from ['"][^'"]+['"];?\s*$/gm, '').replace('export default', 'component ='), contextMenuScope)
const contextMethods = contextMenuScope.component.methods
;(async () => {
  const readonlyMenu = { editable: false, isMutationCommand: contextMethods.isMutationCommand, $message: { warning() {} } }
  assert.equal(await contextMethods.canExecuteCommand.call(readonlyMenu, 'REMOVE_NODE'), false)
  assert.equal(await contextMethods.canExecuteCommand.call(readonlyMenu, 'INSERT_CHILD_NODE'), false)
  assert.equal(await contextMethods.canExecuteCommand.call(readonlyMenu, 'EXPAND_ALL'), true)
  console.log('PASS menu selection/close and readonly context command guards')
})().catch(error => { console.error(error); process.exitCode = 1 })
