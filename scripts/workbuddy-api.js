const fs = require('fs')
const http = require('http')
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
    'C:\\Program Files (x86)'
  ])
  return roots.map(root => path.join(root, 'WorkBuddy', 'WorkBuddy.exe'))
}

function findWorkbuddyInstall() {
  const candidates = uniquePaths([
    process.env.WORKBUDDY_EXE,
    ...discoverWorkbuddyFromRegistry(),
    ...discoverWorkbuddyFromPath(),
    ...discoverWorkbuddyFromCommonDirs()
  ])
  for (const exe of candidates) {
    if (fs.existsSync(exe)) {
      return { exe, cli: resolveCliScript(exe) }
    }
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

function waitForHealth(port = DEFAULT_PORT, timeout = 45000) {
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
      reason:
        '未检测到 Python 3.10+。请安装 https://www.python.org/ 并勾选 Add to PATH'
    }
  }

  let dir
  try {
    dir = ensureWorkbuddySource(projectRoot)
  } catch (err) {
    return {
      ok: false,
      reason: `无法获取 workbuddy_to_api：${err.message || err}`
    }
  }

  ensureEnvFile(dir, apiKey)

  const install = findWorkbuddyInstall()
  if (!install) {
    return {
      ok: false,
      reason:
        '未找到 WorkBuddy 客户端。请安装 WorkBuddy，或在 workbuddy_to_api/.env 中设置 WORKBUDDY_EXE',
      dir
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

  const result = spawnSync(python[0], [...python.slice(1), ...args], {
    cwd: dir,
    encoding: 'utf8',
    shell: false
  })
  if (result.status !== 0) {
    const detail = `${result.stdout || ''}${result.stderr || ''}`.trim()
    const logTail = readProxyLogTail(dir)
    const fatal =
      logTail.match(/FileNotFoundError[^\n]*/)?.[0] ||
      logTail.match(/\[fatal\][^\n]*/)?.[0] ||
      ''
    return {
      ok: false,
      reason:
        fatal ||
        detail ||
        logTail ||
        'workbuddy_to_api 后台启动失败',
      dir
    }
  }

  const ready = await waitForHealth(port)
  return {
    ok: ready,
    port,
    dir,
    reason: ready
      ? ''
      : '代理已拉起但 /health 未就绪，请确认已安装并登录 WorkBuddy 客户端'
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

module.exports = {
  DEFAULT_PORT,
  DEFAULT_API_KEY,
  resolveWorkbuddyDir,
  findWorkbuddyInstall,
  ensureWorkbuddyApi,
  stopWorkbuddyApi,
  checkHealth,
  findPython
}
