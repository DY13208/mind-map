const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, execSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const ENV_FILE = path.join(ROOT, '.env')
const PORT = Number(process.env.MIND_MAP_PORT || 8080)

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

function isVirtualName(name) {
  return /virtual|vmware|vbox|hyper-v|loopback|docker|wsl|vethernet|bluetooth|vnic|pseudo|虚拟/i.test(
    name
  )
}

function scoreIp(address) {
  if (address.startsWith('192.168.')) return 300
  if (address.startsWith('10.')) return 200
  const parts = address.split('.').map(Number)
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return 100
  return 0
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

function detectHost() {
  return (listLanIPs()[0] && listLanIPs()[0].address) || 'localhost'
}

function writeMcpConfig(host) {
  const url = `http://${host}:${PORT}/mcp`
  const config = {
    mcpServers: {
      'mind-map': {
        type: 'http',
        url
      }
    }
  }
  fs.writeFileSync(
    path.join(ROOT, '.mcp.json'),
    JSON.stringify(config, null, 2) + '\n',
    'utf8'
  )
  return url
}

function hasDocker() {
  try {
    execSync('docker info', { stdio: 'ignore' })
    return true
  } catch (e) {
    return false
  }
}

function compose(args, extraEnv) {
  return spawn('docker', ['compose', ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
    env: {
      ...process.env,
      ...extraEnv
    }
  })
}

function ensureEnv() {
  if (!fs.existsSync(ENV_FILE)) {
    console.error('缺少项目根目录 .env，请先复制 .env.example')
    process.exit(1)
  }
  if (!process.env.PGPASSWORD) {
    process.env.PGPASSWORD = 'mindmap'
    console.log('未设置 PGPASSWORD，Docker 内 Postgres 使用默认密码 mindmap')
  }
}

async function up() {
  ensureEnv()
  if (!hasDocker()) {
    console.error('未检测到 Docker。请先安装 Docker Desktop 并保持运行。')
    process.exit(1)
  }
  const host = process.env.PUBLIC_HOST || detectHost()
  const mcpUrl = writeMcpConfig(host)
  console.log('')
  console.log(`  主机 IP  ${host}`)
  console.log(`  对外只开放一个端口：${PORT}`)
  console.log(`  页面     http://${host}:${PORT}`)
  console.log(`  MCP      ${mcpUrl}`)
  console.log('')
  console.log('  正在构建并启动容器（首次会较慢）...')
  const child = compose(['up', '-d', '--build'], {
    PUBLIC_HOST: host,
    MIND_MAP_PORT: String(PORT),
    PGPASSWORD: process.env.PGPASSWORD
  })
  child.on('exit', code => {
    if (code) process.exit(code)
    console.log('')
    console.log('  已启动。浏览器打开上面的页面地址。')
    console.log('  WorkBuddy 把 .mcp.json 里的 url 配上即可，不要再用 3847。')
    console.log('  停止：node scripts/docker-up.js down')
  })
}

function down() {
  if (!hasDocker()) {
    console.error('未检测到 Docker。')
    process.exit(1)
  }
  const child = compose(['down'])
  child.on('exit', code => process.exit(code || 0))
}

const cmd = (process.argv[2] || 'up').toLowerCase()
if (cmd === 'down' || cmd === 'stop') down()
else up()
