const { randomUUID } = require('crypto')
const { readRoomNodes, replaceRoomNodes, canonicalizeNodes } = require('../roomNodes')
const { cloneJson } = require('./canonical')

function rowCheckpoint(row) {
  if (!row) return null
  return {
    id: row.id,
    room_key: row.room_key,
    revision: Number(row.revision),
    tree_snapshot: row.tree_snapshot,
    metadata_snapshot: row.metadata_snapshot || {},
    created_at: row.created_at,
    created_by: row.created_by || '',
    reason: row.reason,
    operation_count: Number(row.operation_count || 0),
    snapshot_version: Number(row.snapshot_version || 1),
    checksum: row.checksum || '',
    node_count: Number(row.node_count || 0)
  }
}

function createPgHistoryStore(pool) {
  function db() {
    return createPgHistoryStore._tx || pool
  }

  return {
    kind: 'pg',
    async withRoomLock(roomKey, fn) {
      const client = await pool.connect()
      const prev = createPgHistoryStore._tx
      try {
        await client.query('begin')
        const locked = await client.query(
          `select room_key, version from rooms where room_key = $1 for update`,
          [roomKey]
        )
        if (!locked.rows[0]) {
          const err = new Error('room not found')
          err.statusCode = 404
          err.code = 'ROOM_NOT_FOUND'
          throw err
        }
        createPgHistoryStore._tx = client
        const out = await fn()
        await client.query('commit')
        return out
      } catch (error) {
        await client.query('rollback').catch(() => {})
        throw error
      } finally {
        createPgHistoryStore._tx = prev || null
        client.release()
      }
    },
    async getLiveState(roomKey) {
      const room = await db().query(
        `select room_key, version, metadata from rooms where room_key = $1`,
        [roomKey]
      )
      if (!room.rows[0]) {
        const err = new Error('room not found')
        err.statusCode = 404
        err.code = 'ROOM_NOT_FOUND'
        throw err
      }
      const table = await readRoomNodes(db(), roomKey)
      const nodes = (table && table.nodes) || {}
      return {
        roomKey,
        revision: Number(room.rows[0].version || 0),
        nodes,
        metadata: room.rows[0].metadata || {}
      }
    },
    async setLiveState(roomKey, next) {
      const canonical = canonicalizeNodes(next.nodes || {})
      const tree = canonical.ok ? canonical.nodes : next.nodes
      await replaceRoomNodes(db(), roomKey, tree, Number(next.revision), {
        allowRestore: true
      })
      await db().query(
        `update rooms
         set version = $2,
             metadata = $3::jsonb,
             updated_at = now(),
             content_updated_at = now()
         where room_key = $1`,
        [roomKey, Number(next.revision), JSON.stringify(next.metadata || {})]
      )
      return { roomKey, revision: Number(next.revision), nodes: tree, metadata: next.metadata || {} }
    },
    async appendOperation(row) {
      await db().query(
        `insert into room_operations
         (room_key, version, operation_id, actor_id, client_id,
          operation_type, payload, event, inverse_payload)
         values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb)`,
        [
          row.room_key,
          row.version,
          row.operation_id,
          row.actor_id || '',
          row.client_id || null,
          row.operation_type,
          JSON.stringify(row.payload || {}),
          JSON.stringify(row.event || {}),
          row.inverse_payload == null ? null : JSON.stringify(row.inverse_payload)
        ]
      )
      await db().query(
        `insert into room_outbox (room_key, version, event)
         values ($1,$2,$3::jsonb)
         on conflict (room_key, version) do nothing`,
        [row.room_key, row.version, JSON.stringify(row.event || {})]
      )
      await db().query('select pg_notify($1, $2)', [
        'collab_events',
        JSON.stringify({
          type: 'event',
          mapId: row.room_key,
          version: row.version,
          operationId: row.operation_id
        }).slice(0, 7900)
      ])
      return row
    },
    async listOperations(roomKey, afterRevision, toRevision) {
      const to = toRevision == null ? 1e18 : Number(toRevision)
      const res = await db().query(
        `select room_key, version, operation_id, actor_id, client_id,
                operation_type, payload, event, inverse_payload, created_at
         from room_operations
         where room_key = $1 and version > $2 and version <= $3
         union all
         select room_key, version, operation_id, actor_id, client_id,
                operation_type, payload, event, inverse_payload, created_at
         from room_operations_archive
         where room_key = $1 and version > $2 and version <= $3
         order by version asc`,
        [roomKey, Number(afterRevision || 0), to]
      )
      return res.rows
    },
    async getOperation(roomKey, operationId) {
      const res = await db().query(
        `select * from room_operations
         where room_key = $1 and operation_id = $2
         union all
         select * from room_operations_archive
         where room_key = $1 and operation_id = $2
         limit 1`,
        [roomKey, operationId]
      )
      return res.rows[0] || null
    },
    async insertCheckpoint(row) {
      const id = row.id || randomUUID()
      const res = await db().query(
        `insert into room_checkpoints
         (id, room_key, revision, tree_snapshot, metadata_snapshot, created_by,
          reason, operation_count, snapshot_version, checksum, node_count)
         values ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,$10,$11)
         on conflict (room_key, revision) do nothing
         returning *`,
        [
          id,
          row.room_key,
          row.revision,
          JSON.stringify(row.tree_snapshot),
          JSON.stringify(row.metadata_snapshot || {}),
          row.created_by || '',
          row.reason || 'THRESHOLD',
          Number(row.operation_count || 0),
          Number(row.snapshot_version || 1),
          row.checksum || '',
          Number(row.node_count || 0)
        ]
      )
      if (res.rows[0]) return rowCheckpoint(res.rows[0])
      const existing = await db().query(
        `select * from room_checkpoints where room_key = $1 and revision = $2`,
        [row.room_key, row.revision]
      )
      return rowCheckpoint(existing.rows[0])
    },
    async hasAnyCheckpoint(roomKey) {
      const res = await db().query(
        `select 1 from room_checkpoints where room_key = $1 limit 1`,
        [roomKey]
      )
      return !!res.rows[0]
    },
    async earliestCheckpoint(roomKey) {
      const res = await db().query(
        `select * from room_checkpoints
         where room_key = $1
         order by revision asc limit 1`,
        [roomKey]
      )
      return rowCheckpoint(res.rows[0])
    },
    async latestCheckpointRevision(roomKey) {
      const res = await db().query(
        `select revision from room_checkpoints
         where room_key = $1
         order by revision desc limit 1`,
        [roomKey]
      )
      return res.rows[0] ? Number(res.rows[0].revision) : null
    },
    async operationStats(roomKey) {
      const res = await db().query(
        `select min(v) as min, max(v) as max, count(*)::int as count
         from (
           select version as v from room_operations where room_key = $1
           union
           select version from room_operations_archive where room_key = $1
         ) t`,
        [roomKey]
      )
      const row = res.rows[0] || {}
      return {
        min: row.min == null ? null : Number(row.min),
        max: row.max == null ? null : Number(row.max),
        count: Number(row.count || 0)
      }
    },
    async latestCheckpointAt(roomKey, revision) {
      const res = await db().query(
        `select * from room_checkpoints
         where room_key = $1 and revision <= $2
         order by revision desc limit 1`,
        [roomKey, Number(revision)]
      )
      return rowCheckpoint(res.rows[0])
    },
    async getCheckpoint(id) {
      const res = await db().query(`select * from room_checkpoints where id = $1`, [id])
      return rowCheckpoint(res.rows[0])
    },
    async insertVersion(row) {
      const id = row.id || randomUUID()
      const res = await db().query(
        `insert into room_versions
         (id, room_key, revision, checkpoint_revision, name, description, type,
          created_by, source, hidden)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         returning *`,
        [
          id,
          row.room_key,
          row.revision,
          Number(row.checkpoint_revision || 0),
          row.name || '',
          row.description || '',
          row.type || 'MANUAL',
          row.created_by || '',
          row.source || 'api',
          !!row.hidden
        ]
      )
      return res.rows[0]
    },
    async getVersion(roomKey, versionId) {
      const res = await db().query(
        `select * from room_versions where room_key = $1 and id = $2`,
        [roomKey, versionId]
      )
      return res.rows[0] || null
    },
    async listVersions(roomKey, query = {}) {
      const limit = Math.min(100, Math.max(1, Number(query.limit) || 20))
      const params = [roomKey]
      let sql = `select * from room_versions where room_key = $1 and hidden = false`
      if (query.type) {
        params.push(query.type)
        sql += ` and type = $${params.length}`
      }
      if (query.createdBy) {
        params.push(query.createdBy)
        sql += ` and created_by = $${params.length}`
      }
      if (query.from) {
        params.push(query.from)
        sql += ` and created_at >= $${params.length}`
      }
      if (query.to) {
        params.push(query.to)
        sql += ` and created_at <= $${params.length}`
      }
      if (query.cursor) {
        params.push(query.cursor)
        sql += ` and created_at < (select created_at from room_versions where id = $${params.length})`
      }
      params.push(limit)
      sql += ` order by created_at desc limit $${params.length}`
      const res = await db().query(sql, params)
      const rows = res.rows
      return {
        versions: rows,
        nextCursor: rows.length === limit ? rows[rows.length - 1].id : null
      }
    },
    async hideVersion(roomKey, versionId) {
      const res = await db().query(
        `update room_versions set hidden = true
         where room_key = $1 and id = $2
         returning *`,
        [roomKey, versionId]
      )
      return res.rows[0] || null
    },
    async lastAutoVersionAt(roomKey) {
      const res = await db().query(
        `select created_at from room_versions
         where room_key = $1 and type = 'AUTO'
         order by created_at desc limit 1`,
        [roomKey]
      )
      if (!res.rows[0]) return 0
      return new Date(res.rows[0].created_at).getTime()
    },
    async insertAudit(row) {
      const id = row.id || randomUUID()
      await db().query(
        `insert into room_history_audit
         (id, room_key, action, version_id, target_revision, from_revision,
          new_revision, user_id, detail)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
        [
          id,
          row.room_key,
          row.action,
          row.version_id || null,
          row.target_revision == null ? null : Number(row.target_revision),
          row.from_revision == null ? null : Number(row.from_revision),
          row.new_revision == null ? null : Number(row.new_revision),
          row.user_id || '',
          JSON.stringify(row.detail || {})
        ]
      )
      return { id, ...row }
    },
    async listAudit(roomKey) {
      const res = await db().query(
        `select * from room_history_audit where room_key = $1 order by created_at asc`,
        [roomKey]
      )
      return res.rows
    }
  }
}

module.exports = { createPgHistoryStore, cloneJson }
