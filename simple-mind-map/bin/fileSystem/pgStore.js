const { randomUUID } = require('crypto')
const { replaceRoomNodes, canonicalizeNodes, validateNodeGraph } = require('../roomNodes')
const { DEFAULT_METADATA, normalizeTitle } = require('./model')

function createPgFileStore(pool) {
  let queryCount = 0
  function wrap(db) {
    const orig = db.query.bind(db)
    return {
      query: (sql, params) => {
        queryCount += 1
        return orig(sql, params)
      }
    }
  }

  return {
    kind: 'pg',
    get queryCount() {
      return queryCount
    },
    resetQueryCount() {
      queryCount = 0
    },
    async withTx(fn) {
      const client = await pool.connect()
      const db = wrap(client)
      try {
        await client.query('begin')
        const out = await fn(db)
        await client.query('commit')
        return out
      } catch (err) {
        await client.query('rollback').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },
    async isDeleted(roomKey) {
      queryCount += 1
      const res = await pool.query(
        `select 1 from room_tombstones where room_key = $1`,
        [roomKey]
      )
      return !!res.rows[0]
    },
    async getRoom(roomKey) {
      queryCount += 1
      const res = await pool.query(
        `select r.room_key, r.title, r.cos_key, r.version, r.metadata,
                r.folder_id, r.owner_id, r.created_at, r.updated_at,
                r.content_updated_at, r.deleted_at, r.deleted_by,
                r.deleted_from_folder_id
         from rooms r
         left join room_tombstones t on t.room_key = r.room_key
         where r.room_key = $1 and t.room_key is null`,
        [roomKey]
      )
      return res.rows[0] || null
    },
    async getNodes(roomKey) {
      queryCount += 1
      const { readRoomNodes } = require('../roomNodes')
      const table = await readRoomNodes(pool, roomKey)
      return (table && table.nodes) || {}
    },
    async operationCount(roomKey) {
      queryCount += 1
      const res = await pool.query(
        `select count(*)::int as n from room_operations where room_key = $1`,
        [roomKey]
      )
      return Number((res.rows[0] && res.rows[0].n) || 0)
    },
    async insertRoom(row, db) {
      const conn = db || pool
      if (!db) queryCount += 1
      const res = await conn.query(
        `insert into rooms
           (room_key, title, cos_key, nodes, version, metadata, folder_id,
           owner_id, team_id, created_at, updated_at, content_updated_at)
         values
           ($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7,$8,$9,now(),now(),now())
         returning room_key, title, cos_key, version, metadata, folder_id,
                   owner_id, team_id, created_at, updated_at, content_updated_at,
                   deleted_at, deleted_by, deleted_from_folder_id`,
        [
          row.room_key,
          normalizeTitle(row.title),
          row.cos_key || row.room_key + '.yjs',
          row.nodes ? JSON.stringify(row.nodes) : null,
          Number(row.version || 0),
          JSON.stringify(row.metadata || DEFAULT_METADATA),
          row.folder_id || null,
          row.owner_id || null,
          row.team_id || null
        ]
      )
      return res.rows[0]
    },
    async writeNodes(roomKey, graph, db) {
      const conn = db || pool
      const canonical = canonicalizeNodes(graph || {})
      const tree = canonical.ok ? canonical.nodes : graph
      const check = validateNodeGraph(tree)
      if (!check.ok) {
        const err = new Error('invalid root tree')
        err.code = 'INVALID_HISTORY_TREE'
        err.statusCode = 400
        throw err
      }
      await replaceRoomNodes(conn, roomKey, tree, 0, { allowRestore: true })
      return tree
    },
    async insertMember(row, db) {
      const conn = db || pool
      if (!db) queryCount += 1
      await conn.query(
        `insert into room_members
           (room_key, user_id, role, direct_role, team_role, source, source_team_id)
         values (
           $1, $2, $3,
           case when $4 = 'team' then null else $3 end,
           case when $4 = 'team' then $3 else null end,
           $4, $5
         )
         on conflict (room_key, user_id) do update set
           direct_role = case when excluded.team_role is null then excluded.direct_role else room_members.direct_role end,
           team_role = case when excluded.team_role is null then room_members.team_role else excluded.team_role end,
           role = case
             when coalesce(case when excluded.team_role is null then excluded.direct_role else room_members.direct_role end, '') = 'owner'
               or coalesce(case when excluded.team_role is null then room_members.team_role else excluded.team_role end, '') = 'owner' then 'owner'
             when coalesce(case when excluded.team_role is null then excluded.direct_role else room_members.direct_role end, '') = 'editor'
               or coalesce(case when excluded.team_role is null then room_members.team_role else excluded.team_role end, '') = 'editor' then 'editor'
             else 'viewer'
           end,
           source = case
             when coalesce(case when excluded.team_role is null then excluded.direct_role else room_members.direct_role end, '') <> '' then 'direct_share'
             else 'team'
           end,
           source_team_id = case
             when excluded.team_role is not null then excluded.source_team_id
             when room_members.team_role is not null then room_members.source_team_id
             else null
           end,
           updated_at = now()`,
        [row.room_key, row.user_id, row.role, row.source || 'direct_share', row.source_team_id || null]
      )
      return row
    },
    async listRoomsRaw(sql, params) {
      queryCount += 1
      const res = await pool.query(sql, params)
      return res.rows
    },
    async query(sql, params) {
      queryCount += 1
      return pool.query(sql, params)
    },
    async updateTitle(roomKey, title) {
      queryCount += 1
      const res = await pool.query(
        `update rooms set title = $2, updated_at = now()
         where room_key = $1
         returning room_key, title, folder_id, owner_id, version,
                   created_at, updated_at, content_updated_at`,
        [roomKey, normalizeTitle(title)]
      )
      return res.rows[0] || null
    },
    async updateFolder(roomKey, folderId) {
      queryCount += 1
      const before = await pool.query(
        `select version from rooms where room_key = $1`,
        [roomKey]
      )
      const nodes = await this.getNodes(roomKey)
      const res = await pool.query(
        `update rooms set folder_id = $2, updated_at = now()
         where room_key = $1
         returning room_key, title, folder_id, owner_id, version,
                   created_at, updated_at, content_updated_at`,
        [roomKey, folderId]
      )
      return {
        row: res.rows[0] || null,
        version: before.rows[0] ? Number(before.rows[0].version) : 0,
        nodes
      }
    },
    async getFolder(id) {
      queryCount += 1
      const res = await pool.query(
        `select * from folders where id = $1 and deleted_at is null`,
        [id]
      )
      return res.rows[0] || null
    },
    async listFolderMembers(id) {
      queryCount += 1
      const res = await pool.query(
        `select fm.folder_id, fm.user_id, fm.role, fm.created_at, fm.updated_at,
                coalesce(u.name, fm.user_id) as name, coalesce(u.avatar, '') as avatar,
                coalesce(u.wecom_userid, fm.user_id) as wecom_userid
         from folder_members fm left join wecom_users u on u.user_id = fm.user_id
         where fm.folder_id = $1 order by fm.created_at asc`,
        [id]
      )
      return res.rows
    },
    async setFolderMember(id, userId, role) {
      queryCount += 1
      const res = await pool.query(
        `insert into folder_members(folder_id, user_id, role) values($1,$2,$3)
         on conflict(folder_id, user_id) do update set role = excluded.role, updated_at = now()
         returning *`,
        [id, userId, role]
      )
      return res.rows[0]
    },
    async removeFolderMember(id, userId) {
      queryCount += 1
      await pool.query(`delete from folder_members where folder_id = $1 and user_id = $2`, [id, userId])
      return true
    },
    async roomKeysInFolder(id) {
      queryCount += 1
      const res = await pool.query(
        `select room_key from rooms where folder_id = $1 and deleted_at is null`,
        [id]
      )
      return res.rows.map(row => row.room_key)
    },
    async folderNameTaken(name, parentId, exceptId) {
      queryCount += 1
      const res = await pool.query(
        `select 1 from folders
         where deleted_at is null
           and parent_id is not distinct from $2
           and lower(name) = lower($1)
           and ($3::uuid is null or id <> $3)
         limit 1`,
        [name, parentId, exceptId || null]
      )
      return !!res.rows[0]
    },
    async insertFolder(row) {
      queryCount += 1
      const res = await pool.query(
        `insert into folders (id, parent_id, name, created_by)
         values ($1,$2,$3,$4)
         returning *`,
        [row.id || randomUUID(), row.parent_id || null, row.name, row.created_by || '']
      )
      return res.rows[0]
    },
    async listFolders(opts = {}) {
      const userId = opts.userId || ''
      const bypass = !!opts.bypass || !userId
      queryCount += 1
      if (bypass) {
        const res = await pool.query(
          `select f.*,
                  (
                    select count(*)::int from rooms r
                    left join room_tombstones t on t.room_key = r.room_key
                    where r.folder_id = f.id and t.room_key is null
                      and r.deleted_at is null
                  ) as room_count
           from folders f
           where f.deleted_at is null
           order by f.name asc`
        )
        return res.rows
      }
      const res = await pool.query(
        `select f.*,
                (f.created_by = $1) as can_manage,
                fm.role as folder_role,
                (
                  select count(*)::int from rooms r
                  left join room_tombstones t on t.room_key = r.room_key
                  where r.folder_id = f.id and t.room_key is null
                    and r.deleted_at is null
                ) as room_count
         from folders f
         left join folder_members fm on fm.folder_id = f.id and fm.user_id = $1
         where f.deleted_at is null
           and (
             f.created_by = $1
             or fm.user_id is not null
             or exists (
               select 1
               from rooms r2
               join room_members m
                 on m.room_key = r2.room_key and m.user_id = $1
               left join room_tombstones t2 on t2.room_key = r2.room_key
               where r2.folder_id = f.id and t2.room_key is null
                 and r2.deleted_at is null
             )
           )
         order by f.name asc`,
        [userId]
      )
      return res.rows
    },
    async updateFolderName(id, name) {
      queryCount += 1
      const res = await pool.query(
        `update folders set name = $2, updated_at = now()
         where id = $1 and deleted_at is null
         returning *`,
        [id, name]
      )
      return res.rows[0] || null
    },
    async countRoomsInFolder(id) {
      queryCount += 1
      const res = await pool.query(
        `select count(*)::int as n
         from rooms r
         left join room_tombstones t on t.room_key = r.room_key
         where r.folder_id = $1 and t.room_key is null and r.deleted_at is null`,
        [id]
      )
      return Number((res.rows[0] && res.rows[0].n) || 0)
    },
    async countChildFolders(id) {
      queryCount += 1
      const res = await pool.query(
        `select count(*)::int as n from folders
         where parent_id = $1 and deleted_at is null`,
        [id]
      )
      return Number((res.rows[0] && res.rows[0].n) || 0)
    },
    async deleteFolder(id) {
      queryCount += 1
      await pool.query(`delete from folders where id = $1`, [id])
      return true
    },
    async upsertUserState(roomKey, userId, patch, db) {
      const conn = db || pool
      if (!db) queryCount += 1
      const favorite =
        patch.is_favorite == null ? null : !!patch.is_favorite
      const res = await conn.query(
        `insert into room_user_state
           (room_key, user_id, is_favorite, last_opened_at, created_at, updated_at)
         values
           ($1, $2, coalesce($3, false), $4, now(), now())
         on conflict (room_key, user_id) do update set
           is_favorite = coalesce($3, room_user_state.is_favorite),
           last_opened_at = coalesce($4, room_user_state.last_opened_at),
           updated_at = now()
         returning *`,
        [
          roomKey,
          userId,
          favorite,
          patch.touch_opened ? new Date().toISOString() : patch.last_opened_at || null
        ]
      )
      return res.rows[0]
    },
    async trashRoom(roomKey, userId) {
      queryCount += 1
      const res = await pool.query(
        `update rooms
         set deleted_from_folder_id = folder_id,
             folder_id = null,
             deleted_at = now(),
             deleted_by = $2
         where room_key = $1
           and deleted_at is null
           and not exists (
             select 1 from room_tombstones t where t.room_key = rooms.room_key
           )
         returning room_key, title, folder_id, owner_id, version,
                   created_at, updated_at, content_updated_at,
                   deleted_at, deleted_by, deleted_from_folder_id`,
        [roomKey, userId || '']
      )
      return res.rows[0] || null
    },
    async restoreRoom(roomKey, folderId) {
      queryCount += 1
      const res = await pool.query(
        `update rooms
         set folder_id = $2,
             deleted_at = null,
             deleted_by = null,
             deleted_from_folder_id = null
         where room_key = $1
         returning room_key, title, folder_id, owner_id, version,
                   created_at, updated_at, content_updated_at,
                   deleted_at, deleted_by, deleted_from_folder_id`,
        [roomKey, folderId]
      )
      return res.rows[0] || null
    },
    async purgeRoom(roomKey) {
      const key = String(roomKey || '')
      await this.withTx(async db => {
        await db.query(`delete from room_history_audit where room_key = $1`, [key])
        await db.query(`delete from room_versions where room_key = $1`, [key])
        await db.query(`delete from room_checkpoints where room_key = $1`, [key])
        await db.query(`delete from room_user_state where room_key = $1`, [key])
        await db.query(`delete from room_members where room_key = $1`, [key])
        await db.query(`delete from room_outbox where room_key = $1`, [key])
        await db.query(`delete from room_operations where room_key = $1`, [key])
        await db.query(
          `delete from room_operations_archive where room_key = $1`,
          [key]
        )
        await db.query(`delete from room_snapshots where room_key = $1`, [key])
        await db.query(`delete from room_nodes where room_key = $1`, [key])
        await db.query(`delete from room_tombstones where room_key = $1`, [key])
        await db.query(`delete from rooms where room_key = $1`, [key])
      })
      return true
    },
    async getPreviewNodes(roomKey) {
      queryCount += 1
      const res = await pool.query(
        `with recursive walk as (
           select uid, parent_uid, position, data, is_root, deleted_at, 0 as depth
           from room_nodes
           where room_key = $1 and is_root and deleted_at is null
           union all
           select n.uid, n.parent_uid, n.position, n.data, n.is_root, n.deleted_at, w.depth + 1
           from room_nodes n
           inner join walk w
             on n.room_key = $1 and n.parent_uid = w.uid and n.deleted_at is null
           where w.depth < 2
         )
         select uid, parent_uid, position, data, is_root, deleted_at
         from walk
         order by depth, position, uid
         limit 40`,
        [String(roomKey || '')]
      )
      return res.rows
    }
  }
}

module.exports = { createPgFileStore }
