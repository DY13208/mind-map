/**
 * 本机 OpenClaw Gateway 自动拉起（供 Start-Docker / docker-up 调用）。
 * Gateway 一般跑在 WSL 用户 systemd：openclaw-gateway.service → 127.0.0.1:18789
 * 启动时会自动开启 gateway.http.endpoints.chatCompletions（助理页依赖）。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn, spawnSync, execFileSync } = require('child_process')

const DEFAULT_PORT = Number(process.env.OPENCLAW_PORT || 18789)
const HEALTH_PATH = '/health'
const DEFAULT_DISTROS = [
  'OpenClawGateway',
  'Ubuntu',
  'Ubuntu-24.04',
  'Ubuntu-22.04'
]
const ENABLE_CHAT_COMPLETIONS =
  process.env.OPENCLAW_ENABLE_CHAT_COMPLETIONS !== '0'
const ENABLE_CHAT_SCRIPT = path.join(__dirname, 'openclaw-enable-chat.js')

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

function toWslPath(winPath) {
  const resolved = path.resolve(winPath)
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(resolved)
  if (!m) return resolved.replace(/\\/g, '/')
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`
}

function httpRequest(
  url,
  { method = 'GET', headers = {}, timeoutMs = 2500 } = {}
) {
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
        method,
        headers,
        timeout: timeoutMs
      },
      res => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', chunk => {
          body += chunk
        })
        res.on('end', () => {
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            body
          })
        })
      }
    )
    req.on('timeout', () => {
      req.destroy()
      resolve({ ok: false, status: 0, body: '', error: 'timeout' })
    })
    req.on('error', err => {
      resolve({
        ok: false,
        status: 0,
        body: '',
        error: (err && err.message) || String(err)
      })
    })
    req.end()
  })
}

async function checkHealth(port = DEFAULT_PORT) {
  const res = await httpRequest(`http://127.0.0.1:${port}${HEALTH_PATH}`)
  if (!res.ok) return { ok: false, status: res.status, error: res.error }
  let data = null
  try {
    data = JSON.parse(res.body || '{}')
  } catch (e) {
    data = null
  }
  return { ok: true, status: res.status, data }
}

async function checkChatCompletions(port = DEFAULT_PORT, token = '') {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await httpRequest(`http://127.0.0.1:${port}/v1/models`, {
    headers,
    timeoutMs: 4000
  })
  return {
    ok: res.ok,
    status: res.status,
    // 0=连不上；404=接口未开；其它（200/401 等）视为端点已暴露
    enabled: res.status > 0 && res.status !== 404
  }
}

function listWslDistros() {
  try {
    const out = execFileSync('wsl.exe', ['-l', '-q'], {
      encoding: 'utf16le',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    return String(out || '')
      .split(/\r?\n/)
      .map(s => s.replace(/\u0000/g, '').trim())
      .filter(Boolean)
      .filter(name => !/^docker-desktop/i.test(name))
  } catch (e) {
    return []
  }
}

function wslRun(distro, command, timeoutMs = 45000) {
  const args = ['-d', distro, '--', 'bash', '-lc', command]
  try {
    const r = spawnSync('wsl.exe', args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return {
      ok: r.status === 0,
      status: r.status,
      stdout: String(r.stdout || '').replace(/\u0000/g, ''),
      stderr: String(r.stderr || '').replace(/\u0000/g, '')
    }
  } catch (err) {
    return {
      ok: false,
      status: -1,
      stdout: '',
      stderr: (err && err.message) || String(err)
    }
  }
}

function distroHasOpenclaw(distro) {
  const probe = wslRun(
    distro,
    [
      'if systemctl --user cat openclaw-gateway.service >/dev/null 2>&1; then echo HAS_SERVICE; fi',
      'if command -v openclaw >/dev/null 2>&1; then echo HAS_CLI; fi',
      'if [ -x "$HOME/.npm-global/bin/openclaw" ]; then echo HAS_NPM; fi'
    ].join('; '),
    20000
  )
  const text = `${probe.stdout}\n${probe.stderr}`
  return /HAS_SERVICE|HAS_CLI|HAS_NPM/.test(text)
}

function resolveDistro() {
  const forced = String(process.env.OPENCLAW_WSL_DISTRO || '').trim()
  const installed = listWslDistros()
  if (forced) return forced
  const preferred = DEFAULT_DISTROS.filter(d => installed.includes(d))
  const candidates = [
    ...preferred,
    ...installed.filter(d => !preferred.includes(d))
  ]
  for (const name of candidates) {
    if (distroHasOpenclaw(name)) return name
  }
  return preferred[0] || installed[0] || 'Ubuntu'
}

function findTrayExe() {
  const fromEnv = String(process.env.OPENCLAW_TRAY_EXE || '').trim()
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const candidates = [
    'D:\\openclaw\\OpenClawTray\\OpenClaw.Tray.WinUI.exe',
    'C:\\openclaw\\OpenClawTray\\OpenClaw.Tray.WinUI.exe',
    path.join(
      process.env.LOCALAPPDATA || '',
      'Programs',
      'OpenClawTray',
      'OpenClaw.Tray.WinUI.exe'
    ),
    path.join(
      home,
      'AppData',
      'Local',
      'Programs',
      'OpenClawTray',
      'OpenClaw.Tray.WinUI.exe'
    )
  ]
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p
  }
  return ''
}

function isTrayRunning() {
  try {
    const r = spawnSync(
      'tasklist',
      ['/FI', 'IMAGENAME eq OpenClaw.Tray.WinUI.exe', '/NH'],
      { encoding: 'utf8', windowsHide: true }
    )
    return /OpenClaw\.Tray\.WinUI\.exe/i.test(String(r.stdout || ''))
  } catch (e) {
    return false
  }
}

function ensureTrayStarted() {
  if (isTrayRunning()) return { ok: true, alreadyRunning: true }
  const exe = findTrayExe()
  if (!exe) return { ok: false, reason: '未找到 OpenClaw Tray' }
  try {
    spawn(exe, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    }).unref()
    return { ok: true, alreadyRunning: false, exe }
  } catch (err) {
    return {
      ok: false,
      reason: (err && err.message) || String(err),
      exe
    }
  }
}

/**
 * 开启 Chat Completions；变更时返回 changed=true（需重启 Gateway）。
 * 不打印 token / 配置原文。
 */
function ensureChatCompletionsConfig(distro) {
  if (!ENABLE_CHAT_COMPLETIONS) {
    return { ok: true, changed: false, skipped: true }
  }
  if (!fs.existsSync(ENABLE_CHAT_SCRIPT)) {
    return {
      ok: false,
      changed: false,
      reason: `缺少脚本 ${ENABLE_CHAT_SCRIPT}`
    }
  }
  const scriptUnix = toWslPath(ENABLE_CHAT_SCRIPT)
  const result = wslRun(
    distro,
    `node "${scriptUnix}" "$HOME/.openclaw/openclaw.json"`,
    30000
  )
  const text = `${result.stdout}\n${result.stderr}`
  if (/ALREADY_ENABLED/.test(text)) {
    return { ok: true, changed: false }
  }
  if (/^ENABLED\b/m.test(text) || /\nENABLED\b/.test(text)) {
    return { ok: true, changed: true }
  }
  if (/NO_CONFIG/.test(text) || result.status === 2) {
    return {
      ok: false,
      changed: false,
      reason: '未找到 OpenClaw 配置文件 ~/.openclaw/openclaw.json'
    }
  }
  return {
    ok: false,
    changed: false,
    reason: (result.stderr || result.stdout || '开启 Chat Completions 失败')
      .trim()
      .slice(0, 240)
  }
}

function readGatewayToken(distro) {
  const result = wslRun(
    distro,
    `node -e "const fs=require('fs');const p=process.env.HOME+'/.openclaw/openclaw.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));process.stdout.write(String(((j.gateway||{}).auth||{}).token||''))"`,
    15000
  )
  if (!result.ok) return ''
  return String(result.stdout || '').trim()
}

function startGatewayInWsl(distro) {
  const cmd = [
    'set -e',
    'export PATH="$HOME/.npm-global/bin:$PATH"',
    // 无 linger 时，WSL 会话一结束 user systemd 会把 gateway 一起杀掉
    'loginctl enable-linger "$(whoami)" >/dev/null 2>&1 || true',
    'if command -v systemctl >/dev/null 2>&1; then',
    '  systemctl --user enable openclaw-gateway.service >/dev/null 2>&1 || true',
    '  systemctl --user start openclaw-gateway.service 2>/dev/null || true',
    '  systemctl --user is-active --quiet openclaw-gateway.service && exit 0',
    'fi',
    'if command -v openclaw >/dev/null 2>&1; then',
    `  nohup openclaw gateway --port ${DEFAULT_PORT} >/tmp/openclaw-gateway-boot.log 2>&1 &`,
    '  exit 0',
    'fi',
    'echo "OPENCLAW_NOT_FOUND" >&2',
    'exit 1'
  ].join('\n')
  return wslRun(distro, cmd, 60000)
}

function restartGatewayInWsl(distro) {
  const cmd = [
    'export PATH="$HOME/.npm-global/bin:$PATH"',
    'if command -v systemctl >/dev/null 2>&1; then',
    '  systemctl --user restart openclaw-gateway.service',
    '  systemctl --user is-active --quiet openclaw-gateway.service && exit 0',
    'fi',
    'pkill -f "openclaw.*gateway" >/dev/null 2>&1 || true',
    'sleep 1',
    `nohup openclaw gateway --port ${DEFAULT_PORT} >/tmp/openclaw-gateway-boot.log 2>&1 &`,
    'exit 0'
  ].join('\n')
  return wslRun(distro, cmd, 60000)
}

/** 防止 WSL 闲置退出导致 Gateway 掉线（托盘同款思路） */
function ensureWslKeepAlive(distro) {
  try {
    const marker = path.join(
      process.env.TEMP || os.tmpdir(),
      `openclaw-wsl-keepalive-${distro}.pid`
    )
    if (fs.existsSync(marker)) {
      const oldPid = Number(fs.readFileSync(marker, 'utf8').trim())
      if (oldPid) {
        try {
          process.kill(oldPid, 0)
          return { ok: true, alreadyRunning: true, pid: oldPid }
        } catch (e) {
          /* stale */
        }
      }
    }
    const child = spawn(
      'wsl.exe',
      [
        '-d',
        distro,
        '--',
        'bash',
        '-lc',
        'while true; do sleep 3600; done'
      ],
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      }
    )
    if (child.pid) {
      fs.writeFileSync(marker, String(child.pid), 'utf8')
      child.unref()
      return { ok: true, alreadyRunning: false, pid: child.pid }
    }
  } catch (err) {
    return { ok: false, reason: (err && err.message) || String(err) }
  }
  return { ok: false, reason: 'keepalive 启动失败' }
}

async function waitForHealth(port, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs
  let last = { ok: false }
  while (Date.now() < deadline) {
    last = await checkHealth(port)
    if (last.ok) return last
    await sleep(1000)
  }
  return last
}

const {
  ensureOpenclawDockerGateway
} = require('./openclaw-docker')

async function ensureOpenclawGateway({
  port = DEFAULT_PORT,
  startTray = true,
  waitMs = Number(process.env.OPENCLAW_WAIT_MS || 90000),
  // docker（默认）| wsl | auto（Docker 失败再试 WSL）
  preferDocker = String(process.env.OPENCLAW_MODE || 'docker').toLowerCase() !== 'wsl'
} = {}) {
  const mode = String(process.env.OPENCLAW_MODE || 'docker').toLowerCase()
  // 默认走 Docker 龙虾网关；未装 WSL 时不要再去碰 WSL（否则会出现 WSL_E_DISTRO_NOT_FOUND）
  if (preferDocker) {
    try {
      const docker = await ensureOpenclawDockerGateway({ port, waitMs })
      if (docker && docker.ok) return docker
      // 仅 OPENCLAW_MODE=auto 时回退 WSL；docker（默认）直接失败返回
      if (mode !== 'auto') {
        return docker
      }
      if (docker && !docker.ok) {
        console.warn(
          `[openclaw] Docker 网关未就绪：${docker.reason || ''}，尝试 WSL…`
        )
      }
    } catch (err) {
      if (mode !== 'auto') {
        return {
          ok: false,
          mode: 'docker',
          reason: (err && err.message) || String(err)
        }
      }
    }
  }

  if (process.platform !== 'win32') {
    return {
      ok: false,
      skipped: true,
      reason: '非 Windows 且 Docker OpenClaw 未就绪'
    }
  }

  let distro = ''
  try {
    distro = resolveDistro()
  } catch (err) {
    return {
      ok: false,
      reason: `无法枚举 WSL：${(err && err.message) || err}`,
      hint: '请确认已安装 WSL，并已在其中装好 OpenClaw Gateway。'
    }
  }
  if (!distro) {
    return {
      ok: false,
      reason: '未找到可用的 WSL 发行版',
      hint:
        '请安装 Ubuntu/OpenClawGateway，或设置 OPENCLAW_WSL_DISTRO；也可先打开 OpenClaw Tray 完成 Setup。'
    }
  }

  const chatCfg = ensureChatCompletionsConfig(distro)
  const liveBefore = await checkHealth(port)
  let alreadyRunning = !!(liveBefore && liveBefore.ok)
  let started = { ok: true, stdout: '', stderr: '' }

  if (!alreadyRunning) {
    started = startGatewayInWsl(distro)
    if (!started.ok && /OPENCLAW_NOT_FOUND/.test(started.stderr || '')) {
      return {
        ok: false,
        distro,
        reason: `WSL「${distro}」内未找到 OpenClaw`,
        hint:
          '请在 OpenClaw Tray 完成 Gateway Setup，或设置 OPENCLAW_WSL_DISTRO 指向已安装发行版。'
      }
    }
  } else if (chatCfg.changed) {
    started = restartGatewayInWsl(distro)
    alreadyRunning = false
  }

  ensureWslKeepAlive(distro)

  const tray = startTray ? ensureTrayStarted() : null
  let health = await waitForHealth(port, waitMs)
  if (!health.ok) {
    // 再强拉一次（WSL 刚醒 / systemd 用户会话未就绪时常见）
    started = startGatewayInWsl(distro)
    await sleep(1500)
    health = await waitForHealth(port, Math.min(waitMs, 30000))
  }
  if (!health.ok) {
    return {
      ok: false,
      distro,
      port,
      tray,
      chatCompletions: chatCfg,
      reason: `Gateway 未在 ${waitMs}ms 内就绪（127.0.0.1:${port}）`,
      hint:
        '请在 OpenClaw Tray 检查 Gateway 状态；若 WSL 为 NAT 且 localhost 转发异常，需开启 localhostForwarding。也可手动执行：node scripts/openclaw-gateway.js',
      detail: (started.stderr || started.stdout || '').trim().slice(0, 400)
    }
  }

  const token = readGatewayToken(distro)
  let api = await checkChatCompletions(port, token)

  // 配置已是 true 但仍 404：再重启一次让 Gateway 重新加载
  if (!api.enabled && chatCfg.ok !== false && !chatCfg.changed) {
    restartGatewayInWsl(distro)
    await waitForHealth(port, waitMs)
    await sleep(1200)
    api = await checkChatCompletions(port, token)
    alreadyRunning = false
  } else if (!api.enabled && chatCfg.changed) {
    await sleep(1500)
    api = await checkChatCompletions(port, token)
  }

  return {
    ok: true,
    alreadyRunning,
    port,
    distro,
    tray,
    hasToken: !!token,
    token, // 仅供启动脚本写入 runtime-config；勿打印到控制台
    chatCompletions: {
      configOk: chatCfg.ok !== false,
      changed: !!chatCfg.changed,
      enabled: !!api.enabled,
      status: api.status,
      reason: chatCfg.reason || ''
    },
    wsl: started
  }
}

/**
 * 写入 Docker/前端可读的 runtime-config（含 Gateway Token）。
 * 文件应 gitignore，勿提交。
 */
function writeOpenclawRuntimeConfig({
  root,
  token = '',
  model = 'openclaw/default',
  port = DEFAULT_PORT
} = {}) {
  const projectRoot = path.resolve(root || path.join(__dirname, '..'))
  const file = path.join(projectRoot, 'docker', 'runtime-config.local.js')
  const dir = path.dirname(file)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const config = {
    gateway: true,
    publicPath: '/',
    openclawBase: '/openclaw-api',
    openclawToken: String(token || ''),
    openclawModel: String(model || 'openclaw/default'),
    openclawControlUrl: `http://127.0.0.1:${port}/chat`,
    openclawBridgeWs: '/openclaw-bridge/ws'
  }
  fs.writeFileSync(
    file,
    'window.__MIND_MAP_RUNTIME__ = ' + JSON.stringify(config, null, 2) + '\n',
    'utf8'
  )
  return { file, hasToken: !!config.openclawToken }
}

function formatOpenclawResult(result) {
  if (!result) return ''
  const lines = []
  if (result.ok) {
    const where =
      result.mode === 'docker'
        ? 'Docker 容器 openclaw-gateway'
        : result.distro
          ? `WSL: ${result.distro}`
          : '本机'
    lines.push(
      result.alreadyRunning
        ? `OpenClaw Gateway 已在运行  http://127.0.0.1:${result.port}（${where}）`
        : `OpenClaw Gateway 已启动  http://127.0.0.1:${result.port}（${where}）`
    )
    if (result.tray && result.tray.ok && !result.tray.alreadyRunning) {
      lines.push('OpenClaw Tray 已拉起')
    }
    if (result.runtimeWritten) {
      lines.push(
        result.hasToken
          ? '助理页连接配置已自动写入（Token 已注入，刷新页面即可用）'
          : '助理页 runtime 已写入，但未读到 Gateway Token，仍需检查 OpenClaw 配置'
      )
    }
    const cc = result.chatCompletions
    if (cc) {
      if (cc.enabled) {
        lines.push(
          cc.changed
            ? 'Chat Completions（/v1/chat/completions）已自动开启'
            : 'Chat Completions（/v1/chat/completions）已就绪'
        )
      } else if (cc.configOk === false) {
        lines.push(`Chat Completions 未能写入配置：${cc.reason || '未知错误'}`)
      } else {
        lines.push(
          'Chat Completions 仍未就绪（/v1/models 返回 ' +
            (cc.status || '?') +
            '）；助理页可能仍提示未启用'
        )
      }
    }
    return lines.join('\n')
  }
  if (result.skipped) {
    lines.push(`OpenClaw：${result.reason}`)
    return lines.join('\n')
  }
  lines.push(`OpenClaw Gateway 未就绪：${result.reason || '未知错误'}`)
  if (result.hint) lines.push(`  → ${result.hint}`)
  if (result.detail) lines.push(`  → ${result.detail}`)
  return lines.join('\n')
}

module.exports = {
  DEFAULT_PORT,
  checkHealth,
  ensureOpenclawGateway,
  formatOpenclawResult,
  findTrayExe,
  writeOpenclawRuntimeConfig,
  readGatewayToken
}

if (require.main === module) {
  ensureOpenclawGateway()
    .then(async r => {
      const token = (r && r.token) || ''
      const runtime = writeOpenclawRuntimeConfig({
        root: path.join(__dirname, '..'),
        token,
        port: DEFAULT_PORT
      })
      if (r) {
        delete r.token
        r.hasToken = !!(runtime && runtime.hasToken)
        r.runtimeWritten = true
      }
      console.log(formatOpenclawResult(r) || JSON.stringify(r, null, 2))
      try {
        const { ensureOpenclawWatchdog } = require('./openclaw-watchdog')
        const wd = ensureOpenclawWatchdog()
        if (wd && wd.ok) {
          console.log(
            wd.alreadyRunning
              ? 'OpenClaw 看门狗已在运行'
              : 'OpenClaw 看门狗已启动（防 502）'
          )
        }
      } catch (e) {
        /* ignore */
      }
      try {
        const {
          ensureOpenclawBridge,
          formatBridgeResult
        } = require('./openclaw-bridge-ctl')
        const bridge = await ensureOpenclawBridge({
          token,
          distro: r && r.distro
        })
        console.log(formatBridgeResult(bridge))
      } catch (e) {
        console.warn(
          'OpenClaw Bridge 启动失败：',
          (e && e.message) || e
        )
      }
      process.exit(r && r.ok ? 0 : 1)
    })
    .catch(err => {
      console.error(err)
      process.exit(1)
    })
}
