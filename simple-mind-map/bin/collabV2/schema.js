async function initCollabV2Schema(db) {
  if (!db || typeof db.query !== 'function') return
  await db.query(`
    alter table room_operations
      add column if not exists client_seq bigint
  `)
  await db.query(`
    alter table room_operations
      add column if not exists target_id text
  `)
  try {
    await db.query(`
      create unique index if not exists room_operations_op_id_global_uidx
      on room_operations(operation_id)
    `)
  } catch (err) {
    console.warn('[collab-v2] skip global operation_id unique index:', err.message)
  }
  await db.query(`
    create index if not exists room_operations_room_version_idx
    on room_operations(room_key, version)
  `)
}

module.exports = { initCollabV2Schema }
