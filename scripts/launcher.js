const fs = require('fs')
const os = require('os')
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

const WEB_PORT = 8081
const COLLAB_PORT = 1234
const AI_PORT = 3456

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

function writeRuntimeConfig(host) {
  const config = {
    host,
    webPort: WEB_PORT,
    collabPort: COLLAB_PORT,
    aiPort: AI_PORT
  }
  const content =
    'window.__MIND_MAP_RUNTIME__ = ' + JSON.stringify(config, null, 2) + '\n'
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
  fs.writeFileSync(CONFIG_FILE, content, 'utf8')
  return config
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
  ;[WEB_PORT, COLLAB_PORT, AI_PORT].forEach(port => {
    const n = killPort(port)
    if (n) log(paint(c.dim, `  已释放端口 ${port}`))
  })
}

function ensureDeps() {
  const targets = [
    { dir: WEB_DIR, name: 'web' },
    { dir: LIB_DIR, name: 'simple-mind-map' }
  ]
  targets.forEach(item => {
    if (fs.existsSync(path.join(item.dir, 'node_modules'))) return
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

function startProcess(name, command, args, cwd, color, extraEnv = {}) {
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
  child.on('exit', code => {
    if (!stopping) {
      log(paint(c.red, `  [${name}] 已退出${code ? ` (${code})` : ''}`))
    }
  })
  children.push(child)
  return child
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
  log('')
  log(paint(c.bold, '  访问地址'))
  log(`  页面    ${paint(c.green, `http://${host}:${WEB_PORT}`)}`)
  log(`  协同    ${paint(c.green, `ws://${host}:${COLLAB_PORT}`)}`)
  log(`  AI      ${paint(c.green, `http://${host}:${AI_PORT}`)}`)
  log('')
  log(paint(c.dim, '  局域网同事打开页面地址，点「协同」，填同一房间即可。'))
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
  writeRuntimeConfig(host)
  log('')
  log(paint(c.green, `  已将使用 IP 设为 ${host}`))
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

  log(paint(c.yellow, '  正在启动全部服务...'))
  startProcess(
    '协同',
    'node',
    ['./bin/collabServer.js'],
    LIB_DIR,
    c.cyan,
    { PORT: String(COLLAB_PORT) }
  )
  startProcess('AI', 'node', ['./scripts/ai.js'], WEB_DIR, c.yellow)
  startProcess(
    '页面',
    'npx',
    ['vue-cli-service', 'serve', '--host', '0.0.0.0', '--port', String(WEB_PORT)],
    WEB_DIR,
    c.green
  )

  printUrls(host)
  log(paint(c.dim, '  等待页面编译完成...'))
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

function printMenu(host) {
  banner()
  log(`  当前使用 IP：${paint(c.green, host || '未设置')}`)
  log('')
  log(`  ${paint(c.cyan, '[1]')}  获取本机 IP 并设为使用地址`)
  log(`  ${paint(c.cyan, '[2]')}  启动全部服务（页面 / 协同 / AI）`)
  log(`  ${paint(c.cyan, '[3]')}  一键：设 IP + 启动全部服务  ${paint(c.dim, '← 回车默认')}`)
  log(`  ${paint(c.cyan, '[4]')}  停止全部服务`)
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
  await menu()
}

main().catch(err => {
  console.error(err)
  process.exitCode = 1
})
