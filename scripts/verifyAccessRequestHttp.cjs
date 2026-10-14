const assert = require('assert/strict')
const crypto = require('crypto')
const http = require('http')
const path = require('path')
const { spawn } = require('child_process')
const { Client } = require('../simple-mind-map/node_modules/pg')
async function main() {
  assert.equal(process.env.PERMISSION_TEST_DISPOSABLE, '1')
  assert.ok(process.env.PGDATABASE && process.env.PGPORT)
  const root = path.resolve(__dirname, '..')
  const socket = http.createServer()
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve))
  const port = socket.address().port
  await new Promise(resolve => socket.close(resolve))
  const base = `http://127.0.0.1:${port}`
  const child = spawn(
    process.execPath,
    ['simple-mind-map/bin/collabServer.js'],
    {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        MIND_MAP_SKIP_ROOT_ENV: '1',
        HOST: '127.0.0.1',
        PORT: String(port),
        COLLAB_V2: '1',
        COLLAB_EVENT_BUS: 'memory',
        WECOM_AUTH_ENABLED: 'true',
        WECOM_CORP_ID: 'wwaccessrequesttest',
        WECOM_AGENT_ID: '1000002',
        WECOM_SECRET: 'unused-local-test-secret',
        WECOM_REDIRECT_URI: `${base}/api/auth/wecom/callback`,
        AUTH_APP_ORIGIN: base,
        AUTH_ALLOWED_ORIGINS: base,
        AUTH_SESSION_SECRET:
          'access-request-test-session-secret-at-least-32-characters',
        AUTH_COOKIE_SECURE: 'false',
        ONEID_AUTH_ENABLED: 'false',
        WORKBUDDY_AUTH_ENABLED: 'false',
        KNOWLEDGE_COMPILER_ENABLED: 'false',
        TENCENT_COS_SECRET_ID: '',
        TENCENT_COS_SECRET_KEY: '',
        TENCENT_COS_BUCKET: '',
        MCP_TOKEN: 'access-request-local-test-mcp-token-at-least-32-characters'
      }
    }
  )
  let log = ''
  child.stdout.on('data', b => {
    log = (log + b).slice(-12000)
  })
  child.stderr.on('data', b => {
    log = (log + b).slice(-12000)
  })
  const db = new Client()
  const prefix = 'access-http-' + Date.now(),
    roomKey = 'room-' + prefix,
    ids = [prefix + '-owner', prefix + '-applicant']
  const tokens = ids.map(() => crypto.randomBytes(32).toString('base64url'))
  const streamController = new AbortController()
  let connected = false
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error('Test server exited: ' + log)
      try {
        if ((await fetch(base + '/api/health')).ok) break
      } catch (_) {
        /* Wait for local startup. */
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    await db.connect()
    connected = true
    for (let i = 0; i < ids.length; i++) {
      await db.query(
        `insert into wecom_users(user_id,corp_id,wecom_userid,name,avatar,departments,last_login_at) values($1,'wwaccessrequesttest',$1,$2,'','[]',now())`,
        [ids[i], i ? 'HTTP Test Applicant' : 'HTTP Test Owner']
      )
      await db.query(
        `insert into auth_sessions(token_hash,user_id,expires_at,absolute_expires_at) values($1,$2,now()+interval '1 hour',now()+interval '1 hour')`,
        [
          crypto
            .createHash('sha256')
            .update(tokens[i])
            .digest('hex'),
          ids[i]
        ]
      )
    }
    await db.query(
      `insert into rooms(room_key,title,cos_key,owner_id,nodes) values($1,'HTTP 申请验证',$2,$3,$4::jsonb)`,
      [
        roomKey,
        'test/' + roomKey + '.json',
        ids[0],
        JSON.stringify({
          data: { uid: 'root', text: 'HTTP Test' },
          children: []
        })
      ]
    )
    await db.query(
      `insert into room_members(room_key,user_id,role,direct_role) values($1,$2,'owner','owner')`,
      [roomKey, ids[0]]
    )
    const api = async (who, pathname, method = 'GET', body) => {
      const response = await fetch(base + pathname, {
        method,
        headers: {
          Origin: base,
          'Content-Type': 'application/json',
          ...(who === null ? {} : { Cookie: 'mind_map_session=' + tokens[who] })
        },
        body: body ? JSON.stringify(body) : undefined
      })
      return { status: response.status, data: await response.json() }
    }
    assert.equal(
      (await api(null, '/api/notifications/access-requests')).status,
      401
    )
    const anonymousStream = await fetch(
      base + '/api/notifications/access-requests/events'
    )
    assert.equal(anonymousStream.status, 401)
    assert.equal((await api(1, `/api/files/${roomKey}/info`)).status, 403)
    const stream = await fetch(
      base + '/api/notifications/access-requests/events',
      {
        headers: { Cookie: 'mind_map_session=' + tokens[0], Origin: base },
        signal: streamController.signal
      }
    )
    assert.equal(stream.status, 200)
    assert.match(stream.headers.get('content-type'), /event-stream/)
    const reader = stream.body.getReader()
    const first = await reader.read()
    assert.match(Buffer.from(first.value).toString(), /ready/)
    const submitted = await api(1, '/api/access-requests', 'POST', {
      roomKey,
      role: 'editor',
      reason: '真实 HTTP 路由验证'
    })
    assert.equal(submitted.status, 200)
    const id = submitted.data.item.id
    const inbox = await api(0, '/api/notifications/access-requests')
    assert.equal(inbox.status, 200)
    assert.ok(inbox.data.list.some(item => item.id === id))
    assert.equal(
      (await api(1, '/api/notifications/access-requests')).data.total,
      0
    )
    assert.equal(
      (
        await api(1, '/api/access-requests/' + id, 'PATCH', {
          decision: 'approve',
          role: 'manager'
        })
      ).status,
      404
    )
    const decision = await api(0, '/api/access-requests/' + id, 'PATCH', {
      decision: 'approve',
      role: 'manager'
    })
    assert.equal(decision.status, 200)
    assert.equal(decision.data.item.granted_role, 'manager')
    const info = await api(1, `/api/files/${roomKey}/info`)
    assert.equal(info.status, 200)
    const mine = await api(1, '/api/access-requests/mine?roomKey=' + roomKey)
    assert.equal(mine.data.item.access.canView, true)
    const results = await api(1, '/api/notifications/access-results')
    assert.ok(
      results.data.list.some(
        item => item.id === id && item.granted_role === 'manager'
      )
    )
    assert.equal(
      (
        await api(1, '/api/notifications/access-results/seen', 'POST', {
          ids: [id]
        })
      ).status,
      200
    )
    assert.equal(
      (await api(1, '/api/notifications/access-results')).data.unread,
      0
    )
    console.log(
      'Authenticated HTTP checks passed: cookie/session identity, anonymous denial, owner inbox/SSE, owner-only custom approval, actual file access, applicant result/read state'
    )
  } finally {
    streamController.abort()
    child.kill('SIGTERM')
    await new Promise(resolve => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 3000)
      child.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
    })
    if (connected) {
      await db.query('delete from rooms where room_key=$1', [roomKey])
      await db.query('delete from wecom_users where user_id=any($1::text[])', [
        ids
      ])
      await db.end()
    }
  }
}
main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
