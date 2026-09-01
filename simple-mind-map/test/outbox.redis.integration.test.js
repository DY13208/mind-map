const assert = require('assert')
const crypto = require('crypto')
const path = require('path')
const { spawn } = require('child_process')
require('../bin/loadEnv')

const portA = Number(process.env.COLLAB_REDIS_PORT_A || 18781)
const portB = Number(process.env.COLLAB_REDIS_PORT_B || 18782)
const baseA = `http://127.0.0.1:${portA}`
const baseB = `http://127.0.0.1:${portB}`
const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:16379'

function authHeaders(extra = {}) {
  const token = process.env.MCP_TOKEN
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra
  }
}

async function request(base, pathname, options = {}) {
  const { headers, ...rest } = options
  const response = await fetch(base + pathname, {
    ...rest,
    headers: authHeaders(headers)
  })
  const data = await response.json().catch(() => ({}))
  return { response, data }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function startServer(port) {
  return spawn(process.execPath, ['bin/collabServer.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      COLLAB_EVENT_BUS: 'redis',
      REDIS_URL: redisUrl,
      COLLAB_OUTBOX_POLL_MS: '100'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function stopServer(child) {
  return new Promise(resolve => {
    if (!child || child.killed) return resolve()
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch (err) {
        // ignore
      }
      resolve()
    }, 5000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    try {
      child.kill()
    } catch (err) {
      clearTimeout(timer)
      resolve()
    }
  })
}

async function waitHealth(base, label) {
  const started = Date.now()
  while (Date.now() - started < 20000) {
    try {
      const { response, data } = await request(base, '/api/health')
      if (response.ok && data.ok) return data
    } catch (err) {
      // still starting
    }
    await delay(200)
  }
  throw new Error(`collab server did not become healthy (${label})`)
}

async function pingRedis() {
  const redis = require('redis')
  const client = redis.createClient({ url: redisUrl, socket: { connectTimeout: 1500 } })
  try {
    await client.connect()
    await client.ping()
    await client.quit()
    return true
  } catch (err) {
    try {
      await client.quit()
    } catch (e) {
      // ignore
    }
    return false
  }
}

async function main() {
  if (!(await pingRedis())) {
    throw new Error(
      `Redis is not reachable at ${redisUrl}. Start it with: docker compose up -d redis`
    )
  }

  const roomKey = `redis-bus-${crypto.randomUUID()}`
  const childA = startServer(portA)
  let childB = null
  try {
    const healthA = await waitHealth(baseA, 'instance A')
    assert.strictEqual(healthA.bus && healthA.bus.name, 'redis', JSON.stringify(healthA.bus))
    childB = startServer(portB)
    const healthB = await waitHealth(baseB, 'instance B')
    assert.strictEqual(healthB.bus && healthB.bus.name, 'redis')

    const created = await request(baseA, '/api/files', {
      method: 'POST',
      body: JSON.stringify({
        room_key: roomKey,
        title: 'Redis 总线',
        tree: { data: { uid: 'root', text: 'Root' }, children: [] }
      })
    })
    assert.strictEqual(created.response.status, 201, created.data.error)

    const added = await request(baseA, `/api/files/${encodeURIComponent(roomKey)}/nodes`, {
      method: 'POST',
      body: JSON.stringify({
        parent: 'root',
        uid: 'from-a',
        text: 'From A',
        confirm_sop_change: true
      })
    })
    assert.strictEqual(added.response.status, 200, added.data.error)
    assert.strictEqual(added.data.version, 1)
    assert.ok(added.data.position)

    const started = Date.now()
    let published = null
    while (Date.now() - started < 8000) {
      const listed = await request(baseB, '/api/ops/outbox?pending=0&limit=50')
      published = (listed.data.items || []).find(
        row => row.room_key === roomKey && Number(row.version) === 1
      )
      if (published && published.published_at) break
      await delay(100)
    }
    assert.ok(published && published.published_at, 'outbox row was not published over Redis')
    console.log('outbox redis stream integration passed')
  } finally {
    await stopServer(childA)
    await stopServer(childB)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
