const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, execSync } = require('child_process')
const {
  DEFAULT_PORT: WORKBUDDY_PORT,
  ensureWorkbuddyApi,
  formatWorkbuddyResult
} = require('./workbuddy-api')
const {
  DEFAULT_PORT: OPENCLAW_PORT,
  ensureOpenclawGateway,
  formatOpenclawResult,
  writeOpenclawRuntimeConfig
} = require('./openclaw-gateway')
const { ensureOpenclawWatchdog } = require('./openclaw-watchdog')
const {
  ensureOpenclawBridge,
  formatBridgeResult
} = require('./openclaw-bridge-ctl')

const ROOT = path.resolve(__dirname, '..')
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

const PORT = Number(process.env.MIND_MAP_PORT || 8080)

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
  // 先写占位 runtime + OpenClaw Token/配置，保证 compose 能拉起龙虾容器
  try {
    const {
      ensureGatewayToken,
      ensureOpenclawConfig,
      DEFAULT_PORT: OC_PORT,
      DEFAULT_IMAGE: OC_IMAGE
    } = require('./openclaw-docker')
    const token = ensureGatewayToken()
    ensureOpenclawConfig(token, Number(process.env.OPENCLAW_PORT || OC_PORT))
    if (!process.env.OPENCLAW_IMAGE) process.env.OPENCLAW_IMAGE = OC_IMAGE
    writeOpenclawRuntimeConfig({
      root: ROOT,
      token,
      port: Number(process.env.OPENCLAW_PORT || OC_PORT)
    })
  } catch (err) {
    writeOpenclawRuntimeConfig({ root: ROOT, port: OPENCLAW_PORT })
    console.log(
      `  OpenClaw 预配置跳过：${(err && err.message) || err}`
    )
  }
  console.log('')
  console.log(`  主机 IP  ${host}`)
  console.log(`  对外只开放一个端口：${PORT}`)
  console.log(`  页面     http://${host}:${PORT}`)
  console.log(`  MCP      ${mcpUrl}`)
  const openclawHostPort = Number(process.env.OPENCLAW_PORT || OPENCLAW_PORT || 4623)
  process.env.OPENCLAW_PORT = String(openclawHostPort)
  console.log(`  OpenClaw 宿主机端口 ${openclawHostPort}（容器内 18789）`)
  console.log('')
  console.log('  正在重新构建并启动容器（含 OpenClaw 龙虾网关，首次拉镜像会较慢）...')
  // 先释放旧映射，避免 --force-recreate 时端口仍被旧容器占用
  try {
    execSync('docker compose stop openclaw-gateway', {
      cwd: ROOT,
      stdio: 'ignore',
      env: process.env
    })
    execSync('docker compose rm -sf openclaw-gateway', {
      cwd: ROOT,
      stdio: 'ignore',
      env: process.env
    })
  } catch (e) {
    /* ignore */
  }
  const child = compose(['up', '-d', '--build', '--force-recreate'], {
    PUBLIC_HOST: host,
    MIND_MAP_PORT: String(PORT),
    PGPASSWORD: process.env.PGPASSWORD,
    OPENCLAW_PORT: String(openclawHostPort)
  })
  child.on('exit', async code => {
    if (code) process.exit(code)
    console.log('')
    console.log('  已启动。浏览器打开上面的页面地址。')
    if (process.platform === 'win32') {
      console.log('')
      console.log('  正在启动本机 WorkBuddy API 代理（SOP 运行 / 补齐流程需要）...')
      try {
        const wb = await ensureWorkbuddyApi({
          root: ROOT,
          port: WORKBUDDY_PORT,
          mcpConfigPath: path.join(ROOT, '.mcp.json')
        })
        formatWorkbuddyResult(wb)
          .split('\n')
          .forEach(line => console.log(`  ${line}`))
        if (wb && wb.ok) {
          console.log(
            `  页面访问 /wb-api → http://127.0.0.1:${wb.port}（经 Docker 网关转发）`
          )
        }
      } catch (err) {
        console.log(
          `  WorkBuddy API 启动异常：${(err && err.message) || err}`
        )
      }

      console.log('')
      console.log('  正在启动本机 OpenClaw Gateway（助理页需要）...')
      try {
        const oc = await ensureOpenclawGateway({
          port: openclawHostPort,
          startTray: true
        })
        const runtime = writeOpenclawRuntimeConfig({
          root: ROOT,
          token: (oc && oc.token) || '',
          model: process.env.OPENCLAW_MODEL || 'openclaw/default',
          port: openclawHostPort
        })
        // 勿把 token 打到控制台
        if (oc) {
          const tokenForBridge = oc.token || ''
          delete oc.token
          oc.hasToken = !!(runtime && runtime.hasToken)
          oc.runtimeWritten = true
          const bridge = await ensureOpenclawBridge({
            token: tokenForBridge,
            distro: oc.distro
          })
          formatBridgeResult(bridge)
            .split('\n')
            .forEach(line => console.log(`  ${line}`))
        }
        formatOpenclawResult(oc)
          .split('\n')
          .forEach(line => console.log(`  ${line}`))
        const wd = ensureOpenclawWatchdog()
        if (wd && wd.ok) {
          console.log(
            wd.alreadyRunning
              ? `  OpenClaw 看门狗已在运行（防 WSL 闲置掉线）`
              : `  OpenClaw 看门狗已启动（防 WSL 闲置掉线）`
          )
        }
        if (oc && oc.ok) {
          console.log(
            `  页面访问 /openclaw-api → http://127.0.0.1:${oc.port}（经 Docker 网关转发）`
          )
          console.log(`  助理页  http://${host}:${PORT}/assistant`)
        } else {
          console.log(
            '  也可稍后手动执行：node scripts/openclaw-gateway.js'
          )
        }
      } catch (err) {
        console.log(
          `  OpenClaw 启动异常：${(err && err.message) || err}`
        )
        console.log('  手动重试：node scripts/openclaw-gateway.js')
      }
    } else {
      console.log(
        '  WorkBuddy API / OpenClaw Gateway 需在 Windows 本机单独启动。'
      )
    }
    console.log('')
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
