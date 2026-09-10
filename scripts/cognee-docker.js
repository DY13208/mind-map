/**
 * 从本机 Cognee 仓库（默认 D:\cognee）拉起 API，供 OpenClaw cognee-openclaw 插件使用。
 * 由 Start-Docker / docker-up 在 OpenClaw 之前调用；仅需 mind-map .env 配置。
 */
const fs = require('fs')
const path = require('path')
const http = require('http')
const { spawn, spawnSync, execSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const DEFAULT_DIR = process.env.COGNEE_DIR || 'D:\\cognee'
const DEFAULT_PORT = Number(process.env.COGNEE_PORT || 8320)
const DEFAULT_URL =
  process.env.COGNEE_URL || `http://host.docker.internal:${DEFAULT_PORT}`

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

function cogneeEnabled() {
  // 默认关闭：生产机通常没有 Cognee 镜像；本机开发在 .env 设 COGNEE_ENABLED=1
  const v = String(process.env.COGNEE_ENABLED || '0').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'on' || v === 'yes'
}

function resolveCogneeDir() {
  const dir = path.resolve(String(process.env.COGNEE_DIR || DEFAULT_DIR).trim())
  return dir
}

function hostHealthUrl(port = DEFAULT_PORT) {
  return (
    process.env.COGNEE_HEALTH_URL ||
    `http://127.0.0.1:${port}/health`
  )
}

function httpGet(url, timeoutMs = 3000) {
  return new Promise(resolve => {
    let parsed
    try {
      parsed = new URL(url)
    } catch (e) {
      resolve({ ok: false, status: 0, error: 'bad url' })
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
      resolve({ ok: false, status: 0, error: 'timeout' })
    })
    req.on('error', err =>
      resolve({
        ok: false,
        status: 0,
        error: (err && err.message) || String(err)
      })
    )
    req.end()
  })
}

async function checkCogneeHealth(port = DEFAULT_PORT) {
  const url = hostHealthUrl(port)
  const res = await httpGet(url)
  if (res.ok) return { ok: true, url, status: res.status }
  // 部分版本用 /healthz 或根路径
  for (const p of ['/healthz', '/api/health', '/']) {
    const u = `http://127.0.0.1:${port}${p}`
    const r = await httpGet(u)
    if (r.ok) return { ok: true, url: u, status: r.status }
  }
  return { ok: false, url, status: res.status || 0, error: res.error }
}

function hasDocker() {
  try {
    execSync('docker info', { stdio: 'ignore' })
    return true
  } catch (e) {
    return false
  }
}

function containerRunning(name = 'cognee') {
  try {
    const out = execSync(
      `docker inspect -f "{{.State.Running}} {{.State.Health.Status}}" ${name}`,
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
    )
      .trim()
      .split(/\s+/)
    return {
      running: out[0] === 'true',
      health: out[1] || ''
    }
  } catch (e) {
    return { running: false, health: '' }
  }
}

function composeCogneeSync(dir, args) {
  return spawnSync('docker', ['compose', ...args], {
    cwd: dir,
    encoding: 'utf8',
    windowsHide: true,
    env: process.env
  })
}

/** 前台输出 docker compose 进度（拉取/构建可见） */
function composeCogneeLive(dir, args) {
  return new Promise(resolve => {
    const child = spawn('docker', ['compose', ...args], {
      cwd: dir,
      env: process.env,
      stdio: 'inherit',
      shell: true,
      windowsHide: false
    })
    child.on('error', err => {
      resolve({ status: 1, error: err })
    })
    child.on('exit', code => {
      resolve({ status: code == null ? 1 : code })
    })
  })
}

/**
 * 确保本机 Cognee API 在跑（docker compose up cognee）。
 * 已健康则立刻返回；否则前台拉起（无镜像会拉取/构建，并实时打印进度）。
 */
async function ensureCognee({
  dir = resolveCogneeDir(),
  port = DEFAULT_PORT,
  waitMs = Number(process.env.COGNEE_WAIT_MS || 180000),
  onLog = null
} = {}) {
  const log = msg => {
    if (typeof onLog === 'function') onLog(msg)
    else console.log(msg)
  }

  if (!cogneeEnabled()) {
    return { ok: true, skipped: true, reason: 'COGNEE_ENABLED 未开启' }
  }
  if (!hasDocker()) {
    return { ok: false, reason: '未检测到 Docker，无法启动 Cognee' }
  }
  if (!fs.existsSync(dir)) {
    return {
      ok: false,
      reason: `Cognee 目录不存在：${dir}`,
      hint: '请设置 COGNEE_DIR 指向本机仓库（如 D:\\cognee）'
    }
  }
  const composeFile = path.join(dir, 'docker-compose.yml')
  if (!fs.existsSync(composeFile)) {
    return {
      ok: false,
      reason: `${dir} 下没有 docker-compose.yml`
    }
  }

  log(`检查 Cognee 健康 ${hostHealthUrl(port)} …`)
  const live = await checkCogneeHealth(port)
  if (live.ok) {
    return {
      ok: true,
      alreadyRunning: true,
      dir,
      port,
      url: DEFAULT_URL,
      healthUrl: live.url
    }
  }

  const existing = containerRunning('cognee')
  if (existing.running) {
    log(`容器 cognee 已在运行（health=${existing.health || 'n/a'}），等待接口就绪…`)
  } else {
    log(`目录 ${dir}`)
    log('启动 Cognee（无镜像会自动拉取/构建，下方为 Docker 实时输出）…')
    // 允许构建与拉取；进度走 stdio inherit，不再静默卡住
    const up = await composeCogneeLive(dir, [
      'up',
      '-d',
      '--build',
      'cognee'
    ])
    if (up.status !== 0) {
      const again = await checkCogneeHealth(port)
      if (again.ok) {
        return {
          ok: true,
          alreadyRunning: true,
          dir,
          port,
          url: DEFAULT_URL,
          healthUrl: again.url
        }
      }
      return {
        ok: false,
        dir,
        port,
        reason: 'docker compose 启动 cognee 失败',
        hint: `请在 ${dir} 手动执行：docker compose up -d --build cognee`
      }
    }
    log('compose 已返回，等待 /health …')
  }

  const deadline = Date.now() + waitMs
  let health = { ok: false }
  while (Date.now() < deadline) {
    health = await checkCogneeHealth(port)
    if (health.ok) break
    log('等待 Cognee /health …')
    await sleep(2000)
  }

  if (!health.ok) {
    const logs = composeCogneeSync(dir, ['logs', '--tail', '40', 'cognee'])
    return {
      ok: false,
      dir,
      port,
      reason: `Cognee 未在 ${waitMs}ms 内就绪（${hostHealthUrl(port)}）`,
      detail: String(logs.stdout || logs.stderr || '')
        .trim()
        .slice(0, 800),
      hint: `查看日志：cd /d ${dir} && docker compose logs -f cognee`
    }
  }

  return {
    ok: true,
    alreadyRunning: false,
    dir,
    port,
    url: DEFAULT_URL,
    healthUrl: health.url
  }
}

function formatCogneeResult(result) {
  if (!result) return ''
  if (result.skipped) return `Cognee 已跳过：${result.reason || ''}`
  if (result.ok) {
    return result.alreadyRunning
      ? `Cognee 已在运行  ${result.healthUrl || hostHealthUrl(result.port)}`
      : `Cognee 已启动  ${result.healthUrl || hostHealthUrl(result.port)} → OpenClaw 使用 ${result.url || DEFAULT_URL}`
  }
  const lines = [`Cognee 未就绪：${result.reason || '未知错误'}`]
  if (result.hint) lines.push(`  → ${result.hint}`)
  return lines.join('\n')
}

function cogneeOpenclawPluginConfig() {
  if (!cogneeEnabled()) return null
  const baseUrl = String(
    process.env.COGNEE_URL || DEFAULT_URL
  ).trim()
  const apiKey = String(process.env.COGNEE_API_KEY || '').trim()
  const datasetName = String(
    process.env.COGNEE_DATASET || 'liangce'
  ).trim()
  return {
    enabled: true,
    hooks: { allowConversationAccess: true },
    config: {
      baseUrl,
      ...(apiKey ? { apiKey } : {}),
      datasetName
    }
  }
}

module.exports = {
  DEFAULT_DIR,
  DEFAULT_PORT,
  DEFAULT_URL,
  cogneeEnabled,
  ensureCognee,
  checkCogneeHealth,
  formatCogneeResult,
  cogneeOpenclawPluginConfig,
  resolveCogneeDir
}

if (require.main === module) {
  ensureCognee()
    .then(r => {
      console.log(formatCogneeResult(r))
      if (r && !r.ok && !r.skipped) {
        if (r.detail) console.error(r.detail)
        process.exit(1)
      }
      process.exit(0)
    })
    .catch(err => {
      console.error(err)
      process.exit(1)
    })
}
