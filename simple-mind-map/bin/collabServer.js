#!/usr/bin/env node

/**
 * Yjs WebSocket 协同服务。
 * 比 y-webrtc 信令更适合跨电脑、跨浏览器的多人实时编辑。
 */
const http = require('http')
const WebSocket = require('ws')
const { setupWSConnection } = require('y-websocket/bin/utils')

const host = process.env.HOST || '0.0.0.0'
const port = Number(process.env.PORT || 1234)

const server = http.createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
  response.end('simple-mind-map collab server ok')
})

const wss = new WebSocket.Server({ noServer: true })

wss.on('connection', (conn, req) => {
  setupWSConnection(conn, req, { gc: true })
})

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, ws => {
    wss.emit('connection', ws, request)
  })
})

server.listen(port, host, () => {
  console.log(`Collab server running at ws://${host}:${port}`)
  console.log('Open the mind map, click 协同, and join the same room.')
})
