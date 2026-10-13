function compactEvent(event) {
  const payload = event && event.event ? event.event : event || {}
  return {
    type: 'event',
    mapId: String(event.mapId || payload.mapId || ''),
    version: Number(event.version || payload.version || 0),
    operationId: String(event.operationId || payload.operationId || ''),
    eventType: String(payload.type || event.type || ''),
    event: payload
  }
}

function createMemoryBus() {
  const listeners = new Set()
  return {
    name: 'memory',
    async start() {},
    async publish(event) {
      const payload = compactEvent(event)
      for (const listener of listeners) {
        await listener(payload)
      }
      return payload
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async close() {
      listeners.clear()
    },
    status() {
      return { name: 'memory', ok: true }
    }
  }
}

function createPostgresBus(pool) {
  const local = createMemoryBus()
  local.name = 'postgres'
  let listenerClient = null
  let started = null
  let closed = false
  let listenerHealthy = false
  let reconnectTimer = null
  let reconnectAttempts = 0
  let lastError = ''

  function releaseListener(client, error) {
    if (!client || listenerClient !== client) return
    listenerClient = null
    listenerHealthy = false
    started = null
    try {
      client.release(error)
    } catch (err) {
      // A failed pg client may already have been removed from the pool.
    }
    if (!closed) scheduleReconnect()
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer) return
    reconnectAttempts += 1
    const delay = Math.min(30000, 250 * Math.pow(2, Math.min(7, reconnectAttempts - 1)))
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      ensureListener().catch(() => scheduleReconnect())
    }, delay)
    if (reconnectTimer.unref) reconnectTimer.unref()
  }

  async function ensureListener() {
    if (closed) throw new Error('postgres event listener is closed')
    if (started) return started
    const attempt = (async () => {
      const client = await pool.connect()
      listenerClient = client
      client.on('error', err => {
        lastError = String((err && err.code) || 'PG_LISTENER_ERROR')
        console.error('[event-bus] listener', (err && err.message) || lastError)
        releaseListener(client, err)
      })
      client.on('end', () => {
        lastError = 'PG_LISTENER_CLOSED'
        releaseListener(client)
      })
      client.on('notification', msg => {
        if (msg.channel !== 'collab_events') return
        let payload = null
        try {
          payload = JSON.parse(msg.payload || '{}')
        } catch (err) {
          return
        }
        local.publish(payload).catch(err => {
          console.error('[event-bus] local fanout', err.message)
        })
      })
      await client.query('LISTEN collab_events')
      listenerHealthy = true
      reconnectAttempts = 0
      lastError = ''
    })()
    started = attempt
    try {
      return await attempt
    } catch (err) {
      if (started === attempt) started = null
      if (listenerClient) releaseListener(listenerClient, err)
      lastError = String((err && err.code) || 'PG_LISTENER_CONNECT_FAILED')
      scheduleReconnect()
      throw err
    }
  }

  return {
    name: 'postgres',
    async start() {
      closed = false
      await ensureListener()
    },
    async publish(event) {
      const payload = compactEvent(event)
      const encoded = JSON.stringify({
        type: payload.type,
        mapId: payload.mapId,
        version: payload.version,
        operationId: payload.operationId,
        eventType: payload.eventType
      })
      await pool.query('select pg_notify($1, $2)', [
        'collab_events',
        encoded.slice(0, 7900)
      ])
      // 本连接收不到自己发出的 NOTIFY，所以本地再发一次给本进程的 WS。
      await local.publish(payload)
      return payload
    },
    subscribe(listener) {
      ensureListener().catch(err => {
        console.error('[event-bus] listen failed', err.message)
      })
      return local.subscribe(listener)
    },
    async close() {
      closed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = null
      await local.close()
      if (listenerClient) {
        const client = listenerClient
        try {
          await client.query('UNLISTEN collab_events')
        } catch (err) {
          // ignore
        }
        listenerClient = null
        listenerHealthy = false
        try { client.release() } catch (err) { /* ignore */ }
      }
      started = null
    },
    status() {
      return {
        name: 'postgres',
        ok: listenerHealthy,
        channel: 'collab_events',
        reconnectAttempts,
        lastError: lastError || undefined
      }
    }
  }
}

let activeBus = null

function setActiveEventBus(bus) {
  activeBus = bus || null
}

function getEventBusStatus() {
  if (!activeBus) return { name: 'none', ok: false }
  if (typeof activeBus.status === 'function') return activeBus.status()
  return { name: activeBus.name || 'unknown', ok: true }
}

function loadRedisClient() {
  try {
    return require('redis')
  } catch (err) {
    return null
  }
}

function createRedisStreamBus(options = {}) {
  const local = createMemoryBus()
  local.name = 'redis'
  const stream = String(options.stream || process.env.COLLAB_REDIS_STREAM || 'collab:events')
  const redisUrl = options.redisUrl || process.env.REDIS_URL || process.env.COLLAB_REDIS_URL
  const maxlen = Math.max(100, Number(options.maxlen || process.env.COLLAB_REDIS_MAXLEN || 10000))
  const clientFactory =
    options.clientFactory ||
    (() => {
      const redis = loadRedisClient()
      if (!redis || typeof redis.createClient !== 'function') {
        throw new Error('redis package is not installed')
      }
      return redis.createClient({ url: redisUrl })
    })
  let publisher = options.publisher || null
  let reader = options.reader || null
  let stopped = false
  let loop = null
  let lastError = ''
  let connected = false
  let lastId = options.startId || '$'
  const publishedIds = new Set()
  const trackedClients = new WeakSet()

  function trackClient(client) {
    if (!client || trackedClients.has(client) || typeof client.on !== 'function') return
    trackedClients.add(client)
    client.on('error', err => {
      connected = false
      lastError = String((err && err.code) || 'REDIS_CONNECTION_ERROR')
    })
    client.on('reconnecting', () => {
      connected = false
    })
    client.on('end', () => {
      connected = false
    })
    client.on('ready', () => {
      connected = true
      lastError = ''
    })
  }

  async function ensureClients() {
    if (!publisher) publisher = clientFactory()
    if (!reader) {
      reader =
        typeof publisher.duplicate === 'function' ? publisher.duplicate() : clientFactory()
    }
    trackClient(publisher)
    if (reader !== publisher) trackClient(reader)
    if (typeof publisher.connect === 'function' && publisher.isOpen !== true) {
      await publisher.connect()
    }
    if (reader !== publisher && typeof reader.connect === 'function' && reader.isOpen !== true) {
      await reader.connect()
    }
    connected = true
  }

  async function readLoop() {
    while (!stopped) {
      try {
        const result = await reader.xRead(
          { key: stream, id: lastId },
          { BLOCK: 2000, COUNT: 100 }
        )
        if (!result) continue
        const entries = Array.isArray(result) ? result : []
        for (let i = 0; i < entries.length; i++) {
          const messages = entries[i].messages || []
          for (let j = 0; j < messages.length; j++) {
            const item = messages[j]
            lastId = item.id || lastId
            if (item.id && publishedIds.delete(item.id)) continue
            let payload = null
            const json = item.message && (item.message.json || item.message.JSON)
            try {
              payload = json ? JSON.parse(json) : compactEvent(item.message || {})
            } catch (err) {
              continue
            }
            await local.publish(payload)
          }
        }
      } catch (err) {
        if (stopped) return
        lastError = String((err && err.message) || err)
        connected = false
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    }
  }

  const bus = {
    name: 'redis',
    async start() {
      stopped = false
      await ensureClients()
      if (!loop) loop = readLoop()
    },
    async publish(event) {
      const payload = compactEvent(event)
      await ensureClients()
      const id = await publisher.xAdd(
        stream,
        '*',
        { json: JSON.stringify(payload) },
        {
          TRIM: {
            strategy: 'MAXLEN',
            strategyModifier: '~',
            threshold: maxlen
          }
        }
      )
      if (id) {
        publishedIds.add(String(id))
        if (publishedIds.size > 4096) {
          publishedIds.delete(publishedIds.values().next().value)
        }
      }
      await local.publish(payload)
      return payload
    },
    subscribe(listener) {
      return local.subscribe(listener)
    },
    status() {
      return {
        name: 'redis',
        ok: connected && !lastError,
        stream,
        lastError: lastError || undefined
      }
    },
    async close() {
      stopped = true
      await local.close()
      connected = false
      try {
        if (reader && reader !== publisher && typeof reader.quit === 'function') {
          await reader.quit()
        }
      } catch (err) {
        // ignore
      }
      try {
        if (publisher && typeof publisher.quit === 'function') await publisher.quit()
      } catch (err) {
        // ignore
      }
      publisher = null
      reader = null
      loop = null
    }
  }
  return bus
}

function createEventBus(options = {}) {
  const requested = String(
    options.driver || process.env.COLLAB_EVENT_BUS || 'postgres'
  ).toLowerCase()
  let bus
  if (requested === 'memory' || (!options.pool && requested !== 'redis')) {
    bus = createMemoryBus()
  } else if (requested === 'redis' || requested === 'redis-streams') {
    try {
      bus = createRedisStreamBus(options)
    } catch (err) {
      console.error('[event-bus] redis init failed, using postgres', err.message)
      bus = options.pool ? createPostgresBus(options.pool) : createMemoryBus()
    }
  } else {
    bus = options.pool ? createPostgresBus(options.pool) : createMemoryBus()
  }
  setActiveEventBus(bus)
  return bus
}

module.exports = {
  compactEvent,
  createMemoryBus,
  createPostgresBus,
  createRedisStreamBus,
  createEventBus,
  setActiveEventBus,
  getEventBusStatus
}
