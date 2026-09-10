/**
 * 用 Docker Compose 拉起 OpenClaw Gateway（龙虾），供 Start-Docker / 助理页使用。
 * 默认镜像：openclaw/openclaw:latest（可用 OPENCLAW_IMAGE 覆盖；GHCR 拉不动时用 Docker Hub）。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const http = require('http')
const { spawnSync, execSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const ENV_FILE = path.join(ROOT, '.env')
const DATA_DIR = path.join(ROOT, 'docker', 'openclaw', 'home')
const CONFIG_FILE = path.join(DATA_DIR, 'openclaw.json')
const DEFAULT_PORT = Number(process.env.OPENCLAW_PORT || 18789)
const DEFAULT_IMAGE =
  process.env.OPENCLAW_IMAGE || 'openclaw/openclaw:latest'

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

function loadEnvFile() {
  const map = {}
  if (!fs.existsSync(ENV_FILE)) return map
  fs.readFileSync(ENV_FILE, 'utf8')
    .split(/\r?\n/)
    .forEach(line => {
      const text = line.trim()
      if (!text || text.startsWith('#')) return
      const i = text.indexOf('=')
      if (i <= 0) return
      let value = text.slice(i + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      map[text.slice(0, i).trim()] = value
    })
  return map
}

function upsertEnvKey(key, value) {
  const text = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : ''
  const lines = text ? text.split(/\r?\n/) : []
  const re = new RegExp(`^\\s*${key}\\s*=`)
  let found = false
  const next = lines.map(line => {
    if (!re.test(line)) return line
    found = true
    return `${key}=${value}`
  })
  if (!found) {
    if (next.length && next[next.length - 1] !== '') next.push('')
    next.push(`# OpenClaw Gateway（Start-Docker 自动写入）`)
    next.push(`${key}=${value}`)
  }
  fs.writeFileSync(ENV_FILE, next.join('\n').replace(/\n*$/, '\n'), 'utf8')
}

function ensureGatewayToken() {
  const fromEnv = String(
    process.env.OPENCLAW_GATEWAY_TOKEN || loadEnvFile().OPENCLAW_GATEWAY_TOKEN || ''
  ).trim()
  if (fromEnv) {
    process.env.OPENCLAW_GATEWAY_TOKEN = fromEnv
    return fromEnv
  }
  const token = crypto.randomBytes(24).toString('hex')
  upsertEnvKey('OPENCLAW_GATEWAY_TOKEN', token)
  process.env.OPENCLAW_GATEWAY_TOKEN = token
  return token
}

function ensureDataDirs() {
  const dirs = [
    DATA_DIR,
    path.join(DATA_DIR, 'workspace'),
    path.join(DATA_DIR, 'agents'),
    path.join(DATA_DIR, 'credentials'),
    path.join(DATA_DIR, 'logs'),
    path.join(DATA_DIR, 'tmp')
  ]
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  }
}

function ensureOpenclawConfig(token, port = DEFAULT_PORT) {
  ensureDataDirs()
  let cfg = {}
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    } catch (e) {
      cfg = {}
    }
  }
  cfg.gateway = cfg.gateway || {}
  cfg.gateway.mode = cfg.gateway.mode || 'local'
  cfg.gateway.bind = 'lan'
  cfg.gateway.port = port
  cfg.gateway.auth = cfg.gateway.auth || {}
  cfg.gateway.auth.mode = 'token'
  cfg.gateway.auth.token = token
  cfg.gateway.http = cfg.gateway.http || {}
  cfg.gateway.http.endpoints = cfg.gateway.http.endpoints || {}
  cfg.gateway.http.endpoints.chatCompletions = {
    ...(cfg.gateway.http.endpoints.chatCompletions || {}),
    enabled: true
  }
  const origins = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    'http://127.0.0.1:8080',
    'http://localhost:8080',
    'http://127.0.0.1:8989',
    'http://localhost:8989'
  ])
  const mindPort = Number(process.env.MIND_MAP_PORT || 8080)
  origins.add(`http://127.0.0.1:${mindPort}`)
  origins.add(`http://localhost:${mindPort}`)
  cfg.gateway.controlUi = cfg.gateway.controlUi || {}
  cfg.gateway.controlUi.allowedOrigins = Array.from(origins)
  // 容器内无宿主机 docker CLI；显式关掉 sandbox，避免 spawn docker ENOENT
  cfg.agents = cfg.agents || {}
  cfg.agents.defaults = cfg.agents.defaults || {}
  cfg.agents.defaults.workspace =
    cfg.agents.defaults.workspace || '/home/node/.openclaw/workspace'
  cfg.agents.defaults.sandbox = cfg.agents.defaults.sandbox || {}
  if (!cfg.agents.defaults.sandbox.mode) {
    cfg.agents.defaults.sandbox.mode = 'off'
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
  return CONFIG_FILE
}

function httpGet(url, timeoutMs = 2500) {
  return new Promise(resolve => {
    let parsed
    try {
      parsed = new URL(url)
    } catch (e) {
      resolve({ ok: false, status: 0, body: '', error: 'bad url' })
      return
    }
    const req = http.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        timeout: timeoutMs
      },
      res => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', c => {
          body += c
        })
        res.on('end', () =>
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            body
          })
        )
      }
    )
    req.on('timeout', () => {
      req.destroy()
      resolve({ ok: false, status: 0, body: '', error: 'timeout' })
    })
    req.on('error', err =>
      resolve({
        ok: false,
        status: 0,
        body: '',
        error: (err && err.message) || String(err)
      })
    )
    req.end()
  })
}

async function checkDockerGatewayHealth(port = DEFAULT_PORT) {
  // 官方镜像用 /healthz；旧脚本兼容 /health
  for (const p of ['/healthz', '/health', '/startupz']) {
    const res = await httpGet(`http://127.0.0.1:${port}${p}`)
    if (res.ok) return { ok: true, status: res.status, path: p }
  }
  return { ok: false, status: 0 }
}

function compose(args, extraEnv = {}) {
  return spawnSync('docker', ['compose', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...extraEnv }
  })
}

function hasDocker() {
  try {
    execSync('docker info', { stdio: 'ignore' })
    return true
  } catch (e) {
    return false
  }
}

function serviceRunning() {
  const r = compose(['ps', '--status', 'running', '-q', 'openclaw-gateway'])
  return !!(r.status === 0 && String(r.stdout || '').trim())
}

/**
 * 确保 Docker 版 OpenClaw Gateway 在跑。
 */
async function ensureOpenclawDockerGateway({
  port = DEFAULT_PORT,
  waitMs = Number(process.env.OPENCLAW_WAIT_MS || 90000)
} = {}) {
  if (!hasDocker()) {
    return {
      ok: false,
      mode: 'docker',
      reason: '未检测到 Docker，无法拉起 OpenClaw 容器'
    }
  }

  const token = ensureGatewayToken()
  ensureOpenclawConfig(token, port)
  upsertEnvKey('OPENCLAW_PORT', String(port))
  upsertEnvKey('OPENCLAW_MODE', 'docker')
  if (!String(process.env.OPENCLAW_IMAGE || '').trim()) {
    upsertEnvKey('OPENCLAW_IMAGE', DEFAULT_IMAGE)
  }

  const liveBefore = await checkDockerGatewayHealth(port)
  let alreadyRunning = !!(liveBefore && liveBefore.ok && serviceRunning())

  if (!alreadyRunning) {
    // 先停旧容器，清掉 /tmp 里的 crash-loop 计数；配置变更后也强制重建
    compose(['rm', '-sf', 'openclaw-gateway'], {
      OPENCLAW_GATEWAY_TOKEN: token,
      OPENCLAW_PORT: String(port),
      OPENCLAW_IMAGE: process.env.OPENCLAW_IMAGE || DEFAULT_IMAGE
    })
    const up = compose(
      ['up', '-d', '--pull', 'missing', '--force-recreate', 'openclaw-gateway'],
      {
        OPENCLAW_GATEWAY_TOKEN: token,
        OPENCLAW_PORT: String(port),
        OPENCLAW_IMAGE: process.env.OPENCLAW_IMAGE || DEFAULT_IMAGE
      }
    )
    if (up.status !== 0) {
      return {
        ok: false,
        mode: 'docker',
        reason: 'docker compose 启动 openclaw-gateway 失败',
        detail: String(up.stderr || up.stdout || '')
          .trim()
          .slice(0, 600),
        hint:
          '请确认能拉取镜像（OPENCLAW_IMAGE，默认 openclaw/openclaw:latest），或先执行：docker pull openclaw/openclaw:latest'
      }
    }
    // 命名卷首次启动时补齐 workspace 等目录
    compose(
      [
        'exec',
        '-T',
        'openclaw-gateway',
        'sh',
        '-c',
        'mkdir -p /home/node/.openclaw/workspace /home/node/.openclaw/agents /home/node/.openclaw/credentials /home/node/.openclaw/logs /home/node/.openclaw/tmp'
      ],
      {
        OPENCLAW_GATEWAY_TOKEN: token,
        OPENCLAW_PORT: String(port),
        OPENCLAW_IMAGE: process.env.OPENCLAW_IMAGE || DEFAULT_IMAGE
      }
    )
  }

  const deadline = Date.now() + waitMs
  let health = { ok: false }
  while (Date.now() < deadline) {
    health = await checkDockerGatewayHealth(port)
    if (health.ok) break
    await sleep(1500)
  }

  if (!health.ok) {
    const logs = compose(['logs', '--tail', '40', 'openclaw-gateway'])
    return {
      ok: false,
      mode: 'docker',
      port,
      reason: `OpenClaw 容器未在 ${waitMs}ms 内就绪（127.0.0.1:${port}）`,
      detail: String(logs.stdout || logs.stderr || '')
        .trim()
        .slice(0, 800),
      hint: '查看日志：docker compose logs -f openclaw-gateway'
    }
  }

  return {
    ok: true,
    mode: 'docker',
    alreadyRunning,
    port,
    hasToken: !!token,
    token,
    chatCompletions: { enabled: true, configOk: true, changed: false },
    distro: 'docker'
  }
}

module.exports = {
  DEFAULT_PORT,
  DEFAULT_IMAGE,
  ensureOpenclawDockerGateway,
  ensureGatewayToken,
  ensureOpenclawConfig,
  checkDockerGatewayHealth,
  DATA_DIR
}

if (require.main === module) {
  ensureOpenclawDockerGateway()
    .then(r => {
      const token = r && r.token
      if (r) delete r.token
      console.log(JSON.stringify({ ...r, hasToken: !!token }, null, 2))
      process.exit(r && r.ok ? 0 : 1)
    })
    .catch(err => {
      console.error(err)
      process.exit(1)
    })
}
