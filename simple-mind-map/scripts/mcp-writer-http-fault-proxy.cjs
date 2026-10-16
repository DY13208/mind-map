'use strict'

// Isolated test-only HTTP fault proxy for mcp-writer-http.cjs. It is mounted
// into a run-owned container and only injects faults for an explicitly armed
// operation_id. It has no dependency on application or database code.
const http = require('http')

const target = new URL(process.env.TARGET_API || 'http://mcp-http-api:1234')
const port = Number(process.env.PORT || 1235)
let arm = null
const attempts = []
const heldRequests = new Set()

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function forward(req, res, body, row, dropAck = false) {
  const headers = { ...req.headers, host: target.host }
  delete headers.connection
  const upstream = http.request({
    hostname: target.hostname,
    port: Number(target.port || 80),
    path: req.url,
    method: req.method,
    headers
  }, upstreamRes => {
    const chunks = []
    upstreamRes.on('data', chunk => chunks.push(chunk))
    upstreamRes.on('end', () => {
      const payload = Buffer.concat(chunks)
      row.backend = {
        statusCode: upstreamRes.statusCode,
        body: payload.toString('utf8')
      }
      if (dropAck) {
        row.responseDroppedAfterCommit = true
        res.destroy()
        return
      }
      const responseHeaders = { ...upstreamRes.headers }
      delete responseHeaders.connection
      delete responseHeaders['transfer-encoding']
      delete responseHeaders['content-length']
      res.writeHead(upstreamRes.statusCode || 502, responseHeaders)
      res.end(payload)
    })
  })
  upstream.on('error', error => {
    row.proxyError = error.message
    if (!res.destroyed) sendJson(res, 502, { code: 'TEST_PROXY_UPSTREAM_ERROR', error: error.message })
  })
  upstream.end(body)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://proxy.local')
  if (url.pathname === '/__control/state' && req.method === 'GET') {
    sendJson(res, 200, { arm: arm && { operationId: arm.operationId, mode: arm.mode }, attempts })
    return
  }
  if (url.pathname === '/__control/arm' && req.method === 'POST') {
    const raw = await readBody(req)
    let input = {}
    try { input = JSON.parse(raw.toString('utf8') || '{}') } catch (_) {}
    if (!input.operationId || !['precommit_then_hold_retry', 'commit_then_drop_ack'].includes(input.mode)) {
      sendJson(res, 400, { code: 'TEST_PROXY_BAD_ARM' })
      return
    }
    arm = { operationId: String(input.operationId), mode: input.mode, released: false }
    for (const resolve of heldRequests) resolve()
    heldRequests.clear()
    sendJson(res, 200, { ok: true, operationId: arm.operationId, mode: arm.mode })
    return
  }
  if (url.pathname === '/__control/release' && req.method === 'POST') {
    if (!arm) {
      sendJson(res, 409, { code: 'TEST_PROXY_NOT_ARMED' })
      return
    }
    arm.released = true
    for (const resolve of heldRequests) resolve()
    heldRequests.clear()
    sendJson(res, 200, { ok: true })
    return
  }
  if (url.pathname === '/__control/reset' && req.method === 'POST') {
    arm = null
    attempts.splice(0, attempts.length)
    for (const resolve of heldRequests) resolve()
    heldRequests.clear()
    sendJson(res, 200, { ok: true })
    return
  }

  let body
  try { body = await readBody(req) } catch (error) {
    sendJson(res, 400, { code: 'TEST_PROXY_READ_FAILED', error: error.message })
    return
  }
  let requestBody = null
  try { requestBody = body.length ? JSON.parse(body.toString('utf8')) : null } catch (_) {}
  const operationId = String(
    requestBody && (requestBody.operation_id || requestBody.operationId) ||
    req.headers['x-operation-id'] || ''
  )
  const row = {
    operationId,
    operationHeaderId: String(req.headers['x-operation-id'] || ''),
    method: req.method,
    path: req.url,
    requestText: body.toString('utf8'),
    requestBody,
    at: new Date().toISOString()
  }
  const matching = arm && operationId === arm.operationId
  if (matching) {
    row.attempt = attempts.filter(item => item.operationId === operationId).length + 1
  }
  attempts.push(row)

  if (!matching) {
    forward(req, res, body, row)
    return
  }

  if (arm.mode === 'precommit_then_hold_retry' && row.attempt === 1) {
    row.requestNotForwarded = true
    res.destroy()
    return
  }
  if (arm.mode === 'precommit_then_hold_retry' && row.attempt === 2 && !arm.released) {
    row.retryHeldUntilRestore = true
    await new Promise(resolve => heldRequests.add(resolve))
    forward(req, res, body, row)
    return
  }
  if (arm.mode === 'commit_then_drop_ack' && row.attempt === 1) {
    forward(req, res, body, row, true)
    return
  }
  forward(req, res, body, row)
})

server.listen(port, '0.0.0.0', () => {
  process.stdout.write(`mcp-writer test fault proxy listening on ${port}; target=${target.href}\n`)
})
