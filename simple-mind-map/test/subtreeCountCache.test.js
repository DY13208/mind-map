const assert = require('assert')
const {
  getRoomSubtreeCounts,
  resetRoomSubtreeCountsCache,
  roomSubtreeCountsCacheStats
} = require('../bin/subtreeCountCache')

function countMap(size, marker = 0) {
  const counts = new Map()
  for (let i = 0; i < size; i++) counts.set('uid-' + i, marker)
  return counts
}

async function testVersionAndDatabaseIsolation() {
  resetRoomSubtreeCountsCache()
  const firstDb = {}
  const secondDb = {}
  let loads = 0
  const loader = value => async () => {
    loads++
    return new Map([['root', value]])
  }

  const first = await getRoomSubtreeCounts(firstDb, 'room', 1, loader(1))
  assert.strictEqual(first.queryCount, 1)
  assert.strictEqual(first.counts.get('root'), 1)

  const sameVersion = await getRoomSubtreeCounts(firstDb, 'room', 1, loader(9))
  assert.strictEqual(sameVersion.queryCount, 0)
  assert.strictEqual(sameVersion.counts.get('root'), 1)

  const otherDb = await getRoomSubtreeCounts(secondDb, 'room', 1, loader(2))
  assert.strictEqual(otherDb.queryCount, 1)
  assert.strictEqual(otherDb.counts.get('root'), 2)

  const newer = await getRoomSubtreeCounts(firstDb, 'room', 2, loader(3))
  assert.strictEqual(newer.queryCount, 1)
  const stale = await getRoomSubtreeCounts(firstDb, 'room', 1, loader(4))
  assert.strictEqual(stale.queryCount, 1)
  const latestAgain = await getRoomSubtreeCounts(firstDb, 'room', 2, loader(5))
  assert.strictEqual(latestAgain.queryCount, 0)
  assert.strictEqual(latestAgain.counts.get('root'), 3)
  assert.strictEqual(loads, 4)
}

async function testSameVersionSingleflight() {
  resetRoomSubtreeCountsCache()
  const db = {}
  let loads = 0
  let resolveLoad
  const loader = () => {
    loads++
    return new Promise(resolve => { resolveLoad = resolve })
  }

  const leader = getRoomSubtreeCounts(db, 'room', 8, loader)
  const follower = getRoomSubtreeCounts(db, 'room', 8, loader)
  await Promise.resolve()
  assert.strictEqual(loads, 1)
  resolveLoad(new Map([['root', 8]]))
  const [first, second] = await Promise.all([leader, follower])
  assert.strictEqual(first.queryCount, 1)
  assert.strictEqual(second.queryCount, 0)
  assert.strictEqual(first.counts, second.counts)
}

async function testPendingLoadsDoNotExceedRoomLimit() {
  resetRoomSubtreeCountsCache()
  const db = {}
  const releases = []
  let admittedLoads = 0
  const leaders = Array.from({ length: 16 }, (_, index) =>
    getRoomSubtreeCounts(db, 'pending-' + index, 1, () => {
      admittedLoads++
      return new Promise(resolve => { releases[index] = resolve })
    })
  )

  await Promise.resolve()
  assert.strictEqual(admittedLoads, 16)
  assert.strictEqual(roomSubtreeCountsCacheStats().rooms, 16)

  const sameRoomFollower = getRoomSubtreeCounts(db, 'pending-0', 1, async () => {
    throw new Error('same-version pending room must share its in-flight load')
  })
  let bypassLoads = 0
  const bypassed = await Promise.all(Array.from({ length: 12 }, (_, index) =>
    getRoomSubtreeCounts(db, 'overflow-' + index, 1, async () => {
      bypassLoads++
      return new Map([['root', index]])
    })
  ))
  assert.strictEqual(bypassLoads, 12)
  assert.strictEqual(roomSubtreeCountsCacheStats().rooms, 16)
  assert.deepStrictEqual(bypassed.map(result => result.counts.get('root')), Array.from({ length: 12 }, (_, i) => i))
  assert.ok(bypassed.every(result => result.queryCount === 1))

  releases.forEach((resolve, index) => resolve(new Map([['root', index]])))
  const completed = await Promise.all([...leaders, sameRoomFollower])
  assert.strictEqual(completed[0].queryCount, 1)
  assert.strictEqual(completed[16].queryCount, 0)
  assert.strictEqual(roomSubtreeCountsCacheStats().rooms, 16)
  assert.strictEqual(roomSubtreeCountsCacheStats().nodeCounts, 16)
}

async function testFailedLoadsAreRetried() {
  resetRoomSubtreeCountsCache()
  const db = {}
  let loads = 0
  await assert.rejects(
    getRoomSubtreeCounts(db, 'room', 1, async () => {
      loads++
      throw new Error('temporary database failure')
    }),
    /temporary database failure/
  )
  const recovered = await getRoomSubtreeCounts(db, 'room', 1, async () => {
    loads++
    return new Map([['root', 1]])
  })
  assert.strictEqual(recovered.queryCount, 1)
  assert.strictEqual(loads, 2)
}

async function testEmptyCountsAndLruRoomLimit() {
  resetRoomSubtreeCountsCache()
  const db = {}
  const load = room => getRoomSubtreeCounts(db, room, 1, async () => new Map())
  for (let i = 0; i < 16; i++) await load('room-' + i)
  assert.strictEqual((await load('room-0')).queryCount, 0)
  await load('room-16')
  assert.strictEqual(roomSubtreeCountsCacheStats().rooms, 16)
  assert.strictEqual((await load('room-0')).queryCount, 0)
  assert.strictEqual((await load('room-1')).queryCount, 1)
}

async function testAggregateAndOversizedCacheLimits() {
  resetRoomSubtreeCountsCache()
  const db = {}
  const load = (room, size) => getRoomSubtreeCounts(db, room, 1, async () => countMap(size))

  await load('large-a', 60000)
  await load('large-b', 40000)
  assert.strictEqual(roomSubtreeCountsCacheStats().nodeCounts, 100000)
  await getRoomSubtreeCounts(db, 'large-a', 1, async () => countMap(1))
  await load('small-c', 1)
  const afterEviction = roomSubtreeCountsCacheStats()
  assert.ok(afterEviction.nodeCounts <= afterEviction.maxNodeCounts)
  assert.strictEqual(afterEviction.rooms, 2)
  assert.strictEqual((await load('large-b', 1)).queryCount, 1)

  resetRoomSubtreeCountsCache()
  let oversizedLoads = 0
  const oversized = () => {
    oversizedLoads++
    return countMap(100001)
  }
  await getRoomSubtreeCounts(db, 'oversized', 1, oversized)
  await getRoomSubtreeCounts(db, 'oversized', 1, oversized)
  assert.strictEqual(oversizedLoads, 2)
  assert.deepStrictEqual(roomSubtreeCountsCacheStats(), {
    rooms: 0,
    nodeCounts: 0,
    maxRooms: 16,
    maxNodeCounts: 100000
  })
}

async function main() {
  await testVersionAndDatabaseIsolation()
  await testSameVersionSingleflight()
  await testPendingLoadsDoNotExceedRoomLimit()
  await testFailedLoadsAreRetried()
  await testEmptyCountsAndLruRoomLimit()
  await testAggregateAndOversizedCacheLimits()
  console.log('subtree count cache tests passed')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
