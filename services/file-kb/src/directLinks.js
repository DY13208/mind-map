'use strict'
const crypto = require('crypto')
const { httpError } = require('./errors')

const PUBLIC_FILE = /^\/api\/kb\/public\/files\/([a-f0-9]{64})\/[^/]+$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const hash = token => crypto.createHash('sha256').update(token).digest('hex')
const view = row => ({ id: row.id, createdAt: row.created_at, expiresAt: row.expires_at, revokedAt: row.revoked_at })

function createDirectLinks(pool) {
  async function issue(user, file, expiresAt, sourceTokenHash = null) {
    const token = crypto.randomBytes(32).toString('hex')
    const result = await pool.query(
      `insert into kb.direct_links (file_id, created_by, token_hash, expires_at, scope_folder_ids, source_token_hash)
       values ($1, $2, $3, $4, $5, $6) returning id, created_at, expires_at, revoked_at`,
      [file.id, user.id, hash(token), expiresAt, user.scopeFolderIds || null, sourceTokenHash])
    return { ...view(result.rows[0]), url: `/api/kb/public/files/${token}/${encodeURIComponent(file.name)}` }
  }
  return {
    async create(user, file, body) {
      const days = body.expiresInDays === undefined ? 7 : body.expiresInDays
      if (!Number.isInteger(days) || days < 0 || days > 365) throw httpError(400, 'invalid_link_expiry')
      const expiresAt = days === 0 ? null : new Date(Date.now() + days * 86400000)
      return issue(user, file, expiresAt)
    },
    async createDownload(user, file) {
      let until = Date.now() + 15 * 60 * 1000
      if (user.via === 'token') {
        if (!/^[a-f0-9]{64}$/.test(user.tokenHash || '')) throw httpError(401, 'unauthorized')
        if (user.tokenExpiresAt) {
          const exp = new Date(user.tokenExpiresAt).getTime()
          if (!Number.isFinite(exp) || exp <= Date.now()) throw httpError(401, 'unauthorized')
          until = Math.min(until, exp)
        }
      }
      return issue(user, file, new Date(until), user.via === 'token' ? user.tokenHash : null)
    },
    async list(user, fileId) {
      const result = await pool.query(
        `select id, created_at, expires_at, revoked_at from kb.direct_links
         where file_id = $1 and created_by = $2 order by created_at desc`, [fileId, user.id])
      return { items: result.rows.map(view) }
    },
    async revoke(user, fileId, id) {
      if (!UUID.test(id)) throw httpError(404, 'missing')
      const result = await pool.query(
        `update kb.direct_links set revoked_at = coalesce(revoked_at, now())
         where id = $1 and file_id = $2 and created_by = $3 returning id`, [id, fileId, user.id])
      if (!result.rows[0]) throw httpError(404, 'missing')
      return { id, revoked: true }
    },
    async resolve(token) {
      const result = await pool.query(
        `select file_id, created_by, scope_folder_ids from kb.direct_links l
         where token_hash = $1 and revoked_at is null and (expires_at is null or expires_at > now())
           and (source_token_hash is null or exists (
             select 1 from kb.mcp_tokens t join public.wecom_users u on u.user_id = t.user_id
             where t.token_hash = l.source_token_hash and t.user_id = l.created_by
               and t.revoked_at is null and (t.expires_at is null or t.expires_at > now())
               and 'kb:read' = any(t.scopes)))`, [hash(token)])
      const row = result.rows[0]
      if (!row) throw httpError(404, 'missing')
      return { fileId: row.file_id, user: { id: row.created_by, ...(row.scope_folder_ids ? { scopeFolderIds: row.scope_folder_ids } : {}) } }
    }
  }
}

module.exports = { createDirectLinks, PUBLIC_FILE }
