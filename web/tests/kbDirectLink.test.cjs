const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const babel = require('@babel/core')
const compiler = require('vue-template-compiler')

function loadDialog(api) {
  const filename = path.join(__dirname, '../src/features/knowledge-base/components/KbDirectLinkDialog.vue')
  assert.ok(fs.existsSync(filename), 'the direct link dialog exists')
  const parsed = compiler.parseComponent(fs.readFileSync(filename, 'utf8'))
  const compiled = compiler.compile(parsed.template.content)
  assert.deepEqual(compiled.errors, [])
  const { code } = babel.transformSync(parsed.script.content, { babelrc: false, configFile: false, plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')] })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', code)(name => {
    if (name === '../services/kbApi') return { __esModule: true, default: api }
    throw new Error(name)
  }, module, module.exports)
  const component = module.exports.default
  const vm = { ...component.data(), file: { id: 'file-1', name: '测试.pdf' }, visible: true, $message: { success() {}, error() {} } }
  Object.entries(component.methods).forEach(([key, value]) => { vm[key] = value.bind(vm) })
  return vm
}

test('generates the selected expiry and retains the link when list refresh fails', async () => {
  const calls = []
  const vm = loadDialog({
    createDirectLink: async (id, body) => { calls.push([id, body]); return { id: 'link-1', url: '/api/kb/public/files/token/name.pdf' } },
    listDirectLinks: async () => { throw new Error('offline') }
  })
  global.window = { location: { origin: 'https://files.example' } }
  try {
    vm.expiresInDays = 0
    await vm.generate()
    assert.deepEqual(calls, [['file-1', { expiresInDays: 0 }]])
    assert.equal(vm.createdUrl, 'https://files.example/api/kb/public/files/token/name.pdf')
    assert.equal(vm.creating, false)
  } finally { delete global.window }
})

test('revoke clears the current URL only when that link is revoked successfully', async () => {
  let failure = true
  const vm = loadDialog({
    revokeDirectLink: async () => { if (failure) throw new Error('offline') },
    listDirectLinks: async () => ({ items: [] })
  })
  vm.createdId = 'link-1'
  vm.createdUrl = 'https://files.example/link-1'
  await vm.revoke({ id: 'link-1' })
  assert.equal(vm.createdUrl, 'https://files.example/link-1')
  failure = false
  await vm.revoke({ id: 'link-1' })
  assert.equal(vm.createdUrl, '')
})
