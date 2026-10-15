const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { createDirectoryRuntime, room, root } = require('./helpers/directoryRuntime.cjs')

const repo = path.resolve(root, '..')
function fixtureRuntime() {
  // File export/import is outside directory loading; any accidental call fails.
  const unrelated = () => { throw new Error('Unexpected file write/export in directory test') }
  const runtime = createDirectoryRuntime({ overrides: {
    [path.join(root, 'src/utils/fileApi.js')]: { getFileExport: unrelated, replaceFileTree: unrelated }
  } })
  const calls = []
  const rows = Array.from({ length: 60 }, (_, i) => ({
    ...room('team-room-' + String(i + 1).padStart(2, '0'), i % 3 + 1),
    title: i % 2 ? '重复标题' : '搜索目标',
    role: i % 3 ? 'editor' : 'owner',
    folderId: i < 40 ? null : '11111111-1111-4111-8111-111111111111'
  }))
  runtime.services.http.setProductHttp(async (pathname, options = {}) => {
    const url = new URL(pathname, 'http://test.invalid')
    calls.push({ url, options })
    if (url.pathname === '/api/teams') {
      const teams = [{ id: 'team-a', name: '团队A', role: 'owner' }]
      return { items: teams, list: teams }
    }
    if (url.pathname === '/api/teams/team-a') return { id: 'team-a', name: '团队A', role: 'owner', fileCount: rows.length }
    if (url.pathname.endsWith('/members')) return { items: [] }
    if (url.pathname.endsWith('/folders')) return { list: [{
      id: '11111111-1111-4111-8111-111111111111', name: '目录', parentId: null,
      teamId: 'team-a', roomCount: 20, canManage: true
    }] }
    if (url.pathname.endsWith('/rooms')) {
      let matches = rows
      if (url.searchParams.get('folderId') === 'root') matches = matches.filter(item => item.folderId === null)
      if (url.searchParams.has('q')) matches = matches.filter(item => item.title.includes(url.searchParams.get('q')))
      if (url.searchParams.has('role')) matches = matches.filter(item => item.role === url.searchParams.get('role').toLowerCase())
      const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : matches.length
      const offset = Number(url.searchParams.get('offset') || 0)
      const list = matches.slice(offset, offset + limit)
      return { items: list, list, total: matches.length, limit, offset }
    }
    throw new Error('Unexpected read ' + pathname)
  })
  const vm = (file, route, propsData = {}) => {
    const component = runtime.load(path.join(root, 'src/pages/ProductShell', file)).default
    return new runtime.Vue({ ...component, created: [], propsData,
      beforeCreate() { this.$route = route; this.$message = { error() {}, warning() {} } } })
  }
  return { runtime, calls, rows, vm, repo }
}

test('[R31] FilesPage sends bounded team paging and shows its team pager', async () => {
  const f = fixtureRuntime()
  const vm = f.vm('FilesPage.vue', { path: '/files', fullPath: '/files?team=team-a', query: { team: 'team-a' }, params: {} }, { mode: 'files' })
  try {
    await vm.load({ reset: true, keepPage: true })
    assert.equal(vm.error, '', 'Production FilesPage must complete its real service calls')
    const request = f.calls.find(item => item.url.pathname.endsWith('/rooms')).url
    assert.equal(request.searchParams.get('limit'), '20', 'Team directory request must be server-bounded')
    assert.equal(request.searchParams.get('folderId'), 'root')
    assert.equal(vm.rooms.length, 20)
    assert.equal(vm.showPager, true, 'Team paging must be reachable through the UI')
  } finally { vm.$destroy(); f.runtime.destroy() }
})

test('[R31] FilesPage second page sends offset and does not refetch team/folder metadata', async () => {
  const f = fixtureRuntime()
  const vm = f.vm('FilesPage.vue', { path: '/files', fullPath: '/files?team=team-a', query: { team: 'team-a' }, params: {} }, { mode: 'files' })
  try {
    await vm.load({ reset: true, keepPage: true })
    const before = f.calls.length
    vm.page = 2
    await vm.load({ reset: true, keepPage: true })
    const later = f.calls.slice(before)
    const page = later.find(item => item.url.pathname.endsWith('/rooms')).url
    assert.equal(page.searchParams.get('offset'), '20')
    assert.deepEqual(later.map(item => item.url.pathname), ['/api/teams/team-a/rooms'],
      'Ordinary page navigation must fetch only the room page')
  } finally { vm.$destroy(); f.runtime.destroy() }
})

test('[R31] SpaceDetail production loading uses a bounded room page instead of all sixty', async () => {
  const f = fixtureRuntime()
  const vm = f.vm('SpaceDetailPage.vue', { path: '/spaces/team-a', params: { id: 'team-a' }, query: {} })
  try {
    await vm.load()
    assert.equal(vm.error, '')
    const request = f.calls.find(item => item.url.pathname.endsWith('/rooms')).url
    assert.equal(request.searchParams.get('limit'), '20', 'SpaceDetail must use the paging service too')
    assert.ok(vm.rooms.length <= 20, `SpaceDetail retained ${vm.rooms.length} room DTOs`)
  } finally { vm.$destroy(); f.runtime.destroy() }
})

test('[R31] legacy team array service contract remains compatible until callers migrate', async () => {
  const f = fixtureRuntime()
  try {
    const list = await f.runtime.services.team.listRooms('team-a')
    assert.ok(Array.isArray(list))
    assert.equal(list[20].roomKey, 'team-room-21')
    assert.equal(list.length, 60, 'Do not silently truncate old full-list callers to twenty')
  } finally { f.runtime.destroy() }
})
