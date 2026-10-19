const http = require('http')
const { resolveUser } = require('../auth')
const { handleRpc } = require('./tools')

function createMcpServer(options) {
  const { pool, config } = options
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true, service: 'file-knowledge-mcp' }))
        return
      }
      if (req.method !== 'POST' || url.pathname !== '/mcp') {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: '没有这个接口' }))
        return
      }
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const raw = Buffer.concat(chunks).toString('utf8')
      const message = raw ? JSON.parse(raw) : {}
      let user = null
      if (message.method === 'tools/call') {
        user = await resolveUser(pool, req, config)
      }
      const result = await handleRpc(message, { pool, config, user })
      if (!result.body) {
        res.writeHead(result.status)
        res.end()
        return
      }
      const data = JSON.stringify(result.body)
      res.writeHead(result.status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(data)
      })
      res.end(data)
    } catch (err) {
      const status = err.statusCode || 500
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: status === 401 ? -32001 : -32603, message: err.message || '内部错误' }
      })
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(body)
    }
  })
}

module.exports = { createMcpServer }
