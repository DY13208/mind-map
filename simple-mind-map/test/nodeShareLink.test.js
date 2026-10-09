const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const vue = fs.readFileSync(path.join(__dirname, '../../web/src/pages/Edit/components/Contextmenu.vue'), 'utf8')
const start = vue.indexOf('    async shareNode() {')
const end = vue.indexOf('\n    // 计算右键菜单', start)
const location = fs.readFileSync(path.join(__dirname, '../../web/src/utils/roomLocation.js'), 'utf8').replace(/export /g, '')

function fixture(clipboard, legacyResult = true) {
  const messages = []
  const copies = []
  const elements = []
  const sandbox = {
    URLSearchParams, navigator: { clipboard },
    window: { location: { origin: 'http://example.test:8989', search: '', pathname: '/' } },
    getRuntimeConfig: () => ({ appUrl: 'https://maps.example.test' }),
    document: {
      createElement: () => ({ style: {}, select() { copies.push(this.value) } }),
      body: {
        appendChild(input) { elements.push(input) },
        removeChild(input) { elements.splice(elements.indexOf(input), 1) }
      },
      execCommand(command) { assert.equal(command, 'copy'); return legacyResult }
    }
  }
  vm.createContext(sandbox)
  vm.runInContext(location, sandbox)
  const share = vm.runInContext('({' + vue.slice(start, end) + '})', sandbox).shareNode
  const context = {
    $route: { query: { room: 'room-a b' } },
    node: { getData: () => 'node&中文' },
    hide() { this.node = null },
    $bus: { $emit() { assert.fail('the old sharing dialog must not open') } },
    $message: Object.fromEntries(['success', 'error', 'warning'].map(type => [type, text => messages.push({ type, text })]))
  }
  return { share: () => share.call(context), context, messages, copies, elements }
}

test('node link copies only room and focus, with no new grant or sharing dialog', async () => {
  const copies = []
  const f = fixture({ writeText: async text => copies.push(text) })
  await f.share()
  const url = new URL(copies[0])
  assert.equal(url.origin, 'https://maps.example.test')
  assert.equal(url.searchParams.get('room'), 'room-a b')
  assert.equal(url.searchParams.get('focus'), 'node&中文')
  assert.deepEqual(Array.from(url.searchParams.keys()), ['room', 'focus'])
  assert.equal(f.messages[0].type, 'success')
  assert.match(f.messages[0].text, /仅有文件访问权限/)
  assert.equal(f.context.node, null)
})

for (const clipboard of [undefined, { writeText: async () => { throw new Error('denied') } }]) {
  test('node link falls back to legacy clipboard on HTTP or permission denial', async () => {
    const f = fixture(clipboard)
    await f.share()
    assert.equal(new URL(f.copies[0]).searchParams.get('focus'), 'node&中文')
    assert.equal(f.messages[0].type, 'success')
    assert.equal(f.elements.length, 0)
  })
}

test('failed copy reports failure and cleans up the temporary element', async () => {
  const f = fixture(undefined, false)
  await f.share()
  assert.equal(f.messages[0].type, 'error')
  assert.equal(f.elements.length, 0)
})

test('unsaved maps do not produce a link', async () => {
  const f = fixture(undefined)
  f.context.$route.query = {}
  await f.share()
  assert.equal(f.messages[0].type, 'warning')
  assert.equal(f.copies.length, 0)
})
