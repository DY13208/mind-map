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
                r.content_updated_at
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
            owner_id, created_at, updated_at, content_updated_at)
         values
           ($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7,$8,now(),now(),now())
         returning room_key, title, cos_key, version, metadata, folder_id,
                   owner_id, created_at, updated_at, content_updated_at`,
        [
          row.room_key,
          normalizeTitle(row.title),
          row.cos_key || row.room_key + '.yjs',
          row.nodes ? JSON.stringify(row.nodes) : null,
          Number(row.version || 0),
          JSON.stringify(row.metadata || DEFAULT_METADATA),
          row.folder_id || null,
          row.owner_id || null
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
        `insert into room_members (room_key, user_id, role)
         values ($1,$2,$3)
         on conflict (room_key, user_id) do update set
           role = excluded.role,
           updated_at = now()`,
        [row.room_key, row.user_id, row.role]
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
                  ) as room_count
           from folders f
           where f.deleted_at is null
           order by f.name asc`
        )
        return res.rows
      }
      const res = await pool.query(
        `select f.*,
                (
                  select count(*)::int from rooms r
                  left join room_tombstones t on t.room_key = r.room_key
                  where r.folder_id = f.id and t.room_key is null
                ) as room_count
         from folders f
         where f.deleted_at is null
           and (
             f.created_by = $1
             or exists (
               select 1
               from rooms r2
               join room_members m
                 on m.room_key = r2.room_key and m.user_id = $1
               left join room_tombstones t2 on t2.room_key = r2.room_key
               where r2.folder_id = f.id and t2.room_key is null
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
         where r.folder_id = $1 and t.room_key is null`,
        [id]
      )
      return Number((res.rows[0] && res.rows[0].n) || 0)
    },
    async deleteFolder(id) {
      queryCount += 1
      await pool.query(`delete from folders where id = $1`, [id])
      return true
    }
  }
}

module.exports = { createPgFileStore }
