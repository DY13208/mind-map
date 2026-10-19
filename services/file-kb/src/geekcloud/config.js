'use strict'
// JackYun (吉客云) MCP data source. Credentials only come from server env; never from the client or DB.
const crypto = require('crypto')
const { CATALOG } = require('./catalog')

const flag = v => /^(1|true|yes|on)$/i.test(String(v ?? '').trim())

function int(env, name, fallback, min, max, errors) {
  const raw = env[name]
  const value = raw == null || raw === '' ? fallback : Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    errors.push(`${name} must be an integer in [${min}, ${max}]`)
    return fallback
  }
  return value
}

const list = v => String(v || '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean)

// Owner (货主) names as JackYun returns them in ownerName. Plain text, no control or markup characters.
const OWNER = /^[^\u0000-\u001f\u007f<>]{1,64}$/

// {"userId":["value"]} maps from env. Bad shape reports an error and loads nothing (deny by default).
function userScope(env, name, valid, errors) {
  if (!env[name]) return {}
  const out = {}
  try {
    const parsed = JSON.parse(env[name])
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape')
    for (const [userId, values] of Object.entries(parsed)) {
      if (!Array.isArray(values) || values.some(v => typeof v !== 'string' || !valid.test(v))) throw new Error('shape')
      out[userId] = [...new Set(values)]
    }
  } catch (_) {
    errors.push(`${name} must be JSON {"userId":["value"]}`)
    return {}
  }
  return out
}

// Misconfiguration never throws: File KB keeps serving and status reports the problem.
function loadGeekcloudConfig(env = process.env) {
  const errors = []
  const enabled = flag(env.FILE_KB_GEEKCLOUD_ENABLED)
  const url = String(env.FILE_KB_GEEKCLOUD_MCP_URL || '').trim()
  const token = String(env.FILE_KB_GEEKCLOUD_MCP_TOKEN || '').trim()
  let endpoint = null
  if (url) {
    try {
      endpoint = new URL(url)
      if (endpoint.protocol !== 'https:') errors.push('FILE_KB_GEEKCLOUD_MCP_URL must use https')
      if (endpoint.username || endpoint.password || endpoint.search) errors.push('FILE_KB_GEEKCLOUD_MCP_URL must not carry credentials or query')
    } catch (_) { errors.push('FILE_KB_GEEKCLOUD_MCP_URL is not a valid URL') }
  }
  if (token && !/^[\x21-\x7e]{8,256}$/.test(token)) errors.push('FILE_KB_GEEKCLOUD_MCP_TOKEN has invalid characters')

  const askedTools = env.FILE_KB_GEEKCLOUD_ALLOWED_TOOLS == null || String(env.FILE_KB_GEEKCLOUD_ALLOWED_TOOLS).trim() === ''
    ? Object.keys(CATALOG)
    : list(env.FILE_KB_GEEKCLOUD_ALLOWED_TOOLS)
  const unknown = askedTools.filter(name => !Object.prototype.hasOwnProperty.call(CATALOG, name))
  if (unknown.length) errors.push(`FILE_KB_GEEKCLOUD_ALLOWED_TOOLS has unsupported tools: ${unknown.join(',')}`)
  const allowedTools = askedTools.filter(name => Object.prototype.hasOwnProperty.call(CATALOG, name))

  const allowedUsers = list(env.FILE_KB_GEEKCLOUD_ALLOWED_USERS)
  let warehouseScope = {}
  if (env.FILE_KB_GEEKCLOUD_WAREHOUSE_SCOPE) {
    try {
      const parsed = JSON.parse(env.FILE_KB_GEEKCLOUD_WAREHOUSE_SCOPE)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape')
      for (const [userId, codes] of Object.entries(parsed)) {
        if (!Array.isArray(codes) || codes.some(c => typeof c !== 'string' || !/^[\w.-]{1,64}$/.test(c))) throw new Error('shape')
        warehouseScope[userId] = [...new Set(codes)]
      }
    } catch (_) {
      errors.push('FILE_KB_GEEKCLOUD_WAREHOUSE_SCOPE must be JSON {"userId":["WAREHOUSE_CODE"]}')
      warehouseScope = {}
    }
  }
  // Goods, stock and price are only shown for SKUs whose ownerName is in the caller's owner scope.
  const ownerScope = userScope(env, 'FILE_KB_GEEKCLOUD_OWNER_SCOPE', OWNER, errors)
  // Prices are a separate grant on top of the owner scope.
  const priceUsers = list(env.FILE_KB_GEEKCLOUD_PRICE_USERS)

  const config = {
    enabled,
    endpoint: endpoint && !errors.some(e => e.startsWith('FILE_KB_GEEKCLOUD_MCP_URL')) ? endpoint.href : null,
    token,
    timeoutMs: int(env, 'FILE_KB_GEEKCLOUD_TIMEOUT_MS', 8000, 1000, 30000, errors),
    maxConcurrency: int(env, 'FILE_KB_GEEKCLOUD_MAX_CONCURRENCY', 2, 1, 8, errors),
    perUserPerMinute: int(env, 'FILE_KB_GEEKCLOUD_RATE_PER_MINUTE', 60, 1, 600, errors),
    breakerThreshold: int(env, 'FILE_KB_GEEKCLOUD_BREAKER_THRESHOLD', 3, 1, 50, errors),
    breakerOpenMs: int(env, 'FILE_KB_GEEKCLOUD_BREAKER_OPEN_MS', 60000, 1000, 3600000, errors),
    allowedTools,
    allowedUsers,
    warehouseScope,
    ownerScope,
    priceUsers,
    errors
  }
  config.configured = !!(config.endpoint && token && !errors.length)
  return config
}

// Fingerprint lets an operator confirm which key is loaded without revealing any of its characters.
function tokenFingerprint(token) {
  if (!token) return null
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 8)
}

module.exports = { loadGeekcloudConfig, tokenFingerprint }
