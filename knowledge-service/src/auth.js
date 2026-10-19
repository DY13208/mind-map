const crypto = require('crypto')

function httpError(status, code, message) {
  const err = new Error(message)
  err.statusCode = status
  err.code = code
  return err
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function parseCookies(header) {
  const cookies = {}
  String(header || '')
    .split(';')
    .forEach(part => {
      const index = part.indexOf('=')
      if (index < 1) return
      const key = part.slice(0, index).trim()
      const value = part.slice(index + 1).trim()
      try {
        cookies[key] = decodeURIComponent(value)
      } catch (err) {
        cookies[key] = value
      }
    })
  return cookies
}

function bearer(header) {
  const match = String(header || '').match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : ''
}

async function resolveUser(pool, req, config) {
  if (config.devUserHeader) {
    const devUser = String((req.headers && req.headers['x-knowledge-dev-user']) || '').trim()
    if (devUser) {
      return {
        id: devUser.slice(0, 160),
        orgId: String((req.headers && req.headers['x-knowledge-dev-org']) || '').slice(0, 160),
        name: devUser.slice(0, 160),
        via: 'dev'
      }
    }
  }
  const token = bearer(req.headers && req.headers.authorization)
  if (token.startsWith('klib_')) {
    const found = await pool.query(
      `select user_id, org_id, scope_folder_ids
       from knowledge.api_tokens
       where token_hash = $1
         and revoked_at is null
         and (expires_at is null or expires_at > now())`,
      [sha256(token)]
    )
    if (!found.rows[0]) throw httpError(401, 'UNAUTHORIZED', '知识库令牌无效')
    return {
      id: found.rows[0].user_id,
      orgId: found.rows[0].org_id || '',
      name: found.rows[0].user_id,
      via: 'token',
      scopeFolderIds: found.rows[0].scope_folder_ids
    }
  }
  const session = parseCookies(req.headers && req.headers.cookie).mind_map_session
  if (session && session.length <= 256) {
    try {
      const found = await pool.query(
        `select u.user_id, u.corp_id, u.name
         from auth_sessions s
         join wecom_users u on u.user_id = s.user_id
         where s.token_hash = $1
           and s.expires_at > now()
           and s.absolute_expires_at > now()`,
        [sha256(session)]
      )
      if (found.rows[0]) {
        return {
          id: found.rows[0].user_id,
          orgId: found.rows[0].corp_id || '',
          name: found.rows[0].name || found.rows[0].user_id,
          via: 'session'
        }
      }
    } catch (err) {
      if (err.code !== '42P01') throw err
    }
  }
  throw httpError(401, 'UNAUTHORIZED', '需要知识库令牌或本机已登录会话')
}

module.exports = { resolveUser, sha256, httpError, parseCookies, bearer }
