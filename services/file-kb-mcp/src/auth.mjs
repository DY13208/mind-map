import crypto from 'node:crypto'

const SESSION_COOKIE = 'mind_map_session'

const SESSION_SQL = `select s.user_id, s.expires_at, s.absolute_expires_at, u.corp_id, u.name
  from public.auth_sessions s
  join public.wecom_users u on u.user_id = s.user_id
  where s.token_hash = $1
    and s.expires_at > now()
    and s.absolute_expires_at > now()`

// Same lookup as services/file-kb/src/auth.js TOKEN_SQL: the owner must still exist in wecom_users.
export const TOKEN_SQL = `select t.user_id, t.scopes, t.scope_folder_ids, t.expires_at, t.revoked_at,
       u.user_id as live_user_id, u.corp_id, u.name
  from kb.mcp_tokens t
  left join public.wecom_users u on u.user_id = t.user_id
  where t.token_hash = $1`

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function parseCookies(header) {
  const out = {}
  String(header || '').split(';').forEach(part => {
    const index = part.indexOf('=')
    if (index < 1) return
    const key = part.slice(0, index).trim()
    if (Object.prototype.hasOwnProperty.call(out, key)) return
    out[key] = decodeURIComponent(part.slice(index + 1).trim())
  })
  return out
}

export class AuthError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

// No cache. Logout deletes the session row and the next MCP call sees it.
export function createSessionAuth(queryable) {
  const query = typeof queryable === 'function' ? queryable : (text, params) => queryable.query(text, params)
  return {
    async authenticate(req) {
      const bearer = /^Bearer\s+([A-Fa-f0-9]{32,128})$/.exec(String(req && req.headers && req.headers.authorization || ''))
      if (bearer) {
        let tokenRows
        const tokenHash = sha256(bearer[1])
        try {
          const result = await query(TOKEN_SQL, [tokenHash])
          tokenRows = result.rows || []
        } catch (err) {
          const wrapped = new AuthError(503, 'auth_unavailable', 'auth backend unavailable')
          wrapped.cause = err
          throw wrapped
        }
        const tokenRow = tokenRows[0]
        if (!tokenRow || tokenRow.revoked_at) throw new AuthError(401, 'unauthorized', 'token revoked')
        if (tokenRow.expires_at && new Date(tokenRow.expires_at).getTime() <= Date.now()) {
          throw new AuthError(401, 'unauthorized', 'token expired')
        }
        if (!tokenRow.live_user_id) throw new AuthError(401, 'token_user_inactive', 'token owner is no longer an active user')
        const allowed = ['kb:read', 'kb:write', 'kb:admin', 'geekcloud:read']
        const scopes = (tokenRow.scopes || []).filter(s => allowed.includes(s))
        if (!scopes.includes('kb:read')) throw new AuthError(403, 'forbidden', 'token cannot read')
        try {
          await query('update kb.mcp_tokens set last_used_at = now() where token_hash = $1 and revoked_at is null', [tokenHash])
        } catch (_) { /* last-used is informational */ }
        // File mutations stay unavailable. kb:read also permits short-lived
        // original-file download links; write/admin scopes are dropped.
        return {
          id: String(tokenRow.user_id),
          corpId: tokenRow.corp_id || '',
          name: tokenRow.name || String(tokenRow.user_id),
          via: 'token',
          tokenHash,
          tokenExpiresAt: tokenRow.expires_at || null,
          scopes: scopes.filter(s => s === 'kb:read' || s === 'geekcloud:read'),
          scopeFolderIds: tokenRow.scope_folder_ids || null
        }
      }
      const token = parseCookies(req && req.headers && req.headers.cookie)[SESSION_COOKIE]
      if (!token || token.length > 256) throw new AuthError(401, 'unauthorized', 'login required')
      let rows
      try {
        const result = await query(SESSION_SQL, [sha256(token)])
        rows = result.rows || []
      } catch (err) {
        const wrapped = new AuthError(503, 'auth_unavailable', 'auth backend unavailable')
        wrapped.cause = err
        throw wrapped
      }
      const row = rows[0]
      if (!row) throw new AuthError(401, 'unauthorized', 'session invalid, expired or revoked')
      const exp = Math.min(new Date(row.expires_at).getTime(), new Date(row.absolute_expires_at).getTime())
      if (!Number.isFinite(exp) || exp <= Date.now()) throw new AuthError(401, 'unauthorized', 'session expired')
      return { id: String(row.user_id), corpId: row.corp_id || '', name: row.name || String(row.user_id), via: 'session' }
    }
  }
}
