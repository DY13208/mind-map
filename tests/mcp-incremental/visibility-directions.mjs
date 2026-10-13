import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url))
const RESULTS_DIR = path.join(TESTS_DIR, 'results')
const APP_A = 'http://127.0.0.1:19090'
const APP_B = 'http://127.0.0.1:19091'
const TOKEN = 'mcp-incremental-test-only-token-0160b5a7'
const DB_PASSWORD = 'mcp-incremental-test-db-password'
const PROJECT = 'mcp-incremental-test'
const SERVICES = [
  { name: `${PROJECT}-app-a-1`, service: 'app-a', instance: 'app-a' },
  { name: `${PROJECT}-app-b-1`, service: 'app-b', instance: 'app-b' },
  { name: `${PROJECT}-postgres-1`, service: 'postgres' },
  { name: `${PROJECT}-redis-1`, service: 'redis' }
]

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function checkEnv(key, expected) {
  const supplied = process.env[key]
  assert(supplied == null || supplied === expected, `${key} must use the fixed local test-only value`)
  process.env[key] = expected
}

function configureTestOnlyEnvironment(runId) {
  assert(/^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/.test(runId), 'set a fresh MCP_BASELINE_RUN_ID (3-64 letters, digits, _ or -)')
  assert(process.env.MIND_MAP_SKIP_ROOT_ENV == null || process.env.MIND_MAP_SKIP_ROOT_ENV === '1', 'MIND_MAP_SKIP_ROOT_ENV must be 1')
  process.env.MIND_MAP_SKIP_ROOT_ENV = '1'
  checkEnv('MCP_BASELINE_RUN_ID', runId)
  checkEnv('MCP_BASELINE_APP_A', APP_A)
  checkEnv('MCP_BASELINE_APP_B', APP_B)
  checkEnv('MCP_BASELINE_MCP_TOKEN', TOKEN)
  checkEnv('MCP_BASELINE_PGHOST', '127.0.0.1')
  checkEnv('MCP_BASELINE_PGPORT', '25492')
  checkEnv('MCP_BASELINE_PGDATABASE', 'mcp_incremental_test')
  checkEnv('MCP_BASELINE_PGUSER', 'mcp_test')
  checkEnv('MCP_BASELINE_PGPASSWORD', DB_PASSWORD)
}

function runDocker(args) {
  const result = spawnSync('docker', args, {
    cwd: path.resolve(TESTS_DIR, '../..'),
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true
  })
  if (result.error || result.status !== 0) {
    throw new Error(`docker ${args[0]} failed: ${(result.stderr || result.stdout || result.error?.message || '').trim()}`)
  }
  return result.stdout.trim()
}

function validateComposeProject(runId) {
  const actualNames = runDocker([
    'ps', '-a', '--filter', `label=com.docker.compose.project=${PROJECT}`,
    '--format', '{{.Names}}'
  ]).split(/\r?\n/).filter(Boolean).sort()
  const expectedNames = SERVICES.map(item => item.name).sort()
  assert(JSON.stringify(actualNames) === JSON.stringify(expectedNames),
    `refusing non-test Compose containers; expected only ${expectedNames.join(', ')}, found ${actualNames.join(', ') || '(none)'}`)

  for (const expected of SERVICES) {
    const labels = JSON.parse(runDocker(['inspect', '--format', '{{json .Config.Labels}}', expected.name]))
    assert(labels?.['com.docker.compose.project'] === PROJECT, `${expected.name} is not in Compose project ${PROJECT}`)
    assert(labels?.['com.docker.compose.service'] === expected.service, `${expected.name} has an unexpected Compose service label`)
    assert(runDocker(['inspect', '--format', '{{.State.Status}}', expected.name]) === 'running', `${expected.name} is not running`)
    if (!expected.instance) continue

    const selected = 'process.stdout.write(JSON.stringify({skip:process.env.MIND_MAP_SKIP_ROOT_ENV,runId:process.env.MCP_BASELINE_RUN_ID,instance:process.env.MCP_BASELINE_INSTANCE,metricsFile:process.env.MCP_BASELINE_METRICS_FILE,pgHost:process.env.PGHOST,pgPort:process.env.PGPORT,pgDatabase:process.env.PGDATABASE,pgUser:process.env.PGUSER,redisUrl:process.env.REDIS_URL,token:process.env.MCP_TOKEN}))'
    const runtime = JSON.parse(runDocker(['exec', expected.name, 'node', '-e', selected]))
    assert(runtime.skip === '1', `${expected.name} must set MIND_MAP_SKIP_ROOT_ENV=1`)
    assert(runtime.runId === runId, `${expected.name} must use MCP_BASELINE_RUN_ID=${runId}; force-recreate only the two test app services first`)
    assert(runtime.instance === expected.instance, `${expected.name} has an unexpected baseline instance name`)
    assert(runtime.metricsFile === `/baseline/${runId}-${expected.instance}.jsonl`, `${expected.name} metrics file prefix does not match run ID ${runId}`)
    assert(runtime.pgHost === 'postgres' && runtime.pgPort === '5432', `${expected.name} is not using test Compose PostgreSQL`)
    assert(runtime.pgDatabase === 'mcp_incremental_test' && runtime.pgUser === 'mcp_test', `${expected.name} is not using the test database`)
    assert(runtime.redisUrl === 'redis://redis:6379', `${expected.name} is not using test Compose Redis`)
    assert(runtime.token === TOKEN, `${expected.name} is not using the fixed test-only MCP token`)
  }
}

function parseRpcBody(raw) {
  let data = null
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    try { data = JSON.parse(line.slice(5).trim()) } catch {}
  }
  if (!data && raw) {
    try { data = JSON.parse(raw) } catch {}
  }
  return data
}

async function requestRpc(base, sessionId, body) {
  const headers = new Headers({
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'mcp-protocol-version': '2024-11-05',
    authorization: `Bearer ${TOKEN}`
  })
  if (sessionId) headers.set('mcp-session-id', sessionId)
  const response = await fetch(new URL('/mcp', base), { method: 'POST', headers, body: JSON.stringify(body) })
  const raw = await response.text()
  return { response, raw, data: parseRpcBody(raw), sessionId: response.headers.get('mcp-session-id') || sessionId }
}

async function initializeMcp(base, label) {
  const initialized = await requestRpc(base, null, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: `mcp-incremental-visibility-${label}`, version: '1.0.0' }
    }
  })
  assert(initialized.response.status === 200 && initialized.data?.result && initialized.sessionId,
    `${label} MCP initialize failed: HTTP ${initialized.response.status} ${initialized.raw.slice(0, 1000)}`)
  await requestRpc(base, initialized.sessionId, { jsonrpc: '2.0', method: 'notifications/initialized' })
  return { base, sessionId: initialized.sessionId, nextId: 2 }
}

async function callAddNode(session, roomKey, text) {
  const requestStartedAtEpochMs = Date.now()
  const result = await requestRpc(session.base, session.sessionId, {
    jsonrpc: '2.0',
    id: session.nextId++,
    method: 'tools/call',
    params: { name: 'add_node', arguments: { room_key: roomKey, parent: 'root', text } }
  })
  assert(result.response.status === 200 && !result.data?.error && !result.data?.result?.isError,
    `MCP add_node failed: HTTP ${result.response.status} ${(result.data?.result?.content || []).map(item => item.text || '').join('\n') || result.raw.slice(0, 1500)}`)
  const content = (result.data?.result?.content || []).map(item => item.text || '').join('')
  let payload
  try { payload = JSON.parse(content) } catch { throw new Error(`MCP add_node returned non-JSON content: ${content.slice(0, 1000)}`) }
  const uid = payload.uid || payload.node?.uid
  assert(uid, `MCP add_node response did not return UID: ${content.slice(0, 1000)}`)
  return {
    uid: String(uid),
    operationId: payload.operationId || payload.operation_id || payload.operation?.operation_id || null,
    version: Number.isSafeInteger(Number(payload.version)) ? Number(payload.version) : null,
    requestStartedAtEpochMs,
    responseCompletedAtEpochMs: Date.now(),
    responsePayload: payload,
    responseStatus: result.response.status
  }
}

function pgConfig(runId) {
  return {
    host: '127.0.0.1',
    port: 25492,
    database: 'mcp_incremental_test',
    user: 'mcp_test',
    password: DB_PASSWORD,
    application_name: `mcp-visibility-${runId}`
  }
}

async function readRoomVersion(db, roomKey) {
  const result = await db.query('select version::int from rooms where room_key = $1', [roomKey])
  assert(result.rows.length === 1, `room row missing from test database: ${roomKey}`)
  return result.rows[0].version
}

function stringify(value) {
  try { return JSON.stringify(value) } catch { return String(value) }
}

function matchesOperation(row, { uid, text, operationId }) {
  return (operationId && row.operation_id === operationId) ||
    stringify(row.payload).includes(uid) || stringify(row.payload).includes(text)
}

async function readCommittedWrite(db, roomKey, baseVersion, text, mcpResult) {
  const deadline = Date.now() + 12_000
  let latest = null
  while (Date.now() <= deadline) {
    const [room, nodeQuery, operations] = await Promise.all([
      db.query('select version::int from rooms where room_key = $1', [roomKey]),
      db.query("select uid, parent_uid, data->>'text' as text, deleted_at from room_nodes where room_key = $1 and uid = $2", [roomKey, mcpResult.uid]),
      db.query(
        `select version::int, operation_id::text, operation_type, actor_id, client_id, payload
         from room_operations where room_key = $1 and version > $2 order by version`,
        [roomKey, baseVersion]
      )
    ])
    const currentVersion = room.rows[0]?.version ?? null
    const node = nodeResultRow(nodeQuery.rows)
    const operation = operations.rows.find(row => matchesOperation(row, { ...mcpResult, text })) || null
    latest = { currentVersion, node, operations: operations.rows, operation }
    if (currentVersion > baseVersion && node && node.deleted_at == null && operation) {
      latest.observedAtEpochMs = Date.now()
      return latest
    }
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  return latest
}

function nodeResultRow(rows) {
  return rows.length === 1 ? rows[0] : null
}

function decodeSocketFrame(payloadData) {
  if (typeof payloadData !== 'string') return null
  const offset = payloadData.indexOf('[')
  if (offset < 0) return null
  try {
    const value = JSON.parse(payloadData.slice(offset))
    if (!Array.isArray(value) || typeof value[0] !== 'string') return null
    return { eventName: value[0], args: value.slice(1) }
  } catch { return null }
}

function recursiveValues(value, wantedKeys, output = []) {
  if (!value || typeof value !== 'object') return output
  if (Array.isArray(value)) {
    for (const item of value) recursiveValues(item, wantedKeys, output)
    return output
  }
  for (const [key, nested] of Object.entries(value)) {
    if (wantedKeys.has(key.toLowerCase())) output.push({ key: key.toLowerCase(), value: nested })
    recursiveValues(nested, wantedKeys, output)
  }
  return output
}

function attachOperationEventCapture(clients) {
  const capture = new Map()
  for (const client of clients) {
    const frames = []
    const handler = event => {
      const decoded = decodeSocketFrame(event.response?.payloadData)
      if (decoded?.eventName !== 'op:event') return
      frames.push({
        receivedAtEpochMs: Date.now(),
        eventName: decoded.eventName,
        args: decoded.args,
        byteLength: Buffer.byteLength(event.response?.payloadData || '')
      })
    }
    client.cdp.on('Network.webSocketFrameReceived', handler)
    capture.set(client.id, { client, frames, handler })
  }
  return capture
}

function eventCorrelation(frames, { roomKey, uid, text, operationId, version }) {
  for (const frame of frames) {
    const serialized = stringify(frame.args)
    if (operationId && serialized.includes(operationId)) return { matched: true, matchedBy: 'operation-id', frame }
    if (serialized.includes(uid)) return { matched: true, matchedBy: 'uid', frame }
    if (serialized.includes(text)) return { matched: true, matchedBy: 'marker-text', frame }
    const versions = recursiveValues(frame.args, new Set(['version']))
      .map(item => Number(item.value)).filter(Number.isFinite)
    const rooms = recursiveValues(frame.args, new Set(['roomkey', 'room_key']))
      .map(item => String(item.value))
    if (versions.includes(version) && (!rooms.length || rooms.includes(roomKey))) {
      return { matched: true, matchedBy: rooms.includes(roomKey) ? 'room-and-version' : 'version-in-isolated-room-session', frame }
    }
  }
  return { matched: false, matchedBy: null, frame: null }
}

async function inspectProductAndDom(client, uid) {
  return client.page.evaluate(targetUid => {
    const seen = new Set()
    const stack = [document.querySelector('#app')?.__vue__ || null]
    let mindMap = null
    while (stack.length) {
      const vm = stack.pop()
      if (!vm || seen.has(vm)) continue
      seen.add(vm)
      if (vm.mindMap && typeof vm.mindMap.getTheme === 'function') {
        mindMap = vm.mindMap
        break
      }
      for (const child of vm.$children || []) stack.push(child)
    }

    const renderer = mindMap?.renderer || null
    let node = null
    try { node = renderer?.findNodeByUid?.(targetUid) || null } catch {}
    let productText = null
    let productParentUid = null
    if (node) {
      try { productText = String(node.getData?.('text') ?? '') } catch {}
      try { productParentUid = node.parent?.getData?.('uid') ?? null } catch {}
    }

    const dom = Array.from(document.querySelectorAll('.smm-node'))
      .filter(element => element.getAttribute('data-node-uid') === targetUid)
    const element = dom[0] || null
    const rect = element?.getBoundingClientRect() || null
    const style = element ? getComputedStyle(element) : null
    const intersectsViewport = Boolean(rect && rect.width > 0 && rect.height > 0 &&
      rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight)
    const centerInside = Boolean(rect && rect.width > 0 && rect.height > 0 &&
      rect.left + rect.width / 2 >= 0 && rect.top + rect.height / 2 >= 0 &&
      rect.left + rect.width / 2 < window.innerWidth && rect.top + rect.height / 2 < window.innerHeight)
    const hit = centerInside ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null
    const hitBelongs = Boolean(hit && element && (hit === element || element.contains(hit) || hit.contains?.(element)))
    const paintable = Boolean(style && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0)
    return {
      rendererAvailable: Boolean(renderer),
      productGraphUidPresent: Boolean(node),
      productText,
      productParentUid,
      domUidMatchCount: dom.length,
      domPresent: Boolean(element),
      domText: element ? String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim() : null,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      boundingBox: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
      intersectsViewport,
      centerInsideViewport: centerInside,
      visibleAtCenter: centerInside && paintable && hitBelongs,
      viewportVisibilityStatus: !element ? 'dom-absent' : (!intersectsViewport ? 'offscreen' : (centerInside && paintable && hitBelongs ? 'visible-at-center' : 'occluded-or-hidden'))
    }
  }, uid)
}

async function waitForProductUid(client, uid, timeoutMs = 10_000) {
  const startedAtEpochMs = Date.now()
  let last = null
  while (Date.now() - startedAtEpochMs < timeoutMs) {
    try {
      last = await inspectProductAndDom(client, uid)
      if (last.productGraphUidPresent) return { ...last, observedAtEpochMs: Date.now(), waitDurationMs: Date.now() - startedAtEpochMs }
    } catch (error) {
      last = { inspectionError: String(error.message || error) }
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  return { ...(last || {}), observedAtEpochMs: Date.now(), waitDurationMs: Date.now() - startedAtEpochMs, productUidTimeout: true }
}

async function waitForRoomHealth(api) {
  for (const [label, base] of [['app-a', APP_A], ['app-b', APP_B]]) {
    const response = await api(base, '/api/health')
    assert(response.response.status === 200, `${label} test app health failed: ${response.response.status} ${response.text.slice(0, 500)}`)
  }
}

async function runDirection({ runId, direction, writerInstance, observerInstance, seedRoom, openBrowserClients, closeBrowserClients, armRemoteVisibility, finishRemoteVisibilityProbe }) {
  const directionId = `${runId}-visibility-${direction}`
  assert(!fs.readdirSync(RESULTS_DIR).some(name => name.startsWith(`${directionId}-`)), `preserving existing output; browser artifacts already exist for ${directionId}`)
  const roomKey = `mcp-vis-${direction}-${randomUUID().slice(0, 12)}`
  const text = `mcp-vis-${direction}-${randomUUID()}`
  const tree = {
    data: { uid: 'root', text: `Visibility root ${direction}`, expand: true },
    children: [
      { data: { uid: `visibility-${direction}-left`, text: `Visible left ${direction}`, expand: true }, children: [] },
      { data: { uid: `visibility-${direction}-right`, text: `Visible right ${direction}`, expand: true }, children: [] }
    ]
  }
  let browserState = null
  let db = null
  let remoteProbe = null
  let eventCapture = null
  let directionResult = {
    direction,
    writerInstance,
    observerInstance,
    roomKey,
    expectedInitialVisibleNodes: 3,
    markerText: text,
    mcp: null,
    database: null,
    browserReadiness: null,
    clients: [],
    remoteVisibilityProbe: null,
    coreStatus: 'incomplete',
    qualityFailures: [],
    limits: {
      domAbsenceInterpretation: 'DOM absence alone does not prove broadcast loss: renderer/view/viewport culling is evaluated separately.',
      eventSemantics: 'CDP op:event proves a WebSocket frame reached the browser, not that the client applied it; the product renderer UID lookup is separate evidence.'
    }
  }
  const writerBase = writerInstance === 'appA' ? APP_A : APP_B
  const observerBase = observerInstance === 'appA' ? APP_A : APP_B
  let probeFinished = false
  let operationReady = false

  try {
    const fixture = await seedRoom(writerBase, roomKey, 'visibility-three-node', { tree })
    assert(fixture.expectedCount === 3, `expected a three-node fixture, got ${fixture.expectedCount}`)
    db = new Client(pgConfig(runId))
    await db.connect()

    browserState = await openBrowserClients({
      appA: APP_A,
      appB: APP_B,
      roomKey,
      runId: directionId,
      outputDir: RESULTS_DIR,
      expectedVisibleNodes: 3,
      pageLoadConcurrency: 4
    })
    const load = browserState.loadMetrics
    const loadSummary = load?.summary || {}
    const observerClients = browserState.clients.filter(client => client.instance === observerInstance)
    assert(browserState.clients.length === 13, `expected 13 browser clients, opened ${browserState.clients.length}`)
    assert(loadSummary.successfulClients === 13, `13-client load failed: ${JSON.stringify(loadSummary.failedClients || [])}`)
    assert(loadSummary.collabV2ReadyClients === 13, `collabV2 readiness failed: ${JSON.stringify(loadSummary.collabV2ReadinessFailures || [])}`)
    assert(loadSummary.structureReadyClients === 13, `three-node structure readiness failed: ${JSON.stringify(loadSummary.structureReadinessFailures || [])}`)
    assert(observerClients.length === (observerInstance === 'appA' ? 7 : 6), `unexpected observer client count for ${observerInstance}`)
    directionResult.browserReadiness = {
      clientsOpened: load.clientCountOpened,
      successfulClients: loadSummary.successfulClients,
      collabV2ReadyClients: loadSummary.collabV2ReadyClients,
      structureReadyClients: loadSummary.structureReadyClients,
      observerClientCount: observerClients.length,
      observerInstance
    }

    const baseVersion = await readRoomVersion(db, roomKey)
    const baselineCounters = new Map(browserState.clients.map(client => [client.id, {
      opEventsReceived: Number(client.websocketCounters?.opEventsReceived || 0),
      framesReceived: Number(client.websocketCounters?.framesReceived || 0)
    }]))
    eventCapture = attachOperationEventCapture(browserState.clients)
    const markerBeforeWrite = await Promise.all(observerClients.map(async client => ({
      clientId: client.id,
      present: await client.page.locator('.smm-node').evaluateAll((elements, marker) =>
        elements.some(element => String(element.innerText || element.textContent || '').includes(marker)), text)
    })))
    assert(markerBeforeWrite.every(item => !item.present), `test marker already existed before MCP write: ${JSON.stringify(markerBeforeWrite.filter(item => item.present))}`)
    directionResult.markerBeforeWrite = markerBeforeWrite
    remoteProbe = await armRemoteVisibility(observerClients, text, { instance: null, timeoutMs: 10_000 })
    assert(remoteProbe.pending?.length === observerClients.length, `visibility probe did not arm all ${observerInstance} clients`)

    const session = await initializeMcp(writerBase, direction)
    const mcpResult = await callAddNode(session, roomKey, text)
    directionResult.mcp = { ...mcpResult, tool: 'add_node', arguments: { room_key: roomKey, parent: 'root', text }, omittedIndex: true }

    const visibilityPromise = finishRemoteVisibilityProbe(remoteProbe, {
      requestStartedAtEpochMs: mcpResult.requestStartedAtEpochMs,
      responseCompletedAtEpochMs: mcpResult.responseCompletedAtEpochMs,
      operationId: mcpResult.operationId,
      timeoutMs: 10_000
    })
    const productPromises = browserState.clients.map(client => waitForProductUid(client, mcpResult.uid, 10_000)
      .then(observation => ({ clientId: client.id, instance: client.instance, ...observation })))
    const committed = await readCommittedWrite(db, roomKey, baseVersion, text, mcpResult)
    assert(committed?.node && committed.node.deleted_at == null, `database did not persist active MCP node ${mcpResult.uid}`)
    assert(committed.node.parent_uid === 'root', `database parent mismatch for ${mcpResult.uid}: ${committed.node.parent_uid}`)
    assert(committed.node.text === text, `database text mismatch for ${mcpResult.uid}`)
    assert(committed.operation, `room_operations has no operation row matching MCP UID/text ${mcpResult.uid}`)
    assert(committed.currentVersion > baseVersion, `database room version did not advance from ${baseVersion}`)
    operationReady = true

    const [visibilityResult, productObservations] = await Promise.all([visibilityPromise, Promise.all(productPromises)])
    probeFinished = true
    const operation = committed.operation
    directionResult.database = {
      committed: true,
      observedCommittedAtEpochMs: committed.observedAtEpochMs,
      roomVersionBefore: baseVersion,
      roomVersionAfter: committed.currentVersion,
      versionDelta: committed.currentVersion - baseVersion,
      node: { uid: committed.node.uid, parentUid: committed.node.parent_uid, text: committed.node.text, deleted: committed.node.deleted_at != null },
      matchingOperation: {
        version: operation.version,
        operationId: operation.operation_id,
        operationType: operation.operation_type,
        actorId: operation.actor_id,
        clientId: operation.client_id,
        matchedBy: operation.operation_id === mcpResult.operationId && mcpResult.operationId ? 'MCP-operation-id' : 'UID-or-text-in-payload'
      },
      operationRowsAfterBaseVersion: committed.operations.map(row => ({ version: row.version, operationId: row.operation_id, operationType: row.operation_type, actorId: row.actor_id, clientId: row.client_id })),
      contiguousVersionsAfterBase: committed.operations.map(row => row.version).every((version, index, rows) => version === baseVersion + index + 1) && committed.operations.at(-1)?.version === committed.currentVersion
    }
    directionResult.remoteVisibilityProbe = {
      status: visibilityResult.status,
      timeoutMs: visibilityResult.timeoutMs,
      armedAtEpochMs: remoteProbe.armedAtEpochMs,
      clients: visibilityResult.clients
    }

    directionResult.clients = productObservations.map(observation => {
      const captured = eventCapture.get(observation.clientId)
      const client = captured?.client
      const before = baselineCounters.get(observation.clientId) || {}
      const afterCount = Number(client?.websocketCounters?.opEventsReceived || 0)
      const eventDelta = afterCount - Number(before.opEventsReceived || 0)
      const correlation = eventCorrelation(captured?.frames || [], {
        roomKey, uid: mcpResult.uid, text, operationId: mcpResult.operationId, version: operation.version
      })
      return {
        clientId: observation.clientId,
        instance: observation.instance,
        isObserver: observation.instance === observerInstance,
        websocket: {
          opEventsReceivedBefore: before.opEventsReceived,
          opEventsReceivedAfter: afterCount,
          opEventCountDelta: eventDelta,
          framesReceivedBefore: before.framesReceived,
          framesReceivedAfter: Number(client?.websocketCounters?.framesReceived || 0),
          roomOpEventFrameCountCaptured: captured?.frames.length || 0,
          operationEventStatus: correlation.matched
            ? 'matched-operation-event'
            : (eventDelta > 0 ? 'op-event-received-unmatched' : 'no-op-event-received'),
          operationEventMatchedBy: correlation.matchedBy,
          matchedEvent: correlation.frame || null
        },
        productRenderer: {
          rendererAvailable: observation.rendererAvailable ?? false,
          uidPresent: observation.productGraphUidPresent ?? false,
          text: observation.productText ?? null,
          parentUid: observation.productParentUid ?? null,
        observedAtEpochMs: observation.observedAtEpochMs ?? null,
          waitDurationMs: observation.waitDurationMs ?? null,
          inspectionError: observation.inspectionError || null
        },
        dom: {
          uidMatchCount: observation.domUidMatchCount ?? 0,
          present: observation.domPresent ?? false,
          text: observation.domText ?? null
        },
        viewport: {
          boundingBox: observation.boundingBox ?? null,
          dimensions: observation.viewport ?? null,
          intersects: observation.intersectsViewport ?? false,
          centerInside: observation.centerInsideViewport ?? false,
          visibleAtCenter: observation.visibleAtCenter ?? false,
          status: observation.viewportVisibilityStatus || 'not-observed'
        }
      }
    })

    const remoteClients = directionResult.clients.filter(client => client.isObserver)
    const missingRemoteEvents = remoteClients.filter(client => client.websocket.operationEventStatus === 'no-op-event-received')
    const unmatchedRemoteEvents = remoteClients.filter(client => client.websocket.operationEventStatus === 'op-event-received-unmatched')
    const missingRemoteRendererState = remoteClients.filter(client => !client.productRenderer.uidPresent)
    if (missingRemoteEvents.length) directionResult.qualityFailures.push({ type: 'op-event-not-received', clientIds: missingRemoteEvents.map(client => client.clientId) })
    if (unmatchedRemoteEvents.length) directionResult.qualityFailures.push({ type: 'op-event-received-but-not-correlated', clientIds: unmatchedRemoteEvents.map(client => client.clientId) })
    if (missingRemoteRendererState.length) directionResult.qualityFailures.push({ type: 'remote-product-graph-missing-uid', clientIds: missingRemoteRendererState.map(client => client.clientId) })
    directionResult.coreStatus = 'complete'
  } catch (error) {
    directionResult.error = String(error.stack || error)
    directionResult.coreStatus = operationReady ? 'partially-complete' : 'failed'
  } finally {
    if (remoteProbe && !probeFinished) {
      try {
        const result = await finishRemoteVisibilityProbe(remoteProbe, { timeoutMs: 10_000 })
        directionResult.remoteVisibilityProbe = { status: result.status, timeoutMs: result.timeoutMs, armedAtEpochMs: remoteProbe.armedAtEpochMs, clients: result.clients }
      } catch (error) {
        directionResult.remoteVisibilityProbeError = String(error.message || error)
      }
    }
    if (eventCapture) {
      for (const { client, handler } of eventCapture.values()) client.cdp.off('Network.webSocketFrameReceived', handler)
    }
    if (browserState) {
      try { await closeBrowserClients(browserState) } catch (error) { directionResult.browserCloseError = String(error.message || error) }
    }
    if (db) await db.end().catch(error => { directionResult.databaseCloseError = String(error.message || error) })
    directionResult.mcpCommitted = Boolean(directionResult.database?.committed)
    directionResult.qualityStatus = directionResult.qualityFailures.length ? 'quality-failures' : (directionResult.coreStatus === 'complete' ? 'passed' : 'not-evaluated')
    directionResult.observerBase = observerBase
  }
  return directionResult
}

async function main() {
  const runId = String(process.env.MCP_BASELINE_RUN_ID || '').trim()
  configureTestOnlyEnvironment(runId)
  validateComposeProject(runId)

  const suffixes = [
    '-visibility-directions-summary.json',
    '-visibility-a-to-b-browser-metrics.json',
    '-visibility-b-to-a-browser-metrics.json'
  ]
  fs.mkdirSync(RESULTS_DIR, { recursive: true })
  for (const suffix of suffixes) {
    assert(!fs.existsSync(path.join(RESULTS_DIR, `${runId}${suffix}`)), `preserving existing output; choose a fresh MCP_BASELINE_RUN_ID (found ${runId}${suffix})`)
  }

  const [{ api, seedRoom }, browser] = await Promise.all([
    import('./fixtures.mjs'),
    import('./browser-baseline.mjs')
  ])
  await waitForRoomHealth(api)

  const directions = []
  directions.push(await runDirection({
    runId,
    direction: 'a-to-b',
    writerInstance: 'appA',
    observerInstance: 'appB',
    seedRoom,
    ...browser
  }))
  directions.push(await runDirection({
    runId,
    direction: 'b-to-a',
    writerInstance: 'appB',
    observerInstance: 'appA',
    seedRoom,
    ...browser
  }))

  const coreComplete = directions.length === 2 && directions.every(direction => direction.coreStatus === 'complete' && direction.mcpCommitted)
  const qualityFailures = directions.flatMap(direction => direction.qualityFailures.map(failure => ({ direction: direction.direction, ...failure })))
  const summary = {
    schema: 1,
    runId,
    composeProject: PROJECT,
    testEnvironment: {
      appA: APP_A,
      appB: APP_B,
      database: '127.0.0.1:25492/mcp_incremental_test',
      token: '[fixed test-only token omitted]',
      rootEnvFileLoadedByScript: false
    },
    coreStatus: coreComplete ? 'complete' : 'incomplete',
    qualityStatus: qualityFailures.length ? 'quality-failures' : (coreComplete ? 'passed' : 'not-evaluated'),
    qualityFailures,
    directions,
    interpretation: 'Each direction uses a real MCP add_node request without index against an isolated three-node room. Database commit, CDP op:event receipt, product renderer UID state, DOM presence and viewport visibility are reported independently. A missing DOM node is not by itself evidence of lost broadcast.',
    limits: [
      'Only the exact mcp-incremental-test Compose project and its four allowlisted containers are accepted.',
      'The harness does not load the repository root .env and hard-codes loopback endpoints, test credentials, and the isolated test database.',
      'An op:event frame proves browser WebSocket receipt, not application of that event; renderer UID state is measured separately.',
      'DOM absence can be caused by renderer culling or viewport state and is not treated as proof of lost broadcast.',
      'The 13 clients use the existing browser-baseline helper and its bounded page-load waves; this is not a simultaneous cold-start test.'
    ]
  }
  const summaryPath = path.join(RESULTS_DIR, `${runId}-visibility-directions-summary.json`)
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' })
  console.log(JSON.stringify({ type: 'visibility_directions_complete', runId, coreStatus: summary.coreStatus, qualityStatus: summary.qualityStatus, directions: directions.map(item => ({ direction: item.direction, coreStatus: item.coreStatus, qualityFailures: item.qualityFailures.length })), summary: summaryPath }))
  if (!coreComplete || qualityFailures.length) process.exitCode = 1
}

const HELP = `双向可见性诊断：对 A→B 与 B→A 分别创建三节点可见夹具，通过真实 MCP add_node（不传 index）写入，并独立记录数据库提交、op:event、渲染器 UID、DOM 和视口状态。

先用全新 run ID 重建两个测试应用容器：
  $env:MIND_MAP_SKIP_ROOT_ENV = '1'
  $env:MCP_BASELINE_RUN_ID = 'mcp-visibility-20261012-a01'
  docker compose --env-file tests/mcp-incremental/test.env -p mcp-incremental-test -f docker/mcp-incremental-test.compose.yml up -d --no-build --no-deps --force-recreate app-a app-b
  node tests/mcp-incremental/visibility-directions.mjs

Compose 始终显式指定测试 env 文件和 project；不要省略 --env-file 或 -p。脚本不会启动、重建或停止服务。
仅接受 project mcp-incremental-test 的 app-a/app-b/postgres/redis 四个容器；数据使用测试数据库 mcp_incremental_test（端口 25492）和固定测试 token。
DOM 未见节点可能由渲染裁剪或视口状态导致，不能单独证明漏广播。
--help 不访问 Docker，也不执行诊断。`

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(HELP)
} else {
  main().catch(error => {
    console.error(`visibility direction probe refused or failed: ${error.message}`)
    process.exitCode = 1
  })
}
