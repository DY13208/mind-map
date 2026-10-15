// Real native business PG/HTTP/Socket handlers under synthetic authentication
// and explicit fixture startup/health controls. Health API is not tested here.
// Never opens the repository .env.
const path = require('node:path')
const http = require('node:http')
const fs = require('node:fs')
const { randomUUID, createHash } = require('node:crypto')
const isolation = require('./isolation.cjs')
const root = path.resolve(__dirname, '../..')
const source = process.argv[2] === 'baseline'
  ? path.join(root, 'work/performance-tdd/baseline-source') : root
const fixtureHarnessSha256 = createHash('sha256').update(fs.readFileSync(__filename)).digest('hex')
const fixtureStartedAt = Date.now()
isolation.configureIsolatedEnvironment()
Object.assign(process.env, { COLLAB_TEST_ACL: '1', COLLAB_HTTP_DIRECT: '1', COLLAB_MCP_DIRECT: '1',
  COLLAB_NODE_COUNT_CACHE: '1', COLLAB_NODE_COUNT_CACHE_WRITERS_READY: '1', COLLAB_V2_EVENT_BRIDGE: '1',
  NODE_ENV: 'production', COLLAB_V2_TRACE: '0' })
const user = { id: 'performance-owner', userid: 'performance-owner', name: 'Synthetic owner' }
const rooms = new Set()
let pool, bus, collab, server
function reply(res, body) {
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}
async function start() {
  await isolation.withIsolatedPg(async guarded => { await guarded.query('select 1') })
  const storage = require(path.join(source, 'simple-mind-map/bin/storage'))
  const acl = require(path.join(source, 'simple-mind-map/bin/roomAcl'))
  pool = storage.getPool()
  server = http.createServer((req, res) => {
    req.authUser = user
    req.forceAcl = true
    const pathname = req.url.split('?')[0]
    if (pathname === '/api/auth/me') return reply(res, { enabled: true, authenticated: true, user,
      providers: {}, oneid: { enabled: false }, wecom: { enabled: false }, workbuddy: { enabled: false } })
    if (pathname === '/api/health') return reply(res, { ok: true, isolatedFixture: true, collabV2: true })
    Promise.resolve(storage.handleApi(req, res)).then(handled => {
      if (!handled && !res.writableEnded) { res.statusCode = 404; reply(res, { code: 'FIXTURE_ROUTE_NOT_FOUND' }) }
    }).catch(error => {
      if (!res.writableEnded) { res.statusCode = error.statusCode || 500; reply(res, { code: error.code || 'FIXTURE_ERROR', error: error.message }) }
    })
  })
  bus = require(path.join(source, 'simple-mind-map/bin/eventBus')).createPostgresBus(pool)
  await bus.start()
  collab = require(path.join(source, 'simple-mind-map/bin/collabV2/socketServer')).attachCollabV2(server, { eventBus: bus })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const manifestDirectory = path.join(root, 'work/performance-tdd', process.argv[2] === 'baseline' ? 'before' : 'after', 'online', 'ordinary-logical', 'app-starts')
  fs.mkdirSync(manifestDirectory, { recursive: true })
  const manifestPath = path.join(manifestDirectory, randomUUID() + '.json')
  fs.writeFileSync(manifestPath, JSON.stringify({ pid: process.pid, fixtureStartedAt, readyAt: Date.now(), base,
    runtime: process.version, source, fixtureHarnessSha256,
    sourceIdentity: process.argv[2] === 'baseline' ? 'Frozen git archive d5793106098afe8a2ff9bbb60193bc25e5e45f88' : 'Authorized candidate working tree; hashes below identify actual files',
    productionFiles: ['simple-mind-map/bin/storage.js', 'simple-mind-map/bin/roomNodes.js', 'simple-mind-map/bin/roomCommands.js',
      'simple-mind-map/bin/eventBus.js', 'simple-mind-map/bin/collabV2/socketServer.js', 'simple-mind-map/bin/collabV2/adapter.js',
      'simple-mind-map/bin/collabV2/sequencer.js', 'simple-mind-map/bin/collabV2/directApplier.js'].map(file => ({ file,
        sha256: createHash('sha256').update(fs.readFileSync(path.join(source, file))).digest('hex') })) }, null, 2))
  process.on('message', async message => {
    const { id, action } = message
    try {
      let value
      if (action === 'seed') {
        const branches = Number(message.branches || 150)
        const leaves = Number(message.leaves || 39)
        if (!Number.isInteger(branches) || !Number.isInteger(leaves) || branches < 1 || leaves < 1 || 1 + branches * (leaves + 1) > 12000) throw new Error('Invalid owned fixture size')
        const roomKey = 'performance-online-' + randomUUID()
        rooms.add(roomKey)
        const graph = message.shape === 'bush'
          ? require(path.join(root, 'simple-mind-map/test/fixtures/largeMapFixtures')).bushObjectGraph(10000, 'online-c2-')
          : { root: { isRoot: true, data: { uid: 'root', text: '<p>Update-0000</p>', richText: true, fontFamily: 'monospace', expand: true }, children: [] } }
        if (message.shape === 'bush') Object.values(graph).forEach(node => { node.data.text = '<p>' + node.data.text + '</p>'; node.data.richText = true; node.data.expand = true })
        for (let i = 0; message.shape !== 'bush' && i < branches; i++) {
          const branch = 'branch-' + i
          graph.root.children.push(branch)
          graph[branch] = { data: { uid: branch, text: '<p>Branch ' + i + '</p>', richText: true, expand: true }, children: [] }
          for (let j = 0; j < leaves; j++) {
            const uid = `leaf-${i}-${j}`
            graph[branch].children.push(uid)
            graph[uid] = { data: { uid, text: '<p>Leaf ' + j + '</p>', richText: true, expand: true }, children: [] }
          }
        }
        await storage.upsertRoom(roomKey, 'Synthetic online performance', { nodes: graph })
        await pool.query("insert into room_members(room_key,user_id,role,direct_role,source) values($1,$2,'owner','owner','direct_share')", [roomKey,user.id])
        value = { roomKey, count: Object.keys(graph).length }
      } else if (action === 'persistTree') {
        if (!rooms.has(message.roomKey)) throw new Error('Fixture room is not owned by this child')
        const initial = await pool.query(`select r.version,
          (select count(*)::int from room_operations o where o.room_key=r.room_key) as operation_count
          from rooms r where r.room_key=$1`, [message.roomKey])
        if (initial.rows.length !== 1 || Number(initial.rows[0].version) !== 0 || initial.rows[0].operation_count !== 0) {
          throw new Error('Complete fixture initialization requires an untouched owned room')
        }
        const graph = {}, stack = [{ node: message.tree, isRoot: true }]
        let count = 0
        while (stack.length) {
          const { node, isRoot } = stack.pop()
          const uid = String(node && node.data && node.data.uid || '')
          if (!uid || Object.hasOwn(graph, uid) || count >= 12000) throw new Error('Invalid owned tree UID/count')
          graph[uid] = { isRoot, data: { ...node.data, uid }, children: (node.children || []).map(item => String(item.data.uid)) }
          count++
          for (const child of node.children || []) stack.push({ node: child, isRoot: false })
        }
        // This is initial fixture setup before opening any browser or command.
        // V2 intentionally rejects an ordinary legacy JSON overwrite of an
        // initialized canonical tree, so request its explicit full-tree path.
        await storage.upsertRoom(message.roomKey, 'Synthetic full App plugin fixture', { nodes: graph, allowFullTree: true })
        value = { roomKey: message.roomKey, count, persisted: true, initialRevision: 0,
          boundary: 'Owned synthetic fixture initialization, not a measured business mutation; explicit full-tree persistence followed by actual canonical PG assertions' }
      } else if (action === 'tree') {
        const result = await pool.query('select uid,parent_uid,data,is_root,position from room_nodes where room_key=$1 and deleted_at is null order by position,uid', [message.roomKey])
        const byUid = new Map(result.rows.map(row => [row.uid, { data: { ...row.data, uid: row.uid, expand: true }, children: [] }]))
        result.rows.forEach(row => {
          if (row.parent_uid && byUid.has(row.parent_uid)) byUid.get(row.parent_uid).children.push(byUid.get(row.uid))
        })
        value = byUid.get(result.rows.find(row => row.is_root).uid)
      } else if (action === 'adoptStableRooms') {
        const prefix = String(message.prefix || '')
        if (!/^performance-c2-stable-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(prefix)) throw new Error('Invalid owned stable fixture namespace')
        const created = await pool.query("select r.room_key from rooms r join room_members m on m.room_key=r.room_key where left(r.room_key,length($1))=$1 and m.user_id=$2 and m.role='owner'", [prefix + '-', user.id])
        for (const row of created.rows) rooms.add(row.room_key)
        value = { adoptedForCleanup: created.rows.map(row => row.room_key), prefix }
      } else if (action === 'state') {
        const result = await pool.query('select version,updated_at from rooms where room_key=$1', [message.roomKey])
        const operations = await pool.query('select version,operation_id,operation_type,payload from room_operations where room_key=$1 order by version', [message.roomKey])
        const graphState = await pool.query('select count(*)::int as count,max(data->>\'text\') filter(where is_root) as root_text from room_nodes where room_key=$1 and deleted_at is null', [message.roomKey])
        value = { revision: result.rows[0] && result.rows[0].version,
          updated_at: result.rows[0] && result.rows[0].updated_at, operations: operations.rows,
          ...graphState.rows[0] }
      } else if (action === 'dropTransport') {
        const owned = Array.from(collab.io.sockets.sockets.values()).filter(socket =>
          socket.data.clientId === message.clientId && socket.data.rooms.has(message.roomKey))
        if (owned.length !== 1) throw new Error('Owned client transport is not unique')
        owned[0].conn.close()
        value = { closedNativeTransport: true, clientId: message.clientId }
      } else if (action === 'stop') {
        if (collab.stop) await collab.stop()
        if (collab.io) await new Promise(resolve => collab.io.close(resolve))
        else await new Promise(resolve => server.close(resolve))
        await bus.close()
        // Rows are scoped to this child's explicitly generated test rooms.
        for (const roomKey of rooms) {
          await pool.query('delete from rooms where room_key=$1', [roomKey])
        }
        await pool.end()
        // All owned services/rows and the pool have closed. Storage may retain
        // background idle timers, so end only this dedicated fixture process
        // after its real stop response has been flushed over IPC.
        process.send({ id, value: { stopped: true } }, () => {
          process.disconnect()
          process.exit(0)
        })
        return
      } else throw new Error('Unsupported fixture control')
      process.send({ id, value })
    } catch (error) { process.send({ id, error: error.message }) }
  })
  process.send({ ready: true, base, source, fixtureHarnessSha256, manifestPath,
    runtime: process.version, baselineSha: 'd5793106098afe8a2ff9bbb60193bc25e5e45f88' })
}
start().catch(error => { console.error(error.stack); process.exit(1) })
