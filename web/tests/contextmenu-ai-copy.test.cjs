const assert = require('assert').strict
const fs = require('fs')
const path = require('path')
const babel = require('@babel/core')
const compiler = require('vue-template-compiler')
const source = fs.readFileSync(path.join(__dirname, '../src/pages/Edit/components/Contextmenu.vue'), 'utf8')
const parsed = compiler.parseComponent(source)
assert.deepEqual(compiler.compile(parsed.template.content).errors, [])
assert.ok(parsed.template.content.includes('@click="copyNodeForAi"'))
const code = babel.transformSync(parsed.script.content, {
  babelrc: false, configFile: false,
  plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
}).code
const mod = { exports: {} }
new Function('require', 'module', 'exports', code)(name => {
  if (name === 'vuex') return { mapState: () => ({}), mapMutations: () => ({}) }
  if (name === '@/utils/roomLocation') return { roomFromLocation: route => route.query.room }
  if (name === 'simple-mind-map/src/utils') return { getTextFromHtml: text => text.replace(/<[^>]*>/g, '') }
  return {}
}, mod, mod.exports)
const methods = mod.exports.default.methods
const node = (text, uid, parent, richText = false) => ({
  parent, getData: key => ({ text, uid, richText }[key])
})
async function run() {
  const messages = []
  const writes = []
  const root = node('张建强日常工作 CPD', 'root')
  const parent = node('<b>C: 面护部订单交付</b>', 'parent', root, true)
  const target = node('D: 每日检查\n并审核销售订单', 'target', parent)
  const vm = {
    node: target, $route: { query: { room: 'room-wsdvc82x' } },
    hide() { this.node = null },
    $message: Object.fromEntries(['success', 'warning', 'error'].map(key => [key, text => messages.push([key, text])]))
  }
  vm.nodeUid = methods.nodeUid.bind(vm)
  Object.defineProperty(global, 'navigator', { configurable: true, value: {
    clipboard: { writeText: async text => writes.push(text) }
  } })
  await methods.copyNodeForAi.call(vm)
  const expected = '执行这个SOP：张建强日常工作 CPD / C: 面护部订单交付 / D: 每日检查 并审核销售订单（room_key=room-wsdvc82x，node_uid=target）'
  assert.deepEqual(writes, [expected])
  assert.equal(messages.pop()[0], 'success')
  // HTTP/权限拒绝时使用实际文本回退，失败不能提示成功。
  navigator.clipboard.writeText = async () => { throw new Error('denied') }
  let removed = false
  global.document = {
    createElement: () => ({ style: {}, select() { assert.equal(this.value, expected) } }),
    body: { appendChild() {}, removeChild() { removed = true } },
    execCommand: () => true
  }
  vm.node = target
  await methods.copyNodeForAi.call(vm)
  assert.equal(removed, true)
  assert.equal(messages.pop()[0], 'success')
  document.execCommand = () => false
  vm.node = target
  await methods.copyNodeForAi.call(vm)
  assert.equal(messages.pop()[0], 'error')
  vm.node = target
  vm.$route.query.room = ''
  await methods.copyNodeForAi.call(vm)
  assert.equal(messages.pop()[0], 'warning')
  assert.equal(writes.length, 1)
  console.log('AI SOP clipboard tests passed')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
