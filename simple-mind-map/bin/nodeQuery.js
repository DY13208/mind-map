const crypto = require('crypto')
const { stripHtml } = require('./mindDoc')

const DEFAULT_PAGE_SIZE = 800
const MAX_PAGE_SIZE = 5000
const DEFAULT_BYTE_LIMIT = 20 * 1024
const QUERY_TIMEOUT_MS = 20000
const MAX_CANDIDATES = 200
const RESPONSE_CURSOR_RESERVE_BYTES = 768

function queryError(message, code, statusCode = 400, extra = {}) {
  const err = new Error(message)
  err.code = code
  err.statusCode = statusCode
  Object.assign(err, extra)
  return err
}

function normalizeName(value) {
  return String(value == null ? '' : value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function compactPathLabel(value) {
  const plain = stripHtml(value)
  if (Buffer.byteLength(plain, 'utf8') <= 512) return plain
  return `${utf8Chunk(plain, 509).value}…`
}

function stableJson(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
}

function queryFingerprint(input) {
  return crypto.createHash('sha256').update(stableJson(input)).digest('base64url')
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function decodeCursor(value) {
  if (!value) return null
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'))
    if (!parsed || typeof parsed !== 'object') throw new Error('invalid cursor')
    return parsed
  } catch (_) {
    throw queryError('分页游标无效，请从第一页重新读取', 'INVALID_CURSOR', 400)
  }
}

function positiveInt(value, fallback, max) {
  if (value == null || value === '') return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0 || n > max) {
    throw queryError(`参数必须是 0 到 ${max} 的整数`, 'INVALID_QUERY')
  }
  return n
}

function normalizeRequest(input = {}) {
  const scope = String(input.scope || 'self')
  if (!['self', 'children', 'subtree', 'path', 'level'].includes(scope)) {
    throw queryError('scope 仅支持 self、children、subtree、path 或 level', 'INVALID_QUERY')
  }
  const levelMode = String(input.level_mode || 'absolute')
  if (!['absolute', 'relative'].includes(levelMode)) {
    throw queryError('level_mode 仅支持 absolute 或 relative', 'INVALID_QUERY')
  }
  const pageSize = positiveInt(input.page_size, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
  if (!pageSize) throw queryError('page_size 必须大于 0', 'INVALID_QUERY')
  const byteLimit = input.byte_limit == null
    ? DEFAULT_BYTE_LIMIT
    : positiveInt(input.byte_limit, DEFAULT_BYTE_LIMIT, DEFAULT_BYTE_LIMIT)
  if (!byteLimit) throw queryError('byte_limit 必须大于 0', 'INVALID_QUERY')

  let selector = input.selector || null
  if (selector != null && (typeof selector !== 'object' || Array.isArray(selector))) {
    throw queryError('selector 必须是对象', 'INVALID_QUERY')
  }
  if (!selector && !(scope === 'level' && levelMode === 'absolute')) {
    throw queryError('此读取范围必须指定 selector', 'MISSING_SELECTOR')
  }
  if (scope === 'level' && input.level == null) {
    throw queryError('scope=level 时必须提供 level', 'MISSING_LEVEL')
  }
  if (scope === 'level' && levelMode === 'absolute' && selector) {
    throw queryError('全图绝对层级读取不应提供 selector；请使用 relative 读取指定节点下的层级', 'INVALID_QUERY')
  }
  if (scope === 'level' && levelMode === 'relative' && !selector) {
    throw queryError('相对层级读取必须指定 selector', 'MISSING_SELECTOR')
  }

  if (selector) {
    const type = String(selector.type || '')
    if (!['uid', 'name', 'path'].includes(type)) {
      throw queryError('selector.type 仅支持 uid、name 或 path', 'INVALID_SELECTOR')
    }
    const match = String(selector.match || 'exact')
    if (!['exact', 'fuzzy'].includes(match)) {
      throw queryError('selector.match 仅支持 exact 或 fuzzy', 'INVALID_SELECTOR')
    }
    if (type !== 'name' && match !== 'exact') {
      throw queryError('只有名称选择器支持 fuzzy 匹配', 'INVALID_SELECTOR')
    }
    if (type === 'path') {
      if (!Array.isArray(selector.segments) || !selector.segments.length || selector.segments.some(item => !normalizeName(item))) {
        throw queryError('路径 selector 必须提供非空 segments 数组', 'INVALID_SELECTOR')
      }
      selector = { type, match, segments: selector.segments.map(item => String(item)) }
    } else {
      const value = String(selector.value || '').trim()
      if (!value) throw queryError('selector.value 不能为空', 'INVALID_SELECTOR')
      selector = { type, match, value }
    }
  }

  return {
    scope,
    selector,
    level: scope === 'level' ? positiveInt(input.level, 0, 100000) : null,
    level_mode: levelMode,
    page_size: pageSize,
    byte_limit: byteLimit,
    cursor: input.cursor ? String(input.cursor) : null
  }
}

async function withQueryTimeout(db, fn) {
  if (!db || typeof db.connect !== 'function') return fn(db)
  const client = await db.connect()
  try {
    await client.query('begin read only')
    await client.query(`set local statement_timeout = '${QUERY_TIMEOUT_MS}ms'`)
    const value = await fn(client)
    await client.query('commit')
    return value
  } catch (err) {
    await client.query('rollback').catch(() => {})
    if (err && err.code === '57014') {
      throw queryError('节点查询超时，请缩小检索范围或继续分页', 'QUERY_TIMEOUT', 504)
    }
    throw err
  } finally {
    client.release()
  }
}

async function roomVersion(db, roomKey) {
  const res = await db.query('select version from rooms where room_key = $1', [roomKey])
  if (!res.rows.length) throw queryError('导图不存在', 'MAP_NOT_FOUND', 404)
  return Number(res.rows[0].version || 0)
}

async function rootUid(db, roomKey) {
  const res = await db.query(
    `select uid from room_nodes
     where room_key = $1 and is_root and deleted_at is null
     limit 1`,
    [roomKey]
  )
  return res.rows[0] ? String(res.rows[0].uid) : ''
}

async function nodeRows(db, roomKey, uids) {
  if (!uids.length) return []
  const res = await db.query(
    `select uid, parent_uid, position, data, is_root
     from room_nodes
     where room_key = $1 and uid = any($2::text[]) and deleted_at is null`,
    [roomKey, uids]
  )
  return res.rows
}

async function pathsForUids(db, roomKey, uids) {
  if (!uids.length) return new Map()
  const res = await db.query(
    `with recursive ancestors as (
       select n.uid as target_uid, n.uid, n.parent_uid, n.data->>'text' as text,
              0 as depth, array[n.uid]::text[] as trail, false as cycle
       from room_nodes n
       where n.room_key = $1 and n.uid = any($2::text[]) and n.deleted_at is null
       union all
       select a.target_uid, p.uid, p.parent_uid, p.data->>'text',
              a.depth + 1, a.trail || p.uid, p.uid = any(a.trail)
       from ancestors a
       join room_nodes p on p.room_key = $1 and p.uid = a.parent_uid and p.deleted_at is null
       where not a.cycle
     )
     select target_uid,
            array_agg(text order by depth desc) as path_parts,
            max(depth)::int as absolute_depth,
            bool_or(cycle) as has_cycle
     from ancestors
     group by target_uid`,
    [roomKey, uids]
  )
  const out = new Map()
  res.rows.forEach(row => {
    out.set(String(row.target_uid), {
      path: (row.path_parts || []).map(compactPathLabel),
      depth: Number(row.absolute_depth || 0),
      hasCycle: !!row.has_cycle
    })
  })
  if (Array.from(out.values()).some(item => item.hasCycle)) {
    throw queryError('导图节点关系存在循环，无法安全读取', 'NODE_GRAPH_CYCLE', 409)
  }
  return out
}

async function candidateDetails(db, roomKey, rows) {
  const paths = await pathsForUids(db, roomKey, rows.map(row => String(row.uid)))
  return rows.map(row => {
    const info = paths.get(String(row.uid)) || { path: [], depth: 0 }
    return {
      uid: String(row.uid),
      parent_uid: row.parent_uid || null,
      path: info.path,
      depth: info.depth,
      text: stripHtml(row.text || (row.data && row.data.text) || '')
    }
  })
}

function boundedCandidates(candidates, byteLimit) {
  const out = []
  for (const candidate of candidates || []) {
    if (jsonBytes({ candidates: [...out, candidate], next_cursor: 'x'.repeat(256) }) > byteLimit - 2048) break
    out.push(candidate)
  }
  return { candidates: out, truncated: out.length < (candidates || []).length }
}

async function resolveSelector(db, roomKey, selector, byteLimit) {
  if (!selector) {
    const uid = await rootUid(db, roomKey)
    if (!uid) throw queryError('导图没有可读取的根节点', 'NODE_TABLE_UNINITIALIZED', 409)
    return { uid }
  }
  if (selector.type === 'uid') {
    const rows = await nodeRows(db, roomKey, [selector.value])
    if (!rows.length) throw queryError('节点不存在', 'NODE_NOT_FOUND', 404)
    return { uid: String(rows[0].uid) }
  }
  if (selector.type === 'path') {
    const parts = selector.segments.map(normalizeName)
    const res = await db.query(
      `with recursive path_steps(step, search_name) as (
         select ordinality::int - 1, value
         from unnest($2::text[]) with ordinality as s(value, ordinality)
       ), walk(uid, step) as (
         select n.uid, 0
         from room_nodes n
         join path_steps p on p.step = 0 and n.search_name = p.search_name
         where n.room_key = $1 and n.is_root and n.deleted_at is null
         union all
         select n.uid, w.step + 1
         from walk w
         join path_steps p on p.step = w.step + 1
         join room_nodes n on n.room_key = $1 and n.parent_uid = w.uid
           and n.search_name = p.search_name and n.deleted_at is null
       )
       select n.uid, n.parent_uid, n.data->>'text' as text
       from walk w
       join room_nodes n on n.room_key = $1 and n.uid = w.uid and n.deleted_at is null
       where w.step = cardinality($2::text[]) - 1
       order by n.uid
       limit $3`,
      [roomKey, parts, MAX_CANDIDATES + 1]
    )
    if (!res.rows.length) throw queryError('未找到完全匹配的节点链路', 'NODE_NOT_FOUND', 404)
    if (res.rows.length > 1) {
      const bounded = boundedCandidates(
        await candidateDetails(db, roomKey, res.rows.slice(0, MAX_CANDIDATES)),
        byteLimit
      )
      throw queryError('完整链路仍匹配到多个节点，请使用 UID', 'NODE_AMBIGUOUS', 409, {
        candidates: bounded.candidates,
        candidates_truncated: bounded.truncated || res.rows.length > MAX_CANDIDATES
      })
    }
    return { uid: String(res.rows[0].uid) }
  }

  const name = normalizeName(selector.value)
  if (!name) throw queryError('节点名称不能为空', 'INVALID_SELECTOR')
  if (selector.match === 'fuzzy') {
    // Never allow the similarity predicate to degrade to an unbounded scan.
    // The index is intentionally checked by name because a partially applied
    // migration may have installed the extension but not the GIN index.
    const index = await db.query(
      `select coalesce(i.indisvalid, false) as ready
       from pg_class c
       left join pg_index i on i.indexrelid = c.oid
       where c.oid = to_regclass('room_nodes_search_name_trgm_idx')`
    )
    if (!index.rows[0] || !index.rows[0].ready) {
      throw queryError('模糊检索索引不可用，请先执行 003_node_query.sql', 'SEARCH_INDEX_UNAVAILABLE', 503)
    }
    let result
    try {
      result = await db.query(
        `select uid, parent_uid, data->>'text' as text, similarity(search_name, $2) as score
         from room_nodes
         where room_key = $1 and deleted_at is null and search_name % $2
         order by score desc, uid
         limit $3`,
        [roomKey, name, MAX_CANDIDATES]
      )
    } catch (err) {
      if (err && (err.code === '42883' || err.code === '42704' || err.code === '42703')) {
        throw queryError('模糊检索索引不可用，请先执行 003_node_query.sql', 'SEARCH_INDEX_UNAVAILABLE', 503)
      }
      throw err
    }
    const candidates = (await candidateDetails(db, roomKey, result.rows)).map((item, index) => ({
        ...item,
        score: Number(result.rows[index].score || 0)
      }))
    const bounded = boundedCandidates(candidates, byteLimit)
    return { candidates: bounded.candidates, candidatesTruncated: bounded.truncated }
  }

  let res
  try {
    res = await db.query(
      `select uid, parent_uid, data->>'text' as text
       from room_nodes
       where room_key = $1 and deleted_at is null and search_name = $2
       order by uid
       limit $3`,
      [roomKey, name, MAX_CANDIDATES + 1]
    )
  } catch (err) {
    if (err && err.code === '42703') {
      throw queryError('节点检索迁移尚未生效，请先执行 003_node_query.sql', 'QUERY_SCHEMA_UNAVAILABLE', 503)
    }
    throw err
  }
  if (!res.rows.length) throw queryError('节点不存在', 'NODE_NOT_FOUND', 404)
  if (res.rows.length > 1) {
    const bounded = boundedCandidates(
      await candidateDetails(db, roomKey, res.rows.slice(0, MAX_CANDIDATES)),
      byteLimit
    )
    throw queryError('存在同名节点，请使用 UID 或完整路径', 'NODE_AMBIGUOUS', 409, {
      candidates: bounded.candidates,
      candidates_truncated: bounded.truncated || res.rows.length > MAX_CANDIDATES
    })
  }
  return { uid: String(res.rows[0].uid) }
}

async function selectScopeRows(db, roomKey, targetUid, request, offset) {
  const limit = request.page_size + 1
  if (request.scope === 'self') {
    if (offset > 0) return []
    return nodeRows(db, roomKey, [targetUid]).then(rows => rows.map(row => ({ ...row, relative_depth: 0 })))
  }
  if (request.scope === 'children') {
    const res = await db.query(
      `select uid, parent_uid, position, data, is_root, 1::int as relative_depth
       from room_nodes
       where room_key = $1 and parent_uid = $2 and deleted_at is null
       order by position, uid offset $3 limit $4`,
      [roomKey, targetUid, offset, limit]
    )
    return res.rows
  }
  if (request.scope === 'subtree' || request.scope === 'level') {
    const targetDepth = request.scope === 'level' ? request.level : null
    const res = await db.query(
      `with recursive walk(uid, parent_uid, position, relative_depth, sort_path, trail, cycle) as (
         select n.uid, n.parent_uid, n.position, 0::int,
                array[coalesce(n.position, ''), n.uid]::text[], array[n.uid]::text[], false
         from room_nodes n
         where n.room_key = $1 and n.uid = $2 and n.deleted_at is null
         union all
         select n.uid, n.parent_uid, n.position, w.relative_depth + 1,
                w.sort_path || array[coalesce(n.position, ''), n.uid], w.trail || n.uid,
                n.uid = any(w.trail)
         from walk w
         join room_nodes n on n.room_key = $1 and n.parent_uid = w.uid and n.deleted_at is null
         where not w.cycle and ($3::int is null or w.relative_depth < $3)
       )
       select n.uid, n.parent_uid, n.position, n.data, n.is_root, w.relative_depth, w.cycle,
              bool_or(w.cycle) over() as has_cycle
       from walk w
       join room_nodes n on n.room_key = $1 and n.uid = w.uid and n.deleted_at is null
       where ($3::int is null or w.relative_depth = $3)
       order by w.sort_path
       offset $4 limit $5`,
      [roomKey, targetUid, targetDepth, offset, limit]
    )
    if (res.rows.some(row => row.cycle || row.has_cycle)) {
      throw queryError('导图节点关系存在循环，无法安全读取', 'NODE_GRAPH_CYCLE', 409)
    }
    return res.rows
  }
  if (request.scope === 'path') {
    const res = await db.query(
      `with recursive ancestors(uid, parent_uid, position, relative_depth, trail, cycle) as (
         select n.uid, n.parent_uid, n.position, 0::int, array[n.uid]::text[], false
         from room_nodes n
         where n.room_key = $1 and n.uid = $2 and n.deleted_at is null
         union all
         select p.uid, p.parent_uid, p.position, a.relative_depth - 1,
                a.trail || p.uid, p.uid = any(a.trail)
         from ancestors a
         join room_nodes p on p.room_key = $1 and p.uid = a.parent_uid and p.deleted_at is null
         where not a.cycle
       )
       select n.uid, n.parent_uid, n.position, n.data, n.is_root, a.relative_depth, a.cycle
       from ancestors a
       join room_nodes n on n.room_key = $1 and n.uid = a.uid and n.deleted_at is null
       order by a.relative_depth asc
       offset $3 limit $4`,
      [roomKey, targetUid, offset, limit]
    )
    if (res.rows.some(row => row.cycle)) {
      throw queryError('导图节点关系存在循环，无法安全读取', 'NODE_GRAPH_CYCLE', 409)
    }
    return res.rows
  }
  throw queryError('不支持的读取范围', 'INVALID_QUERY')
}

function cloneData(data) {
  return JSON.parse(JSON.stringify(data && typeof data === 'object' ? data : {}))
}

function cleanData(data, omitted) {
  const next = cloneData(data)
  if (Object.prototype.hasOwnProperty.call(next, 'imgMap')) {
    delete next.imgMap
    omitted.add('data.imgMap')
  }
  if (typeof next.image === 'string' && /^data:/i.test(next.image)) {
    next.image = null
    omitted.add('data.image(base64)')
  }
  return next
}

function itemFromRow(row, pathInfo, targetDepth, omitted) {
  const uid = String(row.uid)
  const absoluteDepth = Number(pathInfo && pathInfo.depth || 0)
  return {
    uid,
    parent_uid: row.parent_uid || null,
    depth: absoluteDepth,
    relative_depth: targetDepth == null ? Number(row.relative_depth || 0) : absoluteDepth - targetDepth,
    position: row.position || '',
    path: (pathInfo && pathInfo.path) || [],
    data: cleanData(row.data, omitted)
  }
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function utf8Chunk(value, maxBytes) {
  let end = 0
  let bytes = 0
  const raw = String(value || '')
  for (const ch of raw) {
    const n = Buffer.byteLength(ch, 'utf8')
    if (bytes + n > maxBytes) break
    bytes += n
    end += ch.length
  }
  return { value: raw.slice(0, end), length: end }
}

function fragmentFields(data) {
  return ['text', 'note'].filter(field => typeof data[field] === 'string' && data[field].length)
}

function fragmentItem(item, state, byteLimit, omitted) {
  const source = cloneData(item.data)
  const fields = state && Array.isArray(state.fields) ? state.fields : fragmentFields(source)
  if (!fields.length) {
    throw queryError('单个节点元数据超过输出预算，无法安全分片', 'NODE_TOO_LARGE', 413)
  }
  const index = state ? Number(state.index || 0) : 0
  const field = fields[index]
  if (!field || typeof source[field] !== 'string') {
    throw queryError('节点内容分片游标无效', 'INVALID_CURSOR', 400)
  }
  const rawValue = source[field]
  fields.forEach(name => delete source[name])
  const offset = state ? Number(state.offset || 0) : 0
  const overhead = jsonBytes({ ...item, data: source, content_fragment: { field, offset, value: '', complete: false, fields } }) + 512
  // Reserve the outer response envelope, version-bound cursor and warnings.
  // The fragment itself is nested in an item, so sizing only the item would
  // otherwise allow the final JSON response to exceed its hard budget.
  const chunk = utf8Chunk(rawValue.slice(offset), Math.max(1, byteLimit - overhead - 2048))
  if (!chunk.length) throw queryError('单个节点元数据超过输出预算，无法安全分片', 'NODE_TOO_LARGE', 413)
  const complete = offset + chunk.length >= rawValue.length
  omitted.add(`data.${field}(fragmented)`)
  return {
    item: {
      ...item,
      data: source,
      content_fragment: { field, offset, value: chunk.value, complete, fields }
    },
    nextFragment: complete
      ? (index + 1 < fields.length ? { ...state, fields, index: index + 1, offset: 0 } : null)
      : { ...state, fields, index, offset: offset + chunk.length }
  }
}

function responseFitsByteLimit({ roomKey, version, target, scope, items, byteLimit, omitted }) {
  return jsonBytes({
    room_key: roomKey,
    version,
    resolved_target: target,
    scope,
    items,
    has_more: true,
    next_cursor: 'x'.repeat(RESPONSE_CURSOR_RESERVE_BYTES),
    byte_limit: byteLimit,
    omitted_fields: Array.from(omitted),
    warnings: []
  }) <= byteLimit
}

async function itemForFragment(db, roomKey, state, targetDepth, omitted) {
  const rows = await nodeRows(db, roomKey, [state.uid])
  if (!rows.length) throw queryError('节点已不存在，请从第一页重新读取', 'STALE_CURSOR', 409)
  const paths = await pathsForUids(db, roomKey, [state.uid])
  return itemFromRow(rows[0], paths.get(state.uid), targetDepth, omitted)
}

function cursorFor(fingerprint, version, offset, fragment) {
  return encodeCursor({ v: 1, q: fingerprint, version, offset, ...(fragment ? { fragment } : {}) })
}

async function queryRoomNodes(db, roomKey, input) {
  const request = normalizeRequest(input)
  const fingerprint = queryFingerprint({
    scope: request.scope,
    selector: request.selector,
    level: request.level,
    level_mode: request.level_mode,
    page_size: request.page_size,
    byte_limit: request.byte_limit
  })
  const cursor = decodeCursor(request.cursor)
  if (cursor && cursor.q !== fingerprint) {
    throw queryError('分页游标与当前查询条件不一致，请从第一页重新读取', 'INVALID_CURSOR', 400)
  }

  return withQueryTimeout(db, async client => {
    const version = await roomVersion(client, roomKey)
    if (cursor && Number(cursor.version) !== version) {
      throw queryError('导图内容已变化，请从第一页重新读取', 'STALE_CURSOR', 409)
    }
    const selector = request.scope === 'level' && request.level_mode === 'absolute'
      ? null
      : request.selector
    const resolved = await resolveSelector(client, roomKey, selector, request.byte_limit)
    if (resolved.candidates) {
      return {
        room_key: roomKey,
        version,
        scope: request.scope,
        match_status: 'candidates',
        candidates: resolved.candidates,
        has_more: false,
        next_cursor: null,
        byte_limit: request.byte_limit,
        omitted_fields: [],
        warnings: resolved.candidatesTruncated
          ? ['候选过多，已按输出预算截取；请使用更精确名称或路径']
          : []
      }
    }
    const targetUid = resolved.uid
    const targetPath = await pathsForUids(client, roomKey, [targetUid])
    const targetInfo = targetPath.get(targetUid)
    if (!targetInfo) throw queryError('节点不存在', 'NODE_NOT_FOUND', 404)

    const offset = cursor ? Number(cursor.offset || 0) : 0
    const omitted = new Set(['data.imgMap'])
    if (cursor && cursor.fragment) {
      const item = await itemForFragment(client, roomKey, cursor.fragment, targetInfo.depth, omitted)
      const fragmented = fragmentItem(item, cursor.fragment, request.byte_limit, omitted)
      const nextCursor = fragmented.nextFragment
        ? cursorFor(fingerprint, version, offset, fragmented.nextFragment)
        : cursorFor(fingerprint, version, Number(cursor.fragment.after_offset || offset), null)
      return {
        room_key: roomKey,
        version,
        resolved_target: { uid: targetUid, path: targetInfo.path },
        scope: request.scope,
        items: [fragmented.item],
        has_more: true,
        next_cursor: nextCursor,
        byte_limit: request.byte_limit,
        omitted_fields: Array.from(omitted),
        warnings: ['节点长文本已按字段分片；请使用 next_cursor 继续读取']
      }
    }

    const rows = await selectScopeRows(client, roomKey, targetUid, request, offset)
    const hasSqlMore = rows.length > request.page_size
    const pageRows = rows.slice(0, request.page_size)
    const paths = await pathsForUids(client, roomKey, pageRows.map(row => String(row.uid)))
    const items = []
    let pendingFragment = null
    for (let index = 0; index < pageRows.length; index += 1) {
      const row = pageRows[index]
      const item = itemFromRow(row, paths.get(String(row.uid)), targetInfo.depth, omitted)
      if (responseFitsByteLimit({
        roomKey,
        version,
        target: { uid: targetUid, path: targetInfo.path },
        scope: request.scope,
        items: [...items, item],
        byteLimit: request.byte_limit,
        omitted
      })) {
        items.push(item)
        continue
      }
      if (!items.length) {
        const fragment = fragmentItem(item, {
          uid: item.uid,
          after_offset: offset + 1,
          fields: fragmentFields(item.data),
          index: 0,
          offset: 0
        }, request.byte_limit, omitted)
        items.push(fragment.item)
        pendingFragment = fragment.nextFragment
        if (pendingFragment) pendingFragment.after_offset = offset + 1
      } else {
        pendingFragment = {
          uid: item.uid,
          after_offset: offset + items.length + 1,
          fields: fragmentFields(item.data),
          index: 0,
          offset: 0
        }
      }
      break
    }
    const emitted = items.length
    const hasMore = !!pendingFragment || hasSqlMore || emitted < pageRows.length
    const nextOffset = offset + emitted
    return {
      room_key: roomKey,
      version,
      resolved_target: { uid: targetUid, path: targetInfo.path },
      scope: request.scope,
      items,
      has_more: hasMore,
      next_cursor: hasMore ? cursorFor(fingerprint, version, nextOffset, pendingFragment) : null,
      byte_limit: request.byte_limit,
      omitted_fields: Array.from(omitted),
      warnings: []
    }
  })
}

function legacyParentMap(obj) {
  const parents = {}
  Object.keys(obj || {}).forEach(uid => {
    ;((obj[uid] && obj[uid].children) || []).forEach(child => {
      if (obj[child]) parents[child] = uid
    })
  })
  return parents
}

function legacyPathInfo(obj, uid, parents) {
  const ids = []
  const seen = new Set()
  let current = uid
  while (current) {
    if (seen.has(current)) throw queryError('导图节点关系存在循环，无法安全读取', 'NODE_GRAPH_CYCLE', 409)
    seen.add(current)
    const node = obj[current]
    if (!node) break
    ids.unshift(current)
    if (node.isRoot) break
    current = parents[current]
  }
  return {
    path: ids.map(id => compactPathLabel(obj[id].data && obj[id].data.text)),
    depth: Math.max(0, ids.length - 1)
  }
}

function legacyCandidates(obj, uids, parents, byteLimit) {
  return boundedCandidates(
    uids.map(uid => {
      const node = obj[uid]
      const info = legacyPathInfo(obj, uid, parents)
      return {
        uid,
        parent_uid: parents[uid] || null,
        path: info.path,
        depth: info.depth,
        text: stripHtml(node && node.data && node.data.text)
      }
    }),
    byteLimit
  )
}

function sortLegacyChildren(obj, uids) {
  return [...(uids || [])]
    .filter(uid => obj[uid])
    .sort((a, b) => {
      const pa = String(obj[a].position || '')
      const pb = String(obj[b].position || '')
      return pa.localeCompare(pb) || String(a).localeCompare(String(b))
    })
}

function resolveLegacySelector(obj, selector, parents, byteLimit) {
  const root = Object.keys(obj || {}).find(uid => obj[uid] && obj[uid].isRoot) || Object.keys(obj || {})[0]
  if (!root) throw queryError('导图没有可读取的根节点', 'NODE_NOT_FOUND', 404)
  if (!selector) return { uid: root }
  if (selector.type === 'uid') {
    if (!obj[selector.value]) throw queryError('节点不存在', 'NODE_NOT_FOUND', 404)
    return { uid: selector.value }
  }
  if (selector.type === 'name') {
    if (selector.match === 'fuzzy') {
      throw queryError('旧版导图未建立模糊检索索引，请先完成节点表迁移', 'SEARCH_INDEX_UNAVAILABLE', 503)
    }
    const name = normalizeName(selector.value)
    const matches = Object.keys(obj).filter(uid => normalizeName(obj[uid].data && obj[uid].data.text) === name)
    if (!matches.length) throw queryError('节点不存在', 'NODE_NOT_FOUND', 404)
    if (matches.length > 1) {
      const bounded = legacyCandidates(obj, matches, parents, byteLimit)
      throw queryError('存在同名节点，请使用 UID 或完整路径', 'NODE_AMBIGUOUS', 409, {
        candidates: bounded.candidates,
        candidates_truncated: bounded.truncated
      })
    }
    return { uid: matches[0] }
  }
  let candidates = normalizeName(obj[root].data && obj[root].data.text) === normalizeName(selector.segments[0]) ? [root] : []
  for (let index = 1; index < selector.segments.length && candidates.length; index += 1) {
    const expected = normalizeName(selector.segments[index])
    candidates = candidates.flatMap(uid => sortLegacyChildren(obj, obj[uid].children)
      .filter(child => normalizeName(obj[child].data && obj[child].data.text) === expected))
  }
  if (!candidates.length) throw queryError('未找到完全匹配的节点链路', 'NODE_NOT_FOUND', 404)
  if (candidates.length > 1) {
    const bounded = legacyCandidates(obj, candidates, parents, byteLimit)
    throw queryError('完整链路仍匹配到多个节点，请使用 UID', 'NODE_AMBIGUOUS', 409, {
      candidates: bounded.candidates,
      candidates_truncated: bounded.truncated
    })
  }
  return { uid: candidates[0] }
}

function legacyScopeRows(obj, targetUid, request, parents) {
  const asRow = (uid, relativeDepth) => ({
    uid,
    parent_uid: parents[uid] || null,
    position: obj[uid].position || '',
    data: obj[uid].data || {},
    is_root: !!obj[uid].isRoot,
    relative_depth: relativeDepth
  })
  if (request.scope === 'self') return [asRow(targetUid, 0)]
  if (request.scope === 'children') return sortLegacyChildren(obj, obj[targetUid].children).map(uid => asRow(uid, 1))
  if (request.scope === 'path') {
    const chain = []
    let current = targetUid
    const seen = new Set()
    while (current) {
      if (seen.has(current)) throw queryError('导图节点关系存在循环，无法安全读取', 'NODE_GRAPH_CYCLE', 409)
      seen.add(current)
      chain.unshift(current)
      if (obj[current].isRoot) break
      current = parents[current]
    }
    return chain.map(uid => asRow(uid, legacyPathInfo(obj, uid, parents).depth - legacyPathInfo(obj, targetUid, parents).depth))
  }
  const rows = []
  const walk = (uid, depth, seen) => {
    if (seen.has(uid)) throw queryError('导图节点关系存在循环，无法安全读取', 'NODE_GRAPH_CYCLE', 409)
    const nextSeen = new Set(seen)
    nextSeen.add(uid)
    if (request.scope === 'subtree' || depth === request.level) rows.push(asRow(uid, depth))
    if (request.scope === 'level' && depth >= request.level) return
    sortLegacyChildren(obj, obj[uid].children).forEach(child => walk(child, depth + 1, nextSeen))
  }
  walk(targetUid, 0, new Set())
  return rows
}

function queryLegacyNodes(obj, roomKey, version, input) {
  const request = normalizeRequest(input)
  const fingerprint = queryFingerprint({
    scope: request.scope,
    selector: request.selector,
    level: request.level,
    level_mode: request.level_mode,
    page_size: request.page_size,
    byte_limit: request.byte_limit
  })
  const cursor = decodeCursor(request.cursor)
  if (cursor && cursor.q !== fingerprint) {
    throw queryError('分页游标与当前查询条件不一致，请从第一页重新读取', 'INVALID_CURSOR', 400)
  }
  if (cursor && Number(cursor.version) !== Number(version || 0)) {
    throw queryError('导图内容已变化，请从第一页重新读取', 'STALE_CURSOR', 409)
  }
  const parents = legacyParentMap(obj)
  const selector = request.scope === 'level' && request.level_mode === 'absolute' ? null : request.selector
  const resolved = resolveLegacySelector(obj, selector, parents, request.byte_limit)
  const targetInfo = legacyPathInfo(obj, resolved.uid, parents)
  const rows = legacyScopeRows(obj, resolved.uid, request, parents)
  const offset = cursor ? Number(cursor.offset || 0) : 0
  const omitted = new Set(['data.imgMap'])
  if (cursor && cursor.fragment) {
    const row = rows.find(item => String(item.uid) === String(cursor.fragment.uid))
    if (!row) throw queryError('节点范围已变化，请从第一页重新读取', 'STALE_CURSOR', 409)
    const item = itemFromRow(row, legacyPathInfo(obj, row.uid, parents), targetInfo.depth, omitted)
    const fragmented = fragmentItem(item, cursor.fragment, request.byte_limit, omitted)
    const nextCursor = fragmented.nextFragment
      ? cursorFor(fingerprint, Number(version || 0), offset, fragmented.nextFragment)
      : cursorFor(fingerprint, Number(version || 0), Number(cursor.fragment.after_offset || offset), null)
    return {
      room_key: roomKey,
      version: Number(version || 0),
      resolved_target: { uid: resolved.uid, path: targetInfo.path },
      scope: request.scope,
      items: [fragmented.item],
      has_more: true,
      next_cursor: nextCursor,
      byte_limit: request.byte_limit,
      omitted_fields: Array.from(omitted),
      warnings: ['legacy_snapshot_fallback：该导图尚未建立 room_nodes，已使用兼容快照读取']
    }
  }
  const pageRows = rows.slice(offset, offset + request.page_size)
  const items = []
  let pendingFragment = null
  for (const row of pageRows) {
    const info = legacyPathInfo(obj, row.uid, parents)
    const item = itemFromRow(row, info, targetInfo.depth, omitted)
    if (!responseFitsByteLimit({
      roomKey,
      version: Number(version || 0),
      target: { uid: resolved.uid, path: targetInfo.path },
      scope: request.scope,
      items: [...items, item],
      byteLimit: request.byte_limit,
      omitted
    })) {
      if (!items.length) {
        const fragmented = fragmentItem(item, {
          uid: item.uid,
          after_offset: offset + 1,
          fields: fragmentFields(item.data),
          index: 0,
          offset: 0
        }, request.byte_limit, omitted)
        items.push(fragmented.item)
        pendingFragment = fragmented.nextFragment
        if (pendingFragment) pendingFragment.after_offset = offset + 1
      } else {
        pendingFragment = {
          uid: item.uid,
          after_offset: offset + items.length + 1,
          fields: fragmentFields(item.data),
          index: 0,
          offset: 0
        }
      }
      break
    }
    items.push(item)
  }
  const hasMore = !!pendingFragment || offset + items.length < rows.length
  return {
    room_key: roomKey,
    version: Number(version || 0),
    resolved_target: { uid: resolved.uid, path: targetInfo.path },
    scope: request.scope,
    items,
    has_more: hasMore,
    next_cursor: hasMore
      ? cursorFor(fingerprint, Number(version || 0), offset + items.length, pendingFragment)
      : null,
    byte_limit: request.byte_limit,
    omitted_fields: Array.from(omitted),
    warnings: ['legacy_snapshot_fallback：该导图尚未建立 room_nodes，已使用兼容快照读取']
  }
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  DEFAULT_BYTE_LIMIT,
  normalizeName,
  normalizeRequest,
  encodeCursor,
  decodeCursor,
  queryRoomNodes,
  queryLegacyNodes
}
