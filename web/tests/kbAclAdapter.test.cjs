const test = require('node:test')
const assert = require('assert').strict
const fs = require('fs')
const path = require('path')
const babel = require('@babel/core')

function load(source, requireMap) {
  const { code } = babel.transformSync(source, {
    babelrc: false,
    configFile: false,
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
  })
  const mod = { exports: {} }
  const req = name => (requireMap && name in requireMap ? requireMap[name] : require(name))
  new Function('require', 'module', 'exports', code)(req, mod, mod.exports)
  return mod.exports
}

const kbDir = path.resolve(__dirname, '../src/features/knowledge-base')
const status = load(fs.readFileSync(path.join(kbDir, 'constants/status.js'), 'utf8'))
const adapterMod = load(fs.readFileSync(path.join(kbDir, 'services/kbAclAdapter.js'), 'utf8'), { '../constants/status': status })
const { createKbAclAdapter, membersFromAcl, toKbRole, subjectOfMember } = adapterMod

const FOLDER_ID = '11111111-1111-4111-8111-111111111111'
const TEAM_ID = '22222222-2222-4222-8222-222222222222'
const ACL = {
  name: 'docs', ownerUserId: 'owner1', effectiveRole: 'owner', capabilities: ['grant', 'revoke', 'transfer'],
  grants: [
    { subjectType: 'user', subjectId: 'owner1', role: 'owner', source: 'owner', applied: true },
    { subjectType: 'user', subjectId: 'alice', role: 'editor', source: 'direct', applied: true },
    { subjectType: 'user', subjectId: 'alice', role: 'viewer', source: 'inherited', applied: false, inheritedFrom: { id: FOLDER_ID, name: '上级' } },
    { subjectType: 'user', subjectId: 'bob', role: 'manager', source: 'inherited', applied: true, inheritedFrom: { id: FOLDER_ID, name: '上级' } },
    { subjectType: 'user', subjectId: 'carol', role: 'viewer', source: 'inherited', applied: true, inheritedFrom: { id: FOLDER_ID, name: null } },
    { subjectType: 'team', subjectId: TEAM_ID, role: 'viewer', source: 'direct', applied: true }
  ]
}

function fakeApi(acl = ACL) {
  const calls = []
  return {
    calls,
    getAcl: async (...a) => { calls.push(['getAcl', ...a]); return acl },
    putGrant: async (...a) => { calls.push(['putGrant', ...a]); return acl },
    deleteGrant: async (...a) => { calls.push(['deleteGrant', ...a]); return acl },
    transferOwner: async (...a) => { calls.push(['transferOwner', ...a]); return { ...acl, effectiveRole: 'owner' } }
  }
}

test('角色映射：只放行 viewer/editor/manager，owner 不能授予', () => {
  assert.equal(toKbRole('Viewer'), 'viewer')
  assert.equal(toKbRole('Manager'), 'manager')
  assert.equal(toKbRole('Owner'), null)
  assert.equal(toKbRole('Inherit'), null)
  assert.equal(toKbRole('admin'), null)
})

test('ACL → 成员：所有者、直接授权覆盖继承、仅继承只读、团队', () => {
  const list = membersFromAcl(ACL, { owner1: '老板', alice: '爱丽丝' })
  const by = Object.fromEntries(list.map(m => [m.id, m]))
  assert.equal(list[0].id, 'owner1')
  assert.deepEqual([by.owner1.role, by.owner1.name, by.owner1.inheritedOnly], ['owner', '老板', false])
  assert.equal(by.alice.role, 'editor')
  assert.equal(by.alice.inheritedOnly, false)
  assert.match(by.alice.sourceLabel, /^直接授权，覆盖继承自「上级」的查看者$/)
  assert.equal(by.bob.role, 'manager')
  assert.equal(by.bob.inheritedOnly, true)
  assert.match(by.bob.sourceLabel, /继承自「上级」/)
  assert.match(by.carol.sourceLabel, /上级文件夹/)
  const team = by['team:' + TEAM_ID]
  assert.equal(team.kbSubjectType, 'team')
  assert.equal(team.department, '团队')
  assert.deepEqual(subjectOfMember(team), { subjectType: 'team', subjectId: TEAM_ID })
  assert.deepEqual(subjectOfMember(by.alice), { subjectType: 'user', subjectId: 'alice' })
})

test('适配器：预取只请求一次 ACL，按需查名字（精确匹配）', async () => {
  const api = fakeApi()
  const searches = []
  const contacts = {
    listContacts: async ({ search }) => {
      searches.push(search)
      return { list: [{ id: search + 'x', name: '前缀误配' }, ...(search === 'bob' ? [{ id: 'bob', name: '鲍勃' }] : [])] }
    }
  }
  const a = createKbAclAdapter({ api, target: { type: 'folder', id: FOLDER_ID }, contacts, currentUser: { id: 'owner1', name: '我' } })
  await a.prime()
  assert.deepEqual(a.capabilities(), ['grant', 'revoke', 'transfer'])
  const list = await a.listMembers()
  assert.equal(api.calls.filter(c => c[0] === 'getAcl').length, 1)
  const by = Object.fromEntries(list.map(m => [m.id, m]))
  assert.equal(by.owner1.name, '我')
  assert.equal(by.bob.name, '鲍勃')
  assert.equal(by.alice.name, 'alice', '查不到精确匹配时显示 user_id')
  assert.deepEqual(searches.sort(), ['alice', 'bob', 'carol'])
  await a.listMembers()
  assert.equal(api.calls.filter(c => c[0] === 'getAcl').length, 2, '之后每次重新读取')
  assert.equal(searches.length, 3, '名字有缓存')
  assert.equal(a.label, '文件夹')
  assert.deepEqual(a.roleOptions.map(o => o.value), ['Viewer', 'Editor', 'Manager'])
})

test('适配器：授权/修改/移除/转移走 KB 接口，继承项不可改', async () => {
  const api = fakeApi()
  const a = createKbAclAdapter({ api, target: { type: 'file', id: 'f1' } })
  await a.prime()
  const list = await a.listMembers()
  const by = Object.fromEntries(list.map(m => [m.id, m]))
  await a.grant('dave', 'Editor')
  assert.deepEqual(api.calls.at(-1), ['putGrant', 'file', 'f1', { subjectType: 'user', subjectId: 'dave', role: 'editor' }])
  await assert.rejects(a.grant('dave', 'Owner'), /不能直接授予/)
  await a.updateRole(by['team:' + TEAM_ID], 'Manager')
  assert.deepEqual(api.calls.at(-1), ['putGrant', 'file', 'f1', { subjectType: 'team', subjectId: TEAM_ID, role: 'manager' }])
  await a.remove(by.alice)
  assert.deepEqual(api.calls.at(-1), ['deleteGrant', 'file', 'f1', { subjectType: 'user', subjectId: 'alice' }])
  await assert.rejects(a.remove(by.bob), /来源文件夹/)
  await assert.rejects(a.updateRole(by.bob, 'Viewer'), /来源文件夹/)
  const n = api.calls.length
  const after = await a.transferOwnership('alice')
  assert.deepEqual(api.calls[n], ['transferOwner', 'file', 'f1', { userId: 'alice' }])
  assert.deepEqual(api.calls[n + 1], ['getAcl', 'file', 'f1'], '转移后按当前用户重新读取')
  assert.ok(Array.isArray(after))
  assert.equal(a.label, '文件')
})

// ShareFolderDialog：不传 adapter 时行为保持原样（仍调用脑图 folder/room/team 服务）
const dialogFile = path.resolve(__dirname, '../src/pages/ProductShell/components/ShareFolderDialog.vue')
const dialogSource = fs.readFileSync(dialogFile, 'utf8')
const dialogScript = /<script>([\s\S]*?)<\/script>/.exec(dialogSource)[1]

function makeDialog(props = {}) {
  const calls = []
  const svc = name => new Proxy({}, { get: (_t, method) => async (...args) => { calls.push([name, method, ...args]); return method === 'getMembers' ? { list: [] } : [] } })
  const options = load(dialogScript, {
    '@/services/folderService': { __esModule: true, default: svc('folder') },
    '@/services/shareService': { __esModule: true, default: svc('share') },
    '@/services/teamService': { __esModule: true, default: svc('team') },
    '@/utils/auth': { getCurrentUser: () => ({ id: 'me', name: '我' }) }
  }).default
  const vm = Object.assign({}, options.data())
  const propDefaults = Object.fromEntries(Object.entries(options.props).map(([k, v]) => [k, typeof v === 'object' && 'default' in v ? v.default : undefined]))
  Object.assign(vm, propDefaults, props)
  Object.keys(options.computed).forEach(k => {
    const c = options.computed[k]
    Object.defineProperty(vm, k, { get: () => (typeof c === 'function' ? c : c.get).call(vm) })
  })
  Object.keys(options.methods).forEach(k => { vm[k] = options.methods[k].bind(vm) })
  vm.$message = { success() {}, error() {}, info() {}, warning() {} }
  vm.$emit = () => {}
  return { vm, calls, options }
}

test('ShareFolderDialog：adapter 默认为 null，文件夹/脑图行为不变', async () => {
  const { vm, calls, options } = makeDialog({ folder: { id: 'fold1', name: 'F' } })
  assert.equal(options.props.adapter.default, null)
  assert.equal(vm.resourceLabel, '文件夹')
  assert.deepEqual(vm.roleOptions.map(o => o.value), ['Viewer', 'Editor', 'Manager'])
  assert.equal(vm.defaultRole, 'Manager')
  await vm.loadMembers()
  assert.deepEqual(calls.at(-1), ['folder', 'getMembers', 'fold1'])
  await vm.updateRole({ id: 'u1', role: 'viewer' }, 'Editor')
  assert.deepEqual(calls.find(c => c[1] === 'updateMember'), ['folder', 'updateMember', 'fold1', 'u1', 'Editor'])
  await vm.remove({ id: 'u1', role: 'viewer' })
  assert.deepEqual(calls.find(c => c[1] === 'removeMember'), ['folder', 'removeMember', 'fold1', 'u1'])
  assert.equal(calls.filter(c => c[0] !== 'folder').length, 0)
  const room = makeDialog({ room: { roomKey: 'r1', title: 'R' }, resourceType: 'room' })
  assert.equal(room.vm.resourceLabel, '脑图')
  await room.vm.loadMembers()
  assert.deepEqual(room.calls.at(-1), ['share', 'getMembers', 'r1'])
  assert.equal(room.vm.memberSourceLabel({ role: 'editor', aclV2: true, overrideRole: 'Editor' }), '实际可编辑 · 本图单独设置')
})

test('ShareFolderDialog：传入 KB adapter 时只走 adapter', async () => {
  const api = fakeApi()
  const adapter = createKbAclAdapter({ api, target: { type: 'folder', id: FOLDER_ID } })
  await adapter.prime()
  const { vm, calls } = makeDialog({ folder: { id: FOLDER_ID, name: 'docs' }, adapter })
  assert.equal(vm.resourceLabel, '文件夹')
  assert.equal(vm.defaultRole, 'Viewer')
  assert.equal(vm.isFolderManager, false)
  await vm.loadMembers()
  assert.ok(vm.members.length >= 4)
  const bob = vm.members.find(m => m.id === 'bob')
  assert.equal(vm.isInheritedOnly(bob), true)
  assert.match(vm.memberSourceLabel(bob), /继承自/)
  vm.selectedUserIds = ['dave', 'owner1']
  vm.role = 'Editor'
  const result = await vm.grantAdapterSelection()
  assert.deepEqual(result, { changed: 1 })
  assert.deepEqual(api.calls.find(c => c[0] === 'putGrant'), ['putGrant', 'folder', FOLDER_ID, { subjectType: 'user', subjectId: 'dave', role: 'editor' }])
  assert.equal(calls.filter(c => c[0] !== 'team').length, 0, '不调用脑图 folder/share 服务')
  assert.match(dialogSource, /v-if="isOwnerRole\(member\.role\) \|\| readOnly \|\| \(adapter && member\.inheritedOnly\)"/)
  assert.match(dialogSource, /按部门\/团队整体授权（暂不可用）/)
})

test('KbPermissionDialog 复用 ShareFolderDialog', () => {
  const src = fs.readFileSync(path.join(kbDir, 'components/KbPermissionDialog.vue'), 'utf8')
  assert.match(src, /import ShareFolderDialog from '@\/pages\/ProductShell\/components\/ShareFolderDialog\.vue'/)
  assert.match(src, /:adapter="adapter"/)
  assert.match(src, /capabilities\(\)\.includes\('grant'\)/)
  assert.doesNotMatch(src, /placeholder="新所有者的用户 ID"|'用户 ID'/)
})
