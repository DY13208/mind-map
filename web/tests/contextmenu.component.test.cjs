const assert = require('assert').strict
const fs = require('fs')
const path = require('path')
const babel = require('@babel/core')
const compiler = require('vue-template-compiler')

const source = fs.readFileSync(
  path.join(__dirname, '../src/pages/Edit/components/Contextmenu.vue'), 'utf8'
)
const parsed = compiler.parseComponent(source)
assert.deepEqual(compiler.compile(parsed.template.content).errors, [])
const { code } = babel.transformSync(parsed.script.content, {
  babelrc: false, configFile: false,
  plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
})
const mod = { exports: {} }
let clipboardWrite = () => Promise.resolve()
new Function('require', 'module', 'exports', code)(name => {
  if (name === 'vuex') return { mapState: () => ({}), mapMutations: () => ({}) }
  if (name === '@/utils') return { setDataToClipboard: data => clipboardWrite(data) }
  return {}
}, mod, mod.exports)
const component = mod.exports.default
const node = uid => ({ uid, getData: key => key === 'uid' ? uid : '' })
const a = node('a'), b = node('b'), c = node('c')
const makeVm = () => {
  const events = []
  const ticks = []
  const vm = {
    isShow: false, node: null, selectedNodes: [], isMousedown: false,
    isNodeMousedown: false,
    mindMap: {
      renderer: { activeNodeList: [a, b], findNodeByUid: uid => ({ a, b, c }[uid]) },
      select: { getMultiSelectCache: () => [a, b] }
    },
    $bus: { $emit: (...args) => events.push(args) },
    $nextTick: fn => ticks.push(fn),
    $refs: { contextmenuRef: { getBoundingClientRect: () => ({width: 250, height: 700}) } },
    events, ticks
  }
  Object.entries(component.methods).forEach(([key, fn]) => { vm[key] = fn.bind(vm) })
  return vm
}

// 右击其他节点不继承多选；执行概要命令不能被旧缓存替换。
let vm = makeVm()
assert.deepEqual(vm.collectSelectedNodes(c), [c])
vm.show({ clientX: 30, clientY: 40 }, c)
vm.exec('ADD_GENERALIZATION', false)
assert.deepEqual(vm.events, [['execCommand', 'ADD_GENERALIZATION', null, true, [c]]])

// 仍在多选范围内的右击保留选区，并在执行时解析当前节点实例。
vm = makeVm()
assert.deepEqual(vm.collectSelectedNodes(a), [a, b])
vm.selectedNodes = [node('a'), node('b')]
assert.deepEqual(vm.resolveLiveSelectedNodes(), [a, b])
vm.mindMap.renderer.findNodeByUid = () => null
vm.exec('ADD_GENERALIZATION', false)
assert.deepEqual(vm.events, [], '删除后的选区不能退回旧对象或当前默认选区')

// 从节点菜单直接切到画布时，展开/收起必须针对整张图。
for (const command of ['EXPAND_ALL', 'UNEXPAND_ALL']) {
  vm = makeVm()
  vm.show({ clientX: 30, clientY: 40 }, a)
  vm.show2({ clientX: 600, clientY: 450 })
  assert.equal(vm.node, '')
  assert.deepEqual(vm.selectedNodes, [])
  vm.exec(command)
  assert.deepEqual(vm.events[0], command === 'EXPAND_ALL'
    ? ['execCommand', command, ''] : ['execCommand', command, true, ''])
}

// 普通节点点击后不会吞掉下一次空白处右击。
vm = makeVm()
vm.onNodeMousedown()
vm.onNodeMouseup(a, { clientX: 30, clientY: 40 })
assert.equal(vm.isNodeMousedown, false)
vm.onMousedown({ which: 3, clientX: 60, clientY: 70 })
vm.onMouseup({ clientX: 60, clientY: 70 })
assert.equal(vm.type, 'svg')
assert.equal(vm.isShow, true)

// 节点 mouseup 不冒泡时也有独立事件订阅，销毁时必须解除。
for (const [hook, method] of [['created', '$on'], ['beforeDestroy', '$off']]) {
  const listeners = []
  component[hook].call({ ...vm, $bus: { [method]: (...args) => listeners.push(args) } })
  assert.ok(listeners.some(([name, fn]) => name === 'node_mouseup' && fn === vm.onNodeMouseup))
}

// 菜单在 nextTick 前关闭（如拖动画布）不能再读取已销毁的 DOM。
vm.hide()
vm.$refs = {}
vm.ticks.forEach(fn => assert.doesNotThrow(fn))

// 窄/矮视口中的定位不能变成负数。
global.window = { innerWidth: 280, innerHeight: 400 }
vm = makeVm()
assert.deepEqual(vm.getShowPosition(270, 390), { x: 10, y: 10 })
delete global.window

// 禁用菜单不执行；编译真实模板校验点击事件确实传入禁用状态。
const render = compiler.compileToFunctions(parsed.template.content).render
const clicks = []
const Vue = require('vue')
const rendered = new Vue({
  data: () => ({
    isShow: true, left: 0, top: 0, isDark: false, type: 'node',
    insertNodeBtnDisabled: true, insertSummaryBtnDisabled: true,
    upNodeBtnDisabled: true, downNodeBtnDisabled: true, isGeneralization: true,
    hasMapRef: false, hasHyperlink: false, hasNote: false, enableAi: false
  }),
  methods: { $t: key => key, openMapRef() {}, exec: (...args) => clicks.push(args) },
  render
})._render()
for (const child of rendered.children || []) {
  if (child.data && child.data.class && child.data.class.disabled) child.data.on.click()
}
assert.equal(clicks.length, 7)
for (const [key, disabled] of clicks) {
  assert.equal(disabled, true, key)
  vm.exec(key, disabled)
}
assert.deepEqual(vm.events, [])

async function checkClipboardFeedback() {
  const vm = makeVm()
  const messages = []
  vm.$t = key => key
  vm.$message = { success: text => messages.push(text), error: text => messages.push(text) }
  vm.enableCopyToClipboardApi = true
  vm.getExportData = async () => ({ root: '测试' })
  let finish
  clipboardWrite = () => new Promise(resolve => { finish = resolve })
  const pending = vm.copyToClipboard('json')
  await Promise.resolve()
  assert.deepEqual(messages, [], '写入剪贴板完成前不能宣告成功')
  finish()
  await pending
  assert.deepEqual(messages, ['contextmenu.copySuccess'])
  messages.length = 0
  clipboardWrite = () => Promise.reject(new Error('clipboard denied'))
  const originalLog = console.log
  try {
    console.log = () => {}
    await vm.copyToClipboard('json')
  } finally { console.log = originalLog }
  assert.deepEqual(messages, ['contextmenu.copyFail'], '拒绝剪贴板权限时应显示失败')

  const utilsScript = fs.readFileSync(path.join(__dirname, '../src/utils/index.js'), 'utf8')
  const utilsCode = babel.transformSync(utilsScript, {
    babelrc: false, configFile: false,
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
  }).code
  const utilsMod = { exports: {} }
  const completion = Promise.resolve()
  new Function('module', 'exports', 'document', 'navigator', 'ClipboardItem', utilsCode)(
    utilsMod, utilsMod.exports, { documentElement: {} },
    { clipboard: { writeText: () => completion, write: () => completion } }, class ClipboardItem {}
  )
  assert.equal(utilsMod.exports.setDataToClipboard('text'), completion)
  assert.equal(utilsMod.exports.setImgToClipboard('image'), completion)
  console.log('contextmenu component regression tests passed')
}
checkClipboardFeedback().catch(error => { console.error(error); process.exitCode = 1 })
