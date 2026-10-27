const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), babel = require('@babel/core')
function load() {
  const file = path.join(__dirname, '../src/features/knowledge-base/services/kbOrganization.js')
  assert.ok(fs.existsSync(file), 'organization member selection helper exists')
  const { code } = babel.transformSync(fs.readFileSync(file, 'utf8'), { babelrc: false, configFile: false, plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')] })
  const module = { exports: {} }; new Function('module', 'exports', code)(module, module.exports)
  return module.exports
}
const departments = [{ id: '1', parentId: '0', name: '公司' }, { id: '2', parentId: '1', name: '营销部' }, { id: '3', parentId: '2', name: '直播组' }, { id: '4', parentId: '1', name: '财务部' }]
test('department tree and selected scope distinguish descendants from siblings', () => {
  const { departmentTree, departmentScope } = load()
  assert.equal(departmentTree(departments)[0].children[0].children[0].name, '直播组')
  assert.deepEqual(departmentScope(departments, ['2'], false), ['2'])
  assert.deepEqual(departmentScope(departments, ['2', '3'], true), ['2', '3'])
})
test('department members are fully paged and deduplicated across departments', async () => {
  const { loadDepartmentMembers } = load()
  const calls = []
  const api = { listContacts: async p => {
    calls.push(p)
    if (p.departmentId === '3') return { list: [{ id: 'same', name: '跨部门成员' }], total: 1 }
    if (!p.offset) return { list: Array.from({ length: 100 }, (_, i) => ({ id: 'u' + i })), total: 102, nextCursor: 'page2' }
    return { list: [{ id: 'same', name: '跨部门成员' }, { userId: 'last', name: '末页成员' }], total: 102 }
  } }
  const members = await loadDepartmentMembers(api, ['2', '3'])
  assert.equal(members.length, 102)
  assert.ok(members.some(m => m.id === 'last'))
  assert.ok(calls.some(p => p.cursor === 'page2' && p.offset === 100))
})
test('incomplete or failed department reads fail closed instead of returning partial authorization', async () => {
  const { loadDepartmentMembers } = load()
  await assert.rejects(loadDepartmentMembers({ listContacts: async p => {
    if (p.departmentId === '3') throw new Error('组织服务不可用')
    return { list: [{ id: 'one' }], total: 1 }
  } }, ['2', '3']), /不可用/)
  await assert.rejects(loadDepartmentMembers({ listContacts: async () => ({ list: [], total: 5 }) }, ['2']), /完整/)
})
test('effective selection merges department and individual members and permits individual exclusions', () => {
  const { mergeMembers } = load()
  const members = mergeMembers([{ id: 'a' }, { id: 'b' }], [{ id: 'b', name: '成员B' }, { id: 'c' }], ['a'])
  assert.deepEqual(members.map(m => m.id), ['b', 'c'])
  assert.equal(members[0].name, '成员B')
})

function picker(api) {
  const compiler = require('vue-template-compiler')
  const file = path.join(__dirname, '../src/features/knowledge-base/components/KbOrganizationPicker.vue')
  const source = compiler.parseComponent(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(compiler.compile(source.template.content).errors, [])
  const { code } = babel.transformSync(source.script.content, { babelrc: false, configFile: false, plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')] })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', code)(name => name === '@/services/teamService' ? { __esModule: true, default: api } : load(), module, module.exports)
  const component = module.exports.default, events = []
  const vm = { ...component.data(), disabled: false, $emit: (...args) => events.push(args) }
  Object.entries(component.methods).forEach(([name, fn]) => { vm[name] = fn.bind(vm) })
  return { vm, events }
}

test('a late department response cannot replace a newer selection', async () => {
  let finishOld
  const { vm, events } = picker({ listContacts: async ({ departmentId }) => {
    if (departmentId === '2') return new Promise(resolve => { finishOld = resolve })
    return { list: [{ id: 'finance', name: '财务成员' }], total: 1 }
  } })
  vm.departments = departments; vm.departmentIds = ['2']; vm.includeChildren = false
  const pending = vm.refreshSelection()
  vm.departmentIds = ['4']
  await vm.refreshSelection()
  finishOld({ list: [{ id: 'marketing' }], total: 1 })
  await pending
  assert.deepEqual(vm.selected.map(m => m.id), ['finance'])
  assert.deepEqual(events.filter(e => e[0] === 'input').at(-1)[1].map(m => m.id), ['finance'])
  assert.equal(vm.selectionLoading, false)
})

test('department loading failure clears exported members and reports an actionable error', async () => {
  const { vm, events } = picker({ listContacts: async () => { throw new Error('读取失败') } })
  vm.departments = departments; vm.departmentIds = ['2']; vm.explicitIds = ['manual']
  await vm.refreshSelection()
  assert.deepEqual(events.filter(e => e[0] === 'input').at(-1)[1], [])
  assert.equal(events.filter(e => e[0] === 'error').at(-1)[1], '读取失败')
})

test('changing department checkboxes preserves individually excluded members', async () => {
  const { vm } = picker({ listContacts: async () => ({ list: [{ id: 'excluded' }, { id: 'kept' }], total: 2 }) })
  vm.departments = departments
  vm.excludedIds = ['excluded']
  vm.$refs = { tree: { getCheckedKeys: () => ['2', '4'] } }
  vm.checkDepartments()
  // Wait for the real selection refresh that checkDepartments starts.
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(vm.selected.map(m => m.id), ['kept'])
})

test('large departments can be browsed fully before selecting a small subset', async () => {
  const { loadDepartmentMembers } = load()
  const all = Array.from({ length: 601 }, (_, i) => ({ id: 'member-' + i }))
  const result = await loadDepartmentMembers({ listContacts: async ({ offset, limit }) => ({ list: all.slice(offset, offset + limit), total: all.length }) }, ['2'])
  assert.equal(result.length, 601)
})
