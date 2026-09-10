/**
 * OpenClaw Gateway 看门狗：在 Windows 侧周期检查 18789，挂了就拉起 WSL + gateway。
 * 由 Start-Docker / openclaw-gateway 自动后台启动，避免 WSL 闲置退出导致 502。
 *
 * 用法：
 *   node scripts/openclaw-watchdog.js          # 前台
 *   node scripts/openclaw-watchdog.js --daemon # 后台（默认被 ensure 调用）
 */
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const {
  DEFAULT_PORT,
  checkHealth,
  ensureOpenclawGateway,
  writeOpenclawRuntimeConfig
} = require('./openclaw-gateway')

const ROOT = path.resolve(__dirname, '..')
const INTERVAL_MS = Number(process.env.OPENCLAW_WATCHDOG_MS || 20000)
const PID_FILE = path.join(
  process.env.TEMP || require('os').tmpdir(),
  'openclaw-watchdog.pid'
)
const LOG_FILE = path.join(
  process.env.TEMP || require('os').tmpdir(),
  'openclaw-watchdog.log'
)

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try {
    fs.appendFileSync(LOG_FILE, line, 'utf8')
  } catch (e) {
    /* ignore */
  }
}

function isPidAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return false
  }
}

function readPid() {
  try {
    return Number(fs.readFileSync(PID_FILE, 'utf8').trim()) || 0
  } catch (e) {
    return 0
  }
}

function writePid(pid) {
  fs.writeFileSync(PID_FILE, String(pid), 'utf8')
}

async function tick() {
  const port = DEFAULT_PORT
  const health = await checkHealth(port)
  if (health.ok) return { ok: true, repaired: false }

  log(`health fail status=${health.status || 0}；尝试拉起 Gateway`)
  const oc = await ensureOpenclawGateway({
    port,
    startTray: false,
    waitMs: 35000
  })
  if (oc && oc.ok) {
    writeOpenclawRuntimeConfig({
      root: ROOT,
      token: oc.token || '',
      port
    })
    if (oc.token) delete oc.token
    log(`Gateway 已恢复 port=${port}`)
    return { ok: true, repaired: true }
  }
  log(`Gateway 恢复失败：${(oc && oc.reason) || 'unknown'}`)
  return { ok: false, repaired: false }
}

async function loop() {
  writePid(process.pid)
  log(`watchdog start pid=${process.pid} interval=${INTERVAL_MS}ms`)
  // 启动立刻检查一次
  try {
    await tick()
  } catch (err) {
    log(`tick error: ${(err && err.message) || err}`)
  }
  setInterval(() => {
    tick().catch(err => log(`tick error: ${(err && err.message) || err}`))
  }, INTERVAL_MS)
}

function startDaemon() {
  const existing = readPid()
  if (isPidAlive(existing)) {
    return { ok: true, alreadyRunning: true, pid: existing }
  }
  const child = spawn(
    process.execPath,
    [path.join(__dirname, 'openclaw-watchdog.js'), '--run'],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: ROOT,
      env: process.env
    }
  )
  if (!child.pid) return { ok: false, reason: 'spawn failed' }
  writePid(child.pid)
  child.unref()
  return { ok: true, alreadyRunning: false, pid: child.pid }
}

function ensureOpenclawWatchdog() {
  if (process.platform !== 'win32') {
    return { ok: false, skipped: true, reason: '仅 Windows' }
  }
  return startDaemon()
}

module.exports = {
  ensureOpenclawWatchdog,
  startDaemon,
  PID_FILE,
  LOG_FILE
}

if (require.main === module) {
  const args = process.argv.slice(2)
  if (args.includes('--daemon')) {
    const r = startDaemon()
    console.log(
      r.alreadyRunning
        ? `OpenClaw 看门狗已在运行 pid=${r.pid}`
        : `OpenClaw 看门狗已后台启动 pid=${r.pid}`
    )
    console.log(`日志：${LOG_FILE}`)
    process.exit(r.ok ? 0 : 1)
  }
  // --run 或默认：前台循环
  loop().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
