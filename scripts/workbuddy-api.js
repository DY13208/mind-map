const fs = require('fs')
const http = require('http')
const crypto = require('crypto')
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
  const envExe = String(process.env.WORKBUDDY_EXE || '').trim()
  const envCli = String(process.env.WORKBUDDY_CLI_SCRIPT || '').trim()
  const exe =
    (envExe && fs.existsSync(envExe) && envExe) ||
    path.join(local, 'Programs', 'WorkBuddy', 'WorkBuddy.exe')
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
  const resolvedFromExe = resolveCliScript(exe)
  const cli =
    (envCli && fs.existsSync(envCli) && envCli) ||
    (resolvedFromExe && fs.existsSync(resolvedFromExe) && resolvedFromExe) ||
    (fs.existsSync(unpackedCli) ? unpackedCli : packedCli)
  return { exe, cli, local }
}

function checkWorkbuddyClient() {
  const install = findWorkbuddyInstall()
  if (install && fs.existsSync(install.exe)) {
    const cli =
      (process.env.WORKBUDDY_CLI_SCRIPT &&
        fs.existsSync(process.env.WORKBUDDY_CLI_SCRIPT) &&
        process.env.WORKBUDDY_CLI_SCRIPT) ||
      install.cli
    if (fs.existsSync(cli)) {
      return { ok: true, exe: install.exe, cli }
    }
    return {
      ok: false,
      reason: `未找到 WorkBuddy CLI：${cli}`,
      hint:
        '请在 .env 设置 WORKBUDDY_CLI_SCRIPT，或重新安装 WorkBuddy 桌面客户端。'
    }
  }
  const { exe, cli } = getWorkbuddyPaths()
  if (!fs.existsSync(exe)) {
    return {
      ok: false,
      reason: `未找到 WorkBuddy 客户端：${exe}`,
      hint:
        '请先安装并登录 WorkBuddy，或在项目 .env 设置 WORKBUDDY_EXE=完整路径\\WorkBuddy.exe'
    }
  }
  if (!fs.existsSync(cli)) {
    return {
      ok: false,
      reason: `未找到 WorkBuddy CLI：${cli}`,
      hint: 'WorkBuddy 可能未装完整，请设置 WORKBUDDY_CLI_SCRIPT 或重新安装。'
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

function resolveCliScript(exePath) {
  const base = path.dirname(exePath)
  const candidates = [
    path.join(base, 'resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy'),
    path.join(base, 'resources', 'app.asar', 'cli', 'bin', 'codebuddy')
  ]
  return candidates.find(item => fs.existsSync(item)) || candidates[0]
}

function uniquePaths(items) {
  const seen = new Set()
  const result = []
  for (const item of items) {
    if (!item) continue
    const resolved = path.resolve(item)
    const key = resolved.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(resolved)
  }
  return result
}

function discoverWorkbuddyFromRegistry() {
  if (process.platform !== 'win32') return []
  const keys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WorkBuddy',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WorkBuddy',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WorkBuddy'
  ]
  const dirs = []
  for (const key of keys) {
    try {
      const out = execSync(`reg query "${key}" /v InstallLocation`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      })
      const match = out.match(/InstallLocation\s+REG_\w+\s+(.+)/i)
      if (match && match[1]) dirs.push(match[1].trim())
    } catch (e) {
      // key missing or unreadable
    }
  }
  return dirs.map(dir => path.join(dir, 'WorkBuddy.exe'))
}

function discoverWorkbuddyFromPath() {
  if (process.platform !== 'win32') return []
  try {
    const out = execSync('where WorkBuddy.exe', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return out
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
  } catch (e) {
    return []
  }
}

function discoverWorkbuddyFromCommonDirs() {
  const localAppData =
    process.env.LOCALAPPDATA ||
    path.join(process.env.USERPROFILE || '', 'AppData', 'Local')
  const roots = uniquePaths([
    path.join(localAppData, 'Programs'),
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    'C:\\Program Files',
    'C:\\Program Files (x86)',
    'D:\\workbuddy',
    'C:\\workbuddy',
    'D:\\Program Files',
    'D:\\Programs'
  ])
  const results = []
  for (const root of roots) {
    results.push(path.join(root, 'WorkBuddy', 'WorkBuddy.exe'))
    results.push(path.join(root, 'WorkBuddy.exe'))
  }
  return results
}

function findWorkbuddyInstall() {
  const envCli = String(process.env.WORKBUDDY_CLI_SCRIPT || '').trim()
  const candidates = uniquePaths([
    process.env.WORKBUDDY_EXE,
    ...discoverWorkbuddyFromRegistry(),
    ...discoverWorkbuddyFromPath(),
    ...discoverWorkbuddyFromCommonDirs(),
    'D:\\WorkBuddy\\WorkBuddy.exe'
  ])
  for (const exe of candidates) {
    if (!fs.existsSync(exe)) continue
    const cli =
      (envCli && fs.existsSync(envCli) && envCli) || resolveCliScript(exe)
    return { exe, cli }
  }
  return null
}

function readProxyLogTail(dir, maxLines = 8) {
  const logFile = path.join(dir, 'runtime', 'proxy.out.log')
  if (!fs.existsSync(logFile)) return ''
  try {
    const lines = fs
      .readFileSync(logFile, 'utf8')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
    return lines.slice(-maxLines).join('\n')
  } catch (e) {
    return ''
  }
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

/** 将 workbuddy_to_api/.env 里的 WORKBUDDY_* 注入 process.env（不覆盖已有值） */
function hydrateWorkbuddyEnvFromDir(dir) {
  const envFile = path.join(dir, '.env')
  if (!fs.existsSync(envFile)) return
  try {
    fs.readFileSync(envFile, 'utf8')
      .split(/\r?\n/)
      .forEach(line => {
        const text = line.trim()
        if (!text || text.startsWith('#')) return
        const i = text.indexOf('=')
        if (i <= 0) return
        const key = text.slice(0, i).trim()
        let value = text.slice(i + 1).trim()
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1)
        }
        if (!key.startsWith('WORKBUDDY_')) return
        if (process.env[key] == null || process.env[key] === '') {
          process.env[key] = value
        }
      })
  } catch (e) {
    // ignore
  }
}

/**
 * 从本机 WorkBuddy 自定义模型配置注入 DeepSeek / CodeBuddy 环境变量，
 * 让 --serve 网关走自定义 API，而不是平台积分。
 */
function hydrateCustomModelApiKeys() {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  if (!home) return
  const file = path.join(home, '.workbuddy', 'models.json')
  if (!fs.existsSync(file)) return
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
    return
  }
  if (!hit || !hit.apiKey) return

  const apiKey = String(hit.apiKey)
  if (!process.env.DEEPSEEK_API_KEY) process.env.DEEPSEEK_API_KEY = apiKey

  // 官方推荐：用 CODEBUDDY_* 直连第三方模型，绕开平台额度
  if (!process.env.CODEBUDDY_API_KEY) process.env.CODEBUDDY_API_KEY = apiKey
  if (!process.env.CODEBUDDY_BASE_URL) {
    let base = 'https://api.deepseek.com'
    try {
      if (hit.url) {
        const u = new URL(String(hit.url))
        base = `${u.protocol}//${u.host}`
      }
    } catch (e) {
      /* keep default */
    }
    process.env.CODEBUDDY_BASE_URL = base
  }
  const modelId = String(hit.id || 'deepseek-v4-flash')
  if (!process.env.CODEBUDDY_MODEL) process.env.CODEBUDDY_MODEL = modelId
  if (!process.env.CODEBUDDY_BIG_SLOW_MODEL) {
    process.env.CODEBUDDY_BIG_SLOW_MODEL = modelId
  }
  if (!process.env.CODEBUDDY_SMALL_FAST_MODEL) {
    process.env.CODEBUDDY_SMALL_FAST_MODEL = modelId
  }
  if (!process.env.CODEBUDDY_CODE_SUBAGENT_MODEL) {
    process.env.CODEBUDDY_CODE_SUBAGENT_MODEL = modelId
  }
  if (!process.env.WORKBUDDY_DEFAULT_MODEL) {
    process.env.WORKBUDDY_DEFAULT_MODEL = modelId
  }
}

function customModelEnvFingerprint() {
  const parts = [
    process.env.CODEBUDDY_BASE_URL || '',
    process.env.CODEBUDDY_MODEL || '',
    process.env.WORKBUDDY_DEFAULT_MODEL || '',
    // 不落盘完整 key，只用尾缀判断是否换过密钥
    String(process.env.CODEBUDDY_API_KEY || '').slice(-8)
  ]
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex')
}

function readCustomModelEnvMarker(dir) {
  const file = path.join(dir, 'runtime', 'custom-model.env.sha')
  try {
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : ''
  } catch (e) {
    return ''
  }
}

function writeCustomModelEnvMarker(dir, fp) {
  try {
    const runtime = path.join(dir, 'runtime')
    fs.mkdirSync(runtime, { recursive: true })
    fs.writeFileSync(path.join(runtime, 'custom-model.env.sha'), fp, 'utf8')
  } catch (e) {
    // ignore
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

  // 优先读取已有的 workbuddy_to_api/.env（例如 WORKBUDDY_EXE=D:\workbuddy\...）
  hydrateWorkbuddyEnvFromDir(resolveWorkbuddyDir(projectRoot))
  hydrateCustomModelApiKeys()

  const dirEarly = resolveWorkbuddyDir(projectRoot)
  const envFp = customModelEnvFingerprint()
  if (await checkHealth(port)) {
    const prevFp = readCustomModelEnvMarker(dirEarly)
    // 自定义模型环境变了（或旧进程未写入标记）则重启，避免仍走平台积分
    if (
      process.env.CODEBUDDY_API_KEY &&
      process.env.CODEBUDDY_BASE_URL &&
      prevFp !== envFp
    ) {
      stopWorkbuddyApi({ root: projectRoot, apiKey })
      await new Promise(r => setTimeout(r, 1200))
    } else {
      return {
        ok: true,
        alreadyRunning: true,
        port,
        dir: dirEarly,
        exe: (findWorkbuddyInstall() || {}).exe
      }
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

  const install = findWorkbuddyInstall()
  if (!install) {
    const fallback = checkWorkbuddyClient()
    return {
      ok: false,
      reason:
        (fallback && fallback.reason) ||
        '未找到 WorkBuddy 客户端。请安装 WorkBuddy，或设置环境变量 WORKBUDDY_EXE',
      hint:
        (fallback && fallback.hint) ||
        '也可在 workbuddy_to_api/.env 中设置 WORKBUDDY_EXE=你的 WorkBuddy.exe 路径'
    }
  }
  if (!fs.existsSync(install.cli)) {
    return {
      ok: false,
      reason: `未找到 WorkBuddy CLI：${install.cli}`,
      hint: 'WorkBuddy 可能未装完整，请重新安装桌面客户端后再试。'
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
  hydrateWorkbuddyEnvFromDir(dir)

  // 若启动时发现了 exe，写入 .env，方便下次 Start-Docker 自动找到
  if (install.exe) {
    try {
      const envFile = path.join(dir, '.env')
      let text = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : ''
      if (!/^\s*WORKBUDDY_EXE\s*=/m.test(text)) {
        text += `\nWORKBUDDY_EXE=${install.exe}\n`
        if (install.cli) text += `WORKBUDDY_CLI_SCRIPT=${install.cli}\n`
        fs.writeFileSync(envFile, text, 'utf8')
      }
    } catch (e) {
      // ignore
    }
  }

  const args = [
    path.join(dir, 'workbuddy_to_api.py'),
    '--background',
    '--api-key',
    apiKey,
    '--port',
    String(port),
    '--cwd',
    projectRoot,
    '--workbuddy-exe',
    install.exe,
    '--cli-script',
    install.cli
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

  writeCustomModelEnvMarker(dir, envFp)

  return {
    ok: true,
    port,
    dir,
    exe: install.exe
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
  findWorkbuddyInstall,
  ensureWorkbuddyApi,
  stopWorkbuddyApi,
  checkHealth,
  findPython,
  checkWorkbuddyClient,
  formatWorkbuddyResult
}
