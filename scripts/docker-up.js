const fs = require('fs')
const crypto = require('crypto')
const os = require('os')
const path = require('path')
const { spawn, execSync } = require('child_process')
const { stopWorkbuddyApi } = require('./workbuddy-api')
const {
  DEFAULT_PORT: OPENCLAW_PORT,
  ensureOpenclawGateway,
  formatOpenclawResult,
  writeOpenclawRuntimeConfig
} = require('./openclaw-gateway')
const { ensureOpenclawWatchdog, stopOpenclawWatchdog } = require('./openclaw-watchdog')
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
  // 与 scripts/launcher.js 的 mcpServerEntry 保持一致：设了 MCP_TOKEN 就必须
  // 带上 Authorization，否则网关一律 401，导图 MCP 在 WorkBuddy 里连不上。
  const entry = {
    type: 'http',
    url
  }
  if (process.env.MCP_TOKEN) {
    entry.headers = {
      Authorization: `Bearer ${process.env.MCP_TOKEN}`
    }
  }
  const config = {
    mcpServers: {
      'mind-map': entry
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

function loadWikiSecretsIntoEnv() {
  const file = path.join(ROOT, '.secrets', 'wiki.env')
  if (!fs.existsSync(file)) return
  const text = fs.readFileSync(file, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (!key) continue
    if (key === 'DATABASE_URL' && !process.env.DOCMOST_DATABASE_URL) {
      process.env.DOCMOST_DATABASE_URL = value
    }
    if (key === 'APP_SECRET') {
      if (!process.env.DOCMOST_APP_SECRET) process.env.DOCMOST_APP_SECRET = value
      if (!process.env.DOCMOST_SSO_SECRET) process.env.DOCMOST_SSO_SECRET = value
    }
    if (!(key in process.env)) process.env[key] = value
  }
}

function compose(args, extraEnv) {
  require('./wiki-env').ensureWikiEnv()
  loadWikiSecretsIntoEnv()
  return spawn('docker', ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.wiki.yml', ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
    env: {
      ...process.env,
      ...extraEnv
    }
  })
}


function submoduleDirLooksReady(dir) {
  // 有 package.json 或非空 apps/ 即视为已检出，避免每次 up 都打 GitHub
  if (fs.existsSync(path.join(dir, 'package.json'))) return true
  try {
    const apps = path.join(dir, 'apps')
    return fs.existsSync(apps) && fs.readdirSync(apps).length > 0
  } catch (e) {
    return false
  }
}


function listDocmostSourceFiles(rootDir) {
  const skipDir = new Set([
    '.git',
    'node_modules',
    'dist',
    'build',
    '.nx',
    'coverage',
    '.turbo',
    'tmp',
    'temp'
  ])
  const out = []
  function walk(dir) {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (_) {
      return
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        if (skipDir.has(ent.name)) continue
        walk(full)
        continue
      }
      if (!ent.isFile()) continue
      // 忽略本机环境文件，避免 .env 变动触发无意义 rebuild
      if (ent.name === '.env' || ent.name.endsWith('.env.local')) continue
      out.push(full)
    }
  }
  walk(rootDir)
  out.sort()
  return out
}

function hashDocmostSources() {
  const docmostDir = path.join(ROOT, 'integrations', 'docmost')
  const hash = crypto.createHash('sha256')
  const files = listDocmostSourceFiles(docmostDir)
  for (const filePath of files) {
    const rel = path.relative(docmostDir, filePath).replace(/\\/g, '/')
    const st = fs.statSync(filePath)
    hash.update(rel)
    hash.update('\0')
    hash.update(String(st.size))
    hash.update('\0')
    hash.update(String(Math.floor(st.mtimeMs)))
    hash.update('\0')
    // 小文件读内容，大文件只记 size+mtime，兼顾速度和准确性
    if (st.size <= 512 * 1024) {
      hash.update(fs.readFileSync(filePath))
    }
    hash.update('\n')
  }
  hash.update('image=mind-map-docmost\n')
  hash.update('version=' + String(process.env.DOCMOST_VERSION || '0.96.0') + '\n')
  return hash.digest('hex')
}

function docmostImageExists(tag) {
  try {
    execSync('docker image inspect ' + JSON.stringify(tag), { stdio: 'ignore' })
    return true
  } catch (_) {
    return false
  }
}

function ensureDocmostBuilt(extraEnv) {
  const docmostDir = path.join(ROOT, 'integrations', 'docmost')
  const dockerfile = path.join(docmostDir, 'Dockerfile')
  if (!fs.existsSync(dockerfile)) {
    console.error('缺少 integrations/docmost/Dockerfile。请确认已拉取完整仓库源码后再启动。')
    process.exit(1)
  }

  const version = String(process.env.DOCMOST_VERSION || '0.96.0')
  const imageTag = 'mind-map-docmost:' + version
  const stampDir = path.join(ROOT, '.docker-build-stamps')
  const stampFile = path.join(stampDir, 'docmost.sha')
  const currentHash = hashDocmostSources()
  const force =
    process.env.DOCMOST_FORCE_BUILD === '1' ||
    process.env.DOCMOST_FORCE_BUILD === 'true'
  let previousHash = ''
  try {
    previousHash = fs.readFileSync(stampFile, 'utf8').trim()
  } catch (_) {}

  const imageOk = docmostImageExists(imageTag)
  const unchanged = !force && imageOk && previousHash && previousHash === currentHash

  if (unchanged) {
    console.log('  Docmost 镜像已是最新（源码无变化，跳过 rebuild）: ' + imageTag)
    return false
  }

  if (force) console.log('  DOCMOST_FORCE_BUILD=1，强制重建 Docmost 镜像...')
  else if (!imageOk) console.log('  未找到镜像 ' + imageTag + '，开始 build Docmost...')
  else console.log('  检测到 integrations/docmost 源码有变化，开始 rebuild Docmost...')

  // 同步 build，便于启动脚本判断成败
  execSync('docker compose -f docker-compose.yml -f docker-compose.wiki.yml build docmost', {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...(extraEnv || {}) },
    shell: true
  })

  fs.mkdirSync(stampDir, { recursive: true })
  fs.writeFileSync(stampFile, currentHash + '\n', 'utf8')
  console.log('  Docmost 镜像已更新: ' + imageTag)
  return true
}

function ensureGitSubmodules() {
  // docmost 已是主仓库普通目录，不再走 submodule；启动前只检查源码是否齐全
  const docmostDir = path.join(ROOT, 'integrations', 'docmost')
  const dockerfile = path.join(docmostDir, 'Dockerfile')
  if (!fs.existsSync(dockerfile)) {
    console.error('缺少 integrations/docmost/Dockerfile。请确认已拉取完整仓库源码后再启动。')
    process.exit(1)
  }
  console.log('  本地 Docmost 源码已就绪（integrations/docmost）')
  return true
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
  ensureGitSubmodules()
  if (!hasDocker()) {
    console.error('未检测到 Docker。请先安装 Docker Desktop 并保持运行。')
    process.exit(1)
  }
  ensureDocmostBuilt()
  const host = process.env.PUBLIC_HOST || detectHost()
  const wikiPort = Number(process.env.DOCMOST_PORT || 3040)
  // 侧栏 Wiki 新窗口地址：优先用根目录 .env 的 DOCMOST_APP_URL；
  // 未配置时默认本机 IP，避免 127.0.0.1 / localhost 与页面 IP 不一致导致跨域。
  // prefer PUBLIC_HOST for wiki: 有 PUBLIC_HOST 时优先域名，避免侧栏跳到局域网 IP
  if (!String(process.env.DOCMOST_APP_URL || '').trim()) {
    const publicHost = String(process.env.PUBLIC_HOST || '').trim()
    const wikiHost = publicHost || host
    process.env.DOCMOST_APP_URL = `http://${wikiHost}:${wikiPort}`
  } else {
    process.env.DOCMOST_APP_URL = String(process.env.DOCMOST_APP_URL)
      .trim()
      .replace(/\/$/, '')
  }
  const wikiAppUrl = process.env.DOCMOST_APP_URL
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
    // 把合并后的配置写入命名卷（compose up 前），避免容器用残缺配置启动
    try {
      const { syncConfigIntoVolume } = require('./openclaw-docker')
      syncConfigIntoVolume(token, Number(process.env.OPENCLAW_PORT || OC_PORT))
    } catch (e) {
      /* 卷尚未创建时忽略，后面 ensure 会再写 */
    }
    writeOpenclawRuntimeConfig({
      root: ROOT,
      token,
      port: Number(process.env.OPENCLAW_PORT || OC_PORT),
      wikiBase: wikiAppUrl
    })
  } catch (err) {
    writeOpenclawRuntimeConfig({
      root: ROOT,
      port: OPENCLAW_PORT,
      wikiBase: wikiAppUrl
    })
    console.log(
      `  OpenClaw 预配置跳过：${(err && err.message) || err}`
    )
  }
  console.log('')
  console.log(`  主机 IP  ${host}`)
  console.log(`  对外只开放一个端口：${PORT}`)
  console.log(`  页面     http://${host}:${PORT}`)
  console.log(`  MCP      ${mcpUrl}`)
  console.log(`  Wiki     ${wikiAppUrl}`)
  const openclawHostPort = Number(process.env.OPENCLAW_PORT || OPENCLAW_PORT || 4623)
  process.env.OPENCLAW_PORT = String(openclawHostPort)
  console.log(`  OpenClaw 宿主机端口 ${openclawHostPort}（容器内 18789）`)
  console.log('')
  console.log('  正在重新构建并启动容器（OpenClaw 稍后单独拉起，避免迁移锁冲突）...')
  // 停掉看门狗，避免和 compose / ensure 抢同一状态目录
  try {
    const { stopOpenclawWatchdog } = require('./openclaw-watchdog')
    if (typeof stopOpenclawWatchdog === 'function') stopOpenclawWatchdog()
  } catch (e) {
    /* ignore */
  }
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
  // 不要在这里 --force-recreate openclaw-gateway：否则会与后面的 ensure 双重启动抢 migration 锁
  const child = compose(
    [
      'up',
      '-d',
      '--force-recreate',
      '--no-deps',
      'postgres',
      'redis',
      'app',
      'docmost-db',
      'docmost-redis',
      'docmost',
      'wiki-gateway'
    ],
    {
      PUBLIC_HOST: host,
      MIND_MAP_PORT: String(PORT),
      PGPASSWORD: process.env.PGPASSWORD,
      OPENCLAW_PORT: String(openclawHostPort),
      DOCMOST_APP_URL: wikiAppUrl,
      DOCMOST_PORT: String(wikiPort)
    }
  )
  child.on('exit', async code => {
    if (code) process.exit(code)
    const runtimeBuild = compose(['build', 'openwiki-runtime'])
    runtimeBuild.on('exit', runtimeCode => {
      if (runtimeCode) console.error('[Wiki] OpenWiki build failed; retry docker compose -f docker-compose.yml -f docker-compose.wiki.yml build openwiki-runtime')
      else console.log('[Wiki] OpenWiki runtime ready (run on demand)')
    })
    console.log(`  Docmost: ${wikiAppUrl}`)
    console.log('')
    console.log('  已启动。浏览器打开上面的页面地址。')
    if (process.platform === 'win32') {
      console.log('')
      console.log('  跳过 WorkBuddy / 小策执行代理（SOP 已统一走助理 OpenClaw）...')
      try {
        const stopped = stopWorkbuddyApi({ root: ROOT })
        if (stopped) {
          console.log('  已停止本机残留的 WorkBuddy API，释放内存')
        } else {
          console.log('  未检测到 WorkBuddy API 进程')
        }
      } catch (err) {
        console.log(
          `  停止 WorkBuddy API 时忽略：${(err && err.message) || err}`
        )
      }

      console.log('')
      console.log('  正在启动本机 Cognee（OpenClaw 记忆插件）...')
      try {
        const {
          ensureCognee,
          formatCogneeResult,
          cogneeEnabled
        } = require('./cognee-docker')
        if (!cogneeEnabled()) {
          console.log('  Cognee 已跳过（COGNEE_ENABLED 未开启）')
        } else {
          const cg = await ensureCognee({
            onLog: msg => console.log(`  ${msg}`)
          })
          formatCogneeResult(cg)
            .split('\n')
            .forEach(line => console.log(`  ${line}`))
          if (cg && !cg.ok && !cg.skipped) {
            console.log(
              '  （Cognee 未就绪时 OpenClaw 仍会启动，但记忆插件可能不可用）'
            )
          }
        }
      } catch (err) {
        console.log(`  Cognee 启动异常：${(err && err.message) || err}`)
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
          port: openclawHostPort,
          wikiBase: wikiAppUrl
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
        // 看门狗的职责是「防止已就绪的 Gateway 掉线」，不是「反复重试拉起一个
        // 起不来的 Gateway」。Gateway 没起来还启动看门狗，会让它每 20s 重试一次
        // （每次都要 docker run 探针容器），在 Windows 上表现为命令行窗口不停闪现。
        if (oc && oc.ok) {
          const wd = ensureOpenclawWatchdog()
          if (wd && wd.ok) {
            console.log(
              wd.alreadyRunning
                ? `  OpenClaw 看门狗已在运行（防 WSL 闲置掉线）`
                : `  OpenClaw 看门狗已启动（防 WSL 闲置掉线）`
            )
          }
        } else {
          const stopped = stopOpenclawWatchdog()
          if (stopped && stopped.stoppedPid) {
            console.log(
              '  已停止残留的 OpenClaw 看门狗（Gateway 未就绪，避免每 20s 反复重试）'
            )
          }
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
        '  OpenClaw Gateway 需在 Windows 本机单独启动（node scripts/openclaw-gateway.js）。'
      )
    }
    console.log('')
    console.log('  SOP / AI 执行统一走助理（OpenClaw），不再拉起 WorkBuddy / 小策代理。')
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
