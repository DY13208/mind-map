const { getPool } = require('./storage')

const recentFanout = new Map()

let activePublisher = null

function backoffMs(attempts) {
  const n = Math.max(1, Number(attempts) || 1)
  return Math.min(60000, 400 * Math.pow(2, n - 1))
}

function outboxRow(row) {
  if (!row) return null
  return {
    id: Number(row.id),
    room_key: row.room_key,
    mapId: row.room_key,
    version: Number(row.version || 0),
    event: row.event || {},
    created_at: row.created_at,
    published_at: row.published_at,
    attempts: Number(row.attempts || 0),
    last_error: row.last_error || null,
    available_at: row.available_at
  }
}

async function getOutboxStats(pool = getPool()) {
  const res = await pool.query(`
    select
      count(*) filter (where published_at is null) as pending,
      count(*) filter (where published_at is null and attempts > 0) as failed,
      extract(epoch from (now() - min(created_at) filter (where published_at is null))) as oldest_age_seconds
    from room_outbox
  `)
  const row = res.rows[0] || {}
  return {
    pending: Number(row.pending || 0),
    failed: Number(row.failed || 0),
    oldestAgeMs: row.oldest_age_seconds == null
      ? 0
      : Math.max(0, Math.round(Number(row.oldest_age_seconds) * 1000))
  }
}

async function listOutbox(pool = getPool(), options = {}) {
  const limit = Math.min(200, Math.max(1, Number(options.limit) || 50))
  const pending = options.pending !== false
  const res = await pool.query(
    pending
      ? `select id, room_key, version, event, created_at, published_at,
                attempts, last_error, available_at
         from room_outbox
         where published_at is null
         order by id asc
         limit $1`
      : `select id, room_key, version, event, created_at, published_at,
                attempts, last_error, available_at
         from room_outbox
         order by id desc
         limit $1`,
    [limit]
  )
  return res.rows.map(outboxRow)
}

async function replayOutbox(pool = getPool(), options = {}) {
  if (options.id) {
    const res = await pool.query(
      `update room_outbox
       set published_at = null,
           available_at = now(),
           last_error = null
       where id = $1
       returning id`,
      [Number(options.id)]
    )
    return { replayed: res.rowCount }
  }
  if (options.roomKey && options.version != null) {
    const res = await pool.query(
      `update room_outbox
       set published_at = null,
           available_at = now(),
           last_error = null
       where room_key = $1 and version = $2
       returning id`,
      [options.roomKey, Number(options.version)]
    )
    return { replayed: res.rowCount }
  }
  const res = await pool.query(
    `update room_outbox
     set available_at = now(), last_error = null
     where published_at is null and attempts > 0
     returning id`
  )
  return { replayed: res.rowCount }
}

function fanoutDocumentChange(payload) {
  const mapId = payload && (payload.mapId || payload.room_key)
  const version = Number(payload && payload.version)
  if (!mapId || !Number.isFinite(version) || version <= 0) return
  const key = `${mapId}:${version}`
  const now = Date.now()
  const prev = recentFanout.get(key)
  if (prev && now - prev < 8000) return
  const createdAt = payload && payload.created_at
    ? Date.parse(payload.created_at)
    : 0
  recentFanout.set(key, now)
  if (recentFanout.size > 2000) {
    recentFanout.forEach((ts, item) => {
      if (now - ts > 8000) recentFanout.delete(item)
    })
  }
  const { docs } = require('y-websocket/bin/utils')
  const names = [`${mapId}__presence`, mapId]
  const change = {
    roomKey: mapId,
    userId: 'outbox',
    clientId: 'outbox-publisher',
    version,
    updatedAt: new Date().toISOString(),
    nonce: `${mapId}:${version}`
  }
  names.forEach(name => {
    const doc = docs.get(name)
    if (!doc || !doc.awareness) return
    const prevState = doc.awareness.getLocalState() || {}
    doc.awareness.setLocalState({
      ...prevState,
      documentChange: change
    })
  })
  try {
    const { recordBroadcast } = require('./collabMetrics')
    recordBroadcast(createdAt ? Math.max(0, now - createdAt) : 0)
  } catch (err) {
    // ignore metrics failures
  }
}

async function flushOutbox(pool, bus) {
  const client = await pool.connect()
  let claimed = []
  try {
    await client.query('begin')
    const res = await client.query(
      `select id, room_key, version, event, attempts
       from room_outbox
       where published_at is null and available_at <= now()
       order by id
       limit 50
       for update skip locked`
    )
    claimed = res.rows
    for (const row of claimed) {
      try {
        await bus.publish({
          mapId: row.room_key,
          version: Number(row.version),
          operationId: row.event && row.event.operationId,
          event: row.event || {}
        })
        await client.query(
          `update room_outbox
           set published_at = now(), last_error = null
           where id = $1`,
          [row.id]
        )
      } catch (err) {
        const attempts = Number(row.attempts || 0) + 1
        await client.query(
          `update room_outbox
           set attempts = $2,
               last_error = $3,
               available_at = now() + ($4 * interval '1 millisecond')
           where id = $1`,
          [
            row.id,
            attempts,
            String((err && err.message) || err || 'publish failed').slice(0, 500),
            backoffMs(attempts)
          ]
        )
      }
    }
    await client.query('commit')
    return claimed.length
  } catch (err) {
    await client.query('rollback').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

function startOutboxPublisher(options = {}) {
  const pool = options.pool || getPool()
  const bus = options.bus
  const onEvent = options.onEvent || fanoutDocumentChange
  const intervalMs = Math.max(
    50,
    Number(options.intervalMs || process.env.COLLAB_OUTBOX_POLL_MS || 250)
  )
  let timer = null
  let running = false
  let stopped = false
  const unsubscribe = bus && bus.subscribe ? bus.subscribe(onEvent) : null

  async function tick() {
    if (running || stopped || !bus) return 0
    running = true
    try {
      return await flushOutbox(pool, bus)
    } catch (err) {
      console.error('[outbox]', err.message)
      return 0
    } finally {
      running = false
    }
  }

  if (bus && typeof bus.start === 'function') {
    bus.start().catch(err => {
      console.error('[outbox] bus start', err.message)
    })
  }
  timer = setInterval(() => {
    tick().catch(() => {})
  }, intervalMs)
  if (timer.unref) timer.unref()
  tick().catch(() => {})

  const api = {
    kick: tick,
    async stop() {
      stopped = true
      if (timer) clearInterval(timer)
      if (typeof unsubscribe === 'function') unsubscribe()
      if (bus && typeof bus.close === 'function') await bus.close()
      if (activePublisher === api) activePublisher = null
    }
  }
  activePublisher = api
  return api
}

function kickOutboxPublisher() {
  return activePublisher ? activePublisher.kick() : Promise.resolve(0)
}

module.exports = {
  backoffMs,
  outboxRow,
  getOutboxStats,
  listOutbox,
  replayOutbox,
  fanoutDocumentChange,
  flushOutbox,
  startOutboxPublisher,
  kickOutboxPublisher
}
