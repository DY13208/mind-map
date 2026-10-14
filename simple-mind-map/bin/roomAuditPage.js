// Paginated audit view; legacy forward operation replay is kept unchanged.
async function listRoomAuditPage(db, roomKey, { limit = 20, offset = 0, actorId = '', throughVersion } = {}) {
  const size = Math.min(100, Math.max(1, Math.floor(Number(limit) || 20)))
  const start = Number.isFinite(Number(offset)) ? Math.max(0, Math.floor(Number(offset))) : 0
  const params = [roomKey, Number(throughVersion)]
  let where = 'room_key = $1 and version <= $2'
  if (actorId) { params.push(String(actorId)); where += ` and actor_id = $${params.length}` }
  const count = await db.query(`select count(*)::int as total from room_operations where ${where}`, params)
  const pageParams = params.concat(size, start)
  const page = await db.query(`select version, operation_id, actor_id, client_id, operation_type, event, created_at
    from room_operations where ${where} order by version desc
    limit $${pageParams.length - 1} offset $${pageParams.length}`, pageParams)
  return { items: page.rows, total: Number(count.rows[0].total), limit: size, offset: start, throughVersion: Number(throughVersion) }
}
module.exports = { listRoomAuditPage }
