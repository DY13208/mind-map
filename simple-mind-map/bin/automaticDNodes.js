const crypto = require('node:crypto')
const { sqlResolveMemberRole } = require('./roomAcl')

const CURSOR_TTL_MS = 24 * 60 * 60 * 1000
const cursorKey = process.env.AUTH_SESSION_SECRET || process.env.MCP_TOKEN || crypto.randomBytes(32)

// Same title convention as matchDRegistryTitle / isDNode: D: or D：, not D1/D2.
// Strip inline markup without inserting spaces into words such as 自<b>动</b>.
function titleSql(column) {
  const plain = `btrim(regexp_replace(replace(replace(replace(replace(regexp_replace(coalesce(${column}, ''), '<[^>]+>', '', 'g'), '&nbsp;', ' '), '&amp;', '&'), chr(160), ' '), chr(12288), ' '), '[[:space:]]+', ' ', 'g'))`
  return `btrim(regexp_replace(regexp_replace(regexp_replace(${plain}, '^[-*•●][[:space:]]*', ''), '^【[[:space:]]*', ''), '[[:space:]]*】$', ''))`
}

function matchSql(column) {
  const title = titleSql(column)
  return `(${title} ~* '^d[[:space:]]*[：:][[:space:]]*[^[:space:]]' and strpos(${title}, '自动') > 0)`
}

const INDEX_SQL = `create index concurrently if not exists room_nodes_automatic_d_idx on room_nodes(room_key, uid)
  where deleted_at is null and ${matchSql("data->>'text'")}`

function invalidCursor() {
  return Object.assign(new Error('分页游标无效或已过期，请从第一页重新读取'), { code: 'INVALID_CURSOR', statusCode: 400 })
}

function principal(actor) {
  return crypto.createHash('sha256').update(JSON.stringify([actor.id || '', !!actor.bypass])).digest('base64url')
}

function encodeCursor(value) {
  const body = Buffer.from(JSON.stringify(value)).toString('base64url')
  return body + '.' + crypto.createHmac('sha256', cursorKey).update(body).digest('base64url')
}

function decodeCursor(token, actor) {
  try {
    if (typeof token !== 'string' || token.length > 4096) throw invalidCursor()
    const [body, signature, extra] = token.split('.')
    const expected = crypto.createHmac('sha256', cursorKey).update(body || '').digest('base64url')
    if (extra || !signature || signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw invalidCursor()
    const value = JSON.parse(Buffer.from(body, 'base64url').toString())
    if (value.v !== 1 || value.principal !== principal(actor) || !Number.isFinite(value.expires) || value.expires < Date.now() ||
      !Array.isArray(value.after) || value.after.length !== 2 || !value.after.every(x => typeof x === 'string' && x.length > 0 && x.length <= 1024)) throw invalidCursor()
    return value
  } catch (_) { throw invalidCursor() }
}

function accessibleSql(actor, params) {
  if (actor.bypass) return 'true'
  if (!actor.id) throw Object.assign(new Error('请先登录'), { statusCode: 401, code: 'unauthorized' })
  params.push(actor.id)
  const role = sqlResolveMemberRole('m.direct_role', 'm.team_role', 'm.folder_role', 'm.role', 'm.override_role', 'm.acl_v2')
  return `(not exists(select 1 from room_members m where m.room_key = r.room_key)
    or exists(select 1 from room_members m where m.room_key = r.room_key and m.user_id = $${params.length}
      and (${role}) in ('owner', 'manager', 'editor', 'viewer')))`
}

async function queryPage(db, actor, input) {
  const limit = input.limit == null || input.limit === '' ? 50 : Number(input.limit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw Object.assign(new Error('limit 必须是 1 到 200 的整数'), { code: 'INVALID_LIMIT', statusCode: 400 })
  const cursor = input.cursor ? decodeCursor(input.cursor, actor) : null
  const params = []
  const access = accessibleSql(actor, params)
  const visible = `r.deleted_at is null and not exists(select 1 from room_tombstones t where t.room_key = r.room_key) and ${access}`
  const rooms = `select r.room_key, left(r.title, 512) as title, r.version from rooms r where ${visible}`
  let after = ''
  if (cursor) {
    params.push(...cursor.after)
    after = `where (room_key, uid) > ($${params.length - 1}, $${params.length})`
  }
  params.push(limit + 1)
  const result = await db.query(`with visible_rooms as materialized (${rooms}), candidates as (
    select n.room_key, r.title as room_title, r.version as room_version, n.uid, n.parent_uid,
      n.node_version, left(${titleSql("n.data->>'text'")}, 1024) as text,
      length(${titleSql("n.data->>'text'")}) > 1024 as text_truncated, 'room_nodes'::text as source
    from room_nodes n join visible_rooms r on r.room_key = n.room_key
    where n.deleted_at is null and ${matchSql("n.data->>'text'")}
    union all
    select r.room_key, r.title, r.version, j.key, null::text, r.version,
      left(${titleSql("j.value->'data'->>'text'")}, 1024), length(${titleSql("j.value->'data'->>'text'")}) > 1024, 'legacy_json'::text
    from visible_rooms r join rooms legacy on legacy.room_key = r.room_key
    cross join lateral jsonb_each(case when jsonb_typeof(legacy.nodes) = 'object' then legacy.nodes else '{}'::jsonb end) j
    where not exists(select 1 from room_nodes n where n.room_key = r.room_key)
      and ${matchSql("j.value->'data'->>'text'")}
  ) select * from candidates ${after} order by room_key, uid limit $${params.length}`, params)

  // Unknown COS-only rooms must not silently disappear from an "all maps" scan.
  const coverageParams = []
  const coverageAccess = accessibleSql(actor, coverageParams)
  const coverage = await db.query(`with missing as materialized (select r.room_key from rooms r
    where r.deleted_at is null and not exists(select 1 from room_tombstones t where t.room_key = r.room_key)
      and ${coverageAccess} and not exists(select 1 from room_nodes n where n.room_key = r.room_key)
      and (r.nodes is null or jsonb_typeof(r.nodes) <> 'object' or not exists(
        select 1 from jsonb_each(case when jsonb_typeof(r.nodes) = 'object' then r.nodes else '{}'::jsonb end) j
        where jsonb_typeof(j.value->'data') = 'object')))
    select (select count(*)::int from missing) as unindexed_room_count,
      coalesce((select jsonb_agg(room_key) from (select room_key from missing order by room_key limit 20) sample), '[]'::jsonb) as unindexed_room_keys_sample`, coverageParams)
  const items = result.rows.slice(0, limit)
  const hasMore = result.rows.length > limit
  const missing = Number(coverage.rows[0].unindexed_room_count)
  const last = items[items.length - 1]
  return {
    items, limit, has_more: hasMore,
    next_cursor: hasMore ? encodeCursor({ v: 1, principal: principal(actor), after: [last.room_key, last.uid], expires: cursor ? cursor.expires : Date.now() + CURSOR_TTL_MS }) : null,
    complete: !hasMore && missing === 0,
    coverage: { unindexed_room_count: missing, unindexed_room_keys_sample: coverage.rows[0].unindexed_room_keys_sample },
    ...(missing ? { incomplete_reason: '部分可见脑图尚无数据库节点内容；需先读取/迁移这些脑图后重新扫描，不能声称已覆盖全部脑图。' } : {}),
    consistency: 'live_keyset',
    match: { node_type: 'D', field: 'title', contains: '自动' }
  }
}

async function listAutomaticDNodes(pool, actor, input = {}) {
  const db = await pool.connect()
  try {
    await db.query('begin isolation level repeatable read read only')
    await db.query("set local statement_timeout = '15000ms'")
    const page = await queryPage(db, actor, input)
    await db.query('commit')
    return page
  } catch (err) {
    await db.query('rollback').catch(() => {})
    if (err.code === '57014') throw Object.assign(new Error('自动 D 节点查询超时，请稍后重试或减少每页数量'), { code: 'QUERY_TIMEOUT', statusCode: 504 })
    throw err
  } finally { db.release() }
}

module.exports = { titleSql, matchSql, INDEX_SQL, listAutomaticDNodes, decodeCursor, encodeCursor }
