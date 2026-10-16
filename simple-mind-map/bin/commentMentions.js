'use strict'

// 「@我的」提及索引 + 已读状态。
//
// 评论存放在节点 data.comments 中（按 id 合并、删除用墓碑），而且有多条写入路径
// （HTTP 评论接口、MCP、编辑页协作提交、粘贴/导入……）。为了不在每条写路径上挂钩，
// 这里用「按房间版本游标增量建索引」的方式：
//   - comment_mention_cursors 记录每个房间已索引到的版本；
//   - 读取「@我的」时，先把少量版本落后的房间补齐：版本连续时只扫描 room_operations
//     里含 "comments" 的操作；首次、操作被归档/有缺口、或遇到整图替换/撤销等操作时，
//     从当前快照整房重建；
//   - 返回列表前再用当前快照校验（节点仍在、评论未删除），并把失效行标记 deleted，
//     所以索引只需是「超集」，最终结果总是以当前文档为准。
// 并发：每个房间在事务里 `for update skip locked` 抢游标行，多实例/多请求不会重复建；
// 所有写入都是幂等 upsert，墓碑优先（与 commentMerge 的「删除优先」一致）。
const { resolveDisplayName } = require('./displayName')
const { liveComments, normalizeMentions } = require('./commentMerge')

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const SYNC_MAX_ROOMS = 25
const SYNC_BUDGET_MS = 800
const SYNC_MIN_INTERVAL_MS = 3000
const MAX_INCREMENTAL_OPS = 2000
const FULL_REBUILD_OP_RE = /replace|restore|undo|redo|recover|rollback|import|reset/i
const UNREAD_SCAN_LIMIT = 500
const ACCESS_CACHE_MS = 30000

function stripHtml(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

function snippet(text, max = 60) {
  const s = stripHtml(text)
  return s.length > max ? s.slice(0, max) + '…' : s
}

// 提及键：结构化 userId 优先；旧数据/外部写入只有名字时用 name:<名字>
function mentionKey(mention) {
  if (!mention) return ''
  const userId = String(mention.userId || '').trim()
  if (userId) return userId
  const name = String(mention.name || '').trim()
  return name ? 'name:' + name : ''
}

function rowsForComment(nodeUid, comment) {
  if (!comment || comment.deleted) return []
  const mentions = normalizeMentions(comment.mentions)
  const seen = new Set()
  const rows = []
  for (const m of mentions) {
    const key = mentionKey(m)
    if (!key || seen.has(key)) continue
    seen.add(key)
    rows.push({
      comment_id: comment.id,
      mention_key: key,
      mention_name: m.name,
      node_uid: String(nodeUid || ''),
      author_id: String(comment.userId || ''),
      author_name: String(comment.userName || ''),
      author_avatar: String(comment.avatar || ''),
      content: String(comment.content || ''),
      created_ms: Number(comment.time) || 0
    })
  }
  return rows
}

// 从整图快照抽取所有仍有效的提及
function extractFromNodes(nodes) {
  const rows = []
  for (const uid of Object.keys(nodes || {})) {
    const node = nodes[uid]
    const data = (node && node.data) || {}
    if (!Array.isArray(data.comments) || !data.comments.length) continue
    for (const c of liveComments(data.comments)) rows.push(...rowsForComment(data.uid || uid, c))
  }
  return rows
}

// 从任意形状的操作 payload 中找出 comments 数组（node.update 的 patch、插入/粘贴的
// data 等），以最近一层带 uid 的对象作为节点 id。
function extractFromPayload(payload) {
  const upserts = []
  const tombstones = []
  const walk = (value, uid, depth) => {
    if (!value || typeof value !== 'object' || depth > 14) return
    if (Array.isArray(value)) {
      for (const item of value) walk(item, uid, depth + 1)
      return
    }
    const here = typeof value.uid === 'string' && value.uid ? value.uid : uid
    for (const key of Object.keys(value)) {
      const child = value[key]
      if (key === 'comments' && Array.isArray(child)) {
        for (const raw of child) {
          if (!raw || typeof raw !== 'object') continue
          if (raw.deleted === true && raw.id) tombstones.push(String(raw.id))
        }
        for (const c of liveComments(child)) {
          if (here) upserts.push(...rowsForComment(here, c))
        }
        continue
      }
      if (child && typeof child === 'object') walk(child, here, depth + 1)
    }
  }
  walk(payload, '', 0)
  return { upserts, tombstones }
}

function clampLimit(value) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, n)
}

function encodeBefore(row) {
  if (!row) return null
  const t = row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString()
  return Buffer.from(JSON.stringify({ t, r: row.room_key, c: row.comment_id })).toString('base64url')
}

function decodeBefore(value) {
  if (!value) return null
  try {
    const v = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'))
    if (v && typeof v.t === 'string' && Number.isFinite(Date.parse(v.t)) && typeof v.r === 'string' && typeof v.c === 'string') {
      return { t: v.t, r: v.r, c: v.c }
    }
  } catch (e) {
    // fall through
  }
  const err = new Error('before 参数无效')
  err.statusCode = 400
  err.code = 'MENTION_CURSOR_INVALID'
  throw err
}

function clean(v) {
  return v == null ? '' : String(v).trim()
}

// 当前用户可能出现在提及里的键：账号 id 们 + 名字（仅匹配没有 userId 的旧提及）
function identityOf(user = {}) {
  const ids = [user.id, user.user_id, user.userid, user.userId, user.wecomUserId, user.wecom_userid, user.username]
    .map(clean)
    .filter(Boolean)
    // roomAcl 会去掉 wecom: 前缀，房间成员里的 userId 是去前缀的形式
    .reduce((acc, id) => acc.concat(id, id.replace(/^wecom:/i, '')), [])
    .filter(Boolean)
  const uniqIds = Array.from(new Set(ids))
  const names = Array.from(new Set([resolveDisplayName(user), clean(user.name), clean(user.display_name)].filter(Boolean)))
  return {
    userId: clean(user.id) || uniqIds[0] || '',
    ids: uniqIds,
    keys: uniqIds.concat(names.map(n => 'name:' + n))
  }
}

async function initSchema(pool) {
  await pool.query(`
    create table if not exists comment_mentions (
      room_key text not null,
      comment_id text not null,
      mention_key text not null,
      mention_name text not null default '',
      node_uid text not null,
      author_id text not null default '',
      author_name text not null default '',
      author_avatar text not null default '',
      content text not null default '',
      created_at timestamptz not null,
      deleted boolean not null default false,
      indexed_at timestamptz not null default now(),
      primary key (room_key, comment_id, mention_key)
    )
  `)
  await pool.query(`
    create index if not exists comment_mentions_key_time_idx
    on comment_mentions (mention_key, created_at desc, room_key desc, comment_id desc)
    where not deleted
  `)
  await pool.query(`
    create table if not exists comment_mention_cursors (
      room_key text primary key,
      version bigint not null default -1,
      rebuilt_at timestamptz,
      updated_at timestamptz not null default now()
    )
  `)
  await pool.query(`
    create table if not exists comment_mention_reads (
      user_id text not null,
      room_key text not null,
      comment_id text not null,
      read_at timestamptz not null default now(),
      primary key (user_id, room_key, comment_id)
    )
  `)
  await pool.query(`
    create table if not exists comment_mention_read_marks (
      user_id text primary key,
      read_before timestamptz not null,
      updated_at timestamptz not null default now()
    )
  `)
}

async function upsertRows(client, roomKey, rows) {
  if (!rows.length) return
  // 分批 + unnest，避免巨型参数列表
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500)
    await client.query(
      `insert into comment_mentions
         (room_key, comment_id, mention_key, mention_name, node_uid, author_id,
          author_name, author_avatar, content, created_at)
       select $1, t.comment_id, t.mention_key, t.mention_name, t.node_uid, t.author_id,
              t.author_name, t.author_avatar, t.content, to_timestamp(t.created_ms / 1000.0)
         from unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::float8[])
           as t(comment_id, mention_key, mention_name, node_uid, author_id, author_name, author_avatar, content, created_ms)
       on conflict (room_key, comment_id, mention_key) do update
         set node_uid = excluded.node_uid,
             mention_name = excluded.mention_name,
             author_name = excluded.author_name,
             author_avatar = excluded.author_avatar,
             content = excluded.content,
             indexed_at = now()`,
      [
        roomKey,
        batch.map(r => r.comment_id),
        batch.map(r => r.mention_key),
        batch.map(r => r.mention_name),
        batch.map(r => r.node_uid),
        batch.map(r => r.author_id),
        batch.map(r => r.author_name),
        batch.map(r => r.author_avatar),
        batch.map(r => r.content),
        batch.map(r => r.created_ms)
      ]
    )
  }
}

async function markDeleted(client, roomKey, commentIds) {
  const ids = Array.from(new Set(commentIds.filter(Boolean)))
  if (!ids.length) return
  await client.query(
    `update comment_mentions set deleted = true, indexed_at = now()
      where room_key = $1 and comment_id = any($2::text[]) and not deleted`,
    [roomKey, ids]
  )
}

async function rebuildRoom(client, roomKey, loadSnapshot) {
  const loaded = await loadSnapshot(roomKey)
  await client.query('delete from comment_mentions where room_key = $1', [roomKey])
  if (!loaded || !loaded.obj) return null
  await upsertRows(client, roomKey, extractFromNodes(loaded.obj))
  return Number((loaded.row && (loaded.row.version || loaded.row.revision)) || 0)
}

// 同步单个房间；拿不到锁（别的请求/实例正在同步）就跳过
async function syncRoom(pool, roomKey, targetVersion, loadSnapshot) {
  const client = typeof pool.connect === 'function' ? await pool.connect() : pool
  const release = () => { if (client !== pool && typeof client.release === 'function') client.release() }
  try {
    await client.query('begin')
    await client.query(
      `insert into comment_mention_cursors (room_key, version) values ($1, -1)
       on conflict (room_key) do nothing`,
      [roomKey]
    )
    const locked = await client.query(
      'select version from comment_mention_cursors where room_key = $1 for update skip locked',
      [roomKey]
    )
    if (!locked.rows.length) {
      await client.query('rollback')
      return 'busy'
    }
    const from = Number(locked.rows[0].version)
    let target = Number(targetVersion) || 0
    if (from >= target) {
      await client.query('rollback')
      return 'fresh'
    }
    let full = from < 0 || target - from > MAX_INCREMENTAL_OPS
    let ops = []
    if (!full) {
      const res = await client.query(
        `select version, operation_type,
                case when payload::text like '%"comments"%' then payload else null end as payload
           from room_operations
          where room_key = $1 and version > $2 and version <= $3
          order by version`,
        [roomKey, from, target]
      )
      ops = res.rows
      // 有缺口（已归档 / 未落库）或整图类操作 → 整房重建更安全
      if (ops.length !== target - from || ops.some(op => FULL_REBUILD_OP_RE.test(String(op.operation_type || '')))) full = true
    }
    if (full) {
      const v = await rebuildRoom(client, roomKey, loadSnapshot)
      if (v != null && v > target) target = v
      await client.query(
        'update comment_mention_cursors set version = $2, rebuilt_at = now(), updated_at = now() where room_key = $1',
        [roomKey, target]
      )
    } else {
      for (const op of ops) {
        if (!op.payload) continue
        const payload = typeof op.payload === 'string' ? JSON.parse(op.payload) : op.payload
        const { upserts, tombstones } = extractFromPayload(payload)
        await upsertRows(client, roomKey, upserts)
        await markDeleted(client, roomKey, tombstones)
      }
      await client.query(
        'update comment_mention_cursors set version = $2, updated_at = now() where room_key = $1',
        [roomKey, target]
      )
    }
    await client.query('commit')
    return full ? 'rebuilt' : 'incremental'
  } catch (err) {
    try { await client.query('rollback') } catch (e) { /* ignore */ }
    throw err
  } finally {
    release()
  }
}

let syncInFlight = null
let lastSyncAt = 0

// 补齐少量版本落后的房间（最近更新优先），有时间预算；单进程内 single-flight
function syncStaleRooms(pool, loadSnapshot, options = {}) {
  if (syncInFlight) return syncInFlight
  const now = Date.now()
  if (!options.force && now - lastSyncAt < SYNC_MIN_INTERVAL_MS) return Promise.resolve({ skipped: true })
  lastSyncAt = now
  const maxRooms = options.maxRooms || SYNC_MAX_ROOMS
  const budget = options.budgetMs || SYNC_BUDGET_MS
  const log = options.log || console
  syncInFlight = (async () => {
    const started = Date.now()
    const res = await pool.query(
      `select r.room_key, r.version
         from rooms r
         left join comment_mention_cursors c on c.room_key = r.room_key
        where c.room_key is null or r.version > c.version
        order by r.updated_at desc
        limit $1`,
      [maxRooms]
    )
    let synced = 0
    for (const row of res.rows) {
      if (Date.now() - started > budget) break
      try {
        await syncRoom(pool, row.room_key, Number(row.version) || 0, loadSnapshot)
        synced++
      } catch (err) {
        if (log && log.warn) log.warn('[commentMentions] sync failed', row.room_key, err && err.message)
      }
    }
    return { synced, pending: Math.max(0, res.rows.length - synced) }
  })().finally(() => {
    syncInFlight = null
  })
  return syncInFlight
}

function resetSyncStateForTests() {
  syncInFlight = null
  lastSyncAt = 0
}

// 每用户的房间可见性短缓存（列表 + 角标轮询会反复检查同一批房间）
const accessCache = new Map()
async function canView(pool, req, roomAcl, userId, roomKey, memo) {
  if (memo.has(roomKey)) return memo.get(roomKey)
  const cacheKey = userId + '\u0001' + roomKey
  const hit = accessCache.get(cacheKey)
  if (hit && Date.now() - hit.at < ACCESS_CACHE_MS) {
    memo.set(roomKey, hit.ok)
    return hit.ok
  }
  let ok = false
  try {
    const access = await roomAcl.assertRoomAccess(pool, req, roomKey, 'view')
    ok = !!access && access.canView !== false
  } catch (e) {
    ok = false
  }
  memo.set(roomKey, ok)
  accessCache.set(cacheKey, { ok, at: Date.now() })
  if (accessCache.size > 5000) {
    const cutoff = Date.now() - ACCESS_CACHE_MS
    accessCache.forEach((v, k) => { if (v.at < cutoff) accessCache.delete(k) })
  }
  return ok
}

function clearAccessCache() {
  accessCache.clear()
}

const UNREAD_SQL = `
  m.created_at > coalesce((select k.read_before from comment_mention_read_marks k where k.user_id = $3), '-infinity'::timestamptz)
  and not exists (
    select 1 from comment_mention_reads r
     where r.user_id = $3 and r.room_key = m.room_key and r.comment_id = m.comment_id
  )`

async function queryCandidates(pool, ident, before, limit) {
  const params = [ident.keys, ident.ids, ident.userId, limit]
  let cursorSql = ''
  if (before) {
    params.push(before.t, before.r, before.c)
    cursorSql = 'and (m.created_at, m.room_key, m.comment_id) < ($5::timestamptz, $6, $7)'
  }
  const res = await pool.query(
    `select m.room_key, m.comment_id, m.node_uid, m.author_id, m.author_name, m.author_avatar,
            m.content, m.created_at, m.mention_name,
            (${UNREAD_SQL}) as unread
       from comment_mentions m
      where m.mention_key = any($1::text[])
        and not m.deleted
        and not (m.author_id = any($2::text[]))
        ${cursorSql}
      order by m.created_at desc, m.room_key desc, m.comment_id desc
      limit $4`,
    params
  )
  return res.rows
}

async function lookupAuthors(pool, ids) {
  const map = new Map()
  if (!ids.length) return map
  try {
    const res = await pool.query(
      `select user_id, wecom_userid, name, avatar from wecom_users where user_id = any($1::text[])`,
      [ids]
    )
    for (const row of res.rows) map.set(String(row.user_id), row)
  } catch (e) {
    // 没有通讯录表（本地/测试）时用评论里保存的名字
  }
  return map
}

/**
 * 列出提及当前用户的评论（时间倒序，keyset 分页）。
 * 只返回：仍有查看权限的房间、节点与评论在当前快照中仍存在、非本人发的。
 */
async function listMentions(pool, req, options = {}, deps = {}) {
  const { roomAcl, loadSnapshot } = deps
  const ident = identityOf(req.authUser || {})
  const limit = clampLimit(options.limit)
  let before = decodeBefore(options.before)
  const memo = new Map()
  const snapshots = new Map()
  const loadRoom = async roomKey => {
    if (!snapshots.has(roomKey)) {
      let loaded = null
      try { loaded = await loadSnapshot(roomKey) } catch (e) { loaded = null }
      snapshots.set(roomKey, loaded)
    }
    return snapshots.get(roomKey)
  }
  const out = []
  const seen = new Set()
  const stale = new Map()
  let exhausted = false
  let lastRow = null
  for (let round = 0; round < 6 && out.length < limit; round++) {
    const batchSize = Math.min(200, Math.max(limit * 2, 20))
    const rows = await queryCandidates(pool, ident, before, batchSize)
    if (rows.length < batchSize) exhausted = true
    for (const row of rows) {
      lastRow = row
      const key = row.room_key + '\u0001' + row.comment_id
      if (seen.has(key)) continue
      seen.add(key)
      if (!(await canView(pool, req, roomAcl, ident.userId, row.room_key, memo))) continue
      const loaded = await loadRoom(row.room_key)
      const nodes = loaded && loaded.obj
      const node = nodes && nodes[row.node_uid]
      const data = (node && node.data) || null
      const comment = data && liveComments(data.comments).find(c => c.id === row.comment_id)
      if (!comment) {
        if (!stale.has(row.room_key)) stale.set(row.room_key, [])
        stale.get(row.room_key).push(row.comment_id)
        continue
      }
      out.push({ row, comment, data, title: (loaded.row && loaded.row.title) || '' })
      if (out.length >= limit) {
        // 本批还有剩余就一定有下一页
        if (rows.indexOf(row) < rows.length - 1) exhausted = false
        break
      }
    }
    if (exhausted || !rows.length) break
    before = { t: new Date(lastRow.created_at).toISOString(), r: lastRow.room_key, c: lastRow.comment_id }
  }
  // 自愈：快照里已不存在的评论/节点标记删除，角标随之修正
  for (const [roomKey, ids] of stale) {
    try { await markDeleted(pool, roomKey, ids) } catch (e) { /* best effort */ }
  }
  const authors = await lookupAuthors(pool, Array.from(new Set(out.map(o => o.row.author_id).filter(Boolean))))
  const list = out.map(({ row, comment, data, title }) => {
    const dir = authors.get(row.author_id)
    const authorName = dir
      ? resolveDisplayName({ ...dir, id: dir.user_id, userid: dir.wecom_userid }, comment.userName || row.author_id)
      : comment.userName || row.author_name || row.author_id || '匿名用户'
    return {
      id: row.comment_id,
      comment_id: row.comment_id,
      room_key: row.room_key,
      room_name: title || '未命名脑图',
      node_uid: row.node_uid,
      node_text: snippet(data.text) || '（无标题节点）',
      author_id: row.author_id,
      author_name: authorName,
      author_avatar: (dir && dir.avatar) || comment.avatar || row.author_avatar || '',
      content: comment.content,
      mentions: comment.mentions || [],
      created_at: new Date(Number(comment.time) || row.created_at).toISOString(),
      unread: !!row.unread
    }
  })
  const last = out.length ? out[out.length - 1].row : null
  const hasMore = !exhausted && !!last
  return { list, has_more: hasMore, next_cursor: hasMore ? encodeBefore(last) : null }
}

async function countUnread(pool, req, deps = {}) {
  const { roomAcl } = deps
  const ident = identityOf(req.authUser || {})
  const res = await pool.query(
    `select m.room_key, m.comment_id
       from comment_mentions m
      where m.mention_key = any($1::text[])
        and not m.deleted
        and not (m.author_id = any($2::text[]))
        and ${UNREAD_SQL}
      order by m.created_at desc
      limit ${UNREAD_SCAN_LIMIT}`,
    [ident.keys, ident.ids, ident.userId]
  )
  const memo = new Map()
  const seen = new Set()
  for (const row of res.rows) {
    const key = row.room_key + '\u0001' + row.comment_id
    if (seen.has(key)) continue
    if (!(await canView(pool, req, roomAcl, ident.userId, row.room_key, memo))) continue
    seen.add(key)
  }
  return seen.size
}

async function markRead(pool, req, body = {}) {
  const ident = identityOf(req.authUser || {})
  if (body.all === true) {
    // 「全部已读」= 水位线：此刻之前（含客户端时钟略超前的评论）的提及都算已读
    await pool.query(
      `insert into comment_mention_read_marks (user_id, read_before)
       select $1, greatest(now(), coalesce(max(m.created_at), now()))
         from comment_mentions m
        where m.mention_key = any($2::text[])
       on conflict (user_id) do update
         set read_before = greatest(comment_mention_read_marks.read_before, excluded.read_before),
             updated_at = now()`,
      [ident.userId, ident.keys]
    )
    // 水位线以下的逐条记录已无意义，顺手清理
    await pool.query(
      `delete from comment_mention_reads r
        using comment_mention_read_marks k
        where r.user_id = $1 and k.user_id = $1 and r.read_at <= k.read_before`,
      [ident.userId]
    )
    return { all: true }
  }
  const items = (Array.isArray(body.items) ? body.items : [])
    .map(i => ({ room: clean(i && (i.room_key || i.roomKey)), id: clean(i && (i.comment_id || i.commentId || i.id)) }))
    .filter(i => i.room && i.id && i.room.length <= 255 && i.id.length <= 80)
    .slice(0, 200)
  if (!items.length) {
    const err = new Error('items 不能为空')
    err.statusCode = 400
    err.code = 'MENTION_READ_INVALID'
    throw err
  }
  await pool.query(
    `insert into comment_mention_reads (user_id, room_key, comment_id)
     select $1, t.room_key, t.comment_id from unnest($2::text[], $3::text[]) as t(room_key, comment_id)
     on conflict do nothing`,
    [ident.userId, items.map(i => i.room), items.map(i => i.id)]
  )
  return { marked: items.length }
}

const ROUTES = {
  list: '/api/users/me/mentions',
  unread: '/api/users/me/mentions/unread-count',
  read: '/api/users/me/mentions/read'
}

async function handleMentionsRequest(req, res, { url, pathname, db, sendJson, readBody, roomAcl, loadSnapshot, log }) {
  const method = String(req.method || 'GET').toUpperCase()
  const isList = pathname === ROUTES.list && method === 'GET'
  const isUnread = pathname === ROUTES.unread && method === 'GET'
  const isRead = pathname === ROUTES.read && method === 'POST'
  if (!isList && !isUnread && !isRead) return false
  const user = req.authUser
  if (!user || !user.id || user.service) {
    sendJson(res, 401, { ok: false, error: 'unauthorized', message: '请先登录' })
    return true
  }
  try {
    if (isRead) {
      const result = await markRead(db, req, await readBody(req))
      const unread = await countUnread(db, req, { roomAcl })
      sendJson(res, 200, { ok: true, ...result, unread })
      return true
    }
    let indexing = false
    try {
      const r = await syncStaleRooms(db, loadSnapshot, { log })
      indexing = !!(r && r.pending)
    } catch (err) {
      // 建索引失败不影响读取已有索引
      if (log && log.warn) log.warn('[commentMentions] sync skipped', err && err.message)
    }
    const unread = await countUnread(db, req, { roomAcl })
    if (isUnread) {
      sendJson(res, 200, { ok: true, unread, indexing })
      return true
    }
    const page = await listMentions(db, req, { limit: url.searchParams.get('limit'), before: url.searchParams.get('before') }, { roomAcl, loadSnapshot })
    sendJson(res, 200, { ok: true, ...page, unread, indexing })
    return true
  } catch (err) {
    sendJson(res, err.statusCode || 500, {
      ok: false,
      code: err.code || 'MENTIONS_ERROR',
      error: err.statusCode ? err.message : '提及加载失败'
    })
    return true
  }
}

module.exports = {
  ROUTES,
  initSchema,
  mentionKey,
  rowsForComment,
  extractFromNodes,
  extractFromPayload,
  identityOf,
  clampLimit,
  encodeBefore,
  decodeBefore,
  syncRoom,
  syncStaleRooms,
  listMentions,
  countUnread,
  markRead,
  handleMentionsRequest,
  clearAccessCache,
  resetSyncStateForTests
}
