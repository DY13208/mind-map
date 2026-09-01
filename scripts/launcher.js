const fs = require('fs')
const os = require('os')
const net = require('net')
const http = require('http')
const path = require('path')
const readline = require('readline')
const { spawn, execSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const WEB_DIR = path.join(ROOT, 'web')
const LIB_DIR = path.join(ROOT, 'simple-mind-map')
const CONFIG_FILE = path.join(WEB_DIR, 'public', 'runtime-config.js')
const ENV_FILE = path.join(ROOT, '.env')

function loadRootEnv() {
  if (!fs.existsSync(ENV_FILE)) return
  fs.readFileSync(ENV_FILE, 'utf8')
    .split(/\r?\n/)
    .forEach(line => {
      const text = line.trim()
      if (!text || text.startsWith('#')) return
      const index = text.indexOf('=')
      if (index <= 0) return
      const key = text.slice(0, index).trim()
      let value = text.slice(index + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      if (process.env[key] === undefined) process.env[key] = value
    })
}

loadRootEnv()

const {
  DEFAULT_PORT: WORKBUDDY_PORT,
  ensureWorkbuddyApi,
  stopWorkbuddyApi
} = require('./workbuddy-api')

const WEB_PORT = 8081
const COLLAB_PORT = 1234
const AI_PORT = 3456
const MCP_PORT = 3847

const children = []
let stopping = false

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[90m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  white: '\x1b[37m'
}

function paint(color, text) {
  return `${color}${text}${c.reset}`
}

function log(msg = '') {
  console.log(msg)
}

function banner() {
  log('')
  log(paint(c.cyan, '  ╔══════════════════════════════════════════════╗'))
  log(paint(c.cyan, '  ║') + paint(c.bold, '     思绪思维导图  ·  一键启动台          ') + paint(c.cyan, '║'))
  log(paint(c.cyan, '  ╚══════════════════════════════════════════════╝'))
  log('')
}

function scoreIp(address) {
  if (address.startsWith('192.168.')) return 300
  if (address.startsWith('10.')) return 200
  const parts = address.split('.').map(Number)
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return 100
  return 0
}

function isVirtualName(name) {
  return /virtual|vmware|vbox|hyper-v|loopback|docker|wsl|vethernet|bluetooth|vnic|pseudo|虚拟/i.test(
    name
  )
}

function listLanIPs() {
  const ifaces = os.networkInterfaces()
  const list = []
  Object.keys(ifaces).forEach(name => {
    if (isVirtualName(name)) return
    ;(ifaces[name] || []).forEach(addr => {
      const family = addr.family === 'IPv4' || addr.family === 4
      if (!family || addr.internal) return
      if (addr.address.startsWith('169.254.')) return
      list.push({ name, address: addr.address })
    })
  })
  list.sort((a, b) => scoreIp(b.address) - scoreIp(a.address))
  return list
}

function readSavedHost() {
  try {
    const text = fs.readFileSync(CONFIG_FILE, 'utf8')
    const match = text.match(/"host"\s*:\s*"([^"]*)"/)
    return (match && match[1]) || ''
  } catch (e) {
    return ''
  }
}

function mcpServerEntry(host) {
  const entry = {
    type: 'http',
    url: `http://${host}:${MCP_PORT}/mcp`
  }
  if (process.env.MCP_TOKEN) {
    entry.headers = {
      Authorization: `Bearer ${process.env.MCP_TOKEN}`
    }
  }
  return entry
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

function mergeUserMcp(file, host) {
  if (!fs.existsSync(path.dirname(file))) return false
  let data = { mcpServers: {} }
  if (fs.existsSync(file)) {
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8')) || {}
    } catch (e) {
      return false
    }
  }
  if (!data.mcpServers || typeof data.mcpServers !== 'object') {
    data.mcpServers = {}
  }
  data.mcpServers['mind-map'] = {
    ...(data.mcpServers['mind-map'] || {}),
    ...mcpServerEntry(host)
  }
  writeJson(file, data)
  return true
}

function writeMcpConfig(host) {
  const entry = mcpServerEntry(host)
  writeJson(path.join(ROOT, '.mcp.json'), {
    mcpServers: {
      'mind-map': entry
    }
  })
  const home = os.homedir()
  const updated = []
  ;[
    path.join(home, '.workbuddy', 'mcp.json'),
    path.join(home, '.codebuddy', '.mcp.json'),
    path.join(home, '.codebuddy', 'mcp.json')
  ].forEach(file => {
    if (mergeUserMcp(file, host)) updated.push(file)
  })
  return { entry, updated }
}

function writeRuntimeConfig(host) {
  const config = {
    host,
    webPort: WEB_PORT,
    collabPort: COLLAB_PORT,
    aiPort: AI_PORT,
    mcpPort: MCP_PORT
  }
  const content =
    'window.__MIND_MAP_RUNTIME__ = ' + JSON.stringify(config, null, 2) + '\n'
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
  fs.writeFileSync(CONFIG_FILE, content, 'utf8')
  const mcp = writeMcpConfig(host)
  return { ...config, mcp }
}

function pidsOnPort(port) {
  if (process.platform !== 'win32') {
    return []
  }
  try {
    const out = execSync('netstat -ano', { encoding: 'utf8' })
    const pids = new Set()
    out.split(/\r?\n/).forEach(line => {
      if (!/LISTENING/i.test(line)) return
      const parts = line.trim().split(/\s+/)
      const addr = parts[1] || ''
      if (addr === `${port}` || addr.endsWith(`:${port}`)) {
        const pid = parts[parts.length - 1]
        if (pid && pid !== '0') pids.add(pid)
      }
    })
    return [...pids]
  } catch (e) {
    return []
  }
}

function killPort(port) {
  const pids = pidsOnPort(port)
  pids.forEach(pid => {
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' })
    } catch (e) {
      // ignore
    }
  })
  return pids.length
}

function stopAll() {
  stopWorkbuddyApi({ root: ROOT })
  ;[WEB_PORT, COLLAB_PORT, AI_PORT, MCP_PORT, WORKBUDDY_PORT].forEach(port => {
    const n = killPort(port)
    if (n) log(paint(c.dim, `  已释放端口 ${port}`))
  })
}

function pgListen() {
  return {
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432)
  }
}

function pgReady(timeout = 1500) {
  const { host, port } = pgListen()
  return new Promise(resolve => {
    const sock = net.connect({ host, port }, () => {
      sock.end()
      resolve(true)
    })
    sock.setTimeout(timeout, () => {
      sock.destroy()
      resolve(false)
    })
    sock.on('error', () => resolve(false))
  })
}

async function ensurePostgres() {
  if (await pgReady()) {
    log(paint(c.green, `  数据库已就绪  ${pgListen().host}:${pgListen().port}`))
    return true
  }
  log(paint(c.yellow, '  数据库未启动，协同依赖它。正在用 Docker 拉起 Postgres...'))
  try {
    execSync('docker compose up -d postgres', {
      cwd: ROOT,
      stdio: 'inherit',
      env: process.env
    })
  } catch (e) {
    log(paint(c.red, '  无法启动数据库。请打开 Docker Desktop 后重试。'))
    return false
  }
  for (let i = 0; i < 40; i++) {
    if (await pgReady()) {
      log(paint(c.green, `  数据库已就绪  ${pgListen().host}:${pgListen().port}`))
      return true
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  log(paint(c.red, '  数据库启动超时，协同服务将无法保持运行。'))
  return false
}

function ensureDeps() {
  const targets = [
    { dir: WEB_DIR, name: 'web' },
    {
      dir: LIB_DIR,
      name: 'simple-mind-map',
      extra: ['pg', 'cos-nodejs-sdk-v5']
    }
  ]
  targets.forEach(item => {
    const hasModules = fs.existsSync(path.join(item.dir, 'node_modules'))
    const missingExtra = (item.extra || []).some(
      name => !fs.existsSync(path.join(item.dir, 'node_modules', name))
    )
    if (hasModules && !missingExtra) return
    log(paint(c.yellow, `  正在安装 ${item.name} 依赖...`))
    execSync('npm install', { cwd: item.dir, stdio: 'inherit' })
  })
}

function prefixLines(name, color, chunk) {
  const text = chunk.toString()
  const lines = text.split(/\r?\n/)
  const tagged = lines
    .map((line, index) => {
      if (line === '' && index === lines.length - 1) return ''
      return `${paint(color, `[${name}]`)} ${line}`
    })
    .join('\n')
  process.stdout.write(tagged)
}

function startProcess(
  name,
  command,
  args,
  cwd,
  color,
  extraEnv = {},
  { restart = false } = {}
) {
  let restarts = 0
  let stableTimer = null
  const spawnOnce = () => {
    const child = spawn(command, args, {
      cwd,
      shell: true,
      env: {
        ...process.env,
        HOST: '0.0.0.0',
        FORCE_COLOR: '1',
        ...extraEnv
      }
    })
    child.stdout && child.stdout.on('data', chunk => prefixLines(name, color, chunk))
    child.stderr && child.stderr.on('data', chunk => prefixLines(name, color, chunk))
    children.push(child)
    if (restart) {
      if (stableTimer) clearTimeout(stableTimer)
      stableTimer = setTimeout(() => {
        restarts = 0
      }, 30000)
    }
    child.on('exit', code => {
      const idx = children.indexOf(child)
      if (idx >= 0) children.splice(idx, 1)
      if (stopping) return
      log(paint(c.red, `  [${name}] 已退出${code ? ` (${code})` : ''}`))
      if (!restart) return
      const delay = Math.min(30000, 1000 * Math.pow(2, restarts))
      restarts += 1
      log(paint(c.yellow, `  [${name}] ${delay / 1000}s 后自动重启`))
      setTimeout(spawnOnce, delay)
    })
    return child
  }
  return spawnOnce()
}

function waitForHttp(url, timeout = 90000) {
  const started = Date.now()
  return new Promise(resolve => {
    const tick = () => {
      const req = http.get(url, res => {
        res.resume()
        resolve(true)
      })
      req.on('error', () => {
        if (Date.now() - started > timeout) return resolve(false)
        setTimeout(tick, 800)
      })
      req.setTimeout(1500, () => {
        req.destroy()
      })
    }
    tick()
  })
}

function openBrowser(url) {
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true })
    return
  }
  spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], {
    stdio: 'ignore',
    detached: true
  })
}

function printUrls(host) {
  const mcp = mcpServerEntry(host)
  log('')
  log(paint(c.bold, '  访问地址'))
  log(`  页面    ${paint(c.green, `http://${host}:${WEB_PORT}`)}`)
  log(`  协同    ${paint(c.green, `ws://${host}:${COLLAB_PORT}`)}`)
  log(`  AI      ${paint(c.green, `http://${host}:${AI_PORT}`)}`)
  log(`  MCP     ${paint(c.green, mcp.url)}`)
  log(
    `  WorkBuddy API  ${paint(c.green, `http://127.0.0.1:${WORKBUDDY_PORT}`)}  ${paint(c.dim, '(页面走 /wb-api)')}`
  )
  log('')
  log(paint(c.bold, '  WorkBuddy 配置（地址由启动脚本按当前主机 IP 写入）'))
  log(
    JSON.stringify({ mcpServers: { 'mind-map': mcp } }, null, 2)
      .split(/\r?\n/)
      .map(line => '  ' + line)
      .join('\n')
  )
  log('')
  log(paint(c.dim, '  已写入项目 .mcp.json。局域网同事打开页面地址即可协同。'))
  log(
    paint(
      c.dim,
      '  WorkBuddy 代理会随启动台自动拉起（需本机安装并登录 WorkBuddy + Python 3.10+）。'
    )
  )
  log(paint(c.dim, '  关闭本窗口或按 Ctrl+C 会停止全部服务。'))
  log('')
}

function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close()
      resolve(String(answer || '').trim())
    })
  })
}

async function pickHost({ interactive = true } = {}) {
  const list = listLanIPs()
  const saved = readSavedHost()
  if (!list.length) {
    log(paint(c.yellow, '  没有检测到局域网 IPv4，将使用 localhost'))
    return 'localhost'
  }
  if (!interactive || list.length === 1) {
    return list[0].address
  }
  log(paint(c.bold, '  检测到本机地址：'))
  list.forEach((item, index) => {
    const mark = item.address === saved ? '  ← 当前' : ''
    log(
      `    ${paint(c.cyan, `[${index + 1}]`)} ${item.address.padEnd(16)}  ${paint(
        c.dim,
        item.name
      )}${mark}`
    )
  })
  log('')
  const answer = await ask(
    paint(c.yellow, `  选择要使用的 IP，直接回车用 [1]： `)
  )
  const index = answer ? Number(answer) - 1 : 0
  if (Number.isInteger(index) && list[index]) return list[index].address
  return list[0].address
}

async function setHost({ interactive = true } = {}) {
  const host = await pickHost({ interactive })
  const written = writeRuntimeConfig(host)
  log('')
  log(paint(c.green, `  已将使用 IP 设为 ${host}`))
  ;(written.mcp.updated || []).forEach(file => {
    log(paint(c.dim, `  已同步 MCP 地址到 ${file}`))
  })
  printUrls(host)
  return host
}

async function startAll({ pickIp = false } = {}) {
  const host = pickIp
    ? await setHost({ interactive: true })
    : readSavedHost() || (await setHost({ interactive: false }))
  writeRuntimeConfig(host)
  ensureDeps()
  log(paint(c.yellow, '  正在停止旧进程...'))
  stopAll()
  await new Promise(resolve => setTimeout(resolve, 800))

  const dbOk = await ensurePostgres()
  if (!dbOk) {
    log(paint(c.red, '  未启动数据库时，协同端口 1234 起不来。页面仍会打开，但加入房间会失败。'))
  }

  log(paint(c.yellow, '  正在启动 WorkBuddy API 代理...'))
  const wb = await ensureWorkbuddyApi({
    root: ROOT,
    port: WORKBUDDY_PORT,
    mcpConfigPath: path.join(ROOT, '.mcp.json')
  })
  if (wb.ok) {
    log(
      paint(
        c.green,
        wb.alreadyRunning
          ? `  WorkBuddy API 已在运行  http://127.0.0.1:${WORKBUDDY_PORT}`
          : `  WorkBuddy API 已启动  http://127.0.0.1:${WORKBUDDY_PORT}`
      )
    )
  } else if (wb.skipped) {
    log(paint(c.yellow, `  WorkBuddy API：${wb.reason}`))
  } else {
    log(paint(c.red, `  WorkBuddy API 未就绪：${wb.reason}`))
    log(
      paint(
        c.dim,
        '  补齐流程等功能需要 WorkBuddy。请安装客户端并登录后重试，或手动运行 workbuddy_to_api。'
      )
    )
  }

  log(paint(c.yellow, '  正在启动全部服务（含协同 1234）...'))
  startProcess(
    '协同',
    'node',
    ['./bin/collabServer.js'],
    LIB_DIR,
    c.cyan,
    {
      PORT: String(COLLAB_PORT),
      HOST: '0.0.0.0',
      PUBLIC_HOST: host,
      WEB_PORT: String(WEB_PORT),
      NODE_OPTIONS: '--max-old-space-size=3072'
    },
    { restart: true }
  )
  startProcess(
    'MCP',
    'node',
    ['./bin/mcpServer.mjs', '--http'],
    LIB_DIR,
    c.white,
    {
      MCP_PORT: String(MCP_PORT),
      MCP_HOST: '0.0.0.0',
      MIND_MAP_API: `http://127.0.0.1:${COLLAB_PORT}`,
      PUBLIC_HOST: host,
      WEB_PORT: String(WEB_PORT)
    },
    { restart: true }
  )
  startProcess(
    'AI',
    'node',
    ['./scripts/ai.js'],
    WEB_DIR,
    c.yellow,
    {},
    { restart: true }
  )
  startProcess(
    '页面',
    'npx',
    ['vue-cli-service', 'serve', '--host', '0.0.0.0', '--port', String(WEB_PORT)],
    WEB_DIR,
    c.green
  )

  printUrls(host)
  log(paint(c.dim, '  等待协同服务和页面就绪...'))
  const collabReady = await waitForHttp(
    `http://127.0.0.1:${COLLAB_PORT}/api/health`
  )
  if (collabReady) {
    log(paint(c.green, `  协同已监听  ws://${host}:${COLLAB_PORT}`))
  } else {
    log(paint(c.red, '  协同服务没有起来，加入房间会失败。请看上方 [协同] 日志。'))
  }
  const ready = await waitForHttp(`http://127.0.0.1:${WEB_PORT}/`)
  if (ready) {
    const url = `http://${host}:${WEB_PORT}/`
    log(paint(c.green, `  已打开浏览器：${url}`))
    openBrowser(url)
  } else {
    log(paint(c.red, '  页面启动超时，请查看上方日志。'))
  }

  await new Promise(resolve => {
    const quit = () => {
      if (stopping) return
      stopping = true
      log(paint(c.yellow, '\n  正在停止全部服务...'))
      children.forEach(child => {
        try {
          if (process.platform === 'win32') {
            execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' })
          } else {
            child.kill('SIGTERM')
          }
        } catch (e) {
          // ignore
        }
      })
      stopAll()
      resolve()
    }
    process.on('SIGINT', quit)
    process.on('SIGTERM', quit)
  })
}

async function startDocker() {
  const script = path.join(ROOT, 'scripts', 'docker-up.js')
  log(paint(c.yellow, '  交给 Docker：内部跑协同 / MCP / AI / 数据库，对外只开一个端口。'))
  log('')
  await new Promise((resolve, reject) => {
    const child = spawn('node', [script, 'up'], {
      cwd: ROOT,
      stdio: 'inherit',
      shell: true
    })
    child.on('exit', code => {
      if (code) reject(new Error('Docker 启动失败'))
      else resolve()
    })
  })
}

function stopDocker() {
  const script = path.join(ROOT, 'scripts', 'docker-up.js')
  try {
    execSync(`node "${script}" down`, { cwd: ROOT, stdio: 'inherit' })
    log(paint(c.green, '  Docker 已停止'))
  } catch (e) {
    log(paint(c.red, '  停止 Docker 失败，请确认 Docker Desktop 正在运行'))
  }
}

function printMenu(host) {
  banner()
  log(`  当前使用 IP：${paint(c.green, host || '未设置')}`)
  log('')
  log(`  ${paint(c.cyan, '[1]')}  获取本机 IP 并设为使用地址`)
  log(
    `  ${paint(c.cyan, '[2]')}  启动全部服务（页面 / 协同 / AI / MCP / WorkBuddy API）`
  )
  log(`  ${paint(c.cyan, '[3]')}  一键：设 IP + 启动全部服务  ${paint(c.dim, '← 回车默认，含协同')}`)
  log(`  ${paint(c.cyan, '[4]')}  停止全部服务`)
  log(`  ${paint(c.cyan, '[5]')}  Docker 一键启动 ${paint(c.dim, '← 只对外开一个端口，推荐')}`)
  log(`  ${paint(c.cyan, '[6]')}  停止 Docker`)
  log(`  ${paint(c.cyan, '[Q]')}  退出`)
  log('')
}

async function menu() {
  while (true) {
    const host = readSavedHost() || (listLanIPs()[0] && listLanIPs()[0].address) || ''
    printMenu(host)
    const answer = (await ask(paint(c.yellow, '  请选择： '))).toLowerCase()
    if (!answer || answer === '3') {
      await startAll({ pickIp: true })
      return
    }
    if (answer === '1') {
      await setHost({ interactive: true })
      await ask(paint(c.dim, '  按回车返回菜单...'))
      continue
    }
    if (answer === '2') {
      await startAll({ pickIp: false })
      return
    }
    if (answer === '4') {
      stopAll()
      log(paint(c.green, '  服务已停止'))
      await ask(paint(c.dim, '  按回车返回菜单...'))
      continue
    }
    if (answer === '5') {
      await startDocker()
      return
    }
    if (answer === '6') {
      stopDocker()
      await ask(paint(c.dim, '  按回车返回菜单...'))
      continue
    }
    if (answer === 'q') return
  }
}

async function main() {
  if (process.platform === 'win32') {
    try {
      execSync('chcp 65001', { stdio: 'ignore' })
    } catch (e) {
      // ignore
    }
  }

  const cmd = (process.argv[2] || '').toLowerCase()
  if (cmd === 'ip') {
    banner()
    await setHost({ interactive: true })
    return
  }
  if (cmd === 'start') {
    banner()
    await startAll({ pickIp: false })
    return
  }
  if (cmd === 'ip-start' || cmd === 'all') {
    banner()
    await startAll({ pickIp: true })
    return
  }
  if (cmd === 'stop') {
    banner()
    stopAll()
    log(paint(c.green, '  服务已停止'))
    return
  }
  if (cmd === 'docker' || cmd === 'docker-up') {
    banner()
    await startDocker()
    return
  }
  if (cmd === 'docker-stop' || cmd === 'docker-down') {
    banner()
    stopDocker()
    return
  }
  await menu()
}

main().catch(err => {
  console.error(err)
  process.exitCode = 1
})
