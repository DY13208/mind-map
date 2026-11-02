const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/utils/shortNodeLink.js'), 'utf8')
  .replace(/^import .*\n/gm, '').replace(/export /g, '') + '\nmodule.exports = { formatNodeLinkText, createShortNodeLink, copyNodeLinkText }'
function load(overrides = {}) {
  const sandbox = { module: { exports: {} }, URL, getRuntimeConfig: () => ({ appUrl: 'http://local:8989' }), ...overrides }
  vm.runInNewContext(source, sandbox)
  return sandbox.module.exports
}
test('default copy includes 80 Unicode characters plus ellipsis and short link; full copy keeps all paragraphs', () => {
  const { formatNodeLinkText } = load()
  const link = 'http://local:8989/s/ABCDEFGHIJKL'
  assert.equal(formatNodeLinkText('运行方式', link), `运行方式\n${link}`)
  assert.equal(formatNodeLinkText('😀'.repeat(81), link), `${'😀'.repeat(80)}…\n${link}`)
  assert.equal(formatNodeLinkText('第一段\n第二段', link, true), `第一段\n第二段\n${link}`)
  assert.equal(formatNodeLinkText('第一段\n第二段', link), `第一段 第二段\n${link}`)
})
test('link creation uses runtime origin and posts only the clicked room and UID', async () => {
  let sent
  const api = load({ productRequest: async (path, options) => { sent = [path, JSON.parse(options.body)]; return { code: 'ABCDEFGHIJKL' } } })
  assert.equal(await api.createShortNodeLink('room', 'uid'), 'http://local:8989/s/ABCDEFGHIJKL')
  assert.deepEqual(sent, ['/api/node-links', { roomKey: 'room', uid: 'uid' }])
})
test('HTTP clipboard fallback copies the complete payload and cleans temporary textarea', async () => {
  let input, copied = '', removed = false
  const document = { createElement: () => (input = { style: {}, select() { copied = this.value } }),
    body: { appendChild() {}, removeChild(el) { assert.equal(el, input); removed = true } }, execCommand: () => true }
  await load({ navigator: {}, document }).copyNodeLinkText('节点全文\nhttp://local/s/ABCDEFGHIJKL')
  assert.equal(copied, '节点全文\nhttp://local/s/ABCDEFGHIJKL')
  assert.equal(removed, true)
})

test('short-link route resolves to the original room/node and includes shell before navigation', async () => {
  const file = fs.readFileSync(require('node:path').join(__dirname, '../src/pages/NodeShare/ShortLink.vue'), 'utf8')
  const script = file.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/^import .*\n/gm, '').replace('export default', 'module.exports =')
  let destination
  const sandbox = { module: { exports: {} }, resolveShortNodeLink: async () => ({ roomKey: 'r', uid: 'n' }), resolveNavigationShell: () => 'focus' }
  vm.runInNewContext(script, sandbox)
  const page = { $route: { params: { code: 'ABCDEFGHIJKL' } }, $router: { replace: async value => { destination = value } } }
  await sandbox.module.exports.methods.open.call(page)
  assert.equal(destination.path, '/')
  assert.equal(destination.query.room, 'r')
  assert.equal(destination.query.focus, 'n')
  assert.equal(destination.query.shell, 'focus')
})
