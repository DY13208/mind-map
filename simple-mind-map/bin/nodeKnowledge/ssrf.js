const dns = require('dns').promises
const net = require('net')

function isPrivateIp(ip) {
  const value = String(ip || '').trim().toLowerCase()
  if (!value) return true
  if (value === '::1' || value === '0.0.0.0') return true
  if (value.startsWith('127.') || value.startsWith('10.') || value.startsWith('169.254.')) {
    return true
  }
  if (/^192\.168\./.test(value)) return true
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(value)) return true
  if (value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80:')) {
    return true
  }
  return false
}

function assertSafeHttpUrl(raw) {
  let parsed
  try {
    parsed = new URL(String(raw || '').trim())
  } catch (e) {
    const err = new Error('无效的 URL')
    err.statusCode = 400
    err.code = 'INVALID_URL'
    throw err
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    const err = new Error('仅支持 http/https URL')
    err.statusCode = 400
    err.code = 'INVALID_URL_SCHEME'
    throw err
  }
  const host = parsed.hostname
  if (!host || host === 'localhost' || host.endsWith('.local')) {
    const err = new Error('禁止访问本地或内网地址')
    err.statusCode = 400
    err.code = 'SSRF_BLOCKED'
    throw err
  }
  if (net.isIP(host) && isPrivateIp(host)) {
    const err = new Error('禁止访问私网 IP')
    err.statusCode = 400
    err.code = 'SSRF_BLOCKED'
    throw err
  }
  return parsed
}

async function resolvePublicHost(hostname) {
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      const err = new Error('禁止访问私网 IP')
      err.statusCode = 400
      err.code = 'SSRF_BLOCKED'
      throw err
    }
    return [hostname]
  }
  const records = await dns.lookup(hostname, { all: true, verbatim: true })
  const ips = (records || []).map(item => item.address).filter(Boolean)
  if (!ips.length) {
    const err = new Error('无法解析主机名')
    err.statusCode = 400
    err.code = 'DNS_FAILED'
    throw err
  }
  for (const ip of ips) {
    if (isPrivateIp(ip)) {
      const err = new Error('禁止访问解析到私网的主机')
      err.statusCode = 400
      err.code = 'SSRF_BLOCKED'
      throw err
    }
  }
  return ips
}

async function fetchSafeUrl(url, options = {}) {
  const parsed = assertSafeHttpUrl(url)
  await resolvePublicHost(parsed.hostname)
  const maxBytes = Number(options.maxBytes || 5 * 1024 * 1024)
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || 15000))
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = setTimeout(() => {
    if (controller) controller.abort()
  }, timeoutMs)
  try {
    const res = await fetch(parsed.href, {
      method: 'GET',
      redirect: 'error',
      signal: controller ? controller.signal : undefined,
      headers: {
        'User-Agent': 'mind-map-node-knowledge/1.0',
        Accept: '*/*'
      }
    })
    if (!res.ok) {
      const err = new Error(`下载失败 HTTP ${res.status}`)
      err.statusCode = 400
      err.code = 'DOWNLOAD_FAILED'
      throw err
    }
    const mime = String(res.headers.get('content-type') || '')
      .split(';')[0]
      .trim()
      .toLowerCase()
    const len = Number(res.headers.get('content-length') || 0)
    if (len && len > maxBytes) {
      const err = new Error(`远端文件过大（>${maxBytes} 字节）`)
      err.statusCode = 413
      err.code = 'FILE_TOO_LARGE'
      throw err
    }
    const ab = await res.arrayBuffer()
    const buf = Buffer.from(ab)
    if (buf.length > maxBytes) {
      const err = new Error(`远端文件过大（>${maxBytes} 字节）`)
      err.statusCode = 413
      err.code = 'FILE_TOO_LARGE'
      throw err
    }
    return { buffer: buf, mimeType: mime, finalUrl: parsed.href }
  } finally {
    clearTimeout(timer)
  }
}

module.exports = {
  isPrivateIp,
  assertSafeHttpUrl,
  resolvePublicHost,
  fetchSafeUrl
}
