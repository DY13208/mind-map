'use strict';
/**
 * Whole-Wiki (Docmost) search / browse / read / write for the calling user.
 *
 * Authority model: we never touch the Wiki with an elevated identity.
 * The mind-map user id (JWT `sub`) is mapped to its Docmost user, a normal
 * Docmost session is created for THAT user, and every request goes through
 * Docmost's own HTTP API so Docmost enforces space membership and page
 * restrictions. Whatever the account cannot open or edit in the browser,
 * it cannot open or edit here either.
 */
const crypto = require('crypto');
const { Pool } = require('pg');

const SESSION_TTL_SEC = 12 * 60 * 60;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

let pool = null;
const cookieCache = new Map();

function cfg(env = process.env) {
  return {
    baseUrl: String(env.DOCMOST_INTERNAL_URL || 'http://docmost:3000').replace(/\/$/, ''),
    databaseUrl: String(env.DOCMOST_DATABASE_URL || env.DATABASE_URL || '').trim(),
    appSecret: String(env.DOCMOST_APP_SECRET || env.APP_SECRET || '').trim(),
    // Optional: fall back to one fixed Docmost user when the caller has no
    // Docmost counterpart yet. Off unless explicitly configured.
    fallbackUserId: String(env.KNOWLEDGE_WIKI_FALLBACK_USER_ID || '').trim(),
    maxBodyChars: Number(env.KNOWLEDGE_WIKI_MAX_BODY || 120000),
    defaultSearchLimit: Number(env.KNOWLEDGE_WIKI_SEARCH_LIMIT || 20),
    maxSearchLimit: Number(env.KNOWLEDGE_WIKI_SEARCH_MAX_LIMIT || 50),
    maxTreePages: Number(env.KNOWLEDGE_WIKI_MAX_TREE_PAGES || 2000),
    // 用于把新建/更新的页面拼成给人点开的链接
    publicUrl: String(env.DOCMOST_PUBLIC_URL || 'http://localhost:3040').replace(/\/$/, ''),
    maxWriteChars: Number(env.KNOWLEDGE_WIKI_MAX_WRITE_CHARS || 200000),
  };
}

function b64urlJson(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function signDocmostAccessToken({ userId, email, workspaceId, sessionId, appSecret }) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: userId,
    email,
    workspaceId,
    type: 'access',
    sessionId,
    iat: now,
    exp: now + SESSION_TTL_SEC,
    iss: 'Docmost',
  };
  const data = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const signature = crypto.createHmac('sha256', appSecret).update(data, 'utf8').digest();
  return `${data}.${b64url(signature)}`;
}

function getWikiPool(env = process.env) {
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

function fail(code, message, cause) {
  const err = new Error(message || code);
  err.code = code;
  if (cause) err.cause = cause;
  return err;
}

function requireConfig(env = process.env) {
  const c = cfg(env);
  if (!c.databaseUrl || !c.appSecret) {
    throw fail('wiki_unconfigured', 'wiki_unconfigured: Docmost database or app secret missing');
  }
  return c;
}

/** mind-map user id -> Docmost user row. */
async function resolveDocmostUser(userId, env = process.env) {
  const c = requireConfig(env);
  const db = getWikiPool(env);
  const sub = String(userId || '').trim();
  const externalId = `mind-map:${sub}`;
  const email = `${sub.toLowerCase()}@users.mind-map.local`;

  const { rows } = await db.query(
    `select id::text as id, email, name, workspace_id::text as workspace_id,
            deactivated_at, deleted_at
       from users
      where (scim_external_id = $1 or lower(email) = $2)
        and deleted_at is null
      order by (scim_external_id = $1) desc
      limit 1`,
    [externalId, email],
  );
  let row = rows[0];

  if (!row && c.fallbackUserId) {
    const fb = await db.query(
      `select id::text as id, email, name, workspace_id::text as workspace_id,
              deactivated_at, deleted_at
         from users
        where (id::text = $1 or lower(email) = lower($1)) and deleted_at is null
        limit 1`,
      [c.fallbackUserId],
    );
    row = fb.rows[0];
  }

  if (!row) {
    throw fail(
      'wiki_identity_unmapped',
      `wiki_identity_unmapped: 尚无对应的 Wiki 账号（${externalId}）。请先在 Wiki 页面完成一次单点登录。`,
    );
  }
  if (row.deactivated_at) {
    throw fail('wiki_user_disabled', 'wiki_user_disabled: 该账号在 Wiki 中已停用');
  }
  return row;
}

/** Create a Docmost session for the mapped user and return an auth cookie. */
async function cookieForUser(userId, env = process.env) {
  const c = requireConfig(env);
  const key = String(userId);
  const cached = cookieCache.get(key);
  const now = Date.now();
  if (cached && cached.expiresAt > now + REFRESH_MARGIN_MS) return cached.cookie;

  const user = await resolveDocmostUser(userId, env);
  const db = getWikiPool(env);
  const session = (
    await db.query(
      `insert into user_sessions (user_id, workspace_id, device_name, expires_at)
       values ($1, $2, 'knowledge-mcp-wiki', now() + interval '12 hours')
       returning id`,
      [user.id, user.workspace_id],
    )
  ).rows[0];

  const token = signDocmostAccessToken({
    userId: user.id,
    email: user.email,
    workspaceId: user.workspace_id,
    sessionId: session.id,
    appSecret: c.appSecret,
  });
  const cookie = `authToken=${token}`;
  cookieCache.set(key, { cookie, expiresAt: now + SESSION_TTL_SEC * 1000, user });
  return cookie;
}

async function docmostApi(userId, path, body, env = process.env) {
  const c = cfg(env);
  const cookie = await cookieForUser(userId, env);
  let res;
  try {
    res = await fetch(new URL(path, c.baseUrl), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    throw fail('wiki_unreachable', `wiki_unreachable: ${String(e.message || e)}`, e);
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (res.status === 401) throw fail('wiki_auth_failed', 'wiki_auth_failed: Wiki 拒绝了该账号的会话');
  if (res.status === 403) throw fail('forbidden', 'forbidden: 该账号没有访问权限');
  if (!res.ok) {
    throw fail(
      'wiki_http_error',
      `wiki_http_error: Docmost ${path} → ${res.status} ${String(
        (data && (data.message || data.error)) || '',
      ).slice(0, 160)}`,
    );
  }
  if (data && typeof data === 'object' && data.success === true && 'data' in data) return data.data;
  return data;
}

function summarisePage(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    pageId: row.id || row.pageId || null,
    title: row.title || '(无标题)',
    spaceId: row.spaceId || null,
    spaceName: (row.space && row.space.name) || null,
    icon: row.icon || null,
    updatedAt: row.updatedAt || null,
    creator: (row.creator && (row.creator.name || row.creator.email)) || null,
  };
}

/** List spaces the account can read. */
async function wikiSpaces(userId, env = process.env) {
  const data = await docmostApi(userId, '/api/spaces/', { limit: 100 }, env);
  const items = Array.isArray(data) ? data : (data && data.items) || [];
  return {
    count: items.length,
    items: items.map((s) => ({
      spaceId: s.id || null,
      name: s.name || null,
      slug: s.slug || null,
      description: s.description || null,
      memberRole: (s.membership && s.membership.role) || s.memberRole || null,
    })),
  };
}

/** Full-text search across every page the account can read. */
async function wikiSearch(userId, { query, spaceId, limit } = {}, env = process.env) {
  const c = cfg(env);
  const q = String(query || '').trim();
  if (!q) throw fail('missing_query', 'missing_query: query 不能为空');
  const safeLimit = Math.min(
    Math.max(Number(limit) || c.defaultSearchLimit, 1),
    c.maxSearchLimit,
  );
  const data = await docmostApi(
    userId,
    '/api/search',
    { query: q.slice(0, 200), ...(spaceId ? { spaceId: String(spaceId) } : {}), limit: safeLimit },
    env,
  );
  const items = (data && data.items) || [];
  return {
    query: q,
    count: items.length,
    truncated: items.length >= safeLimit,
    items: items.slice(0, safeLimit).map((r) => ({
      pageId: r.id || r.pageId || null,
      title: r.title || '(无标题)',
      spaceId: r.spaceId || null,
      icon: r.icon || null,
      highlight: String(r.highlight || '').replace(/<[^>]+>/g, '').slice(0, 500),
      updatedAt: r.updatedAt || null,
    })),
  };
}

/** Page tree of a space (or of a subtree rooted at pageId). */
async function wikiTree(userId, { spaceId, pageId } = {}, env = process.env) {
  const c = cfg(env);
  if (!spaceId && !pageId) {
    throw fail('missing_params', 'missing_params: 需要 spaceId 或 pageId');
  }
  const data = await docmostApi(
    userId,
    '/api/pages/sidebar-pages',
    {
      ...(spaceId ? { spaceId: String(spaceId) } : {}),
      ...(pageId ? { pageId: String(pageId) } : {}),
      limit: Math.min(c.maxTreePages, 100),
    },
    env,
  );
  const items = Array.isArray(data) ? data : (data && data.items) || [];
  const flat = [];
  const walk = (nodes, depth) => {
    for (const n of Array.isArray(nodes) ? nodes : []) {
      if (!n) continue;
      flat.push({ pageId: n.id || n.pageId || null, title: n.title || '(无标题)', depth, icon: n.icon || null });
      if (n.children && n.children.length) walk(n.children, depth + 1);
      if (flat.length >= c.maxTreePages) return;
    }
  };
  walk(items, 0);
  return { count: flat.length, truncated: flat.length >= c.maxTreePages, pages: flat };
}

/** Read one page's body as markdown (Docmost enforces view permission). */
async function wikiRead(userId, { pageId, format } = {}, env = process.env) {
  const c = cfg(env);
  if (!pageId) throw fail('missing_params', 'missing_params: 需要 pageId');
  const wantFormat = format === 'html' ? 'html' : 'markdown';
  const page = await docmostApi(
    userId,
    '/api/pages/info',
    { pageId: String(pageId), format: wantFormat },
    env,
  );
  if (!page) throw fail('not_found', 'not_found: 页面不存在或无权访问');
  const body =
    typeof page.content === 'string' ? page.content : JSON.stringify(page.content ?? '');
  const clipped = body.length > c.maxBodyChars;
  return {
    ...summarisePage(page),
    format: wantFormat,
    permissions: page.permissions || null,
    bodyChars: body.length,
    truncated: clipped,
    body: clipped ? body.slice(0, c.maxBodyChars) : body,
  };
}

function normaliseContentFormat(format) {
  const f = String(format || 'markdown').toLowerCase();
  if (f === 'html' || f === 'json' || f === 'markdown') return f;
  throw fail('invalid_format', 'invalid_format: format 仅支持 markdown / html / json');
}

function normaliseWriteOperation(operation) {
  const op = String(operation || 'replace').toLowerCase();
  if (op === 'append' || op === 'prepend' || op === 'replace') return op;
  throw fail('invalid_operation', 'invalid_operation: operation 仅支持 replace / append / prepend');
}

function contentHash(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

/**
 * Docmost 的 `format: json` 要求 content 是 ProseMirror 对象本身；
 * `parseProsemirrorContent` 对 json 分支是 `prosemirrorJson = content`，传字符串会
 * `jsonToNode(string)` 失败并报 Invalid content format。所以 json 格式必须原样透传对象。
 */
function normaliseContentPayload(content, wantFormat) {
  if (content == null) return undefined;
  if (wantFormat === 'json') {
    if (typeof content === 'string') {
      // 允许调用方传 JSON 字符串，这里解析成对象再透传
      try {
        return JSON.parse(content);
      } catch (e) {
        throw fail('invalid_content', 'invalid_content: format=json 时 content 必须是对象或合法 JSON 字符串');
      }
    }
    return content;
  }
  return typeof content === 'string' ? content : String(content);
}

function payloadLength(content) {
  if (content == null) return 0;
  return typeof content === 'object' ? JSON.stringify(content).length : String(content).length;
}

/**
 * Create a Wiki page under the calling account's edit permission.
 * Docmost enforces Create-on-space or Edit-on-parent.
 */
async function wikiCreate(
  userId,
  { spaceId, title, content, parentPageId, format } = {},
  env = process.env,
) {
  if (!spaceId) throw fail('missing_params', 'missing_params: 需要 spaceId');
  const wantFormat = normaliseContentFormat(format);
  const body = {
    spaceId: String(spaceId),
    title: title != null ? String(title) : undefined,
    parentPageId: parentPageId ? String(parentPageId) : undefined,
  };
  if (content != null) {
    body.content = normaliseContentPayload(content, wantFormat);
    body.format = wantFormat;
  }
  const page = await docmostApi(userId, '/api/pages/create', body, env);
  const pageId = page && (page.id || page.pageId);
  if (!pageId) throw fail('wiki_http_error', 'wiki_http_error: create 未返回 pageId');
  const after = content != null ? contentHash(JSON.stringify(body.content)) : null;
  return {
    status: 'created',
    ...summarisePage(page),
    pageId,
    slugId: page.slugId || page.slug_id || null,
    permissions: page.permissions || null,
    audit: {
      operation: 'create',
      docmostPageId: pageId,
      afterHash: after,
    },
  };
}

/**
 * Update an existing Wiki page (title and/or body).
 * Docmost enforces edit permission on the target page.
 */
async function wikiUpdate(
  userId,
  { pageId, title, content, format, operation } = {},
  env = process.env,
) {
  if (!pageId) throw fail('missing_params', 'missing_params: 需要 pageId');
  const hasTitle = title != null;
  const hasContent = content != null;
  if (!hasTitle && !hasContent) {
    throw fail('missing_params', 'missing_params: 需要 title 或 content 至少一项');
  }

  let beforeHash = null;
  try {
    const before = await wikiRead(userId, { pageId: String(pageId), format: 'markdown' }, env);
    beforeHash = contentHash(before && before.body);
  } catch {
    // Best-effort; update may still succeed if read fails for other reasons.
  }

  const body = { pageId: String(pageId) };
  if (hasTitle) body.title = String(title);
  let writeOp = null;
  if (hasContent) {
    const wantFormat = normaliseContentFormat(format);
    body.content = normaliseContentPayload(content, wantFormat);
    body.format = wantFormat;
    writeOp = normaliseWriteOperation(operation);
    body.operation = writeOp;
  }

  const page = await docmostApi(userId, '/api/pages/update', body, env);
  const id = (page && (page.id || page.pageId)) || String(pageId);
  const afterHash = hasContent ? contentHash(JSON.stringify(body.content)) : beforeHash;
  return {
    status: 'updated',
    ...summarisePage(page || { id, title }),
    pageId: id,
    slugId: (page && (page.slugId || page.slug_id)) || null,
    permissions: (page && page.permissions) || null,
    audit: {
      operation: writeOp || 'rename',
      docmostPageId: id,
      beforeHash,
      afterHash,
    },
  };
}

module.exports = {
  wikiSpaces,
  wikiSearch,
  wikiTree,
  wikiRead,
  wikiCreate,
  wikiUpdate,
};
