/**
 * 启动 OpenClaw Bridge（Gateway WS → 浏览器简化协议）
 */
const fs = require('fs')
const path = require('path')
const http = require('http')
const { spawn, spawnSync } = require('child_process')

const DEFAULT_BRIDGE_PORT = Number(process.env.OPENCLAW_BRIDGE_PORT || 18790)
const BRIDGE_DIR = path.join(__dirname, 'openclaw-bridge')
const PID_FILE = path.join(
  process.env.TEMP || require('os').tmpdir(),
  'openclaw-bridge.pid'
)

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
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

function checkBridgeHealth(port = DEFAULT_BRIDGE_PORT) {
  return new Promise(resolve => {
    const req = http.get(
      `http://127.0.0.1:${port}/health`,
      { timeout: 2000 },
      res => {
        let body = ''
        res.on('data', d => (body += d))
        res.on('end', () => {
          try {
            const json = JSON.parse(body || '{}')
            resolve({ ok: res.statusCode === 200, data: json })
          } catch (e) {
            resolve({ ok: res.statusCode === 200 })
          }
        })
      }
    )
    req.on('error', () => resolve({ ok: false }))
    req.on('timeout', () => {
      req.destroy()
      resolve({ ok: false })
    })
  })
}

function readTokenViaWsl(distro) {
  const name = String(distro || process.env.OPENCLAW_WSL_DISTRO || 'Ubuntu')
  try {
    const r = spawnSync(
      'wsl.exe',
      [
        '-d',
        name,
        '--',
        'bash',
        '-lc',
        `node -e "const fs=require('fs');const p=process.env.HOME+'/.openclaw/openclaw.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));process.stdout.write(String(((j.gateway||{}).auth||{}).token||''))"`
      ],
      { encoding: 'utf8', timeout: 20000, windowsHide: true }
    )
    return String(r.stdout || '')
      .replace(/\u0000/g, '')
      .trim()
  } catch (e) {
    return ''
  }
}

async function ensureOpenclawBridge({
  port = DEFAULT_BRIDGE_PORT,
  token = '',
  distro = ''
} = {}) {
  if (process.platform !== 'win32') {
    return { ok: false, skipped: true, reason: '仅 Windows 启动 bridge' }
  }
  const live = await checkBridgeHealth(port)
  if (live.ok) {
    return { ok: true, alreadyRunning: true, port }
  }

  const useToken = String(token || readTokenViaWsl(distro) || '').trim()
  if (!useToken) {
    return {
      ok: false,
      reason: '未读到 Gateway Token，无法启动 OpenClaw Bridge'
    }
  }

  const serverJs = path.join(BRIDGE_DIR, 'server.mjs')
  if (!fs.existsSync(serverJs)) {
    return { ok: false, reason: `缺少 ${serverJs}` }
  }

  const child = spawn(process.execPath, [serverJs], {
    cwd: BRIDGE_DIR,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      OPENCLAW_BRIDGE_PORT: String(port),
      OPENCLAW_GATEWAY_WS:
        process.env.OPENCLAW_GATEWAY_WS ||
        `ws://127.0.0.1:${process.env.OPENCLAW_PORT || 18791}`,
      OPENCLAW_GATEWAY_TOKEN: useToken
    }
  })
  if (!child.pid) {
    return { ok: false, reason: 'bridge spawn 失败' }
  }
  fs.writeFileSync(PID_FILE, String(child.pid), 'utf8')
  child.unref()

  for (let i = 0; i < 20; i++) {
    await sleep(500)
    const h = await checkBridgeHealth(port)
    if (h.ok) {
      return { ok: true, alreadyRunning: false, port, pid: child.pid }
    }
  }
  return {
    ok: false,
    reason: `Bridge 未在端口 ${port} 就绪`,
    pid: child.pid
  }
}

function formatBridgeResult(r) {
  if (!r) return ''
  if (r.ok) {
    return r.alreadyRunning
      ? `OpenClaw Bridge 已在运行  ws://127.0.0.1:${r.port}/ws`
      : `OpenClaw Bridge 已启动  ws://127.0.0.1:${r.port}/ws`
  }
  if (r.skipped) return `OpenClaw Bridge：${r.reason}`
  return `OpenClaw Bridge 未就绪：${r.reason || '未知错误'}`
}

module.exports = {
  DEFAULT_BRIDGE_PORT,
  ensureOpenclawBridge,
  formatBridgeResult,
  checkBridgeHealth,
  isPidAlive,
  readPid
}
