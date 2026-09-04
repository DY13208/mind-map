// Mock-only domains. Real Files/Folder/History/Share use productShell.realApi.test.cjs.
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
const team = service('teamService')
const { C3_SERVICE_STATUS_MATRIX } = load(
  path.join(root, 'services/serviceStatus')
)
const { mockControl, mockStore } = load(path.join(root, 'services/mockStore'))
mockControl.setLatency(0)

async function main() {
  assert.equal(C3_SERVICE_STATUS_MATRIX.Room, 'REAL')
  assert.equal(C3_SERVICE_STATUS_MATRIX.Folder, 'REAL')
  assert.equal(C3_SERVICE_STATUS_MATRIX.History, 'REAL')
  assert.equal(C3_SERVICE_STATUS_MATRIX.Share, 'REAL')
  assert.equal(C3_SERVICE_STATUS_MATRIX.Recent, 'MOCK_PENDING')
  assert.equal(C3_SERVICE_STATUS_MATRIX.Favorites, 'MOCK_PENDING')
  assert.equal(C3_SERVICE_STATUS_MATRIX.Trash, 'MOCK_PENDING')
  assert.equal(C3_SERVICE_STATUS_MATRIX.Team, 'MOCK_PENDING')
  assert.equal(room.backendStatus, 'REAL')
  assert.equal(team.backendStatus, 'MOCK_PENDING')

  const recent = await room.listRooms({ recent: true })
  assert.ok(recent.list.length >= 1)
  assert.ok(recent.list.every(item => item.lastOpenedAt))

  const favorites = await room.listRooms({ favorite: true })
  assert.ok(favorites.list.length >= 1)
  assert.ok(favorites.list.every(item => item.favorite))

  const trash = await room.listRooms({ trash: true })
  assert.equal(trash.list.length, 1)

  const mockId = mockStore.rooms.find(item => !item.deletedAt).id
  await room.toggleFavorite(mockId)
  await room.markOpened(mockId)
  await room.deleteRoom(mockId)
  assert.ok((await room.listRooms({ trash: true })).list.some(item => item.id === mockId))
  await room.restoreRoom(mockId)

  const spaces = await team.listSpaces()
  assert.ok(spaces.length >= 1)
  const team2 = await team.listMembers('brand-center')
  await team.updateMemberRole('still-product', 'u2', 'Viewer')
  assert.deepEqual(await team.listMembers('brand-center'), team2)
  await team.removeMember('still-product', 'u2')
  assert.equal((await team.listMembers('still-product')).length, 3)
  assert((await team.listFolders('still-product')).length > 0)
  await assert.rejects(team.getSpace('missing'))

  console.log('Product shell mock-pending contracts passed')
}
main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
