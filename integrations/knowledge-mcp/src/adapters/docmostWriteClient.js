'use strict';
const crypto = require('crypto');
const { Pool } = require('pg');

const JWT_TTL_SEC = 12 * 60 * 60;
let pool = null;
let cachedAuth = null;

function cfg(env = process.env) {
  return {
    baseUrl: String(env.DOCMOST_INTERNAL_URL || 'http://docmost:3000').replace(/\/$/, ''),
    databaseUrl: String(env.DOCMOST_DATABASE_URL || '').trim(),
    appSecret: String(env.DOCMOST_APP_SECRET || env.APP_SECRET || '').trim(),
  };
}

function b64urlJson(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function signAccessToken({ userId, email, workspaceId, sessionId, appSecret }) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: userId,
    email,
    workspaceId,
    type: 'access',
    sessionId,
    iat: now,
    exp: now + JWT_TTL_SEC,
    iss: 'Docmost',
  };
  const data = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const sig = crypto.createHmac('sha256', appSecret).update(data, 'utf8').digest();
  return `${data}.${b64url(sig)}`;
}

function getDocmostPool(env = process.env) {
  const { databaseUrl } = cfg(env);
  if (!databaseUrl) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: databaseUrl,
      max: 4,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 8000,
    });
  }
  return pool;
}

async function api(path, { method = 'POST', body, cookie, env } = {}) {
  const { baseUrl } = cfg(env);
  const res = await fetch(new URL(path, baseUrl), {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body == null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(
      (data && (data.message || data.error || (data.data && data.data.message))) ||
        `Docmost ${method} ${path} → ${res.status}`,
    );
    err.status = res.status;
    err.data = data;
    err.code = 'docmost_http_error';
    throw err;
  }
  if (
    data &&
    typeof data === 'object' &&
    Object.prototype.hasOwnProperty.call(data, 'data') &&
    (data.success === true || data.status === 200)
  ) {
    return data.data;
  }
  return data;
}

async function ensureSyncAuth(env = process.env) {
  const conf = cfg(env);
  if (!conf.databaseUrl || !conf.appSecret) {
    const err = new Error('docmost_sync_unconfigured');
    err.code = 'docmost_sync_unconfigured';
    throw err;
  }
  const now = Date.now();
  if (cachedAuth && cachedAuth.expiresAt > now + 60000) return cachedAuth;

  const db = getDocmostPool(env);
  const owner = (
    await db.query(
      `select id, email, workspace_id, name
         from users
        where role = 'owner' and deleted_at is null and deactivated_at is null
        order by created_at asc
        limit 1`,
    )
  ).rows[0];
  if (!owner) {
    const err = new Error('docmost_not_setup');
    err.code = 'docmost_not_setup';
    throw err;
  }
  const session = (
    await db.query(
      `insert into user_sessions (user_id, workspace_id, device_name, expires_at)
       values ($1, $2, 'knowledge-mcp-ai-write', now() + interval '12 hours')
       returning id`,
      [owner.id, owner.workspace_id],
    )
  ).rows[0];
  const token = signAccessToken({
    userId: owner.id,
    email: owner.email,
    workspaceId: owner.workspace_id,
    sessionId: session.id,
    appSecret: conf.appSecret,
  });
  cachedAuth = {
    cookie: `authToken=${token}`,
    workspaceId: owner.workspace_id,
    userId: owner.id,
    expiresAt: now + JWT_TTL_SEC * 1000,
  };
  return cachedAuth;
}

async function createPage({ spaceId, title, markdown, parentPageId, env }) {
  const auth = await ensureSyncAuth(env);
  const created = await api('/api/pages/create', {
    cookie: auth.cookie,
    body: {
      spaceId,
      title,
      parentPageId: parentPageId || undefined,
      content: markdown,
      format: 'markdown',
    },
    env,
  });
  return created && (created.id || created.pageId);
}

async function updatePage({ pageId, title, markdown, env }) {
  const auth = await ensureSyncAuth(env);
  await api('/api/pages/update', {
    cookie: auth.cookie,
    body: {
      pageId,
      title,
      content: markdown,
      format: 'markdown',
      operation: 'replace',
    },
    env,
  });
  return pageId;
}

async function readPageText(pageId, env = process.env) {
  const db = getDocmostPool(env);
  if (!db) return null;
  const { rows } = await db.query(
    `select id::text as id, title, text_content, content, updated_at
       from pages where id::text = $1 and deleted_at is null limit 1`,
    [String(pageId)],
  );
  if (!rows[0]) return null;
  const text =
    rows[0].text_content ||
    (typeof rows[0].content === 'string'
      ? rows[0].content
      : JSON.stringify(rows[0].content ?? ''));
  return {
    id: rows[0].id,
    title: rows[0].title,
    text,
    updatedAt: rows[0].updated_at,
  };
}

function contentHash(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

module.exports = {
  cfg,
  getDocmostPool,
  ensureSyncAuth,
  createPage,
  updatePage,
  readPageText,
  contentHash,
};