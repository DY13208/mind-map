const assert = require('assert')
const http = require('http')
const { spawn } = require('child_process')
const WebSocket = require('ws')

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

function close(server) {
  return new Promise(resolve => server.close(resolve))
}

async function freePort() {
  const server = http.createServer()
  const port = await listen(server)
  await close(server)
  return port
}

async function waitForHealth(baseUrl, child, output) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`collab server exited early\n${output.join('')}`)
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return
    } catch (err) {
      // server is still starting
    }
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error(`collab server did not become healthy\n${output.join('')}`)
}

function cookieJar() {
  const values = new Map()
  return {
    header() {
      return Array.from(values.entries())
        .map(([key, value]) => `${key}=${value}`)
        .join('; ')
    },
    capture(response) {
      const setCookies = response.headers.getSetCookie
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie')].filter(Boolean)
      setCookies.forEach(cookie => {
        const first = cookie.split(';')[0]
        const separator = first.indexOf('=')
        const key = first.slice(0, separator)
        const value = first.slice(separator + 1)
        if (/max-age=0/i.test(cookie)) values.delete(key)
        else values.set(key, value)
      })
    }
  }
}

async function expectUnauthorizedWebSocket(url, origin) {
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin })
    const timer = setTimeout(() => {
      socket.terminate()
      reject(new Error('unauthorized websocket was not rejected'))
    }, 5000)
    socket.once('unexpected-response', (request, response) => {
      clearTimeout(timer)
      assert.strictEqual(response.statusCode, 401)
      response.resume()
      resolve()
    })
    socket.once('open', () => {
      clearTimeout(timer)
      socket.terminate()
      reject(new Error('unauthorized websocket connected'))
    })
    socket.once('error', err => {
      if (err.message.includes('Unexpected server response: 401')) return
      clearTimeout(timer)
      reject(err)
    })
  })
}

async function main() {
  for (const key of [
    'PGHOST',
    'PGPORT',
    'PGDATABASE',
    'PGUSER',
    'PGPASSWORD'
  ]) {
    if (!process.env[key]) throw new Error(`${key} is required`)
  }

  let tokenCalls = 0
  const wecomServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    res.setHeader('Content-Type', 'application/json')
    if (url.pathname === '/cgi-bin/gettoken') {
      tokenCalls += 1
      res.end(
        JSON.stringify({
          errcode: 0,
          access_token: 'token-1',
          expires_in: 7200
        })
      )
      return
    }
    if (url.pathname === '/cgi-bin/auth/getuserinfo') {
      assert.strictEqual(url.searchParams.get('code'), 'valid-code')
      res.end(JSON.stringify({ errcode: 0, UserId: 'zhangsan' }))
      return
    }
    if (url.pathname === '/cgi-bin/user/get') {
      res.end(
        JSON.stringify({
          errcode: 0,
          userid: 'zhangsan',
          name: '张三',
          avatar: 'https://example.test/avatar.png',
          department: [1, 2]
        })
      )
      return
    }
    res.statusCode = 404
    res.end(JSON.stringify({ errcode: 404 }))
  })
  const wecomPort = await listen(wecomServer)
  const appPort = await freePort()
  const apiPort = await freePort()
  const apiBase = `http://127.0.0.1:${apiPort}`
  const appOrigin = `http://127.0.0.1:${appPort}`
  const output = []

  const child = spawn(process.execPath, ['bin/collabServer.js'], {
    cwd: require('path').resolve(__dirname, '..'),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(apiPort),
      WECOM_AUTH_ENABLED: 'true',
      WECOM_CORP_ID: 'wwintegrationtest',
      WECOM_AGENT_ID: '1000002',
      WECOM_SECRET: 'integration-test-secret',
      WECOM_REDIRECT_URI: `${apiBase}/api/auth/wecom/callback`,
      AUTH_APP_ORIGIN: appOrigin,
      AUTH_SESSION_SECRET:
        'integration-test-session-secret-at-least-32-characters',
      MCP_TOKEN: 'integration-test-mcp-token-at-least-32-characters',
      AUTH_COOKIE_SECURE: 'false',
      WECOM_API_BASE: `http://127.0.0.1:${wecomPort}`,
      WECOM_SSO_BASE: `http://127.0.0.1:${wecomPort}`,
      TENCENT_COS_SECRET_ID: '',
      TENCENT_COS_SECRET_KEY: '',
      TENCENT_COS_BUCKET: 'unused-in-auth-test',
      TENCENT_COS_REGION: 'ap-guangzhou'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', chunk => output.push(chunk.toString()))
  child.stderr.on('data', chunk => output.push(chunk.toString()))

  try {
    await waitForHealth(apiBase, child, output)
    const jar = cookieJar()
    const request = async (path, options = {}) => {
      const headers = { ...(options.headers || {}) }
      if (jar.header()) headers.Cookie = jar.header()
      const response = await fetch(`${apiBase}${path}`, {
        ...options,
        headers,
        redirect: 'manual'
      })
      jar.capture(response)
      return response
    }

    let response = await request('/api/auth/me')
    assert.deepStrictEqual(await response.json(), {
      enabled: true,
      authenticated: false,
      user: null
    })

    response = await request('/api/files')
    assert.strictEqual(response.status, 401)

    response = await request('/api/auth/qr?return_to=%2F%3Froom%3Ddemo')
    assert.strictEqual(response.status, 200)
    const qrChallenge = await response.json()
    assert.strictEqual(qrChallenge.expiresIn, 600)
    const embeddedLoginLocation = new URL(qrChallenge.loginUrl)
    assert.strictEqual(
      embeddedLoginLocation.pathname,
      '/wwopen/sso/qrConnect'
    )
    assert.strictEqual(
      embeddedLoginLocation.searchParams.get('login_type'),
      'jssdk'
    )
    assert(embeddedLoginLocation.searchParams.get('state'))

    response = await request('/api/auth/login?return_to=%2F%3Froom%3Ddemo')
    assert.strictEqual(response.status, 302)
    const loginLocation = new URL(response.headers.get('location'))
    assert.strictEqual(loginLocation.pathname, '/wwopen/sso/qrConnect')
    assert.strictEqual(
      loginLocation.searchParams.get('appid'),
      'wwintegrationtest'
    )
    const state = loginLocation.searchParams.get('state')
    assert(state)

    response = await request(
      `/api/auth/wecom/callback?code=valid-code&state=${encodeURIComponent(
        state
      )}`
    )
    assert.strictEqual(response.status, 302)
    assert.strictEqual(
      response.headers.get('location'),
      `${appOrigin}/?room=demo`
    )

    response = await request('/api/auth/me')
    const me = await response.json()
    assert.strictEqual(me.authenticated, true)
    assert.strictEqual(me.user.id, 'zhangsan')
    assert.strictEqual(me.user.name, '张三')
    assert.deepStrictEqual(me.user.departments, [1, 2])

    response = await request('/api/files')
    assert.strictEqual(response.status, 200)
    assert.deepStrictEqual(await response.json(), { list: [] })
    assert.strictEqual(tokenCalls, 1)

    response = await request(
      `/api/auth/wecom/callback?code=valid-code&state=${encodeURIComponent(
        state
      )}`
    )
    const replayLocation = new URL(response.headers.get('location'))
    assert.strictEqual(
      replayLocation.searchParams.get('auth_error'),
      'expired_state'
    )

    response = await request('/api/auth/logout', {
      method: 'POST',
      headers: { Origin: 'http://evil.example' }
    })
    assert.strictEqual(response.status, 403)

    response = await request('/api/auth/logout', {
      method: 'POST',
      headers: { Origin: appOrigin }
    })
    assert.strictEqual(response.status, 204)

    response = await request('/api/files')
    assert.strictEqual(response.status, 401)

    response = await request('/api/files', {
      headers: {
        Authorization:
          'Bearer integration-test-mcp-token-at-least-32-characters'
      }
    })
    assert.strictEqual(response.status, 200)
    await expectUnauthorizedWebSocket(
      `ws://127.0.0.1:${apiPort}/room-test`,
      appOrigin
    )

    console.log('auth integration tests passed')
  } finally {
    child.kill('SIGTERM')
    await new Promise(resolve => {
      if (child.exitCode !== null) resolve()
      else child.once('exit', resolve)
    })
    await close(wecomServer)
  }
}

main().catch(err => {
  console.error(err)
  process.exitCode = 1
})
