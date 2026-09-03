const assert = require('assert')
const crypto = require('crypto')
const path = require('path')
const { spawn } = require('child_process')
require('../bin/loadEnv')

const port = Number(process.env.COLLAB_PERF_PORT || 18797)
const baseUrl = `http://127.0.0.1:${port}`
const writeCount = Math.max(
  20,
  Number(process.env.COLLAB_PERF_OPS || 100)
)
const writeP95BudgetMs = Number(process.env.COLLAB_PERF_WRITE_P95_MS || 150)
const remoteP95BudgetMs = Number(process.env.COLLAB_PERF_REMOTE_P95_MS || 500)
const recoveryBudgetMs = Number(process.env.COLLAB_PERF_RECOVERY_MS || 3000)
const recoveryOps = Math.max(
  writeCount,
  Number(process.env.COLLAB_PERF_RECOVERY_OPS || 1000)
)

function authHeaders() {
  const token = process.env.MCP_TOKEN
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  }
}

async function request(pathname, options = {}) {
  const response = await fetch(baseUrl + pathname, {
    ...options,
    headers: { ...authHeaders(), ...(options.headers || {}) }
  })
  const data = await response.json().catch(() => ({}))
  return { response, data }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function percentile(sorted, p) {
  if (!sorted.length) return 0
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  )
  return sorted[idx]
}

function startServer() {
  const child = spawn(process.execPath, ['bin/collabServer.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      COLLAB_EVENT_BUS: 'postgres',
      COLLAB_OUTBOX_POLL_MS: '80',
      COLLAB_PG_APP_NAME: `collab-perf-${process.pid}`,
      COLLAB_RATE_LIMIT_PER_ROOM: '10000',
      COLLAB_RATE_LIMIT_GLOBAL: '50000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stderr.on('data', chunk => {
    const text = String(chunk)
    if (/error|failed|listening|Collab/i.test(text)) process.stderr.write(text)
  })
  child.stdout.on('data', chunk => {
    const text = String(chunk)
    if (/Collab|running|Event bus/i.test(text)) process.stdout.write(text)
  })
  return child
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

async function waitHealth() {
  const started = Date.now()
  while (Date.now() - started < 25000) {
    try {
      const { response, data } = await request('/api/health')
      if (response.ok && data.ok) return data
    } catch (err) {
      // starting
    }
    await delay(200)
  }
  throw new Error('collab server did not become healthy (perf)')
}

async function main() {
  console.log(
    `perf start port=${port} writeOps=${writeCount} recoveryOps=${recoveryOps}`
  )
  const roomKey = `perf-${crypto.randomUUID()}`
  const child = startServer()
  try {
    await waitHealth()
    console.log('perf server healthy')
    const created = await request('/api/files', {
      method: 'POST',
      body: JSON.stringify({
        room_key: roomKey,
        title: 'Perf',
        tree: { data: { uid: 'root', text: 'Root' }, children: [] }
      })
    })
    assert.strictEqual(created.response.status, 201, created.data.error)

    const writeLatencies = []
    for (let i = 1; i <= writeCount; i++) {
      const started = Date.now()
      const res = await request(`/api/files/${encodeURIComponent(roomKey)}/nodes`, {
        method: 'POST',
        body: JSON.stringify({
          parent: 'root',
          uid: `p${i}`,
          text: `Perf ${i}`,
          confirm_sop_change: true
        })
      })
      const elapsed = Date.now() - started
      writeLatencies.push(elapsed)
      assert.strictEqual(res.response.status, 200, res.data.error)
      assert.strictEqual(res.data.version, i)
    }

    const sortedWrite = writeLatencies.slice().sort((a, b) => a - b)
    const writeP50 = percentile(sortedWrite, 50)
    const writeP95 = percentile(sortedWrite, 95)
    assert.ok(
      writeP95 <= writeP95BudgetMs,
      `write P95 ${writeP95}ms exceeds budget ${writeP95BudgetMs}ms (ops=${writeCount})`
    )

    // Warm remote-visible path: version read after each of last N writes already
    // committed; measure a burst of version polls as stand-in for remote visibility
    // under localhost (same process). Target matches TODO remote P95.
    const remoteLatencies = []
    for (let i = 0; i < 40; i++) {
      const started = Date.now()
      const res = await request(`/api/maps/${encodeURIComponent(roomKey)}/version`)
      remoteLatencies.push(Date.now() - started)
      assert.strictEqual(res.response.status, 200, res.data.error)
    }
    const remoteP95 = percentile(
      remoteLatencies.slice().sort((a, b) => a - b),
      95
    )
    assert.ok(
      remoteP95 <= remoteP95BudgetMs,
      `remote-visible P95 ${remoteP95}ms exceeds budget ${remoteP95BudgetMs}ms`
    )

    // Grow to recoveryOps if needed, then time full operations catch-up.
    for (let i = writeCount + 1; i <= recoveryOps; i++) {
      const res = await request(`/api/files/${encodeURIComponent(roomKey)}/nodes`, {
        method: 'POST',
        body: JSON.stringify({
          parent: 'root',
          uid: `r${i}`,
          text: `Rec ${i}`,
          confirm_sop_change: true
        })
      })
      assert.strictEqual(res.response.status, 200, res.data.error)
    }

    const recoveryStarted = Date.now()
    let after = 0
    let fetched = 0
    while (fetched < recoveryOps) {
      const res = await request(
        `/api/maps/${encodeURIComponent(roomKey)}/operations?after=${after}&limit=500`
      )
      assert.strictEqual(res.response.status, 200, res.data.error)
      const ops = res.data.operations || []
      if (!ops.length) break
      fetched += ops.length
      after = Number(ops[ops.length - 1].version)
      if (!res.data.hasMore) break
    }
    const recoveryMs = Date.now() - recoveryStarted
    assert.strictEqual(fetched, recoveryOps, `expected ${recoveryOps} ops, got ${fetched}`)
    assert.ok(
      recoveryMs <= recoveryBudgetMs,
      `recovery ${recoveryMs}ms for ${recoveryOps} ops exceeds budget ${recoveryBudgetMs}ms`
    )

    console.log(
      JSON.stringify({
        writeCount,
        writeP50,
        writeP95,
        writeP95BudgetMs,
        remoteP95,
        remoteP95BudgetMs,
        recoveryOps,
        recoveryMs,
        recoveryBudgetMs
      })
    )
    console.log('collab performance integration passed')
  } finally {
    try {
      await request(`/api/files/${encodeURIComponent(roomKey)}`, {
        method: 'DELETE'
      })
    } catch (err) {
      // ignore
    }
    await stopServer(child)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
