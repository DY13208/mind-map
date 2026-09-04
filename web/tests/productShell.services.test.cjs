// Isolated Mock contract tests. No HTTP, database, browser storage or collaboration imports.
const assert = require('assert').strict
const fs = require('fs')
const path = require('path')
const babel = require('@babel/core')
const root = path.resolve(__dirname, '../src')
const cache = new Map()
function load(filename) {
  if (!filename.endsWith('.js')) filename += '.js'
  if (cache.has(filename)) return cache.get(filename).exports
  const module = { exports: {} }
  cache.set(filename, module)
  const { code } = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
    babelrc: false,
    configFile: false,
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
  })
  new Function('require', 'module', 'exports', code)(
    relative => load(path.resolve(path.dirname(filename), relative)),
    module,
    module.exports
  )
  return module.exports
}
const service = name => load(path.join(root, 'services', name)).default
const room = service('roomService')
const folder = service('folderService')
const history = service('historyService')
const team = service('teamService')
const share = service('shareService')
const { mockControl, mockStore } = load(path.join(root, 'services/mockStore'))
mockControl.setLatency(0)

async function main() {
  const initial = await room.listRooms()
  assert.equal(initial.length, 4)
  initial[0].title = 'not written back'
  assert.notEqual((await room.getRoom(initial[0].id)).title, initial[0].title)
  assert.equal((await room.listRooms({ favorite: true })).length, 2)
  assert.equal((await room.listRooms({ shared: true })).length, 2)
  assert.equal((await room.listRooms({ role: 'Viewer' })).length, 1)
  assert.equal((await room.listRooms({ trash: true })).length, 1)
  await assert.rejects(room.createRoom('   '))
  await assert.rejects(room.getRoom('missing'))
  const f = await folder.createFolder('验收文件夹')
  const a = await room.createRoom('验收脑图 A', f.id)
  const b = await room.createRoom('验收脑图 B')
  assert.notEqual(a.id, b.id)
  assert.equal((await room.listRooms({ folderId: f.id })).length, 1)
  await folder.renameFolder(f.id, '验收文件夹二')
  assert.equal((await room.getRoom(a.id)).folderName, '验收文件夹二')
  await room.renameRoom(a.id, '已重命名')
  assert.equal((await room.getRoom(a.id)).title, '已重命名')
  await room.toggleFavorite(a.id)
  assert.equal((await room.getRoom(a.id)).favorite, true)
  await room.markOpened(a.id)
  assert(
    (await room.listRooms({ recent: true })).some(item => item.id === a.id)
  )
  await folder.moveRoom(b.id, f.id)
  assert.equal(
    (await folder.listFolders()).find(item => item.id === f.id).roomCount,
    2
  )
  await assert.rejects(folder.moveRoom(a.id, 'missing'))
  await room.deleteRoom(a.id)
  assert(!(await room.listRooms()).some(item => item.id === a.id))
  assert.equal(
    (await folder.listFolders()).find(item => item.id === f.id).roomCount,
    1
  )
  await room.restoreRoom(a.id)
  await assert.rejects(room.permanentDelete(a.id))
  await room.deleteRoom(a.id)
  await room.permanentDelete(a.id)
  await assert.rejects(room.getRoom(a.id))
  await folder.deleteFolder(f.id)
  assert.equal((await room.getRoom(b.id)).folderId, null)
  const room1Members = await share.getMembers('growth-plan')
  const room2Members = await share.getMembers('product-roadmap')
  const added = await share.addMember('growth-plan', 'qa@example.test')
  assert(
    (await room.getRoom('growth-plan')).collaborators.some(
      member => member.id === added.id
    )
  )
  await assert.rejects(
    share.addMember('growth-plan', 'invalid@example.test', 'Owner')
  )
  assert.equal(
    (await share.getMembers('growth-plan')).length,
    room1Members.length + 1
  )
  assert.deepEqual(await share.getMembers('product-roadmap'), room2Members)
  await assert.rejects(share.addMember('growth-plan', 'qa@example.test'))
  await share.updateMemberRole('growth-plan', added.id, 'Editor')
  assert.equal(
    (await share.getMembers('growth-plan')).find(item => item.id === added.id)
      .role,
    'Editor'
  )
  await share.removeMember('growth-plan', added.id)
  assert(
    !(await room.getRoom('growth-plan')).collaborators.some(
      member => member.id === added.id
    )
  )
  assert.equal(
    (await share.getMembers('growth-plan')).length,
    room1Members.length
  )
  const team2 = await team.listMembers('brand-center')
  await team.updateMemberRole('still-product', 'u2', 'Viewer')
  assert.deepEqual(await team.listMembers('brand-center'), team2)
  await team.removeMember('still-product', 'u2')
  assert.equal((await team.listMembers('still-product')).length, 3)
  assert((await team.listFolders('still-product')).length > 0)
  await assert.rejects(team.getSpace('missing'))
  const versions = await history.listVersions('growth-plan')
  assert.equal(versions.length, 3)
  assert.equal(
    (await history.getVersion('growth-plan', versions[0].id)).version,
    'V18'
  )
  await assert.rejects(history.getVersion('product-roadmap', versions[0].id))
  const before = JSON.stringify(mockStore.rooms)
  assert.equal(
    (await history.restoreVersion('growth-plan', versions[0].id)).mock,
    true
  )
  assert.equal(
    JSON.stringify(mockStore.rooms),
    before,
    'Mock restore must never change real or mock document content'
  )
  mockControl.failNext('retry me')
  await assert.rejects(room.listRooms(), /retry me/)
  assert((await room.listRooms()).length > 0, 'retry succeeds')
  console.log(
    'Product shell service contracts passed; no collaboration/DB calls'
  )
}
main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
