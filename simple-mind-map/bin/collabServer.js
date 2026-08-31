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
  isDeletedRoom
} = require('./storage')

const host = process.env.HOST || '0.0.0.0'
const port = Number(process.env.PORT || 1234)

const server = http.createServer(async (request, response) => {
  try {
    const handled = await handleApi(request, response)
    if (handled) return
  } catch (err) {
    console.error('[api]', err)
    if (!response.headersSent) {
      response.writeHead(500, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
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
  preloadRoom(docName)
    .catch(err => {
      console.error('[persist] preload failed', docName, err.message)
    })
    .finally(() => {
      if (conn.readyState !== WebSocket.OPEN) return
      setupWSConnection(conn, req, { gc: true, docName })
      if (socket && typeof socket.resume === 'function') socket.resume()
    })
})

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, ws => {
    wss.emit('connection', ws, request)
  })
})

initSchema()
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
