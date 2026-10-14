const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const source = fs.readFileSync(path.join(__dirname, '../src/pages/Edit/components/CooperateDialog.vue'), 'utf8')
const start = source.indexOf('    mapV2Peers(peers) {')
const end = source.indexOf('\n    applyV2NodePresence(', start)
const methods = vm.runInNewContext(`({${source.slice(start, end)}})`)
const owner = { ...methods, userId: 'me', userName: 'Me', userColor: '#fff',
  collabV2Adapter: { getClientId: () => 'mine' } }
const input = [
  { userId: 'alice', clientId: 'a', name: 'Same' },
  { userId: 'alice', clientId: 'b', name: 'Same' },
  { userId: 'bob', clientId: 'c', name: 'Same' },
  { userId: 'me', clientId: 'other-tab', name: 'Me' },
  { userId: 'alice', clientId: 'mcp:alice', source: 'mcp', name: 'alice' }
]
const members = owner.mapV2Peers(input)
assert.equal(members.length, 3)
assert.equal(members.filter(row => row.isMe).length, 1)
assert.equal(members.find(row => row.id === 'user:alice').mcp, true)
assert.equal(members.find(row => row.id === 'user:alice').name, 'Same')
assert.equal(input.length, 5, 'connection list is not modified')
assert.equal(owner.mapV2Peers(input.slice().reverse()).length, 3)
assert.equal(owner.mapV2Peers([{ clientId: 'x' }, { clientId: 'y' }]).length, 3, 'unknown accounts stay distinct')
assert.equal(owner.mapV2Peers([]).length, 1, 'self fallback is included once')
console.log('member list: account deduplication, same-name accounts, MCP badge and own tabs passed')
