const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { withDirectoryDatabase, response, seedTeamRooms: seed, FOLDER_A, FOLDER_B } = require('./helpers/directoryPg.cjs')


async function get(f, query = '', user = 'owner', corpId = 'corp-a', teamId = 'team-a') {
  const req = { method: 'GET', url: `/api/teams/${teamId}/rooms${query ? '?' + query : ''}`,
    authUser: user ? { id: user, corpId } : null, headers: {}, forceAcl: true }
  const res = response()
  const handled = await f.team.handleApi(req, res, { db: f.adapter,
    url: new URL(req.url, 'http://fixture.invalid'), readBody: f.storage.readBody, sendJson: f.storage.sendJson })
  assert.equal(handled, true, 'Real team route must handle the request')
  return res
}

test('[R29] real team HTTP handler pages all sixty rows with stable ordering and complete coverage', async () => {
  await withDirectoryDatabase(async f => {
    await seed(f)
    const expected = (await f.client.query(`select room_key from rooms where team_id='team-a'
      and deleted_at is null and room_key not in(select room_key from room_tombstones)
      order by updated_at desc,room_key desc`)).rows.map(row => row.room_key)
    const actual = []
    for (const offset of [0, 20, 40]) {
      const res = await get(f, `limit=20&offset=${offset}&sort=updatedAt&order=desc`)
      assert.equal(res.code, 200)
      assert.equal(res.body.list.length, 20, 'SQL must bound each team room page')
      assert.equal(res.body.total, 60)
      assert.equal(res.body.offset, offset)
      actual.push(...res.body.list.map(row => row.roomKey))
    }
    assert.deepEqual(actual, expected)
    assert.equal(new Set(actual).size, 60)
  })
})

test('[R29] root, folder, room-role and owner/folder/title searches filter before total and paging', async () => {
  await withDirectoryDatabase(async f => {
    await seed(f)
    const cases = [
      ['folderId=root', row => row.folder_id === null],
      [`folderId=${FOLDER_A}`, row => row.folder_id === FOLDER_A],
      ['role=viewer', row => row.version % 3 === 2],
      ['q=Target', row => row.title === 'Target'],
      ['q=' + encodeURIComponent('创建者甲'), row => row.owner_id === 'owner'],
      ['q=' + encodeURIComponent('目录甲'), row => row.folder_id === FOLDER_A],
      [`folderId=${FOLDER_B}&q=Target`, row => row.folder_id === FOLDER_B && row.title === 'Target'],
      ['q=Target%25', () => false]
    ]
    const truth = (await f.client.query(`select room_key,title,folder_id,owner_id,version from rooms
      where team_id='team-a' and room_key like 'a-%' order by room_key`)).rows
    for (const [query, matches] of cases) {
      const allowed = truth.filter(matches)
      const res = await get(f, query + '&limit=5&offset=0&sort=title&order=asc')
      assert.equal(res.code, 200)
      assert.equal(res.body.total, allowed.length, `${query}: total must count the filtered set`)
      assert.ok(res.body.list.length <= 5)
      const keys = new Set(allowed.map(row => row.room_key))
      assert.ok(res.body.list.every(row => keys.has(row.roomKey)), query + ': leaked a row outside the filter')
    }
  })
})

test('[R30] real team ACL rejects unauthenticated, non-member and cross-enterprise requests', async () => {
  await withDirectoryDatabase(async f => {
    await seed(f)
    assert.equal((await get(f, 'limit=20', null)).code, 401)
    assert.equal((await get(f, 'limit=20', 'stranger')).code, 404)
    assert.equal((await get(f, 'limit=20', 'owner', 'corp-b')).code, 404)
    assert.equal((await get(f, 'limit=20', 'owner', 'corp-a', 'team-b')).code, 404)
    const allowed = await get(f, 'limit=20', 'reader')
    assert.equal(allowed.code, 200, 'An actual team member retains list visibility')
    assert.ok(allowed.body.list.every(row => !['deleted', 'tombstoned', 'cross-corp'].includes(row.roomKey)))
  })
})

test('[R30] team DTO reports real content revision/timestamps and room role, not team role', async () => {
  await withDirectoryDatabase(async f => {
    await seed(f)
    const res = await get(f, 'limit=20&sort=updatedAt&order=desc')
    const row = res.body.list.find(item => item.roomKey === 'a-0059')
    assert.ok(row, 'Fixture includes an owner team member who is only a room viewer')
    assert.equal(row.role, 'viewer')
    assert.equal(row.revision, 59, 'Team DTO must carry the actual rooms.version')
    assert.ok(row.contentUpdatedAt)
    assert.ok(row.resourceUpdatedAt)
  })
})

test('[R30] team page default/cap/empty page use the real bounded route', async () => {
  await withDirectoryDatabase(async f => {
    await seed(f, 180)
    const initial = await get(f)
    assert.equal(initial.body.list.length, 20, 'No query defaults to twenty rooms')
    const capped = await get(f, 'limit=999&offset=0')
    assert.equal(capped.body.list.length, 100, 'Page cap is one hundred rooms')
    assert.equal(capped.body.total, 180)
    const empty = await get(f, 'limit=20&offset=200')
    assert.equal(empty.code, 200)
    assert.deepEqual(empty.body.list, [])
    assert.equal(empty.body.total, 180)
  })
})

test('[R30] invalid pagination parameters fail explicitly rather than reading an unbounded team', async () => {
  await withDirectoryDatabase(async f => {
    await seed(f)
    for (const query of ['limit=abc', 'limit=-1', 'offset=-1', 'offset=1.5']) {
      const res = await get(f, query)
      assert.equal(res.code, 400, query + ': malformed paging values must be rejected')
      assert.ok(!res.body.list || res.body.list.length === 0)
    }
  })
})

test('[R29] record two hundred real list samples per sixty/one-thousand/ten-thousand-room fixture', async () => {
  const groups = []
  for (const count of [60, 1000, 10000]) {
    const samples = []
    await withDirectoryDatabase(async f => {
      await seed(f, count)
      for (let i = 0; i < 200; i++) {
        const started = performance.now()
        const res = await get(f, 'limit=20&offset=0&sort=updatedAt&order=desc')
        assert.equal(res.code, 200)
        samples.push({ ms: performance.now() - started, returned: res.body.list.length })
      }
    })
    groups.push({ fixtureRooms: count, samples, p95Ms: samples.map(x=>x.ms).sort((a,b)=>a-b)[189] })
  }
  const phase = process.env.PERF_TDD_PHASE === 'green' ? 'green' : 'red'
  const target = path.resolve(__dirname, `../../work/performance-tdd/${phase}/directory/team-list-baseline.json`)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, JSON.stringify({ groups,
    boundary: 'Real team.handleApi and SQL, in-process HTTP response serializer; excludes network/browser' }, null, 2))
  assert.ok(groups.every(group => group.samples.length === 200))
})
