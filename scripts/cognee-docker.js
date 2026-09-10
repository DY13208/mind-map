/**
 * 从本机 Cognee 仓库（默认 D:\cognee）拉起 API，供 OpenClaw cognee-openclaw 插件使用。
 * 由 Start-Docker / docker-up 在 OpenClaw 之前调用；仅需 mind-map .env 配置。
 */
const fs = require('fs')
const path = require('path')
const http = require('http')
const { spawnSync, execSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const DEFAULT_DIR = process.env.COGNEE_DIR || 'D:\\cognee'
const DEFAULT_PORT = Number(process.env.COGNEE_PORT || 8320)
const DEFAULT_URL =
  process.env.COGNEE_URL || `http://host.docker.internal:${DEFAULT_PORT}`

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

function cogneeEnabled() {
  const v = String(process.env.COGNEE_ENABLED || '1').trim().toLowerCase()
  return v !== '0' && v !== 'false' && v !== 'off' && v !== 'no'
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

function composeCognee(dir, args) {
  return spawnSync('docker', ['compose', ...args], {
    cwd: dir,
    encoding: 'utf8',
    windowsHide: true,
    env: process.env
  })
}

/**
 * 确保本机 Cognee API 在跑（docker compose up cognee）。
 */
async function ensureCognee({
  dir = resolveCogneeDir(),
  port = DEFAULT_PORT,
  waitMs = Number(process.env.COGNEE_WAIT_MS || 120000)
} = {}) {
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

  const up = composeCognee(dir, ['up', '-d', 'cognee'])
  if (up.status !== 0) {
    return {
      ok: false,
      dir,
      port,
      reason: 'docker compose 启动 cognee 失败',
      detail: String(up.stderr || up.stdout || '')
        .trim()
        .slice(0, 600),
      hint: `请在 ${dir} 手动执行：docker compose up -d cognee`
    }
  }

  const deadline = Date.now() + waitMs
  let health = { ok: false }
  while (Date.now() < deadline) {
    health = await checkCogneeHealth(port)
    if (health.ok) break
    await sleep(2000)
  }

  if (!health.ok) {
    const logs = composeCognee(dir, ['logs', '--tail', '40', 'cognee'])
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
