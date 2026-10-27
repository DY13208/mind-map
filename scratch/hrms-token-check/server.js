/**
 * 临时换票试验台。只监听本机，不接入脑图。测完删除整个 scratch/hrms-token-check 目录。
 */
const http = require('http')
const https = require('https')
const fs = require('fs')
const path = require('path')

const PORT = Number(process.env.HRMS_CHECK_PORT || 8791)
const ROOT = __dirname
const ISSUE_PATH = '/api/method/employee_roster.integrations.external_api.issue_token'
const FILES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/call.html': 'call.html',
  '/style.css': 'style.css'
}

function send(res, status, payload, type) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

function readBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function parseBase(raw) {
  const url = new URL(String(raw || '').trim())
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw Object.assign(new Error('地址只接受 http 或 https'), { statusCode: 400 })
  }
  if (url.username || url.password || url.search || url.hash) {
    throw Object.assign(new Error('地址不能带账号、查询参数或锚点'), { statusCode: 400 })
  }
  return url.origin
}

function frappeDetail(payload) {
  if (!payload || typeof payload !== 'object') return ''
  if (payload._server_messages) {
    try {
      const list = JSON.parse(payload._server_messages)
      const first = JSON.parse(list[0] || '{}')
      if (first.message) return String(first.message)
    } catch (err) {
      /* 保留原始响应 */
    }
  }
  if (typeof payload.message === 'string') return payload.message
  if (payload.exception) return String(payload.exception).split('\n').pop()
  if (payload.exc_type) return String(payload.exc_type)
  return ''
}

function requestUpstream(target, { method, headers, body }) {
  const lib = target.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method,
        headers,
        timeout: 15000
      },
      res => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let payload = null
          try {
            payload = text ? JSON.parse(text) : null
          } catch (err) {
            payload = null
          }
          resolve({ status: res.statusCode, text, payload })
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('连接人事系统超时')))
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

function issuedFrom(payload) {
  const data =
    payload && payload.access_token
      ? payload
      : payload && payload.message && typeof payload.message === 'object'
        ? payload.message
        : null
  if (!data || !String(data.access_token || '').startsWith('hrms_ext_')) return null
  return {
    access_token: data.access_token,
    token_type: data.token_type || 'Bearer',
    expires_at: data.expires_at ?? null,
    scope: data.scope || 'user',
    user: data.user || '',
    token_id: data.token_id || ''
  }
}

async function exchange(input) {
  const base = parseBase(input.base)
  const key = String(input.exchangeKey || '').trim()
  const sid = String(input.sid || '').trim()
  const clientName = String(input.clientName || '').trim()
  if (key.length < 32 || key.length > 512) {
    throw Object.assign(new Error('交换密钥需要 32–512 个字符'), { statusCode: 400 })
  }
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(sid)) {
    throw Object.assign(new Error('sid 格式不像人事系统的登录会话'), { statusCode: 400 })
  }
  if (!clientName || clientName.length > 140) {
    throw Object.assign(new Error('client_name 需要 1–140 个字符'), { statusCode: 400 })
  }
  const body = new URLSearchParams({ client_name: clientName }).toString()
  const upstream = await requestUpstream(new URL(ISSUE_PATH, base), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
      'X-API-Exchange-Key': key,
      Cookie: `sid=${sid}`
    },
    body
  })
  const token = issuedFrom(upstream.payload)
  const detail = frappeDetail(upstream.payload)
  return {
    ok: Boolean(token) && upstream.status >= 200 && upstream.status < 300,
    status: upstream.status,
    detail,
    token,
    raw: token ? undefined : String(upstream.text || '').slice(0, 2000)
  }
}

async function callApi(input) {
  const base = parseBase(input.base)
  const apiPath = String(input.path || '').split('?')[0]
  if (!apiPath.startsWith('/api/') || apiPath.includes('..') || /[\s\u0000]/.test(apiPath)) {
    throw Object.assign(new Error('只允许调用 /api/ 开头的路径'), { statusCode: 400 })
  }
  const method = String(input.method || 'GET').toUpperCase()
  if (!['GET', 'POST'].includes(method)) {
    throw Object.assign(new Error('试验台只发送 GET 或 POST'), { statusCode: 400 })
  }
  const headers = { Accept: 'application/json' }
  const token = String(input.token || '').trim()
  if (token) {
    if (!token.startsWith('hrms_ext_')) {
      throw Object.assign(new Error('令牌需要以 hrms_ext_ 开头'), { statusCode: 400 })
    }
    headers.Authorization = `Bearer ${token}`
  }
  let body
  if (method === 'POST' && input.json && typeof input.json === 'object') {
    body = JSON.stringify(input.json)
    headers['Content-Type'] = 'application/json'
    headers['Content-Length'] = Buffer.byteLength(body)
  }
  const upstream = await requestUpstream(new URL(apiPath, base), { method, headers, body })
  return {
    ok: upstream.status >= 200 && upstream.status < 300 && !upstream.payload?.exc_type,
    status: upstream.status,
    detail: frappeDetail(upstream.payload),
    data: upstream.payload,
    raw: upstream.payload ? undefined : String(upstream.text || '').slice(0, 2000)
  }
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (req.method === 'GET' && FILES[url.pathname]) {
    const file = path.join(ROOT, FILES[url.pathname])
    const type = file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8'
    send(res, 200, fs.readFileSync(file), type)
    return
  }
  if (req.method !== 'POST' || (url.pathname !== '/exchange' && url.pathname !== '/call')) {
    send(res, 404, { error: '没有这个试验接口' })
    return
  }
  try {
    const input = JSON.parse((await readBody(req)) || '{}')
    const result = url.pathname === '/exchange' ? await exchange(input) : await callApi(input)
    send(res, 200, result)
  } catch (err) {
    send(res, err.statusCode || 502, { ok: false, error: err.message || '请求失败' })
  }
}

http.createServer((req, res) => {
  handle(req, res).catch(err => {
    if (!res.headersSent) send(res, 500, { ok: false, error: '试验台内部错误' })
  })
}).listen(PORT, '127.0.0.1', () => {
  console.log(`hrms token check http://127.0.0.1:${PORT}`)
})
