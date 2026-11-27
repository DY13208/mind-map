const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const babel = require('@babel/core')
const compiler = require('vue-template-compiler')

const filename = path.resolve(
  __dirname,
  '../src/pages/Edit/components/NodeTag.vue'
)
const parsed = compiler.parseComponent(fs.readFileSync(filename, 'utf8'))
const { code } = babel.transformSync(parsed.script.content, {
  babelrc: false,
  configFile: false,
  plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
})
const moduleRef = { exports: {} }
new Function('require', 'module', 'exports', code)(
  name => {
    if (name === 'simple-mind-map/src/utils/index') {
      return {
        generateColorByContent: () => '#000',
        isMobile: () => false
      }
    }
    return {}
  },
  moduleRef,
  moduleRef.exports
)
const component = moduleRef.exports.default

function makeNode(tags) {
  const data = { tag: tags }
  return {
    data,
    calls: [],
    getData(key) {
      return data[key]
    },
    setTag(nextTags) {
      this.calls.push(nextTags)
      data.tag = nextTags
    }
  }
}

function makeVm() {
  const vm = {
    ...component.data(),
    $bus: { $emit() {} }
  }
  Object.entries(component.methods).forEach(([name, method]) => {
    vm[name] = method.bind(vm)
  })
  return vm
}

test('NodeTag template compiles', () => {
  assert.deepEqual(compiler.compile(parsed.template.content).errors, [])
})

test('confirm commits text that has not been added with Enter', () => {
  const node = makeNode([])
  const vm = makeVm()
  vm.handleNodeActive(null, [node])
  vm.dialogVisible = true
  vm.tag = '待处理'

  vm.confirm()

  assert.deepEqual(node.calls, [['待处理']])
  assert.deepEqual(node.data.tag, ['待处理'])
  assert.equal(vm.dialogVisible, false)
})

test('Enter adds a tag and confirm does not add it twice', () => {
  const node = makeNode([])
  const vm = makeVm()
  vm.handleNodeActive(null, [node])
  vm.tag = '重点'

  vm.add()
  vm.confirm()

  assert.deepEqual(node.calls, [['重点']])
})

test('cancel discards additions and deletions from the draft', () => {
  const originalTags = ['原标签', '保留标签']
  const node = makeNode(originalTags)
  const vm = makeVm()
  vm.handleNodeActive(null, [node])

  assert.notEqual(vm.tagArr, originalTags)
  vm.del(0)
  vm.tag = '未保存标签'
  vm.add()
  vm.cancel()

  assert.deepEqual(node.data.tag, ['原标签', '保留标签'])
  assert.deepEqual(vm.tagArr, ['原标签', '保留标签'])
  assert.equal(vm.tag, '')
  assert.deepEqual(node.calls, [])
})

test('delete is persisted only after confirm', () => {
  const node = makeNode(['删除我', '保留我'])
  const vm = makeVm()
  vm.handleNodeActive(null, [node])

  vm.del(0)
  assert.deepEqual(node.data.tag, ['删除我', '保留我'])
  vm.confirm()

  assert.deepEqual(node.calls, [['保留我']])
  assert.deepEqual(node.data.tag, ['保留我'])
})
