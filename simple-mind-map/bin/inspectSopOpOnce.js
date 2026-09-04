require('./loadEnv')
const { Pool } = require('pg')

const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD
})

;(async () => {
  const opId = '753eb6d8-3241-4e00-94dd-a7907dbd5454'
  const found = await pool.query(
    `select room_key, version, operation_id, operation_type, actor_id, client_id,
            client_seq, target_id, created_at,
            payload, event
     from room_operations
     where operation_id = $1
     union all
     select room_key, version, operation_id, operation_type, actor_id, client_id,
            client_seq, target_id, created_at,
            payload, event
     from room_operations_archive
     where operation_id = $1
     limit 5`,
    [opId]
  )
  console.log('OP_ROWS', found.rowCount)
  found.rows.forEach(row => {
    const payload = row.payload || {}
    console.log(
      JSON.stringify(
        {
          room_key: row.room_key,
          version: row.version,
          operation_type: row.operation_type,
          actor_id: row.actor_id,
          client_id: row.client_id,
          client_seq: row.client_seq,
          target_id: row.target_id,
          created_at: row.created_at,
          payloadKeys: Object.keys(payload),
          uid: payload.uid,
          parent: payload.parent || payload.parentUid,
          text: payload.text,
          confirm_sop_change: payload.confirm_sop_change,
          baseRevision: payload.baseRevision
        },
        null,
        2
      )
    )
  })
  const room = await pool.query(
    `select version from rooms where room_key = 'room-vybh2lxq'`
  )
  const sop = await pool.query(
    `select uid, parent_uid, left(data->>'text', 80) as text
     from room_nodes
     where room_key = 'room-vybh2lxq'
       and deleted_at is null
       and lower(regexp_replace(coalesce(data->>'text',''), '<[^>]+>', '', 'g')) = 'sop'
     limit 20`
  )
  console.log('ROOM_VERSION', room.rows[0])
  console.log('SOP_NODES', sop.rows)
  await pool.end()
})().catch(err => {
  console.error(err.message)
  process.exit(1)
})
