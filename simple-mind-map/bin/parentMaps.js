// Reverse only direct node mapRef edges; never traverse ancestors or history.
const { normalizeMapRef } = require('../src/utils/mapRef')
const acl = require('./roomAcl')
const { encodeCursor, decodeCursor } = require('./fileSystem/model')

async function listParentMaps(db, req, roomKey, input = {}) {
  await acl.assertRoomAccess(db, req, roomKey, 'view')
  const limit = Math.min(100, Math.max(1, Math.floor(Number(input.limit) || 20)))
  const q = String(input.q || '').trim().slice(0, 80)
  const cursor = decodeCursor(input.cursor)
  if (input.cursor && (!cursor || cursor.room !== roomKey || cursor.q !== q || typeof cursor.after !== 'string')) {
    throw acl.aclError(400, 'INVALID_CURSOR', '分页状态已失效，请重新查询')
  }
  const actor = acl.actorFromReq(req)
  // Cookie-granted rooms remain candidates; the shared ACL verifies the token.
  const shareIds = Array.from(String((req.headers && req.headers.cookie) || '').matchAll(/(?:^|;\s*)mind_map_share_[0-9a-f]{16}=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\./gi), match => match[1])
  const escaped = value => value.replace(/[%_\\]/g, ch => '\\' + ch)
  // String refs include old serialized JSON: SQL narrows candidates, then the
  // shared normalizer confirms the exact edge (no substring false positives).
  const result = await db.query(`
    with refs as (
      select n.room_key, n.data -> 'mapRef' as ref
      from room_nodes n where n.deleted_at is null and n.data ? 'mapRef'
      union all
      select r.room_key, item.value -> 'data' -> 'mapRef' as ref
      from rooms r cross join lateral jsonb_each(
        case when jsonb_typeof(r.nodes) = 'object' then r.nodes else '{}'::jsonb end
      ) item
      where not exists (select 1 from room_nodes n where n.room_key = r.room_key and n.is_root and n.deleted_at is null)
        and coalesce((item.value ->> 'deleted')::text, 'false') <> 'true'
        and item.value -> 'data' ? 'mapRef'
    )
    select r.room_key, r.title, jsonb_agg(distinct refs.ref) as refs
    from refs join rooms r on r.room_key = refs.room_key
    where r.room_key <> $1 and r.room_key > $2
      and r.deleted_at is null
      and not exists (select 1 from room_tombstones t where t.room_key = r.room_key)
      and ($6::boolean or (
        exists (select 1 from room_members m where m.room_key = r.room_key and m.user_id = $7 and m.role in ('owner', 'editor', 'viewer'))
        or not exists (select 1 from room_members m where m.room_key = r.room_key)
        ${shareIds.length ? 'or exists (select 1 from node_shares s where s.room_key = r.room_key and s.id = any($8::uuid[]) and s.revoked_at is null and (s.expires_at is null or s.expires_at > now()))' : 'or cardinality($8::uuid[]) > 0'}
      ))
      and coalesce(r.title, '') ilike $3 escape '\\'
      and (
        btrim(coalesce(nullif(refs.ref ->> 'mapId', ''), nullif(refs.ref ->> 'map_id', ''), refs.ref ->> 'room_key')) = $1
        or (jsonb_typeof(refs.ref) = 'string' and (refs.ref #>> '{}') like $4 escape '\\')
      )
    group by r.room_key, r.title
    order by r.room_key limit $5
  `, [roomKey, cursor ? cursor.after : '', '%' + escaped(q) + '%', '%' + escaped(roomKey) + '%', limit + 1, actor.bypass, actor.id, shareIds])
  const candidates = result.rows.slice(0, limit)
  const list = []
  for (const row of candidates) {
    if (!row.refs.some(ref => { const value = normalizeMapRef(ref); return value && value.mapId === roomKey })) continue
    try {
      const access = await acl.assertRoomAccess(db, req, row.room_key, 'view')
      if (access.exists && access.canView) list.push({ roomKey: row.room_key, title: row.title || '未命名' })
    } catch (err) {
      // Only known inaccessible/deleted targets are filtered. DB failures must
      // surface as failures, never as an empty result or a partial success.
      if (![401, 403, 404].includes(err.statusCode)) throw err
    }
  }
  const hasMore = result.rows.length > limit
  return {
    list, hasMore,
    nextCursor: hasMore ? encodeCursor({ room: roomKey, q, after: candidates[candidates.length - 1].room_key }) : null
  }
}
module.exports = { listParentMaps }
