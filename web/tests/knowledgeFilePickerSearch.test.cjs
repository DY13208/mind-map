const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const compiler = require('vue-template-compiler')
const source = compiler.parseComponent(fs.readFileSync(require('node:path').join(__dirname, '../src/pages/Edit/components/KnowledgeFilePicker.vue'), 'utf8'))
function picker(api) {
  const body = source.script.content.replace(/^import .*$/gm, '').replace('export default', 'return')
  const component = new Function('kbApi', 'formatSize', 'MAX_KNOWLEDGE_FILES', 'KnowledgeFileDetails', body)(api, String, 20, {})
  const vm = { ...component.data(), moreSequence: 0 }
  Object.entries(component.methods).forEach(([key, fn]) => { vm[key] = fn.bind(vm) })
  Object.entries(component.computed).forEach(([key, fn]) => Object.defineProperty(vm, key, {get: () => fn.call(vm)}))
  return vm
}
test('folder checkboxes save, restore and remove folder references without selecting files implicitly', () => {
  const vm = picker({})
  const checked = []
  vm.$refs = {tree: {setChecked: (...args) => checked.push(args)}}
  vm.$set = (obj, key, value) => { obj[key] = value }
  vm.$delete = (obj, key) => { delete obj[key] }
  vm.$message = {warning: () => {}}
  const folder = {id: 'same', kind: 'folder', name: '资料'}
  vm.checkFile(folder, true)
  vm.checkFile({id: 'same', kind: 'file', name: '文件'}, true)
  assert.deepEqual(vm.selectedKeys, ['folder:same', 'file:same'])
  assert.equal(vm.treeProps.disabled(folder), undefined)
  assert.equal(vm.treeProps.disabled({kind:'more'}), true)
  vm.remove(folder)
  assert.deepEqual(vm.selectedKeys, ['file:same'])
  assert.deepEqual(checked, [['folder:same', false]])
  vm.readonly = true
  vm.checkFile(folder, true)
  assert.deepEqual(vm.selectedKeys, ['file:same'])
})
test('search returns matching folders and files, including folder pagination', async () => {
  const calls = []
  const vm = picker({
    listFolders: async args => { calls.push(args); return { items: [{ id: 'folder', name: '经营报表' }], nextCursor: 'next-folder' } },
    listFiles: async () => ({ items: [{ id: 'file', name: '报表.csv' }] })
  })
  vm.query = ' 报表 '
  const rows = await vm.fetchChildren('')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].q, '报表')
  assert.deepEqual(rows.map(row => row.kind), ['folder', 'file', 'more'])
  assert.equal(rows[2].folderCursor, 'next-folder')
})
test('expanding a matched folder lists its contents without filtering by folder name', async () => {
  const calls = []
  const vm = picker({ listFolders: async args => { calls.push(args); return { items: [] } }, listFiles: async args => { calls.push(args); return { items: [{ id: 'child', name: '十月.csv' }] } } })
  vm.query = '经营报表'
  const rows = await vm.fetchChildren('folder')
  assert.equal(rows[0].name, '十月.csv')
  assert.ok(calls.every(args => !args.q))
  assert.equal(calls[1].folderId, 'folder')
})
test('picker template compiles', () => assert.deepEqual(compiler.compile(source.template.content).errors, []))

test('folder API searches all visible depths with literal wildcard escaping and cursor pagination', async () => {
  const api = fs.readFileSync(require('node:path').join(__dirname, '../../services/file-kb/src/api.js'), 'utf8')
  const body = api.slice(api.indexOf('  async function listFolders('), api.indexOf('  async function renameFolder('))
  const queries = []
  const id = '51a08398-e1e6-4a77-bd0d-2c70a219cc87'
  const pool = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [{ id, name: '报表', has_children: true }, { id, name: '下一页' }] } } }
  let result
  const list = new Function('pool', 'ownerClause', 'qp', 'pageParams', 'folderView', 'send', 'UUID', 'HttpError', body + '\nreturn listFolders')(pool, () => 'visible_to_user', (url, a, b) => url.searchParams.get(a) || url.searchParams.get(b), () => ({pageSize: 1}), row => row, (res, status, value) => { result = value }, /^[0-9a-f-]{36}$/, Error)
  await list({}, {id: 'reader'}, new URL('http://local/folders?q=' + encodeURIComponent('报表_%')))
  assert.match(queries[0].sql, /visible_to_user/)
  assert.match(queries[0].sql, /f.name ilike/)
  assert.doesNotMatch(queries[0].sql, /f.parent_id is null/)
  assert.ok(queries[0].params.includes('%报表\\_\\%%'))
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].hasChildren, true)
  await list({}, {id: 'reader'}, new URL('http://local/folders?q=报表&cursor=' + result.nextCursor))
  assert.match(queries[1].sql, /\(f.name, f.id\) >/)
  await list({}, {id: 'reader'}, new URL('http://local/folders?parent_id=root'))
  assert.match(queries[2].sql, /f.parent_id is null/)
})
