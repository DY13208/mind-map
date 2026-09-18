/**
 * 用 Docker Compose 拉起 OpenClaw Gateway（龙虾），供 Start-Docker / 助理页使用。
 * 默认镜像：openclaw/openclaw:latest（可用 OPENCLAW_IMAGE 覆盖；GHCR 拉不动时用 Docker Hub）。
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const http = require('http')
const { spawnSync, execSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const ENV_FILE = path.join(ROOT, '.env')
const DATA_DIR = path.join(ROOT, 'docker', 'openclaw', 'home')
// 仅作单次注入的临时文件，绝不把含 token/MCP 凭据的配置落在 Git 工作区。
const CONFIG_FILE = path.join(os.tmpdir(), 'mind-map-openclaw.inject.json')
const PROTECTED_CONFIG_FILE = String(
  process.env.OPENCLAW_CONFIG_SOURCE || loadEnvFile().OPENCLAW_CONFIG_SOURCE || ''
).trim()
// 宿主机映射端口（避免与本机原生 OpenClaw Tray 的 18789 冲突）
const DEFAULT_PORT = Number(process.env.OPENCLAW_PORT || 4623)
// 容器内监听端口（compose / nginx 固定走这个）
const CONTAINER_PORT = Number(process.env.OPENCLAW_GATEWAY_PORT || 18789)
const DEFAULT_IMAGE =
  process.env.OPENCLAW_IMAGE || 'openclaw/openclaw:latest'
const COGNEE_PLUGIN_ID = 'cognee-openclaw'

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

/**
 * 本机 WorkBuddy 已配 DeepSeek 时，写入 .env，供 OpenClaw 容器注入。
 * 不打印密钥。已有 DEEPSEEK_API_KEY 时不覆盖。
 */
function hydrateDeepseekApiKey() {
  const existing = String(
    process.env.DEEPSEEK_API_KEY || loadEnvFile().DEEPSEEK_API_KEY || ''
  ).trim()
  if (existing && !existing.startsWith('${')) {
    process.env.DEEPSEEK_API_KEY = existing
    return true
  }
  const home = process.env.USERPROFILE || process.env.HOME || ''
  if (!home) return false
  const file = path.join(home, '.workbuddy', 'models.json')
  if (!fs.existsSync(file)) return false
  let hit = null
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    const list = Array.isArray(raw) ? raw : raw.models || []
    hit = list.find(
      m =>
        m &&
        m.apiKey &&
        !String(m.apiKey).startsWith('${') &&
        (/deepseek/i.test(String(m.id || '')) ||
          /deepseek/i.test(String(m.vendor || '')) ||
          /deepseek\.com/i.test(String(m.url || '')))
    )
  } catch (e) {
    return false
  }
  if (!hit || !hit.apiKey) return false
  const apiKey = String(hit.apiKey).trim()
  upsertEnvKey('DEEPSEEK_API_KEY', apiKey)
  process.env.DEEPSEEK_API_KEY = apiKey
  return true
}

function applyDeepseekModel(cfg) {
  if (!hydrateDeepseekApiKey()) return cfg
  cfg.models = cfg.models || {}
  cfg.models.mode = cfg.models.mode || 'merge'
  cfg.models.providers = cfg.models.providers || {}
  const prev = cfg.models.providers.deepseek || {}
  const models =
    Array.isArray(prev.models) && prev.models.length
      ? prev.models
      : [
          {
            id: 'deepseek-v4-flash',
            name: 'DeepSeek V4 Flash',
            api: 'openai-completions',
            input: ['text'],
            contextWindow: 1000000,
            maxTokens: 8192
          }
        ]
  cfg.models.providers.deepseek = {
    ...prev,
    baseUrl: prev.baseUrl || 'https://api.deepseek.com/v1',
    // 引用环境变量，避免把密钥写进可提交的配置
    apiKey: '${DEEPSEEK_API_KEY}',
    api: prev.api || 'openai-completions',
    models
  }
  cfg.agents = cfg.agents || {}
  cfg.agents.defaults = cfg.agents.defaults || {}
  const current = cfg.agents.defaults.model
  const primary =
    typeof current === 'string'
      ? current
      : current && typeof current === 'object'
        ? current.primary
        : ''
  const missingAuth = !primary || /^openai\//i.test(String(primary))
  if (missingAuth) {
    cfg.agents.defaults.model = {
      ...(current && typeof current === 'object' ? current : {}),
      primary: 'deepseek/deepseek-v4-flash'
    }
  }
  return cfg
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

function rotateGatewayToken() {
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
  if (process.env.OPENCLAW_VOLUME) return process.env.OPENCLAW_VOLUME
  const inspected = spawnSync(
    'docker',
    ['inspect', 'mind-map-openclaw-gateway-1', '--format', '{{range .Mounts}}{{if eq .Destination "/home/node/.openclaw"}}{{.Name}}{{end}}{{end}}'],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true }
  )
  const mounted = String(inspected.stdout || '').trim()
  if (mounted) return mounted

  const listed = spawnSync(
    'docker',
    ['compose', '-f', 'docker-compose.yml', 'config', '--volumes'],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true }
  )
  const logical = String(listed.stdout || '')
    .split(/\r?\n/)
    .map(s => s.trim())
    .find(s => /openclaw$/.test(s))
  if (!logical) return 'mind-map_mind-map-openclaw'

  // `compose config --volumes` returns the logical key, while Docker stores
  // the default-scoped volume with the Compose project prefix. Resolve the
  // real volume before probing or copying its contents.
  const candidates = [
    `${process.env.COMPOSE_PROJECT_NAME || path.basename(ROOT)}_${logical}`,
    `mind-map_${logical}`,
    logical
  ]
  for (const candidate of candidates) {
    const probe = spawnSync('docker', ['volume', 'inspect', candidate], {
      cwd: ROOT,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore']
    })
    if (probe.status === 0) return candidate
  }
  return candidates[1]
}

/**
 * Cognee 是安装在 OpenClaw 状态卷里的外部插件。若 memory slot 指向一个
 * 不存在的插件，OpenClaw 会在网关监听前终止并被 Compose 无限重启。
 */
function cogneePluginInstalled() {
  const r = spawnSync(
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
        'test -f /data/extensions/cognee-openclaw/openclaw.plugin.json',
        'test -f /data/extensions/cognee-openclaw/dist/index.js'
      ].join(' && ')
    ],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true }
  )
  if (r.error || r.status === null) return { ok: false, indeterminate: true }
  return { ok: r.status === 0, indeterminate: r.status !== 0 && !!r.stderr }
}

function disableCogneePlugin(cfg) {
  if (!cfg || !cfg.plugins) return false
  let changed = false
  if (
    cfg.plugins.slots &&
    cfg.plugins.slots.memory === COGNEE_PLUGIN_ID
  ) {
    delete cfg.plugins.slots.memory
    changed = true
  }
  if (cfg.plugins.entries && cfg.plugins.entries[COGNEE_PLUGIN_ID]) {
    const entry = cfg.plugins.entries[COGNEE_PLUGIN_ID]
    if (entry.enabled !== false) {
      entry.enabled = false
      changed = true
    }
  }
  return changed
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
  // 卷内配置是运行时真相；仅在新卷上允许从仓库外的受保护位置注入。
  // 不再读取 DATA_DIR/openclaw.json 作为回退，避免旧快照在重启时覆盖卷内修改。
  const fromVolume = pullConfigFromVolume()
  if (!fromVolume && !PROTECTED_CONFIG_FILE) {
    throw new Error('无法读取命名卷内 openclaw.json，已停止覆盖以保护现有配置')
  }
  const fromProtectedSource =
    !fromVolume && PROTECTED_CONFIG_FILE
      ? readJsonFile(path.resolve(PROTECTED_CONFIG_FILE))
      : null
  let cfg = fromVolume || fromProtectedSource || {}
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
  applyDeepseekModel(cfg)

  // Cognee 是可选能力：插件未安装时清理失效引用，让 Gateway 先正常启动。
  let cogneeActive = false
  /* LIANGCE_LOAD_COGNEE_ENV */
  {
    const envMap = loadEnvFile()
    for (const k of ['COGNEE_ENABLED','COGNEE_DIR','COGNEE_PORT','COGNEE_URL','COGNEE_API_KEY','COGNEE_DATASET']) {
      if (!String(process.env[k] || '').trim() && envMap[k]) process.env[k] = envMap[k]
    }
  }
  try {
    const { cogneeEnabled, cogneeOpenclawPluginConfig } = require('./cognee-docker')
    const probe = cogneePluginInstalled()
    /* LIANGCE_COGNEE_SLOT_GUARD */
    // Keep Cognee memory slot whenever plugin files exist on the volume.
    // COGNEE_ENABLED=false alone must NOT clear plugins.slots.memory.
    const pluginFilesPresent = probe.ok
    const cogneeWanted = cogneeEnabled()
    const pluginInstalled = pluginFilesPresent && cogneeWanted
    if (pluginInstalled) {
      const plugin = cogneeOpenclawPluginConfig()
      if (plugin) {
        cfg.plugins = cfg.plugins || {}
        cfg.plugins.entries = cfg.plugins.entries || {}
        const prev =
          (cfg.plugins.entries[COGNEE_PLUGIN_ID] &&
            cfg.plugins.entries[COGNEE_PLUGIN_ID].config) ||
          {}
        const nextConfig = {
          ...prev,
          ...plugin.config
        }
        // env 未给 key 时保留卷里已有 apiKey
        if (!plugin.config.apiKey && prev.apiKey) {
          nextConfig.apiKey = prev.apiKey
        }
        cfg.plugins.entries[COGNEE_PLUGIN_ID] = {
          ...(cfg.plugins.entries[COGNEE_PLUGIN_ID] || {}),
          ...plugin,
          config: nextConfig
        }
        cfg.plugins.slots = cfg.plugins.slots || {}
        if (!cfg.plugins.slots.memory) {
          cfg.plugins.slots.memory = COGNEE_PLUGIN_ID
        }
        cogneeActive = true
      }
    } else if (!probe.ok && !probe.indeterminate) {
      disableCogneePlugin(cfg)
    } else if (pluginFilesPresent) {
      cfg.plugins = cfg.plugins || {}
      cfg.plugins.entries = cfg.plugins.entries || {}
      cfg.plugins.entries[COGNEE_PLUGIN_ID] = {
        ...(cfg.plugins.entries[COGNEE_PLUGIN_ID] || {}),
        enabled: true
      }
      cfg.plugins.slots = cfg.plugins.slots || {}
      cfg.plugins.slots.memory = COGNEE_PLUGIN_ID
      cogneeActive = true
    }
  } catch (e) {
    // 探测异常时保留原配置，禁止误删 slot。
  }

  // 仅当插件确实在卷内时，才强制启用 Cognee memory slot；否则 Gateway 会因插件缺失崩溃重启。
  if (cogneeActive) {
    cfg.plugins = cfg.plugins || {}
    cfg.plugins.entries = cfg.plugins.entries || {}
    cfg.plugins.entries[COGNEE_PLUGIN_ID] =
      cfg.plugins.entries[COGNEE_PLUGIN_ID] || {}
    cfg.plugins.entries[COGNEE_PLUGIN_ID].enabled = true
    cfg.plugins.slots = cfg.plugins.slots || {}
    cfg.plugins.slots.memory = COGNEE_PLUGIN_ID
  }

  /* LIANGCE_INGRESS_PERSIST */
  {
    const LIANGCE_ID = 'liangce-ingress'
    const LIANGCE_PATH = '/home/node/.openclaw/extensions/liangce-ingress'
    cfg.plugins = cfg.plugins || {}
    cfg.plugins.entries = cfg.plugins.entries || {}
    const prevLiangce = cfg.plugins.entries[LIANGCE_ID] || {}
    const envMap = loadEnvFile()
    const envSecret = String(
      process.env.OPENCLAW_LIANGCE_HANDOFF_SECRET ||
        envMap.OPENCLAW_LIANGCE_HANDOFF_SECRET ||
        (prevLiangce.config && prevLiangce.config.handoffSecret) ||
        ''
    ).trim()
    cfg.plugins.entries[LIANGCE_ID] = {
      ...prevLiangce,
      enabled: true,
      config: {
        ...(prevLiangce.config || {}),
        ...(envSecret ? { handoffSecret: envSecret } : {})
      }
    }
    cfg.plugins.load = cfg.plugins.load || {}
    const paths = Array.isArray(cfg.plugins.load.paths)
      ? cfg.plugins.load.paths.slice()
      : []
    if (!paths.includes(LIANGCE_PATH)) paths.push(LIANGCE_PATH)
    cfg.plugins.load.paths = paths
    if (Array.isArray(cfg.plugins.allow) && cfg.plugins.allow.length) {
      const allow = new Set(cfg.plugins.allow.map(String))
      allow.add(LIANGCE_ID)
      if (cogneeActive) allow.add(COGNEE_PLUGIN_ID)
      cfg.plugins.allow = Array.from(allow)
    }
    if (cogneeActive) {
      cfg.plugins.slots = cfg.plugins.slots || {}
      cfg.plugins.slots.memory = COGNEE_PLUGIN_ID
    }
  }

  
  /* PHASE2B_PLUGINS_ALLOW */
  {
    // Explicit allowlist: unknown third-party plugins cannot auto-load.
    const REQUIRED = [
      'anthropic', 'browser', 'canvas', 'cognee-openclaw', 'cua-computer',
      'device-pair', 'file-transfer', 'geolocation', 'liangce-ingress',
      'linux-node', 'memory-core', 'ollama', 'openai', 'talk-voice', 'xai', 'deepseek'
    ]
    cfg.plugins = cfg.plugins || {}
    const allow = new Set((Array.isArray(cfg.plugins.allow) ? cfg.plugins.allow : []).map(String))
    for (const id of REQUIRED) allow.add(id)
    allow.add('liangce-ingress')
    allow.add(COGNEE_PLUGIN_ID)
    cfg.mcp = cfg.mcp || {}
    cfg.mcp.servers = cfg.mcp.servers || {}
    delete cfg.mcp.servers['identity-mcp']
    const kmcpUrl = process.env.KNOWLEDGE_MCP_URL || 'http://knowledge-mcp:18792/mcp'
    cfg.mcp.servers['knowledge-mcp'] = { url: kmcpUrl }
    cfg.plugins.allow = Array.from(allow)
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
  hydrateDeepseekApiKey()
  return {
    OPENCLAW_GATEWAY_TOKEN: token,
    OPENCLAW_PORT: String(port),
    OPENCLAW_IMAGE: process.env.OPENCLAW_IMAGE || DEFAULT_IMAGE,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || ''
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

/**
 * 把仓库内 liangce-ingress 插件同步进 OpenClaw 命名卷。
 * Start-Docker 会把 plugins.load.paths 写进 openclaw.json；若卷里没有插件文件，
 * Gateway 会直接拒启（plugin path not found）。Git pull 不会更新命名卷，必须在此拷贝。
 */
function syncLiangceIngressIntoVolume(containerId) {
  const hostDir = path.join(ROOT, 'integrations', 'openclaw', 'liangce-ingress')
  const marker = path.join(hostDir, 'openclaw.plugin.json')
  if (!fs.existsSync(marker)) {
    return {
      ok: false,
      reason: 'missing integrations/openclaw/liangce-ingress (git pull first)'
    }
  }
  if (!containerId) {
    return { ok: false, reason: 'no openclaw-gateway container; cannot sync liangce-ingress' }
  }

  // Prefer volumes-from alpine so mkdir works even when gateway is crash-looping
  // (docker exec fails on restarting containers; docker cp needs parent dirs).
  const mkdir = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--volumes-from',
      containerId,
      'alpine:3.20',
      'sh',
      '-c',
      'mkdir -p /home/node/.openclaw/extensions/liangce-ingress && chown -R 1000:1000 /home/node/.openclaw/extensions || true'
    ],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true }
  )
  if (mkdir.status !== 0) {
    // Fallback: try exec (container created but not yet restarting)
    spawnSync(
      'docker',
      [
        'exec',
        containerId,
        'sh',
        '-lc',
        'mkdir -p /home/node/.openclaw/extensions/liangce-ingress || true'
      ],
      { cwd: ROOT, encoding: 'utf8', windowsHide: true }
    )
  }

  const cp = spawnSync(
    'docker',
    [
      'cp',
      hostDir + '/.',
      containerId + ':/home/node/.openclaw/extensions/liangce-ingress/'
    ],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true }
  )
  if (cp.status !== 0) {
    return {
      ok: false,
      reason: 'docker cp liangce-ingress failed',
      detail: String(cp.stderr || cp.stdout || mkdir.stderr || '').trim().slice(0, 400)
    }
  }
  spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--volumes-from',
      containerId,
      'alpine:3.20',
      'sh',
      '-c',
      'chown -R 1000:1000 /home/node/.openclaw/extensions/liangce-ingress 2>/dev/null || true'
    ],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true }
  )
  return { ok: true }
}

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
  const backup = `${id}:/home/node/.openclaw/openclaw.json`
  const backupPath = path.join(os.tmpdir(), `openclaw.json.bak.${Date.now()}`)
  const saved = spawnSync('docker', ['cp', backup, backupPath], { cwd: ROOT, encoding: 'utf8', windowsHide: true })
  if (saved.status !== 0) {
    return { ok: false, reason: '覆盖前无法备份卷内 openclaw.json', detail: String(saved.stderr || '') }
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
  try {
    fs.unlinkSync(CONFIG_FILE)
  } catch (e) {
    /* 临时注入文件将在下次写入时覆盖 */
  }
  // 复制前已由容器卷保留 last-good；复制后恢复运行用户权限，避免 root:root 配置。
  spawnSync('docker', ['exec', id, 'sh', '-lc', 'chown node:node /home/node/.openclaw/openclaw.json 2>/dev/null || true; chmod 600 /home/node/.openclaw/openclaw.json'], { cwd: ROOT, encoding: 'utf8', windowsHide: true })
  const pluginSync = syncLiangceIngressIntoVolume(id)
  if (!pluginSync.ok) {
    return {
      ok: false,
      reason: pluginSync.reason || '同步 liangce-ingress 失败',
      detail: pluginSync.detail || '',
      containerId: id
    }
  }
  return { ok: true, containerId: id, liangceIngressSynced: true }
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
      ensureOpenclawConfig(token, port)
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
  rotateGatewayToken,
  ensureOpenclawConfig,
  cogneePluginInstalled,
  disableCogneePlugin,
  syncConfigIntoVolume,
  checkDockerGatewayHealth,
  DATA_DIR
}

if (require.main === module) {
  if (process.argv.includes('--rotate-token')) rotateGatewayToken()
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
