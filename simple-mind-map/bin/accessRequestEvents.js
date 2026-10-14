const CHANNEL = 'mind_map_access_requests'
const bridges = new WeakMap()

// One LISTEN connection per process/pool, shared by all authenticated SSE clients.
function bridgeFor(pool) {
  if (bridges.has(pool)) return bridges.get(pool)
  const subscribers = new Map()
  let client = null,
    connecting = null,
    retry = null,
    stopped = false
  const dispatch = message => {
    if (message.channel !== CHANNEL) return
    let data
    try {
      data = JSON.parse(message.payload)
    } catch (_) {
      return
    }
    for (const userId of data.users || []) {
      for (const callback of subscribers.get(userId) || []) callback()
    }
  }
  const reconnect = () => {
    if (client) {
      client.removeAllListeners('notification')
      client.removeAllListeners('error')
      client.removeAllListeners('end')
      client.release(true)
      client = null
    }
    if (!stopped && subscribers.size && !retry) {
      retry = setTimeout(() => {
        retry = null
        connect().catch(() => {})
      }, 2000)
      retry.unref()
    }
  }
  async function connect() {
    if (client || connecting || stopped) return connecting
    connecting = (async () => {
      const conn = await pool.connect()
      if (stopped || !subscribers.size) {
        conn.release()
        return
      }
      client = conn
      conn.on('notification', dispatch)
      conn.on('error', reconnect)
      conn.on('end', reconnect)
      await conn.query(`listen ${CHANNEL}`)
      // A reconnect may have missed events; durable inbox reads reconcile them.
      for (const callbacks of subscribers.values())
        for (const callback of callbacks) callback()
    })()
    try {
      await connecting
    } catch (error) {
      reconnect()
      throw error
    } finally {
      connecting = null
    }
  }
  const bridge = {
    subscribe(userId, callback) {
      stopped = false
      if (!subscribers.has(userId)) subscribers.set(userId, new Set())
      subscribers.get(userId).add(callback)
      connect().catch(() => {})
      return () => {
        const set = subscribers.get(userId)
        if (set) {
          set.delete(callback)
          if (!set.size) subscribers.delete(userId)
        }
        if (!subscribers.size) {
          stopped = true
          clearTimeout(retry)
          retry = null
          if (client) {
            const old = client
            client = null
            old.removeAllListeners('notification')
            old.removeAllListeners('error')
            old.removeAllListeners('end')
            old.release(true)
          }
        }
      }
    }
  }
  bridges.set(pool, bridge)
  return bridge
}

async function publish(db, userIds) {
  const users = [...new Set(userIds.filter(Boolean).map(String))]
  // Small batches keep pg_notify payloads below PostgreSQL's 8KB limit.
  for (let index = 0; index < users.length; index += 10) {
    await db.query('select pg_notify($1, $2)', [
      CHANNEL,
      JSON.stringify({ users: users.slice(index, index + 10) })
    ])
  }
}

function stream(pool, req, res, userId) {
  require('./auth').applyCorsHeaders(req, res)
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive'
  })
  res.write('retry: 3000\nevent: ready\ndata: {}\n\n')
  let closed = false
  const send = () => {
    if (
      !closed &&
      !res.destroyed &&
      !res.writableEnded &&
      !res.writableNeedDrain
    )
      res.write('event: invalidate\ndata: {}\n\n')
  }
  const unsubscribe = bridgeFor(pool).subscribe(userId, send)
  const heartbeat = setInterval(() => {
    if (!res.destroyed && !res.writableEnded && !res.writableNeedDrain)
      res.write(': heartbeat\n\n')
  }, 25000)
  // Reconnect periodically so the normal authentication/session checks run again.
  const expiry = setTimeout(() => res.end(), 5 * 60 * 1000)
  heartbeat.unref()
  expiry.unref()
  const close = () => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    clearTimeout(expiry)
    unsubscribe()
  }
  res.on('close', close)
  res.on('error', close)
  return close
}
module.exports = { publish, stream, bridgeFor }
