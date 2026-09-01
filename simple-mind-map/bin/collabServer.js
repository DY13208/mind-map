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
  getRoom
} = require('./storage')
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

const host = process.env.HOST || '0.0.0.0'
const port = Number(process.env.PORT || 1234)

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

const wss = new WebSocket.Server({
  noServer: true,
  maxPayload: 120 * 1024 * 1024
})

wss.on('connection', (conn, req) => {
  let docName
  try {
    const raw = (req.url || '/').slice(1).split('?')[0]
    docName = safeRoomKey(decodeURIComponent(raw || 'default'))
    if (isDeletedRoom(docName)) throw new Error('room deleted')
  } catch (err) {
    conn.close(1008, 'invalid room name')
    return
  }
  if (docs.has(docName)) {
    setupWSConnection(conn, req, { gc: true, docName })
    return
  }
  // upgrade 完成后客户端会立即发送 Yjs sync step 1。数据库预加载期间如果还没
  // 注册 setupWSConnection 的 message 监听，这个首帧会直接丢失并导致页面永远
  // 等不到 synced。先暂停底层 socket，装好处理器后再恢复读取。
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
  .then(() => {
    attachPersistence()
    server.listen(port, host, () => {
      console.log(`Collab server running at ws://${host}:${port}`)
      console.log(`Collab HTTP API: http://${host}:${port}/api/files`)
      console.log('Persistence: PostgreSQL rooms + COS mind-map/')
    })
  })
  .catch(err => {
    console.error('Failed to start collab server:', err)
    process.exit(1)
  })
