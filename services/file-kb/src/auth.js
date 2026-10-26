'use strict'
// File KB authentication.
// Source of truth: the mind-map app's own session table (simple-mind-map/bin/auth.js):
//   cookie mind_map_session -> sha256(token) = auth_sessions.token_hash
//   valid while expires_at > now() AND absolute_expires_at > now()
//   logout = DELETE FROM auth_sessions WHERE token_hash = ...
// kb_app only has column-level SELECT on those tables (scripts/file-kb/bootstrap.sql).
// We never trust identity headers sent by the client (X-User-Id etc.).
const crypto = require('crypto')

const SESSION_COOKIE = 'mind_map_session'
const MAX_TOKEN_LENGTH = 256

const SESSION_SQL = `select s.user_id, s.expires_at, s.absolute_expires_at, u.corp_id, u.name
  from public.auth_sessions s
  join public.wecom_users u on u.user_id = s.user_id
  where s.token_hash = $1
    and s.expires_at > now()
    and s.absolute_expires_at > now()`

// MCP token lookup. The left join tells "token owner no longer in wecom_users" apart from "no token".
// kb_app can read wecom_users(user_id, corp_id, name) per scripts/file-kb/bootstrap.sql.
const TOKEN_SQL = `select t.user_id, t.scopes, t.scope_folder_ids, t.expires_at, t.revoked_at,
       u.user_id as live_user_id, u.corp_id, u.name
  from kb.mcp_tokens t
  left join public.wecom_users u on u.user_id = t.user_id
  where t.token_hash = $1`

const TOKEN_SCOPES = ['kb:read', 'kb:write', 'kb:admin', 'geekcloud:read']

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function parseCookies(header) {
  const out = {}
  String(header || '').split(';').forEach(part => {
    const i = part.indexOf('=')
    if (i < 1) return
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (Object.prototype.hasOwnProperty.call(out, k)) return // first wins, like app
    try { out[k] = decodeURIComponent(v) } catch (_) { out[k] = v }
  })
  return out
}

class AuthError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

function createAuthenticator({ query, ttlMs = 0, maxEntries = 5000, superAdminIds = [], now = () => Date.now() }) {
  if (typeof query !== 'function') throw new Error('query function required')
  const ttl = Math.max(0, Math.min(Number(ttlMs) || 0, 30000)) // hard cap 30s
  const cache = new Map() // tokenHash -> { user, until }
  const admins = new Set(superAdminIds)

  function invalidate(tokenHash) {
    if (tokenHash) cache.delete(tokenHash)
    else cache.clear()
  }

  async function authenticate(req, options = {}) {
    const bearer = /^Bearer\s+([A-Fa-f0-9]{32,128})$/.exec(String(req && req.headers && req.headers.authorization || ''))
    if (bearer) return authenticateToken(bearer[1])
    const token = parseCookies(req && req.headers && req.headers.cookie)[SESSION_COOKIE]
    if (!token) throw new AuthError(401, 'unauthorized', 'login required')
    if (token.length > MAX_TOKEN_LENGTH) throw new AuthError(401, 'unauthorized', 'login required')
    const tokenHash = sha256(token)
    const t = now()
    const fresh = options.fresh || ttl <= 0
    if (!fresh) {
      const hit = cache.get(tokenHash)
      if (hit && hit.until > t) return hit.user
      if (hit) cache.delete(tokenHash)
    }

    let rows
    try {
      const result = await query(SESSION_SQL, [tokenHash])
      rows = result && result.rows ? result.rows : []
    } catch (err) {
      const e = new AuthError(503, 'auth_unavailable', 'auth backend unavailable')
      e.cause = err
      throw e
    }
    const row = rows[0]
    if (!row) throw new AuthError(401, 'unauthorized', 'session invalid, expired or revoked')
    // Defensive re-check in JS (clock source = DB in SQL; this guards stubs/caching).
    const exp = Math.min(new Date(row.expires_at).getTime(), new Date(row.absolute_expires_at).getTime())
    if (!Number.isFinite(exp) || exp <= t) throw new AuthError(401, 'unauthorized', 'session expired')
    const user = {
      id: String(row.user_id),
      corpId: row.corp_id || '',
      name: row.name || String(row.user_id),
      superAdmin: admins.has(String(row.user_id)),
      via: 'session'
    }
    if (!fresh && ttl > 0 && maxEntries > 0) {
      if (cache.size >= maxEntries) cache.delete(cache.keys().next().value)
      // never cache past the session's own expiry
      cache.set(tokenHash, { user, until: Math.min(t + ttl, exp) })
    }
    return user
  }

  async function authenticateToken(raw) {
    let rows
    try {
      const result = await query(TOKEN_SQL, [sha256(raw)])
      rows = result && result.rows ? result.rows : []
    } catch (err) {
      const e = new AuthError(503, 'auth_unavailable', 'auth backend unavailable')
      e.cause = err
      throw e
    }
    const row = rows[0]
    if (!row || row.revoked_at) throw new AuthError(401, 'unauthorized', 'token revoked')
    if (row.expires_at && new Date(row.expires_at).getTime() <= now()) throw new AuthError(401, 'unauthorized', 'token expired')
    if (!row.live_user_id) throw new AuthError(401, 'token_user_inactive', 'token owner is no longer an active user')
    const scopes = (row.scopes || []).filter(s => TOKEN_SCOPES.includes(s))
    if (!scopes.length) throw new AuthError(403, 'forbidden', 'token has no scope')
    return {
      id: String(row.user_id),
      corpId: row.corp_id || '',
      name: row.name || String(row.user_id),
      via: 'token',
      tokenHash: sha256(raw),
      tokenExpiresAt: row.expires_at || null,
      scopes,
      scopeFolderIds: row.scope_folder_ids || null
    }
  }

  return { authenticate, invalidate, cacheSize: () => cache.size }
}

module.exports = { createAuthenticator, AuthError, parseCookies, sha256, SESSION_COOKIE, SESSION_SQL, TOKEN_SQL, TOKEN_SCOPES }
