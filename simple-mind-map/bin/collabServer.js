#!/usr/bin/env node

require('./loadEnv')
const http = require('http')
const WebSocket = require('ws')
const { docs } = require('y-websocket/bin/utils')
const { setupWSConnection } = require('./collabWs')
const {
  initSchema,
  attachPersistence,
  preloadRoom,
  handleApi,
  safeRoomKey,
  isDeletedRoom,
  getRoom,
  getPool,
  operationEvents
} = require('./storage')
const { createEventBus, createPostgresBus, setActiveEventBus } = require('./eventBus')
const { startOutboxPublisher } = require('./outbox')
const {
  initAuth,
  isAuthEnabled,
  handleAuthApi,
  authenticateRequest,
  authenticateWebsocketRequest,
  requireAuthenticatedRequest,
  applyCorsHeaders,
  isAllowedOrigin
} = require('./auth')
const roomAcl = require('./roomAcl')
const { setWsConnections, recordBroadcast } = require('./collabMetrics')
const { attachCollabV2, shouldHandleUpgrade } = require('./collabV2/socketServer')
const { isCollabV2Enabled } = require('./collabV2/flag')

const host = process.env.HOST || '0.0.0.0'
const port = Number(process.env.PORT || 1234)

let openSockets = 0

function trackSocket(conn) {
  openSockets += 1
  setWsConnections(openSockets)
  conn.on('error', () => {})
  conn.on('close', () => {
    openSockets = Math.max(0, openSockets - 1)
    setWsConnections(openSockets)
  })
}

const server = http.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname
    if (request.method === 'OPTIONS' && pathname.startsWith('/api/')) {
      applyCorsHeaders(request, response)
      response.writeHead(isAllowedOrigin(request) ? 204 : 403)
      response.end()
      return
    }
    const authHandled = await handleAuthApi(request, response)
    if (authHandled) return
    if (pathname.startsWith('/api/') && pathname !== '/api/health') {
      const authenticated = await requireAuthenticatedRequest(request, response)
      if (!authenticated) return
    }
    const handled = await handleApi(request, response)
    if (handled) return
  } catch (err) {
    console.error('[api]', err)
    if (!response.headersSent) {
      applyCorsHeaders(request, response)
      response.writeHead(500, {
        'Content-Type': 'application/json; charset=utf-8'
      })
      response.end(JSON.stringify({ error: err.message || 'server error' }))
    }
    return
  }
  response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
  response.end('simple-mind-map collab server ok')
})

const v2RuntimeOnly = isCollabV2Enabled()
const wss = v2RuntimeOnly
  ? null
  : new WebSocket.Server({
      noServer: true,
      maxPayload: 120 * 1024 * 1024
    })

if (wss) wss.on('connection', (conn, req) => {
  trackSocket(conn)
  let docName
  try {
    const raw = (req.url || '/').slice(1).split('?')[0]
    docName = safeRoomKey(decodeURIComponent(raw || 'default'))
    if (isDeletedRoom(docName)) throw new Error('room deleted')
  } catch (err) {
    conn.close(1008, 'invalid room name')
    return
  }
  const baseRoom = roomAcl.presenceDocRoomKey(docName)
  const wsAction = String(docName).endsWith('__presence') ? 'view' : 'edit'
  const finishSetup = () => {
    if (docs.has(docName) || String(docName).endsWith('__presence')) {
      setupWSConnection(conn, req, { gc: true, docName })
      return true
    }
    return false
  }
  const rejectForbidden = err => {
    const code = err && err.statusCode === 404 ? 1008 : 1008
    try {
      conn.close(code, (err && err.code) || 'forbidden')
    } catch (e) {
      // ignore
    }
  }
  const authorizeThen = next => {
    if (!isAuthEnabled()) {
      next()
      return
    }
    roomAcl
      .assertRoomAccess(getPool(), req, baseRoom, wsAction)
      .then(() => next())
      .catch(rejectForbidden)
  }
  authorizeThen(() => {
    if (finishSetup()) return
    const socket = conn._socket
    if (socket && typeof socket.pause === 'function') socket.pause()
    const resume = () => {
      if (socket && typeof socket.resume === 'function') socket.resume()
    }
    preloadRoom(docName)
      .then(async payload => {
        if (conn.readyState !== WebSocket.OPEN) return
        if (!payload || payload.type === 'empty') {
          const row = await getRoom(docName)
          if (row) {
            resume()
            conn.close(1011, 'saved map missing content')
            return
          }
        }
        setupWSConnection(conn, req, { gc: true, docName })
        resume()
      })
      .catch(err => {
        console.error('[persist] preload failed', docName, err.message)
        resume()
        try {
          conn.close(1011, 'load failed')
        } catch (e) {
          // ignore
        }
      })
  })
})

function rejectUpgrade(socket, status, message) {
  const body = String(message || 'Unauthorized')
  socket.write(
    `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(
      body
    )}\r\n\r\n${body}`
  )
  socket.destroy()
}

server.on('upgrade', async (request, socket, head) => {
  try {
    if (shouldHandleUpgrade(request.url || '')) {
      return
    }
    if (v2RuntimeOnly) {
      rejectUpgrade(socket, '404 Not Found', 'v1 collab disabled')
      return
    }
    if (isAuthEnabled()) {
      try {
        request.authUser = await authenticateWebsocketRequest(request)
      } catch (err) {
        const status =
          err.statusCode === 403 ? '403 Forbidden' : '401 Unauthorized'
        rejectUpgrade(socket, status, err.message || 'Unauthorized')
        return
      }
    }
    wss.handleUpgrade(request, socket, head, ws => {
      wss.emit('connection', ws, request)
    })
  } catch (err) {
    console.error('[auth] websocket authentication failed:', err.message)
    rejectUpgrade(
      socket,
      '503 Service Unavailable',
      'Authentication unavailable'
    )
  }
})

Promise.all([initSchema(), initAuth()])
  .then(async () => {
    attachPersistence()
    let bus = createEventBus({ pool: getPool() })
    try {
      if (typeof bus.start === 'function') await bus.start()
    } catch (err) {
      console.error('[event-bus] start failed, falling back to postgres:', err.message)
      if (bus && bus.name === 'redis') {
        if (typeof bus.close === 'function') await bus.close().catch(() => {})
        bus = createPostgresBus(getPool())
        setActiveEventBus(bus)
        if (typeof bus.start === 'function') await bus.start()
      } else {
        throw err
      }
    }
    const history = require('./collabHistory')
    history.createServerHistoryEngine(getPool())
    require('./fileSystem').createServerFileSystem(getPool(), {
      history: require('./collabHistory').getHistoryEngine()
    })
    operationEvents.on('committed', event => {
      history.onCommitted(event).catch(err => {
        console.error('[history] onCommitted', err && err.message)
      })
    })
    const outboxEnabled =
      !v2RuntimeOnly &&
      !/^(0|false|off|no)$/i.test(String(process.env.COLLAB_OUTBOX_PUBLISHER || '1'))
    let publisher = null
    if (outboxEnabled) {
      publisher = startOutboxPublisher({ pool: getPool(), bus })
      operationEvents.on('committed', () => {
        publisher.kick().catch(() => {})
      })
    } else {
      console.warn(
        v2RuntimeOnly
          ? '[outbox] V1 publisher off (COLLAB_V2 runtime)'
          : '[outbox] publisher disabled (COLLAB_OUTBOX_PUBLISHER)'
      )
    }
    const { startOperationsArchiver } = require('./storage')
    startOperationsArchiver()
    const v2 = attachCollabV2(server)
    server.listen(port, host, () => {
      console.log(`Collab server running at ws://${host}:${port}`)
      console.log(`Collab HTTP API: http://${host}:${port}/api/files`)
      if (v2.enabled) {
        console.log(`Collaboration V2: ws://${host}:${port}/collab-v2`)
        console.log('V1 y-websocket / presence / outbox publisher: off')
      } else {
        console.log('Collaboration V2 disabled (COLLAB_V2=0)')
      }
      console.log('Persistence: PostgreSQL rooms + COS mind-map/')
      console.log(
        `Event bus: ${bus.name} (outbox publisher ${outboxEnabled ? 'on' : 'off'})`
      )
    })
  })
  .catch(err => {
    console.error('Failed to start collab server:', err)
    process.exit(1)
  })
