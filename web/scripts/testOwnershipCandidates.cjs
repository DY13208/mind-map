const fs = require('fs')
const vm = require('vm')
const assert = require('assert')
const vue = require('../node_modules/vue-template-compiler')
const source = vue.parseComponent(fs.readFileSync(require.resolve('../src/pages/ProductShell/components/ShareFolderDialog.vue'), 'utf8'))
const errors = vue.compile(source.template.content).errors
assert.deepStrictEqual(errors, [])
const context = { module: { exports: {} }, getCurrentUser: () => ({}), folderService: {}, shareService: {}, teamService: {}, setTimeout, clearTimeout }
vm.runInNewContext(source.script.content.replace(/^import .*$/gm, '').replace('export default', 'module.exports ='), context)
const component = context.module.exports
function fixture(isTeam = false) {
  const c = { ...component.data(), isTeam, resourceId: 'folder', currentUserId: 'owner',
    members: [{ id: 'owner', name: '所有者', role: 'Owner' }, { id: 'member', name: '原成员', role: 'Editor' }],
    transferVisible: true, $message: { error() {} } }
  Object.entries(component.methods).forEach(([name, fn]) => { c[name] = fn.bind(c) })
  Object.defineProperty(c, 'transferCandidates', { get: () => component.computed.transferCandidates.call(c) })
  return c
}
async function main() {
  const c = fixture()
  const calls = []
  context.teamService.listContacts = async filters => {
    calls.push(filters)
    return filters.offset ? { list: [{ id: 'last', name: '最后一人' }], nextCursor: null } :
      { list: [{ id: 'owner', name: '所有者' }, { id: 'member', name: '原成员' }, { id: 'new', name: '新成员', wecomUserId: 'new-account' }], nextCursor: '100' }
  }
  await c.loadTransferContacts()
  assert.strictEqual(c.transferCandidates.length, 2, 'merge contacts, deduplicate, exclude owner')
  await c.loadTransferContacts(true)
  assert.strictEqual(calls[1].offset, 100)
  assert.strictEqual(c.transferCandidates.length, 3)
  c.transferQuery = 'new-account'
  assert.strictEqual(c.transferCandidates[0].id, 'new', 'search by account')
  let oldReady
  context.teamService.listContacts = filters => filters.search === '旧' ? new Promise(resolve => { oldReady = resolve }) : Promise.resolve({ list: [{ id: 'latest', name: '新' }], nextCursor: null })
  c.transferQuery = '旧'
  const pending = c.loadTransferContacts()
  c.transferQuery = '新'
  await c.loadTransferContacts()
  oldReady({ list: [{ id: 'stale', name: '旧' }], nextCursor: '100' }); await pending
  assert.strictEqual(c.transferContacts[0].id, 'latest', 'late search results must not replace current results')
  const team = fixture(true)
  team.transferContacts = [{ id: 'outsider', name: '外部成员' }]
  assert.strictEqual(team.transferCandidates.length, 1, 'teams retain member requirement')
  console.log('Ownership candidate search, pagination, stale-response, team eligibility and template checks passed')
}
main().catch(err => { console.error(err); process.exitCode = 1 })
