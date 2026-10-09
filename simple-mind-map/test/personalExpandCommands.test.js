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
const findStart = method('findExpandStartNode', 'async expandSubtreeProgressive')
const level = method('expandToLevel', 'toggleActiveExpand')
const collectFrontier = method('collectCollapsedFrontier', 'async hydrateFrontier')
// 使用与实际渲染器相同的限制，覆盖异步分批展开。
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
  const summaryGrandchild = { data: { uid: 'summary-grandchild' }, children: [] }
  const summaryChild = {
    data: { uid: 'summary-child', expand: true },
    children: [summaryGrandchild]
  }
  const summary = { uid: 'summary', expand: true, children: [summaryChild] }
  const root = {
    data: { uid: 'root', expand: true, generalization: [summary] },
    children: [branch]
  }
  let saved
  let renderCount = 0
  const renderer = { renderTree: root, _expandAllToken: 1, _expandOperationId: 1,
    getExpandTreeData: node => node.data || node,
    getGeneralizationTrees(node) {
      const list = node.data && node.data.generalization
      return list ? (Array.isArray(list) ? list : [list]) : []
    },
    nodeHasChildren: node => node.children.length > 0 || Number((node.data || node).childCount) > 0,
    findExpandStartNode: uid => findStart.call(renderer, uid),
    collectCollapsedFrontier(node) { return collectFrontier.call(this, node) },
    hydrateFrontier: async () => {},
    applyExpandFlagsToLevel: flags,
    waitForRender: async () => { renderCount++; renderer.mindMap.render() }, setRootNodeCenter() {}
  }
  const mindMap = renderer.mindMap = { renderer,
    emit(name) { if (name === 'personal_expand_change') saved = sandbox.collect(mindMap, saved) },
    render() { sandbox.apply(mindMap, saved) }
  }
  saved = sandbox.collect(mindMap)
  return { renderer, branch, deep, summary, summaryChild, summaryGrandchild,
    get renderCount() { return renderCount } }
}
async function main() {
  let f = fixture()
  assert.strictEqual(findStart.call(f.renderer, 'summary'), f.summary,
    'expand all must target the stored summary object')
  assert.strictEqual(findStart.call(f.renderer, 'missing'), null,
    'missing expand target must not fall back to the whole tree')
  await progressive.call(f.renderer, f.renderer.renderTree, 1)
  assert.strictEqual(f.branch.data.expand, true, 'render restoration must keep each expanded batch')
  assert.strictEqual(f.deep.data.expand, true, 'nested async batch must stay expanded')

  // 选中目标本身可能是已折叠的 HTTP 懒加载占位节点，必须先请求其子树。
  f = fixture()
  const lazyLeaf = { data: { uid: 'lazy-leaf' }, children: [] }
  const lazyDeep = { data: { uid: 'lazy-deep', expand: false, childCount: 1 }, children: [] }
  const lazyTarget = { data: { uid: 'lazy-target', expand: false, childCount: 1 }, children: [] }
  const lazyLevelOne = { data: { uid: 'lazy-level-one', expand: true }, children: [lazyTarget] }
  f.renderer.renderTree = {
    data: { uid: 'root', expand: true }, children: [lazyLevelOne]
  }
  const hydrationRequests = []
  f.renderer.hydrateFrontier = async nodes => {
    let changed = false
    for (const node of nodes) {
      const uid = node.data && node.data.uid
      if (uid === 'lazy-target' || uid === 'lazy-deep') hydrationRequests.push(uid)
      if (uid === 'lazy-target' && !node.children.length) {
        node.children.push(lazyDeep)
        changed = true
      } else if (uid === 'lazy-deep' && !node.children.length) {
        node.children.push(lazyLeaf)
        changed = true
      }
    }
    return changed
  }
  await progressive.call(f.renderer, lazyTarget, 1)
  assert.deepStrictEqual(hydrationRequests, ['lazy-target', 'lazy-deep'],
    'expanding a collapsed target stub must hydrate the target before traversing below it')
  assert.strictEqual(lazyTarget.data.expand, true)
  assert.strictEqual(lazyDeep.data.expand, true)
  assert.strictEqual(lazyDeep.children[0], lazyLeaf)

  // 已展开的部分占位节点也要继续加载，expand=true 不代表子树已齐全。
  f = fixture()
  const partialLeaf = { data: { uid: 'partial-leaf' }, children: [] }
  const partialStub = { data: { uid: 'partial', expand: true, childCount: 1 }, children: [] }
  const partialRoot = { data: { uid: 'root', expand: true }, children: [partialStub] }
  f.renderer.renderTree = partialRoot
  let partialHydrations = 0
  f.renderer.hydrateFrontier = async nodes => {
    const node = nodes.find(item => item.data && item.data.uid === 'partial')
    if (!node || node.children.length) return false
    partialHydrations++
    node.children.push(partialLeaf)
    return true
  }
  await progressive.call(f.renderer, partialRoot, 1)
  assert.strictEqual(partialHydrations, 1,
    'expanded partial stubs must still be sent through lazy hydration')
  assert.strictEqual(partialStub.children[0], partialLeaf)
  assert.ok(f.renderCount > 0, 'hydrated children of an expanded stub must be rendered')

  // 协同刷新可能在加载期间替换 renderTree，后续应从当前树按 UID 继续。
  f = fixture()
  const oldRoot = f.renderer.renderTree
  const replacementLeaf = { data: { uid: 'replacement-leaf' }, children: [] }
  const replacementBranch = {
    data: { uid: 'branch', expand: false, childCount: 1 },
    children: [replacementLeaf]
  }
  const replacementRoot = {
    data: { uid: 'root', expand: true }, children: [replacementBranch]
  }
  let replaced = false
  f.renderer.hydrateFrontier = async nodes => {
    if (!replaced && nodes.some(node => node.data && node.data.uid === 'branch')) {
      replaced = true
      f.renderer.renderTree = replacementRoot
    }
    return false
  }
  await progressive.call(f.renderer, oldRoot, 1)
  assert.strictEqual(replaced, true, 'test must replace renderTree during a frontier await')
  assert.strictEqual(replacementBranch.data.expand, true,
    'the current tree should continue expanding after hydration replaces the old reference')
  assert.strictEqual(f.branch.data.expand, false,
    'a detached tree reference must not receive the expansion')

  f = fixture()
  collapse.call(f.renderer, false)
  assert.strictEqual(f.branch.data.expand, false)
  assert.strictEqual(f.deep.data.expand, false)
  assert.strictEqual(f.summary.expand, false, 'collapse all must include summaries')
  assert.strictEqual(f.summaryChild.data.expand, false,
    'collapse all must include summary descendants')
  assert.strictEqual(f.summaryGrandchild.data.expand, undefined)
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
