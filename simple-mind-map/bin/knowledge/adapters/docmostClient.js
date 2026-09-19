/**
 * Docmost HTTP client for machine sync (JWT as workspace owner).
 */
const crypto = require('crypto')
const { Pool } = require('pg')

const EMAIL_DOMAIN = 'users.mind-map.local'
const JWT_TTL_SEC = 12 * 60 * 60

let pool = null
let cachedAuth = null

function cfg(env = process.env) {
  return {
    baseUrl: String(env.DOCMOST_INTERNAL_URL || 'http://docmost:3000').replace(
      /\/$/,
      ''
    ),
    databaseUrl: String(env.DOCMOST_DATABASE_URL || env.DATABASE_URL || '').trim(),
    appSecret: String(env.DOCMOST_APP_SECRET || env.APP_SECRET || '').trim(),
    enabled: /^(true|1|yes|on)$/i.test(
      String(env.DOCMOST_SYNC_ENABLED || 'false')
    )
  }
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function base64Url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

function sanitizeLocalPart(raw) {
  const cleaned = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._+-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return cleaned.slice(0, 64) || 'user'
}

function sanitizeSlug(raw, prefix) {
  const body = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
  const core = body || 'x'
  const slug = `${prefix}-${core}`.replace(/-+/g, '-').slice(0, 100)
  return /^[a-z0-9]/.test(slug) ? slug : `s-${slug}`
}

function emailForMindMapUser(userId) {
  return `${sanitizeLocalPart(userId)}@${EMAIL_DOMAIN}`
}

function signAccessToken({ userId, email, workspaceId, sessionId, appSecret }) {
  const header = { alg: 'HS256', typ: 'JWT' }
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    sub: userId,
    email,
    workspaceId,
    type: 'access',
    sessionId,
    iat: now,
    exp: now + JWT_TTL_SEC,
    iss: 'Docmost'
  }
  const data = `${base64UrlJson(header)}.${base64UrlJson(payload)}`
  const signature = crypto
    .createHmac('sha256', appSecret)
    .update(data, 'utf8')
    .digest()
  return `${data}.${base64Url(signature)}`
}

function getPool(env = process.env) {
  const { databaseUrl } = cfg(env)
  if (!databaseUrl) return null
  if (!pool) {
    pool = new Pool({
      connectionString: databaseUrl,
      max: 4,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 8000
    })
  }
  return pool
}

async function request(path, { method = 'POST', body, cookie, env } = {}) {
  const { baseUrl } = cfg(env)
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: body == null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000)
  })
  const text = await response.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch (_) {
    data = { raw: text }
  }
  if (!response.ok) {
    const err = new Error(
      (data && (data.message || data.error || (data.data && data.data.message))) ||
        `Docmost ${method} ${path} → ${response.status}`
    )
    err.status = response.status
    err.data = data
    throw err
  }
  // Docmost wraps many successful payloads as { data, success, status }
  if (
    data &&
    typeof data === 'object' &&
    Object.prototype.hasOwnProperty.call(data, 'data') &&
    (data.success === true || data.status === 200)
  ) {
    return data.data
  }
  return data
}

async function ensureSyncAuth(env = process.env) {
  const conf = cfg(env)
  if (!conf.databaseUrl || !conf.appSecret) {
    const err = new Error('Docmost sync 未配置 DATABASE_URL / APP_SECRET')
    err.code = 'DOCMOST_SYNC_UNCONFIGURED'
    throw err
  }
  const now = Date.now()
  if (cachedAuth && cachedAuth.expiresAt > now + 60000) return cachedAuth

  const db = getPool(env)
  const owner = (
    await db.query(
      `select id, email, workspace_id, name
         from users
        where role = 'owner' and deleted_at is null and deactivated_at is null
        order by created_at asc
        limit 1`
    )
  ).rows[0]
  if (!owner) {
    const err = new Error('Docmost 尚无 owner，请先完成 Wiki 建站')
    err.code = 'DOCMOST_NOT_SETUP'
    throw err
  }
  const session = (
    await db.query(
      `insert into user_sessions (user_id, workspace_id, device_name, expires_at)
       values ($1, $2, 'mind-map-sync', now() + interval '12 hours')
       returning id`,
      [owner.id, owner.workspace_id]
    )
  ).rows[0]
  const token = signAccessToken({
    userId: owner.id,
    email: owner.email,
    workspaceId: owner.workspace_id,
    sessionId: session.id,
    appSecret: conf.appSecret
  })
  cachedAuth = {
    cookie: `authToken=${token}`,
    workspaceId: owner.workspace_id,
    userId: owner.id,
    expiresAt: now + JWT_TTL_SEC * 1000
  }
  return cachedAuth
}

async function ensureUser(db, workspaceId, { userId, name }) {
  const email = emailForMindMapUser(userId)
  const externalId = `mind-map:${String(userId).trim()}`.slice(0, 200)
  const display = String(name || userId || 'MindMap User').trim().slice(0, 120)
  let user = (
    await db.query(
      `select id, email from users
        where workspace_id = $1
          and (lower(email) = $2 or scim_external_id = $3)
          and deleted_at is null
        limit 1`,
      [workspaceId, email, externalId]
    )
  ).rows[0]
  if (!user) {
    user = (
      await db.query(
        `insert into users (
           name, email, email_verified_at, role, workspace_id,
           locale, has_generated_password, scim_external_id, last_login_at
         ) values ($1, $2, now(), 'member', $3, 'zh-CN', true, $4, now())
         returning id, email`,
        [display, email, workspaceId, externalId]
      )
    ).rows[0]
    const everyone = (
      await db.query(
        `select id from groups
          where workspace_id = $1 and is_default = true and deleted_at is null
          limit 1`,
        [workspaceId]
      )
    ).rows[0]
    if (everyone) {
      await db.query(
        `insert into group_users (user_id, group_id)
         values ($1, $2)
         on conflict (group_id, user_id) do nothing`,
        [user.id, everyone.id]
      )
    }
  } else {
    await db.query(
      `update users
          set name = coalesce(nullif($2, ''), name),
              scim_external_id = coalesce(scim_external_id, $3),
              updated_at = now()
        where id = $1`,
      [user.id, display, externalId]
    )
  }
  return { id: user.id, email: user.email || email }
}

async function findSpaceBySlug(db, workspaceId, slug) {
  const row = (
    await db.query(
      `select id, name, slug from spaces
        where workspace_id = $1 and slug = $2 and deleted_at is null
        limit 1`,
      [workspaceId, slug]
    )
  ).rows[0]
  return row || null
}

async function findPageSlugId(db, pageId) {
  if (!db || !pageId) return null
  const row = (
    await db.query(
      `select slug_id from pages
        where id = $1 and deleted_at is null
        limit 1`,
      [pageId]
    )
  ).rows[0]
  return row && row.slug_id ? String(row.slug_id) : null
}

module.exports = {
  cfg,
  sanitizeSlug,
  emailForMindMapUser,
  getPool,
  request,
  ensureSyncAuth,
  ensureUser,
  findSpaceBySlug,
  findPageSlugId
}
