const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { execSync, spawnSync } = require('child_process')

const DEFAULT_REPO = 'https://github.com/yxxawa/workbuddy_to_api.git'
const DEFAULT_PORT = 3000
const DEFAULT_API_KEY = 'local'

function resolveWorkbuddyDir(root) {
  const candidates = [
    process.env.WORKBUDDY_API_DIR,
    path.join(root, 'workbuddy_to_api'),
    path.join(root, '..', 'workbuddy_to_api')
  ]
    .filter(Boolean)
    .map(item => path.resolve(item))
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'workbuddy_to_api.py'))) return dir
  }
  return path.join(root, 'workbuddy_to_api')
}

function getWorkbuddyPaths() {
  const local =
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const exe = path.join(local, 'Programs', 'WorkBuddy', 'WorkBuddy.exe')
  const packedCli = path.join(
    local,
    'Programs',
    'WorkBuddy',
    'resources',
    'app.asar',
    'cli',
    'bin',
    'codebuddy'
  )
  const unpackedCli = path.join(
    local,
    'Programs',
    'WorkBuddy',
    'resources',
    'app.asar.unpacked',
    'cli',
    'bin',
    'codebuddy'
  )
  const cli = fs.existsSync(unpackedCli) ? unpackedCli : packedCli
  return { exe, cli, local }
}

function checkWorkbuddyClient() {
  const { exe, cli } = getWorkbuddyPaths()
  if (!fs.existsSync(exe)) {
    return {
      ok: false,
      reason: `未找到 WorkBuddy 客户端：${exe}`,
      hint:
        '请先安装并登录 WorkBuddy 桌面版（默认装到 %LOCALAPPDATA%\\Programs\\WorkBuddy），再重新运行启动脚本。'
    }
  }
  if (!fs.existsSync(cli)) {
    return {
      ok: false,
      reason: `未找到 WorkBuddy CLI：${cli}`,
      hint: 'WorkBuddy 可能未装完整，请重新安装桌面客户端后再试。'
    }
  }
  return { ok: true, exe, cli }
}

function ensureWorkbuddySource(root) {
  const dir = resolveWorkbuddyDir(root)
  if (fs.existsSync(path.join(dir, 'workbuddy_to_api.py'))) return dir
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  execSync(`git clone --depth 1 "${DEFAULT_REPO}" "${dir}"`, {
    stdio: 'inherit',
    shell: true
  })
  if (!fs.existsSync(path.join(dir, 'workbuddy_to_api.py'))) {
    throw new Error('拉取 workbuddy_to_api 后仍未找到主程序')
  }
  return dir
}

function findPython() {
  const candidates = [
    ['python'],
    ['py', '-3'],
    ['python3']
  ]
  for (const parts of candidates) {
    try {
      const result = spawnSync(parts[0], [...parts.slice(1), '--version'], {
        encoding: 'utf8'
      })
      if (result.status !== 0) continue
      const text = `${result.stdout || ''}${result.stderr || ''}`
      const match = text.match(/Python\s+(\d+)\.(\d+)/i)
      if (!match) continue
      const major = Number(match[1])
      const minor = Number(match[2])
      if (major > 3 || (major === 3 && minor >= 10)) return parts
    } catch (e) {
      // try next
    }
  }
  return null
}

function ensureEnvFile(dir, apiKey = DEFAULT_API_KEY) {
  const envFile = path.join(dir, '.env')
  if (fs.existsSync(envFile)) return
  const example = path.join(dir, '.env.example')
  if (fs.existsSync(example)) {
    fs.copyFileSync(example, envFile)
  } else {
    fs.writeFileSync(
      envFile,
      `PROXY_HOST=127.0.0.1\nPROXY_PORT=${DEFAULT_PORT}\nPROXY_API_KEY=${apiKey}\n`,
      'utf8'
    )
  }
}

function readTailLog(filePath, maxLines = 30) {
  if (!fs.existsSync(filePath)) return ''
  try {
    const text = fs.readFileSync(filePath, 'utf8')
    const lines = text.split(/\r?\n/).filter(Boolean)
    return lines.slice(-maxLines).join('\n')
  } catch (e) {
    return ''
  }
}

function diagnoseStartupFailure(dir) {
  const errLog = path.join(dir, 'runtime', 'proxy.err.log')
  const outLog = path.join(dir, 'runtime', 'proxy.out.log')
  const errText = readTailLog(errLog, 40)
  const outText = readTailLog(outLog, 20)
  const merged = `${errText}\n${outText}`

  if (/WorkBuddy executable not found/i.test(merged)) {
    const { exe } = getWorkbuddyPaths()
    return {
      reason: `未找到 WorkBuddy 客户端（${exe}）`,
      hint:
        '请先安装并登录 WorkBuddy 桌面版，再重新运行启动脚本。导图页面可正常打开，但「补齐流程」需要 WorkBuddy。'
    }
  }
  if (/WorkBuddy CLI script not found/i.test(merged)) {
    return {
      reason: 'WorkBuddy 安装不完整，缺少 CLI 组件',
      hint: '请重新安装 WorkBuddy 桌面客户端后再试。'
    }
  }
  if (/FileNotFoundError/i.test(merged)) {
    return {
      reason: 'WorkBuddy 依赖文件缺失',
      hint: merged.split('\n').slice(-3).join(' ')
    }
  }
  if (/ModuleNotFoundError|ImportError/i.test(merged)) {
    return {
      reason: 'Python 环境异常',
      hint: merged.split('\n').slice(-3).join(' ')
    }
  }
  if (errText) {
    const lastLine =
      errText
        .split('\n')
        .reverse()
        .find(line => line.trim() && !/^-+$/.test(line.trim())) || ''
    return {
      reason: lastLine || '代理进程启动后立即退出',
      hint: `详细日志：${errLog}`
    }
  }
  return {
    reason: '代理进程启动失败',
    hint: `请查看日志：${errLog}`
  }
}

function checkHealth(port = DEFAULT_PORT, timeout = 1500) {
  return new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:${port}/health`, res => {
      res.resume()
      resolve(res.statusCode >= 200 && res.statusCode < 300)
    })
    req.on('error', () => resolve(false))
    req.setTimeout(timeout, () => {
      req.destroy()
      resolve(false)
    })
  })
}

function waitForHealth(port = DEFAULT_PORT, timeout = 60000) {
  const started = Date.now()
  return new Promise(resolve => {
    const tick = async () => {
      if (await checkHealth(port)) return resolve(true)
      if (Date.now() - started > timeout) return resolve(false)
      setTimeout(tick, 500)
    }
    tick()
  })
}

function runPythonBackground(python, args, cwd) {
  return spawnSync(python[0], [...python.slice(1), ...args], {
    cwd,
    encoding: 'utf8',
    shell: false,
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1'
    }
  })
}

async function ensureWorkbuddyApi({
  root,
  port = DEFAULT_PORT,
  apiKey = DEFAULT_API_KEY,
  mcpConfigPath
} = {}) {
  if (process.platform !== 'win32') {
    return {
      ok: false,
      skipped: true,
      reason: 'WorkBuddy 代理仅支持 Windows（需本机安装 WorkBuddy 客户端）'
    }
  }

  const projectRoot = path.resolve(root || path.join(__dirname, '..'))
  const mcpConfig = path.resolve(
    mcpConfigPath || path.join(projectRoot, '.mcp.json')
  )

  if (await checkHealth(port)) {
    return {
      ok: true,
      alreadyRunning: true,
      port,
      dir: resolveWorkbuddyDir(projectRoot)
    }
  }

  const python = findPython()
  if (!python) {
    return {
      ok: false,
      reason: '未检测到 Python 3.10+',
      hint: '请安装 https://www.python.org/ 并勾选「Add python.exe to PATH」后重试。'
    }
  }

  const client = checkWorkbuddyClient()
  if (!client.ok) {
    return {
      ok: false,
      reason: client.reason,
      hint: client.hint
    }
  }

  let dir
  try {
    dir = ensureWorkbuddySource(projectRoot)
  } catch (err) {
    return {
      ok: false,
      reason: `无法获取 workbuddy_to_api：${err.message || err}`,
      hint: '请确认已安装 Git，且网络可访问 GitHub。'
    }
  }

  ensureEnvFile(dir, apiKey)

  const args = [
    path.join(dir, 'workbuddy_to_api.py'),
    '--background',
    '--api-key',
    apiKey,
    '--port',
    String(port),
    '--cwd',
    projectRoot
  ]
  if (fs.existsSync(mcpConfig)) {
    args.push('--mcp-config', mcpConfig)
  }

  const result = runPythonBackground(python, args, dir)
  if (result.status !== 0) {
    const diag = diagnoseStartupFailure(dir)
    return {
      ok: false,
      reason: diag.reason,
      hint: diag.hint,
      dir,
      log: path.join(dir, 'runtime', 'proxy.err.log')
    }
  }

  const ready = await waitForHealth(port)
  if (!ready) {
    const diag = diagnoseStartupFailure(dir)
    return {
      ok: false,
      port,
      dir,
      reason: diag.reason || '代理已拉起但 /health 未就绪',
      hint:
        diag.hint ||
        '请确认 WorkBuddy 已安装并登录；若刚装好，可等 1 分钟后重新运行启动脚本。',
      log: path.join(dir, 'runtime', 'proxy.err.log')
    }
  }

  return {
    ok: true,
    port,
    dir
  }
}

function stopWorkbuddyApi({ root, apiKey = DEFAULT_API_KEY } = {}) {
  if (process.platform !== 'win32') return false
  const projectRoot = path.resolve(root || path.join(__dirname, '..'))
  const dir = resolveWorkbuddyDir(projectRoot)
  const script = path.join(dir, 'workbuddy_to_api.py')
  if (!fs.existsSync(script)) return false
  const python = findPython()
  if (!python) return false
  try {
    spawnSync(
      python[0],
      [...python.slice(1), script, '--stop', '--api-key', apiKey],
      {
        cwd: dir,
        encoding: 'utf8',
        stdio: 'ignore'
      }
    )
    return true
  } catch (e) {
    return false
  }
}

function formatWorkbuddyResult(wb) {
  if (!wb) return ''
  const lines = []
  if (wb.ok) {
    lines.push(
      wb.alreadyRunning
        ? `WorkBuddy API 已在运行  http://127.0.0.1:${wb.port}`
        : `WorkBuddy API 已启动  http://127.0.0.1:${wb.port}`
    )
    return lines.join('\n')
  }
  if (wb.skipped) {
    lines.push(`WorkBuddy API：${wb.reason}`)
    return lines.join('\n')
  }
  lines.push(`WorkBuddy API 未就绪：${wb.reason || '未知错误'}`)
  if (wb.hint) lines.push(`  → ${wb.hint}`)
  if (wb.log) lines.push(`  → 日志：${wb.log}`)
  return lines.join('\n')
}

module.exports = {
  DEFAULT_PORT,
  DEFAULT_API_KEY,
  resolveWorkbuddyDir,
  ensureWorkbuddyApi,
  stopWorkbuddyApi,
  checkHealth,
  findPython,
  checkWorkbuddyClient,
  formatWorkbuddyResult
}
