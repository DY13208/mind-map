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
// 宿主机映射端口（避免与本机原生 OpenClaw Tray 的 18789 冲突）
const DEFAULT_PORT = Number(process.env.OPENCLAW_PORT || 4623)
// 容器内监听端口（compose / nginx 固定走这个）
const CONTAINER_PORT = Number(process.env.OPENCLAW_GATEWAY_PORT || 18789)
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

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    return null
  }
}

function volumeName() {
  // compose 项目名默认是目录名 mind-map
  return process.env.OPENCLAW_VOLUME || 'mind-map_mind-map-openclaw'
}

/** 从命名卷拉出当前配置（保留 UI 里配过的 DeepSeek / 插件等） */
function pullConfigFromVolume() {
  ensureDataDirs()
  const tmp = path.join(DATA_DIR, 'openclaw.volume.json')
  try {
    fs.unlinkSync(tmp)
  } catch (e) {
    /* ignore */
  }
  const r = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '-v',
      `${volumeName()}:/data`,
      '-v',
      `${DATA_DIR}:/out`,
      'alpine',
      'sh',
      '-c',
      'if [ -f /data/openclaw.json ]; then cp /data/openclaw.json /out/openclaw.volume.json; elif [ -f /data/openclaw.json.last-good ]; then cp /data/openclaw.json.last-good /out/openclaw.volume.json; fi'
    ],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true }
  )
  if (r.status !== 0 || !fs.existsSync(tmp)) return null
  const cfg = readJsonFile(tmp)
  try {
    fs.unlinkSync(tmp)
  } catch (e) {
    /* ignore */
  }
  return cfg && typeof cfg === 'object' ? cfg : null
}

function clearStaleLocks() {
  spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '-v',
      `${volumeName()}:/data`,
      'alpine',
      'sh',
      '-c',
      [
        'rm -f /data/tmp/openclaw-1000/* 2>/dev/null || true',
        'rm -rf /data/migration /data/tmp/openclaw-* 2>/dev/null || true',
        'mkdir -p /data/tmp /data/migration',
        // 残留的 generation/reindex 锁偶发也会卡住启动
        'rm -f /data/agents/main/agent/*.lock /data/agents/main/agent/*.lock.sqlite 2>/dev/null || true',
        'true'
      ].join('; ')
    ],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true }
  )
}

function ensureOpenclawConfig(token, port = DEFAULT_PORT) {
  ensureDataDirs()
  // 优先用卷里已有完整配置，避免把 UI 配好的模型/插件盖成精简 stub（会触发 clobber + 迁移锁）
  const fromVolume = pullConfigFromVolume()
  let cfg = fromVolume || readJsonFile(CONFIG_FILE) || {}
  if (!cfg || typeof cfg !== 'object') cfg = {}

  cfg.gateway = cfg.gateway || {}
  cfg.gateway.mode = 'local'
  cfg.gateway.bind = 'lan'
  // 容器内始终监听 CONTAINER_PORT；host 侧用 OPENCLAW_PORT 映射进来
  cfg.gateway.port = CONTAINER_PORT
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
    ...((cfg.gateway.controlUi && cfg.gateway.controlUi.allowedOrigins) || []),
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://127.0.0.1:${CONTAINER_PORT}`,
    `http://localhost:${CONTAINER_PORT}`,
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

  // Cognee 记忆插件：由 COGNEE_* env 驱动，merge 进已有配置（保留 UI 其它项）
  try {
    const { cogneeEnabled, cogneeOpenclawPluginConfig } = require('./cognee-docker')
    if (cogneeEnabled()) {
      const plugin = cogneeOpenclawPluginConfig()
      if (plugin) {
        cfg.plugins = cfg.plugins || {}
        cfg.plugins.entries = cfg.plugins.entries || {}
        const prev =
          (cfg.plugins.entries['cognee-openclaw'] &&
            cfg.plugins.entries['cognee-openclaw'].config) ||
          {}
        const nextConfig = {
          ...prev,
          ...plugin.config
        }
        // env 未给 key 时保留卷里已有 apiKey
        if (!plugin.config.apiKey && prev.apiKey) {
          nextConfig.apiKey = prev.apiKey
        }
        cfg.plugins.entries['cognee-openclaw'] = {
          ...(cfg.plugins.entries['cognee-openclaw'] || {}),
          ...plugin,
          config: nextConfig
        }
        cfg.plugins.slots = cfg.plugins.slots || {}
        if (!cfg.plugins.slots.memory) {
          cfg.plugins.slots.memory = 'cognee-openclaw'
        }
      }
    }
  } catch (e) {
    /* cognee 脚本缺失时忽略 */
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

function composeEnv(token, port) {
  return {
    OPENCLAW_GATEWAY_TOKEN: token,
    OPENCLAW_PORT: String(port),
    OPENCLAW_IMAGE: process.env.OPENCLAW_IMAGE || DEFAULT_IMAGE
  }
}

function containerId() {
  const r = compose(['ps', '-aq', 'openclaw-gateway'])
  return r.status === 0 ? String(r.stdout || '').trim().split(/\r?\n/)[0] : ''
}

/**
 * 把宿主机 openclaw.json 拷进命名卷（不用单文件 bind mount，避免 Windows EBUSY rename）。
 * 须在 gateway 进程读配置前完成；create 后、start 前最稳。
 */
function syncConfigIntoVolume(token, port) {
  const env = composeEnv(token, port)
  // 确保容器已创建（不一定在跑），以便 docker cp 写入同一命名卷
  let created = compose(['create', 'openclaw-gateway'], env)
  if (created.status !== 0) {
    created = compose(['up', '-d', '--no-start', 'openclaw-gateway'], env)
  }
  const id = containerId()
  if (!id) {
    return {
      ok: false,
      reason: '无法定位 openclaw-gateway 容器，配置未能写入卷',
      detail: String(created.stderr || created.stdout || '')
        .trim()
        .slice(0, 400)
    }
  }
  const cp = spawnSync(
    'docker',
    ['cp', CONFIG_FILE, `${id}:/home/node/.openclaw/openclaw.json`],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true }
  )
  if (cp.status !== 0) {
    return {
      ok: false,
      reason: 'docker cp openclaw.json 失败',
      detail: String(cp.stderr || cp.stdout || '')
        .trim()
        .slice(0, 400)
    }
  }
  return { ok: true, containerId: id }
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
  // 先停掉再合并配置，避免运行中 cp 触发 clobber / 迁移锁
  const env = composeEnv(token, port)
  const liveBefore = await checkDockerGatewayHealth(port)
  let alreadyRunning = !!(liveBefore && liveBefore.ok && serviceRunning())

  upsertEnvKey('OPENCLAW_PORT', String(port))
  upsertEnvKey('OPENCLAW_MODE', 'docker')
  if (!String(process.env.OPENCLAW_IMAGE || '').trim()) {
    upsertEnvKey('OPENCLAW_IMAGE', DEFAULT_IMAGE)
  }

  if (alreadyRunning) {
    return {
      ok: true,
      mode: 'docker',
      alreadyRunning: true,
      port,
      hasToken: !!token,
      token,
      chatCompletions: { enabled: true, configOk: true, changed: false },
      distro: 'docker'
    }
  }

  compose(['rm', '-sf', 'openclaw-gateway'], env)
  clearStaleLocks()
  // 给上一次崩溃留下的 migration lease 一点过期缓冲
  await sleep(2000)
  ensureOpenclawConfig(token, port)
  const synced = syncConfigIntoVolume(token, port)
  if (!synced.ok) {
    return {
      ok: false,
      mode: 'docker',
      reason: synced.reason || '写入 OpenClaw 配置失败',
      detail: synced.detail || '',
      hint: '确认 Docker 正常，且 docker/openclaw/home/openclaw.json 可写'
    }
  }
  const up = compose(
    ['up', '-d', '--pull', 'missing', '--no-deps', 'openclaw-gateway'],
    env
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

  const deadline = Date.now() + waitMs
  let health = { ok: false }
  let migrationRetried = false
  while (Date.now() < deadline) {
    health = await checkDockerGatewayHealth(port)
    if (health.ok) break
    const logs = compose(['logs', '--tail', '30', 'openclaw-gateway'])
    const text = String(logs.stdout || logs.stderr || '')
    if (
      !migrationRetried &&
      /startup migrations are already running/i.test(text)
    ) {
      migrationRetried = true
      const m = text.match(
        /retry after the other OpenClaw process finishes or after ([0-9T:\.\-Z]+)/i
      )
      let waitUntil = Date.now() + 15000
      if (m && m[1]) {
        const ts = Date.parse(m[1])
        if (!Number.isNaN(ts)) waitUntil = Math.max(waitUntil, ts + 1000)
      }
      const sleepMs = Math.min(
        Math.max(waitUntil - Date.now(), 2000),
        Math.max(deadline - Date.now() - 5000, 2000)
      )
      compose(['rm', '-sf', 'openclaw-gateway'], env)
      clearStaleLocks()
      await sleep(sleepMs)
      syncConfigIntoVolume(token, port)
      compose(
        ['up', '-d', '--pull', 'missing', '--no-deps', 'openclaw-gateway'],
        env
      )
      continue
    }
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
    alreadyRunning: false,
    port,
    hasToken: !!token,
    token,
    chatCompletions: { enabled: true, configOk: true, changed: false },
    distro: 'docker'
  }
}

module.exports = {
  DEFAULT_PORT,
  CONTAINER_PORT,
  DEFAULT_IMAGE,
  ensureOpenclawDockerGateway,
  ensureGatewayToken,
  ensureOpenclawConfig,
  syncConfigIntoVolume,
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
