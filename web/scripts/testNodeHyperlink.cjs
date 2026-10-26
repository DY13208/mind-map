const assert = require('assert')
const fs = require('fs')
const path = require('path')
const babel = require('@babel/core')
const compiler = require('vue-template-compiler')
global.window = { location: { href: 'https://map.example.com/?room=B' } }

const file = path.resolve(__dirname, '../src/pages/Edit/components/NodeHyperlink.vue')
const parsed = compiler.parseComponent(fs.readFileSync(file, 'utf8'))
assert.deepStrictEqual(compiler.compile(parsed.template.content).errors, [])
const code = babel.transformSync(parsed.script.content, {
  configFile: false,
  babelrc: false,
  plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
}).code
const nodes = new Map()
const writes = []
const mindMap = {
  renderer: { findNodeByUid: uid => nodes.get(String(uid)) || null },
  cooperate: null
}
function makeNode(uid, hyperlink = '', hyperlinkTitle = '') {
  const data = { uid, hyperlink, hyperlinkTitle }
  const node = {
    mindMap,
    getData(key) {
      return key ? data[key] : { ...data }
    },
    setHyperlink(...args) {
      writes.push([uid, ...args])
      data.hyperlink = args[0]
      data.hyperlinkTitle = args[1]
    }
  }
  nodes.set(uid, node)
  return node
}
const componentModule = { exports: {} }
new Function('require', 'module', 'exports', code)(
  id => {
    if (id === 'simple-mind-map/src/utils/localFileLink') return require('../../simple-mind-map/src/utils/localFileLink.js')
    if (id === './ConflictDraftPanel.vue') return { default: {} }
    if (id === '@/utils/conflictEdit') {
      return {
        currentEditPrincipal: () => 'test-user',
        discardEditSession: () => {},
        getEditCooperate: map => map && map.cooperate,
        getLiveNode: (map, uid) => map.renderer.findNodeByUid(uid),
        isCollaborativeRoom: route => !!(route && route.query && route.query.room),
        isEditConflictError: () => false,
        persistConflictSessionDraft: async () => ({}),
        persistEditConflict: async () => ({})
      }
    }
    if (id === '@/utils/conflictDraftStore') {
      return {
        conflictDraftKey: () => 'key',
        removeConflictDraft: async () => true
      }
    }
    if (id === '@/utils/roomLocation') {
      return { roomFromLocation: route => (route && route.query && route.query.room) || '' }
    }
    throw new Error(`Unexpected import: ${id}`)
  },
  componentModule,
  componentModule.exports
)
const component = componentModule.exports.default

function make() {
  return {
    ...component.data(),
    ...component.methods,
    $route: { query: {} },
    $t: key => key,
    $bus: { $on() {}, $off() {}, $emit() {} },
    $message: { warning() {}, error() {} },
    $confirm: async () => true
  }
}

async function main() {
  const form = make()
  const first = makeNode('a', 'https://a.example.com')
  const second = makeNode('b')
  for (const [input, expected] of [
    [' example.com/docs?q=1#part ', 'https://example.com/docs?q=1#part'],
    ['HTTPS://example.com/a', 'HTTPS://example.com/a'],
    ['http://localhost:8989/?room=A', 'http://localhost:8989/?room=A'],
    ['localhost:8989/a', 'https://localhost:8989/a'],
    ['//example.com/a', 'https://example.com/a'],
    ['/?room=A&focus=node', '/?room=A&focus=node'],
    ['../files', '../files'], ['#node', '#node'],
    ['例子.测试/资料', 'https://例子.测试/资料']
  ]) assert.strictEqual(form.normalizeLink(input), expected)
  for (const input of ['', ' ', 'not a url', 'javascript:alert(1)', 'data:text/html,test', 'ftp://example.com', 'https://', 'example', 'https://bad host']) {
    assert.throws(() => form.normalizeLink(input), undefined, input)
  }

  form.handleNodeActive(null, [first])
  form.handleShowNodeLink()
  assert(form.hasExistingLink)
  assert.strictEqual(writes.length, 0)

  // The selected Node object can be replaced while the dialog is open. Saving
  // must resolve the UID again instead of writing through the stale reference.
  const replacement = makeNode('a', 'https://a.example.com')
  form.handleNodeActive(null, [second])
  form.link = 'docs.example.com'
  form.linkTitle = '  项目资料  '
  await form.confirm()
  assert.deepStrictEqual(writes, [['a', 'https://docs.example.com', '项目资料']])
  assert.strictEqual(replacement.getData('hyperlink'), 'https://docs.example.com')
  assert.strictEqual(first.getData('hyperlink'), 'https://a.example.com')

  form.handleShowNodeLink(second)
  form.link = 'javascript:alert(1)'
  await form.confirm()
  assert(form.dialogVisible)
  assert(form.error)
  assert.strictEqual(writes.length, 1)
  await form.cancel()
  assert.strictEqual(writes.length, 1, 'Cancel must preserve node data')

  form.handleShowNodeLink(replacement)
  await form.removeLink()
  assert.deepStrictEqual(writes[1], ['a', '', ''])

  const keyboard = make()
  let confirmed = 0
  keyboard.confirm = () => confirmed++
  keyboard.onInputKeydown({ key: 'Enter', isComposing: true, stopPropagation() {} })
  assert.strictEqual(confirmed, 0)
  keyboard.onInputKeydown({ key: 'Enter', stopPropagation() {}, preventDefault() {} })
  assert.strictEqual(confirmed, 1)

  console.log('PASS: Vue template, URL validation, UID re-resolution, cancel/removal, and IME-safe Enter.')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
