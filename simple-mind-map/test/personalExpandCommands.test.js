const assert = require('assert')
const fs = require('fs')
const vm = require('vm')
const render = fs.readFileSync(require.resolve('../src/core/render/Render.js'), 'utf8')
const utils = fs.readFileSync(require.resolve('../../web/src/utils/personalExpandState.js'), 'utf8').replace(/export /g, '')
const sandbox = { console, setTimeout, clearTimeout }
vm.createContext(sandbox)
vm.runInContext(utils + '\nthis.collect = collectPersonalExpandState; this.apply = applyPersonalExpandState', sandbox)
function method(name, next) {
  const start = render.indexOf('  ' + name + '(')
  return vm.runInContext('({' + render.slice(start, render.indexOf('\n  ' + next + '(', start)).replace(/\n  \/\/[^\n]*/g, '') + '})', sandbox)[name.replace('async ', '')]
}
const progressive = method('async expandSubtreeProgressive', 'unexpandAllNode')
const collapse = method('unexpandAllNode', 'expandToLevel')
const level = method('expandToLevel', 'toggleActiveExpand')
// Same limits as the actual renderer; exercise all async batches.
vm.runInContext('const EXPAND_ALL_MAX_ROUNDS=24, EXPAND_ALL_MAX_NODES=200, EXPAND_ALL_BATCH=6, EXPAND_ALL_PER_FRAME=48', sandbox)
sandbox.walk = (root, parent, visit) => {
  function walk(node, depth) { visit(node, null, depth === 0, depth); (node.children || []).forEach(child => walk(child, depth + 1)) }
  walk(root, 0)
}
const flags = method('applyExpandFlagsToLevel', 'hydrateThen')
function fixture() {
  const leaf = { data: { uid: 'leaf' }, children: [] }
  const deep = { data: { uid: 'deep', expand: false }, children: [leaf] }
  const branch = { data: { uid: 'branch', expand: false }, children: [deep] }
  const root = { data: { uid: 'root', expand: true }, children: [branch] }
  let saved
  const renderer = { renderTree: root, _expandAllToken: 1, _expandOperationId: 1,
    nodeHasChildren: node => node.children.length > 0,
    collectCollapsedFrontier(node) {
      if (node.data.expand === false && node.children.length) return [node]
      return node.children.flatMap(child => this.collectCollapsedFrontier(child))
    },
    hydrateFrontier: async () => {},
    applyExpandFlagsToLevel: flags,
    waitForRender: async () => renderer.mindMap.render(), setRootNodeCenter() {}
  }
  const mindMap = renderer.mindMap = { renderer,
    emit(name) { if (name === 'personal_expand_change') saved = sandbox.collect(mindMap, saved) },
    render() { sandbox.apply(mindMap, saved) }
  }
  saved = sandbox.collect(mindMap)
  return { renderer, branch, deep }
}
async function main() {
  let f = fixture()
  await progressive.call(f.renderer, f.renderer.renderTree, 1)
  assert.strictEqual(f.branch.data.expand, true, 'render restoration must keep each expanded batch')
  assert.strictEqual(f.deep.data.expand, true, 'nested async batch must stay expanded')
  collapse.call(f.renderer, false)
  assert.strictEqual(f.branch.data.expand, false)
  assert.strictEqual(f.deep.data.expand, false)
  f.renderer.hydrateThen = (root, target, options, after) => { f.finish = after }
  level.call(f.renderer, 2)
  f.finish()
  assert.strictEqual(f.branch.data.expand, true)
  assert.strictEqual(f.deep.data.expand, false)
  level.call(f.renderer, 3)
  const stale = f.finish
  collapse.call(f.renderer, false)
  stale()
  assert.strictEqual(f.branch.data.expand, false, 'late level hydration must not undo collapse')
  level.call(f.renderer, 3)
  const first = f.finish
  level.call(f.renderer, 1)
  const latest = f.finish
  latest(); first()
  assert.strictEqual(f.branch.data.expand, false, 'latest level selection wins')
  f = fixture()
  let finishHydration
  f.renderer.hydrateFrontier = () => new Promise(resolve => { finishHydration = resolve })
  const pending = progressive.call(f.renderer, f.renderer.renderTree, 1)
  collapse.call(f.renderer, false)
  finishHydration(); await pending
  assert.strictEqual(f.branch.data.expand, false, 'in-flight expand all must stop after collapse')
  // Exercise the real Vue subscription while a restore is awaiting hydration.
  const vue = fs.readFileSync(require.resolve('../../web/src/pages/Edit/components/CooperateDialog.vue'), 'utf8')
  const begin = vue.indexOf('    bindPersonalExpandState() {')
  const end = vue.indexOf('    async restorePersonalExpandState()', begin)
  let remoteReady
  const listeners = {}
  Object.assign(sandbox, {
    loadPersonalExpandState: () => ({ branch: true }),
    savePersonalExpandState() {}, bindPersonalAppearance: () => () => {},
    getPersonalViewState: () => new Promise(resolve => { remoteReady = resolve }),
    savePersonalViewState: async () => {},
    setTimeout: () => 1, clearTimeout() {}
  })
  const bind = vm.runInContext('({' + vue.slice(begin, end) + '})', sandbox).bindPersonalExpandState
  f = fixture()
  f.renderer.mindMap.on = (name, fn) => { listeners[name] = fn }
  const component = { mindMap: f.renderer.mindMap, roomName: 'test', userId: 'test-user',
    unbindPersonalExpandState() {}, restorePersonalExpandState() {},
    $set(state, uid, value) { state[uid] = value }, personalExpandApplying: true }
  bind.call(component)
  listeners.afterExecCommand('SET_NODE_EXPAND', { data: { uid: 'branch' } }, false)
  assert.strictEqual(component.personalExpandState.branch, false, 'user commands during restore must be recorded')
  remoteReady({ state: { expand: { branch: true } } })
  await Promise.resolve(); await Promise.resolve()
  assert.strictEqual(component.personalExpandState.branch, false, 'late initial preferences must not overwrite user input')
  f.branch.data.expand = true
  listeners.personal_expand_change()
  assert.strictEqual(component.personalExpandState.branch, true, 'async batch event updates personal preferences')
  console.log('Personal expansion async batch, collapse, level, and cancellation regressions passed')
}
main().catch(err => { console.error(err); process.exitCode = 1 })
