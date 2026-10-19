'use strict'
const http = require('http')

async function request(handler, { method = 'GET', path = '/', headers = {}, body } = {}) {
  const server = http.createServer((req, res) => { handler(req, res) })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  const sent = { ...headers }
  if (sent.origin === '@self') sent.origin = `http://127.0.0.1:${port}`
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: sent, body })
    const text = await res.text()
    let parsed = null
    try { parsed = JSON.parse(text) } catch (_) { parsed = text }
    return { status: res.status, body: parsed }
  } finally {
    await new Promise(r => server.close(r))
  }
}

module.exports = { request }
