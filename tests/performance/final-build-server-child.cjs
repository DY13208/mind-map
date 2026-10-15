// Owned isolated backend fixture for the final-build E2E acceptance.
//
// It runs the REAL native business/PG/HTTP/Socket handlers. Two flag profiles:
//   default   : optimized switches stay at their code defaults (OFF):
//               COLLAB_HTTP_DIRECT, COLLAB_MCP_DIRECT, COLLAB_NODE_COUNT_CACHE,
//               COLLAB_NODE_COUNT_CACHE_WRITERS_READY, COLLAB_V2_EVENT_BRIDGE.
//   optimized : same process with those switches forced ON (supplementary path).
//
// COLLAB_TEST_ACL=1 is retained ONLY as the synthetic transport-identity shim
// (real enterprise auth providers are disabled in isolation). It makes the
// socket carry an explicit userId and sets forceAcl, so room_members is still
// the real authorization source. Distinct actors are selected by the
// `perf_fixture_actor` cookie so separate browsers are separate principals.
//
// Never opens the repository .env. Never prints credentials.
const path = require('node:path')
const http = require('node:http')
const fs = require('node:fs')
const { randomUUID, createHash } = require('node:crypto')
const isolation = require('./isolation.cjs')
const root = path.resolve(__dirname, '../..')
const profile = ['optimized', 'bridge'].includes(process.argv[2]) ? process.argv[2] : 'default'
const fixtureHarnessSha256 = createHash('sha256').update(fs.readFileSync(__filename)).digest('hex')

isolation.configureIsolatedEnvironment()
// Base flags common to both profiles.
Object.assign(process.env, {
  COLLAB_TEST_ACL: '1',
  NODE_ENV: 'production',
  COLLAB_V2_TRACE: '0'
})
const optimizedFlags = {
  COLLAB_HTTP_DIRECT: '1',
  COLLAB_MCP_DIRECT: '1',
  COLLAB_NODE_COUNT_CACHE: '1',
  COLLAB_NODE_COUNT_CACHE_WRITERS_READY: '1',
  COLLAB_V2_EVENT_BRIDGE: '1'
}
if (profile === 'optimized') Object.assign(process.env, optimizedFlags)
else if (profile === 'bridge') {
  for (const key of Object.keys(optimizedFlags)) delete process.env[key]
  process.env.COLLAB_V2_EVENT_BRIDGE = '1'
} else for (const key of Object.keys(optimizedFlags)) delete process.env[key]

const ACTORS = {
  owner: { id: 'e2e-owner', userid: 'e2e-owner', name: 'E2E Owner' },
  'editor-a': { id: 'e2e-editor-a', userid: 'e2e-editor-a', name: 'E2E Editor A' },
  'editor-b': { id: 'e2e-editor-b', userid: 'e2e-editor-b', name: 'E2E Editor B' },
  viewer: { id: 'e2e-viewer', userid: 'e2e-viewer', name: 'E2E Viewer' }
}
const ROOM_MEMBERS = [
  ['owner', 'owner'],
  ['editor-a', 'editor'],
  ['editor-b', 'editor'],
  ['viewer', 'viewer']
]
const rooms = new Set()
let pool, bus, collab, server

function reply(res, body) {
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}
function actorFromRequest(req) {
  const cookie = String(req.headers.cookie || '')
  const match = cookie.match(/(?:^|;\s*)perf_fixture_actor=([^;]+)/)
  const key = match ? decodeURIComponent(match[1]) : 'owner'
  return { key: ACTORS[key] ? key : 'owner', user: ACTORS[key] || ACTORS.owner }
}

const { buildSmallGraph, buildLargeGraph } = require('./final-build-fixtures.cjs')

function buildSmall(graph) { return graph || buildSmallGraph() }

async function start() {
  await isolation.withIsolatedPg(async guarded => { await guarded.query('select 1') })
  const storage = require(path.join(root, 'simple-mind-map/bin/storage'))
  pool = storage.getPool()
  server = http.createServer((req, res) => {
    const actor = actorFromRequest(req)
    req.authUser = actor.user
    req.forceAcl = true
    const pathname = req.url.split('?')[0]
    if (pathname === '/api/auth/me') {
      return reply(res, { enabled: true, authenticated: true, user: actor.user,
        providers: {}, oneid: { enabled: false }, wecom: { enabled: false }, workbuddy: { enabled: false } })
    }
    if (pathname === '/api/health') return reply(res, { ok: true, isolatedFixture: true, collabV2: true })
    Promise.resolve(storage.handleApi(req, res)).then(handled => {
      if (!handled && !res.writableEnded) { res.statusCode = 404; reply(res, { code: 'FIXTURE_ROUTE_NOT_FOUND' }) }
    }).catch(error => {
      if (!res.writableEnded) { res.statusCode = error.statusCode || 500; reply(res, { code: error.code || 'FIXTURE_ERROR', error: error.message }) }
    })
  })
  bus = require(path.join(root, 'simple-mind-map/bin/eventBus')).createPostgresBus(pool)
  await bus.start()
  collab = require(path.join(root, 'simple-mind-map/bin/collabV2/socketServer')).attachCollabV2(server, { eventBus: bus })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`

  const manifestDirectory = path.join(root, 'work/performance-tdd/pi/final-build-e2e/app-starts')
  fs.mkdirSync(manifestDirectory, { recursive: true })
  const manifestPath = path.join(manifestDirectory, randomUUID() + '.json')
  fs.writeFileSync(manifestPath, JSON.stringify({ pid: process.pid, profile, readyAt: Date.now(), base,
    runtime: process.version, fixtureHarnessSha256,
    optimizedFlags: profile === 'optimized' ? optimizedFlags : 'code defaults (OFF)',
    effectiveFlags: {
      COLLAB_HTTP_DIRECT: process.env.COLLAB_HTTP_DIRECT || null,
      COLLAB_MCP_DIRECT: process.env.COLLAB_MCP_DIRECT || null,
      COLLAB_NODE_COUNT_CACHE: process.env.COLLAB_NODE_COUNT_CACHE || null,
      COLLAB_NODE_COUNT_CACHE_WRITERS_READY: process.env.COLLAB_NODE_COUNT_CACHE_WRITERS_READY || null,
      COLLAB_V2_EVENT_BRIDGE: process.env.COLLAB_V2_EVENT_BRIDGE || null,
      COLLAB_TEST_ACL: process.env.COLLAB_TEST_ACL || null,
      COLLAB_V2: process.env.COLLAB_V2 || null
    },
    productionFiles: ['simple-mind-map/bin/storage.js', 'simple-mind-map/bin/roomNodes.js', 'simple-mind-map/bin/roomCommands.js',
      'simple-mind-map/bin/eventBus.js', 'simple-mind-map/bin/collabV2/socketServer.js', 'simple-mind-map/bin/collabV2/adapter.js',
      'simple-mind-map/bin/collabV2/sequencer.js', 'simple-mind-map/bin/collabV2/directApplier.js'].map(file => ({ file,
        sha256: createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') })) }, null, 2))

  const RUN_ID = /^[0-9a-f]{16}$/
  function ownedRoomKey(runId, roomKey) {
    if (!RUN_ID.test(String(runId || ''))) throw new Error('Invalid owned fixture run id')
    if (roomKey && !String(roomKey).startsWith('final-build-e2e-' + runId + '-')) throw new Error('Room is outside the owned run namespace')
    return roomKey || ('final-build-e2e-' + runId + '-' + randomUUID())
  }
  async function seedRoom(shape, message) {
    const roomKey = ownedRoomKey(message.runId, message.roomKey)
    rooms.add(roomKey)
    const graph = shape === 'large' ? buildLargeGraph(Number(message.nodes) || 10000) : buildSmall()
    const count = Object.keys(graph).length
    await storage.upsertRoom(roomKey, 'E2E fixture ' + shape, { nodes: graph, allowFullTree: true })
    for (const [actorKey, role] of ROOM_MEMBERS) {
      await pool.query("insert into room_members(room_key,user_id,role,direct_role,source) values($1,$2,$3,$3,'direct_share')", [roomKey, ACTORS[actorKey].id, role])
    }
    return { roomKey, count, shape, runId: message.runId, members: ROOM_MEMBERS.map(([key, role]) => ({ actor: key, userId: ACTORS[key].id, role })) }
  }

  process.on('message', async message => {
    const { id, action } = message
    try {
      let value
      if (action === 'seedSmall') {
        value = await seedRoom('small', message)
      } else if (action === 'seedLarge') {
        value = await seedRoom('large', message)
      } else if (action === 'tree') {
        if (!rooms.has(message.roomKey)) throw new Error('Fixture room is not owned by this child')
        const result = await pool.query('select uid,parent_uid,data,is_root,position from room_nodes where room_key=$1 and deleted_at is null order by position,uid', [message.roomKey])
        const byUid = new Map(result.rows.map(row => [row.uid, { data: { ...row.data, uid: row.uid, expand: true }, children: [] }]))
        result.rows.forEach(row => {
          if (row.parent_uid && byUid.has(row.parent_uid)) byUid.get(row.parent_uid).children.push(byUid.get(row.uid))
        })
        const rootRow = result.rows.find(row => row.is_root)
        value = rootRow ? byUid.get(rootRow.uid) : null
      } else if (action === 'rawNodes') {
        // Read-only canonical projection of actual PG room_nodes. No field is
        // synthesized, expanded or dropped; ordering is the stored position/uid.
        if (!rooms.has(message.roomKey)) throw new Error('Fixture room is not owned by this child')
        const result = await pool.query('select room_key,uid,parent_uid,data,is_root,position,deleted_at from room_nodes where room_key=$1 order by position nulls last,uid', [message.roomKey])
        value = { roomKey: message.roomKey, rows: result.rows }
      } else if (action === 'rawState') {
        if (!rooms.has(message.roomKey)) throw new Error('Fixture room is not owned by this child')
        const result = await pool.query('select room_key,version,title,metadata,updated_at from rooms where room_key=$1', [message.roomKey])
        value = { room: result.rows[0] || null }
      } else if (action === 'state') {
        if (!rooms.has(message.roomKey)) throw new Error('Fixture room is not owned by this child')
        const result = await pool.query('select version,updated_at from rooms where room_key=$1', [message.roomKey])
        const operations = await pool.query('select version,operation_id,operation_type from room_operations where room_key=$1 order by version', [message.roomKey])
        const graphState = await pool.query("select count(*)::int as count,max(data->>'text') filter(where is_root) as root_text from room_nodes where room_key=$1 and deleted_at is null", [message.roomKey])
        value = { revision: result.rows[0] && result.rows[0].version, updated_at: result.rows[0] && result.rows[0].updated_at,
          operations: operations.rows, ...graphState.rows[0] }
      } else if (action === 'nodeCount') {
        if (!rooms.has(message.roomKey)) throw new Error('Fixture room is not owned by this child')
        const result = await pool.query('select count(*)::int as count from room_nodes where room_key=$1 and deleted_at is null', [message.roomKey])
        value = { roomKey: message.roomKey, count: result.rows[0].count }
      } else if (action === 'ownedRooms') {
        value = { rooms: Array.from(rooms) }
      } else if (action === 'adoptRooms') {
        // Test-only cold-restart adoption constrained to this run's namespace.
        // Never seeds or upserts; only records existing owned rooms for reads
        // and for the explicitly namespaced cleanup on stop.
        const runId = String(message.runId || '')
        if (!RUN_ID.test(runId)) throw new Error('Invalid owned fixture run id')
        const prefix = 'final-build-e2e-' + runId + '-'
        let requested = Array.isArray(message.roomKeys) && message.roomKeys.length
          ? message.roomKeys.map(String)
          : (await pool.query('select room_key from rooms where left(room_key,length($1))=$1 order by room_key', [prefix])).rows.map(row => row.room_key)
        for (const roomKey of requested) {
          if (!roomKey.startsWith(prefix)) throw new Error('Adoption refused outside owned run namespace')
          const exists = await pool.query('select 1 from rooms where room_key=$1', [roomKey])
          if (!exists.rows.length) throw new Error('Adoption refused for missing room ' + roomKey)
          rooms.add(roomKey)
        }
        value = { runId, prefix, adopted: Array.from(rooms) }
      } else if (action === 'stop') {
        if (collab.stop) await collab.stop()
        if (collab.io) await new Promise(resolve => collab.io.close(resolve))
        else await new Promise(resolve => server.close(resolve))
        await bus.close()
        let deleted = []
        if (!message.preserveRooms) {
          for (const roomKey of rooms) { await pool.query('delete from rooms where room_key=$1', [roomKey]); deleted.push(roomKey) }
        }
        await pool.end()
        process.send({ id, value: { stopped: true, preservedRooms: message.preserveRooms ? Array.from(rooms) : null, deleted } }, () => {
          process.disconnect()
          process.exit(0)
        })
        return
      } else throw new Error('Unsupported fixture control')
      process.send({ id, value })
    } catch (error) { process.send({ id, error: error.message }) }
  })
  process.send({ ready: true, base, profile, fixtureHarnessSha256, manifestPath, runtime: process.version,
    optimizedFlags: profile === 'optimized' ? optimizedFlags : 'code defaults (OFF)' })
}
start().catch(error => { console.error(error.stack); process.exit(1) })
