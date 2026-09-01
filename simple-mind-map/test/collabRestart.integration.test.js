const assert = require('assert')
const crypto = require('crypto')
const path = require('path')
const { spawn } = require('child_process')
require('../bin/loadEnv')

const port = Number(process.env.COLLAB_RESTART_PORT || 18765)
const baseUrl = `http://127.0.0.1:${port}`
const roomKey = `restart-${crypto.randomUUID()}`

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

function startServer() {
  const child = spawn(process.execPath, ['bin/collabServer.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stderr.on('data', chunk => {
    const text = String(chunk)
    if (/error|failed/i.test(text)) process.stderr.write(text)
  })
  return child
}

async function waitHealth(label) {
  const started = Date.now()
  while (Date.now() - started < 20000) {
    try {
      const { response } = await request('/api/health')
      if (response.ok) return
    } catch (err) {
      // server still starting
    }
    await delay(200)
  }
  throw new Error(`collab server did not become healthy (${label})`)
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

async function main() {
  let child = startServer()
  try {
    await waitHealth('first start')
    const created = await request('/api/files', {
      method: 'POST',
      body: JSON.stringify({
        room_key: roomKey,
        title: '重启房间',
        tree: { data: { uid: 'root', text: 'Root' }, children: [] }
      })
    })
    assert.strictEqual(created.response.status, 201, created.data.error)
    const added = await request(`/api/files/${encodeURIComponent(roomKey)}/nodes`, {
      method: 'POST',
      body: JSON.stringify({
        parent: 'root',
        uid: 'keep',
        text: 'Keep after restart',
        confirm_sop_change: true
      })
    })
    assert.strictEqual(added.response.status, 200, added.data.error)
    assert.strictEqual(added.data.version, 1)

    await stopServer(child)
    child = startServer()
    await waitHealth('after restart')

    const version = await request(`/api/maps/${encodeURIComponent(roomKey)}/version`)
    assert.strictEqual(version.response.status, 200, version.data.error)
    assert.strictEqual(version.data.version, 1)
    const snapshot = await request(
      `/api/maps/${encodeURIComponent(roomKey)}/snapshot?depth=2`
    )
    assert.strictEqual(snapshot.response.status, 200, snapshot.data.error)
    assert.strictEqual(snapshot.data.version, 1)
    const consistency = await request(
      `/api/maps/${encodeURIComponent(roomKey)}/consistency`
    )
    assert.strictEqual(consistency.data.ok, true)
    assert.strictEqual(consistency.data.source, 'table')
    const full = await request(
      `/api/files/${encodeURIComponent(roomKey)}?format=full`
    )
    const names = JSON.stringify(full.data)
    assert.ok(names.includes('Keep after restart'), 'restart lost node text')
    console.log(`collab restart integration passed (${roomKey})`)
  } finally {
    try {
      await request(`/api/files/${encodeURIComponent(roomKey)}`, {
        method: 'DELETE'
      })
    } catch (err) {
      // ignore cleanup errors
    }
    await stopServer(child)
  }
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err)
    process.exit(1)
  })
