const assert = require('assert')
const fs = require('fs')
const vm = require('vm')
const compiler = require('vue-template-compiler')
const path = require('path')
const source = fs.readFileSync(path.resolve(__dirname, '../src/pages/Edit/components/NodeHyperlink.vue'), 'utf8')
const parsed = compiler.parseComponent(source)
assert.deepStrictEqual(compiler.compile(parsed.template.content).errors, [])
const context = { URL, window: { location: { href: 'https://map.example.com/?room=B' } } }
vm.runInNewContext(parsed.script.content.replace('export default', 'component ='), context)
const c = context.component
const make = () => ({ ...c.data(), ...c.methods, $t: key => key })
const form = make()
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
const writes = []
const a = { getData: key => key === 'hyperlink' ? 'https://a.example.com' : '', setHyperlink: (...args) => writes.push(['a', ...args]) }
const b = { getData: () => '', setHyperlink: (...args) => writes.push(['b', ...args]) }
form.handleNodeActive(null, [a])
form.handleShowNodeLink()
assert(form.hasExistingLink)
assert.equal(writes.length, 0)
form.handleNodeActive(null, [b])
form.link = 'docs.example.com'
form.linkTitle = '  项目资料  '
form.confirm()
assert.deepStrictEqual(writes, [['a', 'https://docs.example.com', '项目资料']])
form.confirm()
assert.equal(writes.length, 1, 'Duplicate submit must not write')
form.handleShowNodeLink(b)
form.link = 'javascript:alert(1)'
form.confirm()
assert(form.dialogVisible)
assert(form.error)
assert.equal(writes.length, 1)
form.cancel()
assert.equal(writes.length, 1, 'Cancel must preserve node data')
form.handleShowNodeLink(a)
form.removeLink()
assert.deepStrictEqual(writes[1], ['a', '', ''])
const keyboard = make()
let confirmed = 0
keyboard.confirm = () => confirmed++
keyboard.onInputKeydown({key:'Enter', isComposing:true, stopPropagation(){}})
assert.equal(confirmed, 0)
keyboard.onInputKeydown({key:'Enter', stopPropagation(){}, preventDefault(){}})
assert.equal(confirmed, 1)
console.log('PASS: Vue template, URL normalization and validation, stable target, optional title, cancel, removal, duplicate submit and IME-safe Enter.')
