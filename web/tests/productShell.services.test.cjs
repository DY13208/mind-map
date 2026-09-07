// Service contract tests use an injected HTTP transport; no network or mockStore state.
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
const { setProductHttp } = load(path.join(root, 'services/productHttp'))

const requests = []
setProductHttp(async (url, options = {}) => {
  requests.push({ url, options })
  if (url === '/api/teams') return { teams: [{ id: 't1', name: '产品组', corpName: '示例企业', role: 'owner', sourceType: 'CUSTOM_TEAM' }] }
  if (url === '/api/teams/t1') return { team: { id: 't1', name: '产品组', corpName: '示例企业', role: 'owner' } }
  if (url === '/api/teams/t1/members') {
    if (options.method === 'POST') return { members: [{ id: 'u2', wecomUserId: 'wx2', name: '陈晨', department: '产品部', position: '设计师', role: 'member' }] }
    return { members: [{ id: 'u1', wecomUserId: 'wx1', name: '李依然', department: '产品部', position: '负责人', role: 'owner' }] }
  }
  if (url === '/api/wecom/contacts?search=%E9%99%88%E6%99%A8') return { contacts: [{ id: 'u2', wecomUserId: 'wx2', name: '陈晨', departments: ['产品部'], position: '设计师', avatarUrl: '/avatar.png' }], total: 1 }
  if (url === '/api/teams/t1/rooms') {
    if (options.method === 'POST') return { room: { roomKey: 'room-new', title: '新脑图', role: 'owner', owner: { id: 'u1', name: '李依然' } } }
    return { list: [{ roomKey: 'room-1', title: '规划脑图', role: 'editor', owner: { id: 'u1', name: '李依然' } }] }
  }
  if (url.endsWith('/members/u2') && options.method === 'PATCH') return { member: { id: 'u2', name: '陈晨', role: 'admin' } }
  if (url.endsWith('/members/u2') && options.method === 'DELETE') return { ok: true }
  throw new Error(`未覆盖的请求 ${options.method || 'GET'} ${url}`)
})

async function main() {
  assert.equal(C3_SERVICE_STATUS_MATRIX.Room, 'REAL')
  assert.equal(C3_SERVICE_STATUS_MATRIX.Folder, 'REAL')
  assert.equal(C3_SERVICE_STATUS_MATRIX.History, 'REAL')
  assert.equal(C3_SERVICE_STATUS_MATRIX.Share, 'REAL')
  assert.equal(C3_SERVICE_STATUS_MATRIX.Recent, 'REAL')
  assert.equal(C3_SERVICE_STATUS_MATRIX.Favorites, 'REAL')
  assert.equal(C3_SERVICE_STATUS_MATRIX.Trash, 'REAL')
  assert.equal(C3_SERVICE_STATUS_MATRIX.Team, 'REAL')
  assert.equal(room.backendStatus, 'REAL')
  assert.equal(team.backendStatus, 'REAL')

  const spaces = await team.listSpaces()
  assert.ok(spaces.length >= 1)
  assert.equal(spaces[0].sourceType, 'CUSTOM_TEAM')
  assert.equal((await team.getSpace('t1')).corpName, '示例企业')
  const contacts = await team.listContacts({ search: '陈晨' })
  assert.equal(contacts.list[0].wecomUserId, 'wx2')
  assert.equal(contacts.list[0].department, '产品部')
  assert.equal(contacts.list[0].position, '设计师')
  await team.addMembers('t1', ['wx2', 'wx2'])
  assert.deepEqual(JSON.parse(requests.find(item => item.url === '/api/teams/t1/members' && item.options.method === 'POST').options.body), { wecomUserIds: ['wx2'] })
  assert.equal((await team.listMembers('t1'))[0].teamRole, 'owner')
  assert.equal((await team.listRooms('t1'))[0].roomKey, 'room-1')
  assert.equal((await team.createRoom('t1', '新脑图')).roomKey, 'room-new')
  assert.equal((await team.updateMemberRole('t1', 'u2', 'admin')).teamRole, 'admin')
  assert.deepEqual(await team.removeMember('t1', 'u2'), { ok: true })
  await team.createSpace('新团队', '协作')
  assert.equal(JSON.parse(requests.find(item => item.url === '/api/teams' && item.options.method === 'POST').options.body).sourceType, 'CUSTOM_TEAM')

  console.log('Product shell Team real service contracts passed')
}
main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
