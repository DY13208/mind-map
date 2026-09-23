const { randomUUID } = require('crypto')
const { readRoomNodes, replaceRoomNodes, canonicalizeNodes } = require('../roomNodes')
const { cloneJson } = require('./canonical')
const { assertHistoryWritable } = require('./migrate')

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

function encodeCursor(row) {
  return Buffer.from(
    JSON.stringify({
      t: new Date(row.created_at).toISOString(),
      id: String(row.id)
    })
  ).toString('base64')
}

function decodeCursor(raw) {
  const text = String(raw || '')
  try {
    const parsed = JSON.parse(Buffer.from(text, 'base64').toString('utf8'))
    if (parsed && parsed.id) return parsed
  } catch (err) {
    /* id-only fallback */
  }
  return { id: text }
}

function createPgHistoryStore(pool) {
  let writableOk = false
  async function ensureWritable(db) {
    if (writableOk) return
    await assertHistoryWritable(db)
    writableOk = true
  }
  function methods(db) {
    return {
      kind: 'pg',
      async getLiveState(roomKey) {
        const room = await db.query(
          `select room_key, version, metadata,
                  coalesce(restore_epoch_revision, 0) as restore_epoch_revision
           from rooms where room_key = $1`,
          [roomKey]
        )
        if (!room.rows[0]) {
          const err = new Error('room not found')
          err.statusCode = 404
          err.code = 'ROOM_NOT_FOUND'
          throw err
        }
        const table = await readRoomNodes(db, roomKey)
        const nodes = (table && table.nodes) || {}
        return {
          roomKey,
          revision: Number(room.rows[0].version || 0),
          restoreEpochRevision: Number(room.rows[0].restore_epoch_revision || 0),
          nodes,
          metadata: room.rows[0].metadata || {}
        }
      },
      async setLiveState(roomKey, next) {
        await ensureWritable(db)
        const canonical = canonicalizeNodes(next.nodes || {})
        const tree = canonical.ok ? canonical.nodes : next.nodes
        await replaceRoomNodes(db, roomKey, tree, Number(next.revision), {
          allowRestore: true
        })
        const epochSql =
          next.restoreEpochRevision != null
            ? `, restore_epoch_revision = $4`
            : ''
        const params = [
          roomKey,
          Number(next.revision),
          JSON.stringify(next.metadata || {})
        ]
        if (next.restoreEpochRevision != null) {
          params.push(Number(next.restoreEpochRevision))
        }
        await db.query(
          `update rooms
           set version = $2,
               metadata = $3::jsonb,
               updated_at = now(),
               content_updated_at = now()
               ${epochSql}
           where room_key = $1`,
          params
        )
        return {
          roomKey,
          revision: Number(next.revision),
          nodes: tree,
          metadata: next.metadata || {}
        }
      },
      async appendOperation(row) {
        await db.query(
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
        await db.query(
          `insert into room_outbox (room_key, version, event)
           values ($1,$2,$3::jsonb)
           on conflict (room_key, version) do nothing`,
          [row.room_key, row.version, JSON.stringify(row.event || {})]
        )
        await db.query('select pg_notify($1, $2)', [
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
        const res = await db.query(
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
        const res = await db.query(
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
        await ensureWritable(db)
        const id = row.id || randomUUID()
        const res = await db.query(
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
        const existing = await db.query(
          `select * from room_checkpoints where room_key = $1 and revision = $2`,
          [row.room_key, row.revision]
        )
        return rowCheckpoint(existing.rows[0])
      },
      async hasAnyCheckpoint(roomKey) {
        const res = await db.query(
          `select 1 from room_checkpoints where room_key = $1 limit 1`,
          [roomKey]
        )
        return !!res.rows[0]
      },
      async earliestCheckpoint(roomKey) {
        const res = await db.query(
          `select * from room_checkpoints
           where room_key = $1
           order by revision asc limit 1`,
          [roomKey]
        )
        return rowCheckpoint(res.rows[0])
      },
      async latestCheckpointRevision(roomKey) {
        const res = await db.query(
          `select revision from room_checkpoints
           where room_key = $1
           order by revision desc limit 1`,
          [roomKey]
        )
        return res.rows[0] ? Number(res.rows[0].revision) : null
      },
      async operationStats(roomKey) {
        const res = await db.query(
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
        const res = await db.query(
          `select * from room_checkpoints
           where room_key = $1 and revision <= $2
           order by revision desc limit 1`,
          [roomKey, Number(revision)]
        )
        return rowCheckpoint(res.rows[0])
      },
      async getCheckpoint(id) {
        const res = await db.query(`select * from room_checkpoints where id = $1`, [id])
        return rowCheckpoint(res.rows[0])
      },
      async insertVersion(row) {
        await ensureWritable(db)
        const id = row.id || randomUUID()
        const sql = `insert into room_versions
           (id, room_key, revision, checkpoint_revision, name, description, type,
            created_by, source, hidden, summary, summary_status, editors,
            source_kind, availability, legacy_source, created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13::jsonb,$14,$15,$16,$17)
           returning *`
        const params = [
          id,
          row.room_key,
          row.revision == null ? null : Number(row.revision),
          Number(row.checkpoint_revision || 0),
          row.name || '',
          row.description || '',
          row.type || 'MANUAL',
          row.created_by || '',
          row.source || 'api',
          !!row.hidden,
          JSON.stringify(row.summary || {}),
          row.summary_status || 'pending',
          JSON.stringify(row.editors || []),
          row.source_kind || '',
          row.availability || 'readable',
          row.legacy_source || '',
          row.created_at || new Date().toISOString()
        ]
        try {
          const res = await db.query(sql, params)
          return res.rows[0]
        } catch (error) {
          if (error && error.code === '23505' && String(row.type).toUpperCase() === 'AUTO') {
            const existing = await db.query(
              `select * from room_versions
               where room_key = $1 and revision = $2 and type = 'AUTO' and hidden = false
               limit 1`,
              [row.room_key, Number(row.revision)]
            )
            if (existing.rows[0]) return existing.rows[0]
          }
          throw error
        }
      },
      async getVersion(roomKey, versionId, options = {}) {
        const hiddenSql = options.includeHidden ? '' : ' and hidden = false'
        const res = await db.query(
          `select * from room_versions where room_key = $1 and id = $2${hiddenSql}`,
          [roomKey, versionId]
        )
        return res.rows[0] || null
      },
      async getLegacySnapshot(roomKey, versionId) {
        const res = await db.query(
          `select * from room_version_legacy_map
           where room_key = $1 and version_id = $2`,
          [roomKey, versionId]
        )
        return res.rows[0] || null
      },
      async previousVisibleVersion(roomKey, before) {
        const params = [roomKey]
        let sql = `select * from room_versions
          where room_key = $1 and hidden = false`
        if (before && before.created_at) {
          params.push(
            before.created_at,
            before.revision == null ? -1 : Number(before.revision),
            before.id
          )
          sql += ` and (created_at, coalesce(revision, -1), id) < ($2::timestamptz, $3::bigint, $4::uuid)`
        }
        sql += ` order by created_at desc, coalesce(revision, -1) desc, id desc limit 1`
        const res = await db.query(sql, params)
        return res.rows[0] || null
      },
      async updateVersionMeta(roomKey, versionId, patch) {
        const res = await db.query(
          `update room_versions
           set summary = coalesce($3::jsonb, summary),
               summary_status = coalesce($4, summary_status),
               editors = coalesce($5::jsonb, editors),
               availability = coalesce($6, availability)
           where room_key = $1 and id = $2
           returning *`,
          [
            roomKey,
            versionId,
            patch.summary == null ? null : JSON.stringify(patch.summary),
            patch.summary_status || null,
            patch.editors == null ? null : JSON.stringify(patch.editors),
            patch.availability || null
          ]
        )
        return res.rows[0] || null
      },
      async resolveUserNames(ids) {
        const list = (ids || []).map(String).filter(Boolean)
        if (!list.length) return {}
        try {
          const res = await db.query(
            `select user_id, name from wecom_users where user_id = any($1::text[])`,
            [list]
          )
          const map = {}
          res.rows.forEach(row => {
            map[row.user_id] = row.name || row.user_id
          })
          return map
        } catch (err) {
          return {}
        }
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
          const cur = decodeCursor(query.cursor)
          if (cur.t) {
            params.push(cur.t, cur.id)
            sql += ` and (created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`
          } else if (cur.id) {
            params.push(cur.id)
            sql += ` and (created_at, id) < (
              select created_at, id from room_versions where id = $${params.length}
            )`
          }
        }
        params.push(limit)
        sql += ` order by created_at desc, id desc limit $${params.length}`
        const res = await db.query(sql, params)
        const rows = res.rows
        return {
          versions: rows,
          nextCursor: rows.length === limit ? encodeCursor(rows[rows.length - 1]) : null
        }
      },
      async hideVersion(roomKey, versionId) {
        const res = await db.query(
          `update room_versions set hidden = true
           where room_key = $1 and id = $2 and hidden = false
           returning *`,
          [roomKey, versionId]
        )
        return res.rows[0] || null
      },
      async lastAutoVersionAt(roomKey) {
        const res = await db.query(
          `select created_at from room_versions
           where room_key = $1 and type = 'AUTO'
           order by created_at desc limit 1`,
          [roomKey]
        )
        if (!res.rows[0]) return 0
        return new Date(res.rows[0].created_at).getTime()
      },
      async lastAutoVersionRevision(roomKey) {
        const res = await db.query(
          `select revision from room_versions
           where room_key = $1 and type = 'AUTO' and revision is not null
           order by created_at desc limit 1`,
          [roomKey]
        )
        return res.rows[0] && res.rows[0].revision != null
          ? Number(res.rows[0].revision)
          : null
      },
      async latestVisibleRevision(roomKey) {
        const res = await db.query(
          `select max(revision)::bigint as revision
           from room_versions
           where room_key = $1 and hidden = false and revision is not null`,
          [roomKey]
        )
        return res.rows[0] && res.rows[0].revision != null
          ? Number(res.rows[0].revision)
          : null
      },
      async insertAudit(row) {
        const id = row.id || randomUUID()
        await db.query(
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
        const res = await db.query(
          `select * from room_history_audit where room_key = $1 order by created_at asc`,
          [roomKey]
        )
        return res.rows
      },
      async upsertAutoJob(row) {
        await ensureWritable(db)
        await db.query(
          `insert into room_history_auto_jobs
             (room_key, last_revision, last_activity_at, due_at, editors, status, attempts)
           values ($1,$2,$3,$4,$5::jsonb,'pending',0)
           on conflict (room_key) do update set
             last_revision = excluded.last_revision,
             last_activity_at = excluded.last_activity_at,
             due_at = excluded.due_at,
             editors = (
               select coalesce(jsonb_agg(distinct e), '[]'::jsonb)
               from (
                 select jsonb_array_elements_text(
                   coalesce(room_history_auto_jobs.editors, '[]'::jsonb)
                 ) e
                 union
                 select jsonb_array_elements_text(excluded.editors)
               ) s
             ),
             status = 'pending',
             last_error = null`,
          [
            row.room_key,
            Number(row.last_revision || 0),
            row.last_activity_at || new Date().toISOString(),
            row.due_at || new Date().toISOString(),
            JSON.stringify(row.editors || [])
          ]
        )
      },
      async claimDueAutoJobs(now, limit, workerId, maxAttempts) {
        const res = await db.query(
          `with picked as (
             select room_key from room_history_auto_jobs
             where status = 'pending'
               and due_at <= $1::timestamptz
               and attempts < $2
             order by due_at
             for update skip locked
             limit $3
           )
           update room_history_auto_jobs j
           set status = 'running',
               locked_at = now(),
               locked_by = $4,
               attempts = j.attempts + 1
           from picked
           where j.room_key = picked.room_key
           returning j.*`,
          [
            new Date(now).toISOString(),
            Number(maxAttempts || 5),
            Math.max(1, Number(limit) || 8),
            workerId || 'history-worker'
          ]
        )
        return res.rows
      },
      async completeAutoJob(roomKey, revision) {
        if (revision == null) {
          await db.query(`delete from room_history_auto_jobs where room_key = $1`, [
            roomKey
          ])
          return
        }
        await db.query(
          `delete from room_history_auto_jobs
           where room_key = $1 and last_revision <= $2`,
          [roomKey, Number(revision)]
        )
      },
      async failAutoJob(roomKey, error) {
        await db.query(
          `update room_history_auto_jobs
           set status = 'pending',
               last_error = $2,
               due_at = now() + interval '15 seconds'
           where room_key = $1`,
          [roomKey, String((error && error.message) || error || 'auto version failed').slice(0, 500)]
        )
      },
      async getRestoreIdempotency(roomKey, key) {
        const res = await db.query(
          `select result from room_restore_idempotency
           where room_key = $1 and idempotency_key = $2`,
          [roomKey, key]
        )
        return res.rows[0] ? res.rows[0].result : null
      },
      async putRestoreIdempotency(roomKey, key, result) {
        await db.query(
          `insert into room_restore_idempotency (room_key, idempotency_key, result)
           values ($1,$2,$3::jsonb)
           on conflict (room_key, idempotency_key) do nothing`,
          [roomKey, key, JSON.stringify(result || {})]
        )
        const existing = await this.getRestoreIdempotency(roomKey, key)
        return existing
      }
    }
  }

  const root = methods(pool)
  root.withTx = async function withTx(fn) {
    const client = await pool.connect()
    try {
      await client.query('begin')
      const out = await fn(methods(client), client)
      await client.query('commit')
      return out
    } catch (error) {
      await client.query('rollback').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }
  root.withRoomLock = async function withRoomLock(roomKey, fn) {
    const client = await pool.connect()
    try {
      await client.query('begin')
      const locked = await client.query(
        `select room_key, version, coalesce(restore_epoch_revision, 0) as restore_epoch_revision
         from rooms where room_key = $1 for update`,
        [roomKey]
      )
      if (!locked.rows[0]) {
        const err = new Error('room not found')
        err.statusCode = 404
        err.code = 'ROOM_NOT_FOUND'
        throw err
      }
      const out = await fn(methods(client), client)
      await client.query('commit')
      return out
    } catch (error) {
      await client.query('rollback').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }
  return root
}

module.exports = { createPgHistoryStore, cloneJson, encodeCursor, decodeCursor }
