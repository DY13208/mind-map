const http = require('http')
const net = require('net')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const REPO_ROOT = path.resolve(__dirname, '../../..')

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port || 0, '127.0.0.1', () => resolve(server.address().port))
  })
}

async function reservePort() {
  const server = http.createServer()
  const port = await listen(server)
  await new Promise(resolve => server.close(resolve))
  return port
}

function waitHealth(url, child, output, ms = 40000) {
  const deadline = Date.now() + ms
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (child && child.exitCode !== null) {
        reject(new Error('collab server exited\n' + (output || []).join('')))
        return
      }
      const req = http.get(url + '/api/health', res => {
        res.resume()
        if (res.statusCode === 200) {
          resolve()
          return
        }
        retry()
      })
      req.on('error', retry)
      req.setTimeout(1500, () => {
        req.destroy()
        retry()
      })
    }
    const retry = () => {
      if (Date.now() > deadline) {
        reject(new Error('health timeout\n' + (output || []).join('')))
        return
      }
      setTimeout(tick, 250)
    }
    tick()
  })
}

function startCollab(env = {}) {
  const output = []
  const child = spawn(
    process.execPath,
    [path.join(REPO_ROOT, 'simple-mind-map/bin/collabServer.js')],
    {
      cwd: path.join(REPO_ROOT, 'simple-mind-map'),
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        COLLAB_E2E: '1',
        COLLAB_OUTBOX_PUBLISHER: '0',
        AUTH_COOKIE_SECURE: 'false',
        ...env
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  child.stdout.on('data', chunk => output.push(String(chunk)))
  child.stderr.on('data', chunk => output.push(String(chunk)))
  child.on('error', err => output.push(String(err)))
  const logFile = path.join(__dirname, '.server.log')
  child.stdout.on('data', chunk => fs.appendFileSync(logFile, chunk))
  child.stderr.on('data', chunk => fs.appendFileSync(logFile, chunk))
  return { child, output }
}

function contentType(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8'
  if (file.endsWith('.js')) return 'application/javascript; charset=utf-8'
  if (file.endsWith('.css')) return 'text/css; charset=utf-8'
  if (file.endsWith('.json')) return 'application/json; charset=utf-8'
  if (file.endsWith('.svg')) return 'image/svg+xml'
  if (file.endsWith('.ico')) return 'image/x-icon'
  if (file.endsWith('.png')) return 'image/png'
  if (file.endsWith('.woff2')) return 'font/woff2'
  return 'application/octet-stream'
}

function startGateway(collabPort, options = {}) {
  const target = '127.0.0.1'
  const runtime = () => ({
    gateway: true,
    host: '127.0.0.1',
    webPort: Number(options.webPort || 0),
    collabPort,
    collabV2: true,
    collabV2Trace: true
  })
  const server = http.createServer((req, res) => {
    const url = req.url || '/'
    const file = (url.split('?')[0] || '/')
    if (file === '/dist/runtime-config.js' || file === '/runtime-config.js') {
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store'
      })
      res.end('window.__MIND_MAP_RUNTIME__ = ' + JSON.stringify(runtime()))
      return
    }
    if (
      url.startsWith('/api') ||
      url.startsWith('/collab-v2') ||
      url.startsWith('/socket.io') ||
      url.startsWith('/collab')
    ) {
      const proxy = http.request(
        {
          host: target,
          port: collabPort,
          path: url,
          method: req.method,
          headers: { ...req.headers, host: target + ':' + collabPort }
        },
        up => {
          res.writeHead(up.statusCode || 502, up.headers)
          up.pipe(res)
        }
      )
      proxy.on('error', () => {
        if (!res.headersSent) res.writeHead(502)
        res.end('proxy error')
      })
      req.pipe(proxy)
      return
    }
    let staticFile = file
    if (staticFile === '/' || staticFile === '') staticFile = '/index.html'
    const abs = path.join(REPO_ROOT, staticFile.replace(/^\/+/, ''))
    if (!abs.startsWith(REPO_ROOT) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    res.writeHead(200, { 'Content-Type': contentType(abs) })
    fs.createReadStream(abs).pipe(res)
  })
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {})
    const backend = net.connect(collabPort, target, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`]
      const headers = { ...req.headers, host: target + ':' + collabPort }
      Object.keys(headers).forEach(key => {
        const value = headers[key]
        if (Array.isArray(value)) value.forEach(item => lines.push(key + ': ' + item))
        else if (value != null) lines.push(key + ': ' + value)
      })
      backend.write(lines.join('\r\n') + '\r\n\r\n')
      if (head && head.length) backend.write(head)
      backend.pipe(socket)
      socket.pipe(backend)
    })
    backend.on('error', () => {
      try {
        socket.destroy()
      } catch (err) {}
    })
  })
  server.on('clientError', () => {})
  return server
}

function authEnv(origin) {
  return {
    WECOM_AUTH_ENABLED: '1',
    WECOM_CORP_ID: 'ww1234567890abcdef',
    WECOM_AGENT_ID: '1000001',
    WECOM_SECRET: 'e2e-wecom-secret-not-used',
    AUTH_SESSION_SECRET: 'e2e-session-secret-32-chars-min!!',
    MCP_TOKEN: 'e2e-mcp-token-needs-32-characters!!',
    WECOM_REDIRECT_URI: origin + '/api/auth/wecom/callback',
    AUTH_APP_ORIGIN: origin,
    AUTH_ALLOWED_ORIGINS: origin,
    AUTH_COOKIE_SECURE: 'false'
  }
}

async function startStack(options = {}) {
  const collabPort = options.collabPort || (await reservePort())
  const webPort = options.webPort || (await reservePort())
  const origin = 'http://127.0.0.1:' + webPort
  const env = {
    PORT: String(collabPort),
    COLLAB_V2: options.collabV2 == null ? '1' : String(options.collabV2),
    COLLAB_V2_TRACE: '1',
    WECOM_AUTH_ENABLED: options.auth ? '1' : '0'
  }
  if (options.auth) Object.assign(env, authEnv(origin))
  const collab = startCollab(env)
  await waitHealth('http://127.0.0.1:' + collabPort, collab.child, collab.output)
  const gatewayOpts = { webPort }
  const gateway = startGateway(collabPort, gatewayOpts)
  await listen(gateway, webPort)
  gatewayOpts.webPort = webPort
  return {
    collabPort,
    webPort,
    origin,
    api: 'http://127.0.0.1:' + collabPort,
    child: collab.child,
    output: collab.output,
    gateway,
    async close() {
      await new Promise(resolve => gateway.close(resolve))
      if (collab.child.exitCode == null) collab.child.kill()
    }
  }
}

module.exports = { startStack, REPO_ROOT, authEnv }
