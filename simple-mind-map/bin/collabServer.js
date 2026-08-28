#!/usr/bin/env node

require('./loadEnv')
const http = require('http')
const WebSocket = require('ws')
const { setupWSConnection } = require('y-websocket/bin/utils')
const { initSchema, attachPersistence, preloadRoom, handleApi } = require('./storage')

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

const wss = new WebSocket.Server({ noServer: true })

wss.on('connection', (conn, req) => {
  const raw = (req.url || '/').slice(1).split('?')[0]
  const docName = decodeURIComponent(raw || 'default')
  preloadRoom(docName)
    .catch(err => {
      console.error('[persist] preload failed', docName, err.message)
    })
    .finally(() => {
      setupWSConnection(conn, req, { gc: true })
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
