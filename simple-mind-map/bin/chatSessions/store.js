/**
 * Product-shell assistant chat in mind_map Postgres.
 * OpenClaw gateway state stays in its Docker volume; do not write here from Cognee/Yiran.
 */

const MAX_SESSIONS = 40
const MAX_MESSAGES = 80

function asText(value, max = 8000) {
  return String(value == null ? '' : value).slice(0, max)
}

function newId(prefix = 'c') {
  return `${prefix}${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}`
}

async function initSchema(db) {
  await db.query(`
    create table if not exists chat_sessions (
      id text primary key,
      user_id text not null,
      wecom_userid text not null default '',
      corp_id text not null default '',
      title text not null default '新对话',
      active boolean not null default false,
      updated_at timestamptz not null default now(),
      created_at timestamptz not null default now(),
      deleted_at timestamptz
    )`)
  await db.query(`
    create index if not exists chat_sessions_user_updated_idx
      on chat_sessions(user_id, updated_at desc)
      where deleted_at is null`)
  await db.query(`
    create table if not exists chat_messages (
      id text primary key,
      session_id text not null references chat_sessions(id) on delete cascade,
      role text not null default 'user',
      content text not null default '',
      status text not null default '',
      extra jsonb not null default '{}'::jsonb,
      sort_index integer not null default 0,
      created_at timestamptz not null default now()
    )`)
  await db.query(`
    create index if not exists chat_messages_session_sort_idx
      on chat_messages(session_id, sort_index asc, created_at asc)`)
}

function actorFromReq(req) {
  const user = (req && req.authUser) || {}
  if (!user.id || user.service) {
    const err = new Error('请先登录')
    err.statusCode = 401
    err.code = 'unauthorized'
    throw err
  }
  return {
    userId: String(user.id).trim(),
    wecomUserId: String(user.wecomUserId || user.id).trim(),
    corpId: String(user.corpId || '').trim()
  }
}

function sessionDto(row, messages) {
  return {
    id: row.id,
    title: row.title || '新对话',
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.getTime()
        : new Date(row.updated_at || Date.now()).getTime(),
    messages: Array.isArray(messages) ? messages : undefined
  }
}

function messageDto(row) {
  let extra = row.extra
  if (typeof extra === 'string') {
    try {
      extra = JSON.parse(extra)
    } catch (e) {
      extra = {}
    }
  }
  if (!extra || typeof extra !== 'object') extra = {}
  return {
    id: row.id,
    role: row.role || 'user',
    content: row.content || '',
    status: row.status || '',
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.getTime()
        : new Date(row.created_at || Date.now()).getTime(),
    ...extra
  }
}

async function listConversations(db, actor, options = {}) {
  const includeMessages = options.includeMessages !== false
  const limit = Math.min(
    MAX_SESSIONS,
    Math.max(1, Number(options.limit) || MAX_SESSIONS)
  )
  const sessions = await db.query(
    `select * from chat_sessions
     where user_id = $1 and deleted_at is null
     order by updated_at desc
     limit $2`,
    [actor.userId, limit]
  )
  const conversations = []
  let activeId = ''
  for (const row of sessions.rows) {
    if (row.active) activeId = row.id
    let messages = []
    if (includeMessages) {
      const msgRes = await db.query(
        `select * from chat_messages
         where session_id = $1
         order by sort_index asc, created_at asc
         limit $2`,
        [row.id, MAX_MESSAGES]
      )
      messages = msgRes.rows.map(messageDto)
    }
    conversations.push(sessionDto(row, includeMessages ? messages : undefined))
  }
  if (!activeId && conversations.length) activeId = conversations[0].id
  return { conversations, activeId }
}

async function replaceConversations(db, actor, state = {}) {
  const incoming = Array.isArray(state.conversations)
    ? state.conversations.slice(0, MAX_SESSIONS)
    : []
  const activeId = asText(state.activeId || '', 80)

  await db.query(
    `update chat_sessions set deleted_at = now(), active = false, updated_at = now()
     where user_id = $1 and deleted_at is null`,
    [actor.userId]
  )

  for (let i = 0; i < incoming.length; i++) {
    const conv = incoming[i] || {}
    const id = asText(conv.id, 80) || newId('c')
    const title = asText(conv.title || '新对话', 200) || '新对话'
    let updatedAt = new Date()
    if (conv.updatedAt) {
      const parsed = new Date(conv.updatedAt)
      if (!Number.isNaN(parsed.getTime())) updatedAt = parsed
    }
    const isActive = activeId ? id === activeId : i === 0
    await db.query(
      `insert into chat_sessions (
         id, user_id, wecom_userid, corp_id, title, active, updated_at, created_at, deleted_at
       ) values ($1, $2, $3, $4, $5, $6, $7, $7, null)
       on conflict (id) do update set
         user_id = excluded.user_id,
         wecom_userid = excluded.wecom_userid,
         corp_id = excluded.corp_id,
         title = excluded.title,
         active = excluded.active,
         updated_at = excluded.updated_at,
         deleted_at = null`,
      [
        id,
        actor.userId,
        actor.wecomUserId,
        actor.corpId,
        title,
        isActive,
        updatedAt
      ]
    )
    await db.query(`delete from chat_messages where session_id = $1`, [id])
    const messages = Array.isArray(conv.messages)
      ? conv.messages.slice(0, MAX_MESSAGES)
      : []
    for (let j = 0; j < messages.length; j++) {
      const m = messages[j] || {}
      const mid = asText(m.id, 80) || newId('m')
      const role = asText(m.role || 'user', 32) || 'user'
      const content = asText(m.content, 100000)
      const status = asText(m.status || '', 64)
      const {
        id: _id,
        role: _role,
        content: _content,
        status: _status,
        createdAt: _createdAt,
        ...extra
      } = m
      let createdAt = new Date()
      if (m.createdAt) {
        const parsed = new Date(m.createdAt)
        if (!Number.isNaN(parsed.getTime())) createdAt = parsed
      }
      await db.query(
        `insert into chat_messages (
           id, session_id, role, content, status, extra, sort_index, created_at
         ) values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
         on conflict (id) do update set
           session_id = excluded.session_id,
           role = excluded.role,
           content = excluded.content,
           status = excluded.status,
           extra = excluded.extra,
           sort_index = excluded.sort_index,
           created_at = excluded.created_at`,
        [
          mid,
          id,
          role,
          content,
          status,
          JSON.stringify(extra || {}),
          j,
          createdAt
        ]
      )
    }
  }

  return listConversations(db, actor)
}

module.exports = {
  initSchema,
  actorFromReq,
  listConversations,
  replaceConversations,
  MAX_SESSIONS,
  MAX_MESSAGES
}
