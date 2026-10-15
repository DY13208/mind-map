'use strict'

// 个人主页“编辑活动”：直接聚合 room_operations（及归档表）的 actor_id/created_at，
// 按东八区自然日分桶。只读，不新增写入路径。
const TZ = 'Asia/Shanghai'
const MAX_DAYS = 400

let indexesStarted = false

// 后台建索引：CONCURRENTLY 不阻塞写入；幂等，失败只记日志，不影响启动。
function ensureUserActivityIndexes(pool, log = console) {
  if (indexesStarted || !pool) return Promise.resolve()
  indexesStarted = true
  const statements = [
    `create index concurrently if not exists room_operations_actor_time_idx
       on room_operations(actor_id, created_at)`,
    `create index concurrently if not exists room_operations_archive_actor_time_idx
       on room_operations_archive(actor_id, created_at)`
  ]
  return statements.reduce((p, sql) => p.then(() => pool.query(sql).catch(err => {
    if (log && log.warn) log.warn('[userActivity] index build skipped:', err && err.message)
  })), Promise.resolve())
}

function clampDays(value) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n) || n <= 0) return 371
  return Math.min(MAX_DAYS, n)
}

async function getUserActivity(db, userId, days) {
  const span = clampDays(days)
  const result = await db.query(
    `with bounds as (
       select (now() at time zone '${TZ}')::date as today
     ),
     since as (
       select ((today - ($2::int - 1)) :: timestamp at time zone '${TZ}') as t, today from bounds
     ),
     ops as (
       select o.created_at from room_operations o, since
        where o.actor_id = $1 and o.created_at >= since.t
       union all
       select a.created_at from room_operations_archive a, since
        where a.actor_id = $1 and a.created_at >= since.t
     )
     select to_char((created_at at time zone '${TZ}')::date, 'YYYY-MM-DD') as day,
            count(*)::int as count
       from ops
      group by 1
      order by 1`,
    [String(userId), span]
  )
  const today = await db.query(`select to_char((now() at time zone '${TZ}')::date, 'YYYY-MM-DD') as today`)
  const list = result.rows.map(row => ({ date: row.day, count: Number(row.count) || 0 }))
  return {
    today: today.rows[0] && today.rows[0].today,
    timezone: TZ,
    days: list,
    total: list.reduce((sum, item) => sum + item.count, 0)
  }
}

async function handleActivityRequest(req, res, { url, db, sendJson }) {
  const user = req.authUser
  if (!user || !user.id || user.service) {
    sendJson(res, 401, { error: 'unauthorized', message: '请先登录' })
    return true
  }
  const data = await getUserActivity(db, user.id, url.searchParams.get('days'))
  sendJson(res, 200, { ok: true, ...data })
  return true
}

module.exports = { ensureUserActivityIndexes, getUserActivity, handleActivityRequest, clampDays }
