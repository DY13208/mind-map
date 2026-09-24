/* eslint-env node */
/* global globalThis */
/**
 * 通讯页（主服务）地址解析单测。
 *
 * 回归的 bug：原来 getJobHubBase() 无脑用 `http://<页面host>:5000`，
 * 页面部署在公网域名上时就变成 `http://xx.stillgroup.net:5000` ——
 * 那端口实测是群晖 NAS，永远不会是通讯页，于是永远报
 * 「连不上主服务 http://xx.stillgroup.net:5000（通讯页 comm.py 是否在运行？）」。
 *
 * 现在改成一组候选地址逐个探测（谁回的 /api/peers 是合法 JSON 用谁）。
 * 做法照 web/tests/job-history.component.test.cjs：babel 转 CJS + require stub。
 */
const fs = require('fs')
const path = require('path')
const babel = require('@babel/core')

const WEB = path.join(__dirname, '..')
const results = []
function check(name, ok, extra = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`)
}

function loadCjs(file, stub) {
  const src = fs.readFileSync(file, 'utf8')
  const { code } = babel.transformSync(src, {
    babelrc: false,
    configFile: false,
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
  })
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', code)(stub, mod, mod.exports)
  return mod.exports
}

// ---- 浏览器环境 stub ----
function makeStorage() {
  const map = new Map()
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k),
    clear: () => map.clear()
  }
}

// node 里没有 window，得自己造一个（源码是按浏览器写的）
const win = {
  location: {},
  localStorage: makeStorage(),
  sessionStorage: makeStorage(),
  __MIND_MAP_RUNTIME__: {}
}
globalThis.window = win

let runtimeConfig = {}
window.localStorage = makeStorage()
window.sessionStorage = makeStorage()
window.location = {
  hostname: '192.168.1.114',
  origin: 'http://192.168.1.114:8989',
  port: '8989',
  protocol: 'http:',
  search: ''
}
window.__MIND_MAP_RUNTIME__ = {}

// ---- 可编程 fetch ----
let fetchHandler = () => ({ status: 200, body: '{"peers":[]}' })
let fetchLog = []
globalThis.fetch = async (url, options = {}) => {
  fetchLog.push({ url: String(url), method: options.method || 'GET' })
  const r = fetchHandler(String(url), options)
  if (r instanceof Error) throw r
  const status = r.status === undefined ? 200 : r.status
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body))
  }
}
globalThis.AbortController = globalThis.AbortController || class {
  abort() {}
}

const hub = loadCjs(path.join(WEB, 'src/utils/workbuddyJobBridge.js'), name => {
  if (name === './runtimeConfig') {
    return { getRuntimeConfig: () => ({ ...runtimeConfig }) }
  }
  return {}
})

function setPage({ hostname, origin, port, protocol, query = '' }) {
  window.location = {
    hostname,
    origin,
    port,
    protocol,
    search: query
  }
}

async function main() {
  // ---- 1. 私网判断 ----
  check('192.168.x 算局域网', hub.isPrivateHost('192.168.1.114') === true)
  check('10.x 算局域网', hub.isPrivateHost('10.0.0.8') === true)
  check('172.16~31 算局域网', hub.isPrivateHost('172.20.3.4') === true)
  check('172.32 不算局域网', hub.isPrivateHost('172.32.3.4') === false)
  check('127.0.0.1 算局域网', hub.isPrivateHost('127.0.0.1') === true)
  check(
    '公网域名不算局域网（这就是错地址的根源）',
    hub.isPrivateHost('xx.stillgroup.net') === false
  )
  check('8.8.8.8 不算局域网', hub.isPrivateHost('8.8.8.8') === false)

  // ---- 2. 候选地址 ----
  runtimeConfig = {}
  window.__MIND_MAP_RUNTIME__ = {}
  setPage({ hostname: '192.168.1.114', origin: 'http://192.168.1.114:8989', port: '8989', protocol: 'http:' })
  let cands = hub.jobHubCandidates()
  check(
    '页面在私网 IP 上：先试同主机的 5050（新版通讯页端口）',
    cands[0] === 'http://192.168.1.114:5050',
    JSON.stringify(cands)
  )
  check('再试 5000（老版端口）', cands.includes('http://192.168.1.114:5000'))
  check('最后带同源 /jobhub 反代兜底', cands.includes('http://192.168.1.114:8989/jobhub'))

  setPage({ hostname: 'xx.stillgroup.net', origin: 'http://xx.stillgroup.net:8990', port: '8990', protocol: 'http:' })
  cands = hub.jobHubCandidates()
  check(
    '页面在公网域名上：绝不再猜 <域名>:5000（那是别人的服务）',
    !cands.some(u => u.includes(':5000')) && !cands.some(u => u.includes(':5050')),
    JSON.stringify(cands)
  )
  check(
    '公网域名下只留同源 /jobhub',
    cands.length === 1 && cands[0] === 'http://xx.stillgroup.net:8990/jobhub',
    JSON.stringify(cands)
  )

  // ---- 3. 配置与手动覆盖 ----
  runtimeConfig = { workbuddyJobHub: 'http://192.168.0.54:5050' }
  cands = hub.jobHubCandidates()
  check('构建时配置排在最前', cands[0] === 'http://192.168.0.54:5050', JSON.stringify(cands))

  setPage({
    hostname: 'xx.stillgroup.net',
    origin: 'http://xx.stillgroup.net:8990',
    port: '8990',
    protocol: 'http:',
    query: '?hub=http://192.168.1.114:5050'
  })
  check(
    '?hub= 临时指定优先级最高（救急用）',
    hub.jobHubCandidates()[0] === 'http://192.168.1.114:5050',
    JSON.stringify(hub.jobHubCandidates())
  )
  setPage({ hostname: 'xx.stillgroup.net', origin: 'http://xx.stillgroup.net:8990', port: '8990', protocol: 'http:' })

  check('setJobHubOverride 写进本地', hub.setJobHubOverride('http://192.168.0.54:5050') === 'http://192.168.0.54:5050')
  check(
    '记下的地址也进候选',
    hub.jobHubCandidates().includes('http://192.168.0.54:5050'),
    JSON.stringify(hub.jobHubCandidates())
  )
  hub.setJobHubOverride('')

  // ---- 4. 探测：谁像通讯页用谁 ----
  runtimeConfig = {}
  window.__MIND_MAP_RUNTIME__ = {}
  setPage({ hostname: '192.168.1.114', origin: 'http://192.168.1.114:8989', port: '8989', protocol: 'http:' })

  // 5050 通、5000 挂
  fetchHandler = url => {
    if (url.startsWith('http://192.168.1.114:5050/')) {
      return { status: 200, body: { peers: [{ ip: '192.168.1.114', port: 8799, name: 'DESKTOP' }] } }
    }
    return new Error('connect ECONNREFUSED')
  }
  let resolved = await hub.resolveJobHub({ force: true })
  check('探测到 5050 上的通讯页', resolved.ok && resolved.base === 'http://192.168.1.114:5050', JSON.stringify(resolved.base))
  check('带回 peers', resolved.peers.length === 1 && resolved.peers[0].name === 'DESKTOP')

  const peersRes = await hub.listHubPeers()
  check('listHubPeers 用探测结果', peersRes.ok && peersRes.hub === 'http://192.168.1.114:5050')
  check(
    'peers 归一化（key/url/label）',
    peersRes.peers[0].key === '192.168.1.114:8799' && peersRes.peers[0].url === 'http://192.168.1.114:8799',
    JSON.stringify(peersRes.peers[0])
  )

  // 5050 挂、5000 通（老版本通讯页）
  window.sessionStorage.clear()
  hub.setJobHubOverride('')  // 连模块内存里的解析缓存一起清掉
  fetchHandler = url => {
    if (url.startsWith('http://192.168.1.114:5000/')) return { status: 200, body: { peers: [] } }
    return new Error('connect ECONNREFUSED')
  }
  resolved = await hub.resolveJobHub({ force: true })
  check('5050 不通时退到 5000', resolved.ok && resolved.base === 'http://192.168.1.114:5000', resolved.base)

  // 返回 HTML（群晖那种）不算通讯页
  window.sessionStorage.clear()
  hub.setJobHubOverride('')  // 连模块内存里的解析缓存一起清掉
  fetchHandler = () => ({ status: 200, body: '<!DOCTYPE html><html>群晖 NAS</html>' })
  resolved = await hub.resolveJobHub({ force: true })
  check(
    '回 HTML 的端口不算通讯页（不会把 NAS 当主服务）',
    !resolved.ok && resolved.base === '',
    JSON.stringify(resolved)
  )
  check(
    '失败时给出可操作的提示',
    !resolved.ok && /没找到通讯页/.test(resolved.error) && /\?hub=/.test(resolved.error),
    resolved.error
  )
  const failedPeers = await hub.listHubPeers()
  check('连不上主服务时 listHubPeers 返回 ok:false + 提示', !failedPeers.ok && /没找到通讯页/.test(failedPeers.error))
  check('失败结果里带着试过的地址', Array.isArray(failedPeers.tried) && failedPeers.tried.length > 0)

  // ---- 5. 缓存 ----
  window.sessionStorage.clear()
  hub.setJobHubOverride('')  // 连模块内存里的解析缓存一起清掉
  fetchLog = []
  fetchHandler = () => ({ status: 200, body: { peers: [] } })
  await hub.resolveJobHub({ force: true })
  const firstRound = fetchLog.length
  fetchLog = []
  await hub.resolveJobHub()
  check(
    '解析成功后 30s 内不再重复探测',
    fetchLog.length === 0 && firstRound > 0,
    `首轮 ${firstRound} 次请求，第二轮 ${fetchLog.length} 次`
  )
  check('上次连上的地址被记到 sessionStorage', window.sessionStorage.getItem('mindmap-job-hub-resolved') !== null)
  await hub.resolveJobHub({ force: true })
  check('force:true 会重探', fetchLog.length > 0)

  // ---- 7. 公网页面：一律走同源 /jobhub 中继 ----
  // 页面在公网地址上时，浏览器（Chrome 142+ 的 Local Network Access）不许它访问
  // 回环/私网地址，直连只会白跑一趟 + 控制台一堆错。所以这时要直接走同源中继。
  setPage({
    hostname: 'xx.stillgroup.net',
    origin: 'https://xx.stillgroup.net:8989',
    port: '8989',
    protocol: 'https:'
  })
  window.sessionStorage.clear()
  hub.setJobHubOverride('')  // 连模块内存里的解析缓存一起清掉
  fetchLog = []
  fetchHandler = url => {
    if (url.includes('/jobhub/api/peers')) {
      return { status: 200, body: { peers: [{ ip: '192.168.1.114', port: 8799, name: 'DESKTOP' }] } }
    }
    if (url.includes('/jobhub/api/gateways')) {
      return { status: 200, body: { gateways: [{ url: 'http://127.0.0.1:50001', cwd: 'D:\\demo' }] } }
    }
    return new Error('公网页面不该直连：' + url)
  }
  const relayed = await hub.listHostGateways({ ip: '192.168.1.114', port: 8799 })
  check(
    '公网页面：局域网主机走同源中继（via=hub）',
    relayed.ok && relayed.via === 'hub',
    JSON.stringify({ ok: relayed.ok, via: relayed.via })
  )
  check(
    '中继打的就是页面同源的 /jobhub',
    fetchLog.some(l => l.url === 'https://xx.stillgroup.net:8989/jobhub/api/gateways?ip=192.168.1.114&port=8799'),
    JSON.stringify(fetchLog.map(l => l.url))
  )
  check(
    '一次都没直连 192.168.1.114:8799',
    !fetchLog.some(l => l.url.startsWith('http://192.168.1.114:8799')),
    JSON.stringify(fetchLog.map(l => l.url))
  )

  // 回环地址不吃中继：中继是通讯页去连，127.0.0.1 在那边等于它自己
  fetchLog = []
  window.sessionStorage.clear()
  hub.setJobHubOverride('')  // 连模块内存里的解析缓存一起清掉
  fetchHandler = url => {
    if (url.includes(':8799')) return new Error('Failed to fetch')
    return { status: 200, body: { peers: [] } }
  }
  const loopback = await hub.listHostGateways({ ip: '127.0.0.1', port: 8799 })
  check(
    '回环主机不走中继（否则打到通讯页自己那台机器）',
    !loopback.ok && !fetchLog.some(l => l.url.includes('/jobhub/api/gateways')),
    JSON.stringify({ ok: loopback.ok, log: fetchLog.map(l => l.url) })
  )

  // 私网页面：还是直连优先（不依赖通讯页，也不多绕一圈）
  setPage({ hostname: '192.168.0.54', origin: 'http://192.168.0.54:8989', port: '8989', protocol: 'http:' })
  window.sessionStorage.clear()
  hub.setJobHubOverride('')  // 连模块内存里的解析缓存一起清掉
  fetchLog = []
  fetchHandler = url => {
    if (url.startsWith('http://192.168.1.114:8799')) return { status: 200, body: { gateways: [] } }
    return new Error('私网页面不该走这条路：' + url)
  }
  const direct = await hub.listHostGateways({ ip: '192.168.1.114', port: 8799 })
  check(
    '私网页面：直连优先（via=direct）',
    direct.ok && direct.via === 'direct',
    JSON.stringify({ ok: direct.ok, via: direct.via })
  )

  // 公网页面下主机列表不该出现回环
  setPage({
    hostname: 'xx.stillgroup.net',
    origin: 'https://xx.stillgroup.net:8989',
    port: '8989',
    protocol: 'https:'
  })
  window.sessionStorage.clear()
  hub.setJobHubOverride('')  // 连模块内存里的解析缓存一起清掉
  fetchHandler = url => {
    if (url.includes('/jobhub/api/peers')) {
      return {
        status: 200,
        body: { peers: [{ ip: '192.168.1.114', port: 8799, name: 'DESKTOP', online: true }] }
      }
    }
    if (url.includes('/jobhub/api/gateways')) return { status: 200, body: { gateways: [] } }
    if (url.includes(':8799')) return new Error('Failed to fetch')
    return { status: 200, body: {} }
  }
  const publicHosts = await hub.resolveJobHosts()
  check(
    '公网页面：列表里没有 127.0.0.1（浏览器连不上，列了只会让人白点）',
    !publicHosts.hosts.some(h => h.ip === '127.0.0.1'),
    JSON.stringify(publicHosts.hosts.map(h => h.key))
  )
  check(
    '公网页面：默认目标是登记过的局域网主机',
    !!publicHosts.defaultHost && publicHosts.defaultHost.ip === '192.168.1.114',
    JSON.stringify(publicHosts.defaultHost && publicHosts.defaultHost.key)
  )

  // ---- 8. 页面部署在局域网某台机器上：默认就用那台的 WorkBuddy ----
  // 场景：页面挂在 http://192.168.0.54:8990，同事从自己电脑打开它派任务。
  // 不要求每个人都在自己电脑上跑桥接 —— 用「页面所在那台」的最省事。
  setPage({
    hostname: '192.168.0.54',
    origin: 'http://192.168.0.54:8990',
    port: '8990',
    protocol: 'http:'
  })
  window.sessionStorage.clear()
  hub.setJobHubOverride('')
  check(
    'pageMachineHost：私网页面 → 指向页面那台的 8799',
    (hub.pageMachineHost() || {}).key === '192.168.0.54:8799',
    JSON.stringify(hub.pageMachineHost())
  )
  setPage({
    hostname: 'xx.stillgroup.net',
    origin: 'https://xx.stillgroup.net:8989',
    port: '8989',
    protocol: 'https:'
  })
  check('pageMachineHost：公网域名页面 → 不用它（得走中继）', hub.pageMachineHost() === null)
  setPage({
    hostname: '192.168.0.54',
    origin: 'http://192.168.0.54:8990',
    port: '8990',
    protocol: 'http:'
  })
  window.sessionStorage.clear()
  hub.setJobHubOverride('')
  fetchLog = []
  fetchHandler = url => {
    if (url === 'http://192.168.0.54:8799/api/gateways') {
      return { status: 200, body: { gateways: [{ url: 'http://127.0.0.1:50001', cwd: 'D:\\demo' }] } }
    }
    if (url.includes('/api/peers')) return new Error('不该去找通讯页')
    if (url.includes(':8799')) return new Error('Failed to fetch')
    return new Error('不该请求：' + url)
  }
  const pageHosts = await hub.resolveJobHosts()
  check(
    '页面主机能用：不去翻通讯页（少一次请求 + 少几条红字）',
    !fetchLog.some(l => l.url.includes('/api/peers')),
    JSON.stringify(fetchLog.map(l => l.url))
  )
  check(
    '页面在私网 IP 上：执行主机列表第一条是「页面主机」',
    !!pageHosts.hosts[0] && pageHosts.hosts[0].key === '192.168.0.54:8799',
    JSON.stringify(pageHosts.hosts.map(h => h.key))
  )
  check(
    '默认目标就是页面那台（不用同事自己开桥接）',
    !!pageHosts.defaultHost && pageHosts.defaultHost.key === '192.168.0.54:8799',
    JSON.stringify(pageHosts.defaultHost && pageHosts.defaultHost.key)
  )
  check(
    '没有通讯页也算可用（ok:true）',
    pageHosts.ok === true,
    JSON.stringify({ ok: pageHosts.ok, error: pageHosts.error })
  )
  check('页面上标出它是什么角色', /页面主机/.test(pageHosts.hosts[0].label), pageHosts.hosts[0].label)

  // ---- 9. 写操作必须是 POST ----
  // 回归：把 dispatch/stop/attach 收敛到 bridgeRequest 时漏了 method: 'POST'，
  // 于是按 GET 发、又带着 body → fetch 直接抛
  // 「Failed to execute 'fetch' on 'Window': Request with GET/HEAD method cannot have body」
  setPage({
    hostname: '192.168.0.54',
    origin: 'http://192.168.0.54:8990',
    port: '8990',
    protocol: 'http:'
  })
  window.sessionStorage.clear()
  hub.setJobHubOverride('')
  fetchLog = []
  fetchHandler = url => {
    if (url.includes('/api/dispatch')) {
      return { status: 200, body: { ok: true, job: { id: 'job-1' }, gatewayCwd: 'D:\\demo' } }
    }
    if (url.includes('/api/stop')) return { status: 200, body: { ok: true } }
    if (url.includes('/api/attach')) return { status: 200, body: { ok: true, attachments: [] } }
    return { status: 200, body: {} }
  }
  const writeTarget = { ip: '192.168.0.54', port: 8799 }
  const dispatched = await hub.dispatchWorkbuddyJob({
    host: writeTarget,
    gateway: 'http://127.0.0.1:50001',
    prompt: '把今天的销售表汇总'
  })
  await hub.stopHostJob({ host: writeTarget, gateway: 'http://127.0.0.1:50001', id: 'job-1' })
  await hub.attachFilesViaBridge({
    host: writeTarget,
    roomKey: 'room-1',
    nodeUid: 'node-1',
    files: [{ name: 'a.txt', base64: 'eA==' }]
  })
  const writes = fetchLog.filter(l => /\/api\/(dispatch|stop|attach)/.test(l.url))
  check('派发成功', dispatched.ok === true, JSON.stringify(dispatched.error || ''))
  check(
    '派发/停止/挂附件都是 POST（GET 带 body 会被 fetch 直接抛错）',
    writes.length === 3 && writes.every(l => l.method === 'POST'),
    JSON.stringify(writes.map(l => `${l.method} ${l.url}`))
  )

  // ---- 10. 同源桥接：页面和 WorkBuddy 在同一台机器上（走 /bridge/ 反代）----
  // 场景：脑图部署在服务器上，任务也用**服务器上**的 WorkBuddy 跑。
  // 浏览器的 127.0.0.1 是同事自己的电脑，所以桥接必须挂在同源路径下。
  runtimeConfig = { workbuddyJobBridge: '/bridge' }
  setPage({
    hostname: 'xx.stillgroup.net',
    origin: 'https://xx.stillgroup.net:8989',
    port: '8989',
    protocol: 'https:'
  })
  window.sessionStorage.clear()
  hub.setJobHubOverride('')
  check(
    '桥接配成相对路径 → 认成同源桥接',
    hub.isSameOriginBridge() === true,
    hub.getJobBridgeBase()
  )
  fetchLog = []
  fetchHandler = url => {
    if (url === '/bridge/api/gateways') {
      return { status: 200, body: { gateways: [{ url: 'http://127.0.0.1:50001', cwd: 'D:\\demo' }] } }
    }
    if (url.includes('/api/peers')) return new Error('不该去找通讯页')
    return new Error('不该请求：' + url)
  }
  const sameHosts = await hub.resolveJobHosts()
  check(
    '同源桥接：请求走相对路径（同源，没有跨域也没有混合内容）',
    fetchLog.some(l => l.url === '/bridge/api/gateways'),
    JSON.stringify(fetchLog.map(l => l.url))
  )
  check(
    '同源桥接：主机列表里标明「页面同源」（别让人以为是自己的电脑）',
    sameHosts.hosts.some(h => /页面同源/.test(h.label)),
    JSON.stringify(sameHosts.hosts.map(h => h.label))
  )
  check(
    '同源桥接：默认目标就是它',
    !!sameHosts.defaultHost && sameHosts.defaultHost.key === '127.0.0.1:8799',
    JSON.stringify(sameHosts.defaultHost && sameHosts.defaultHost.key)
  )
  // 派发也要打在同源路径上
  fetchLog = []
  fetchHandler = url => {
    if (url === '/bridge/api/dispatch') {
      return { status: 200, body: { ok: true, job: { id: 'job-9' } } }
    }
    return new Error('不该请求：' + url)
  }
  const sameDispatch = await hub.dispatchWorkbuddyJob({
    host: { ip: '127.0.0.1', port: 8799 },
    gateway: 'http://127.0.0.1:50001',
    prompt: '干活'
  })
  check(
    '同源桥接：派发也走 /bridge（POST）',
    sameDispatch.ok === true && fetchLog.some(l => l.url === '/bridge/api/dispatch' && l.method === 'POST'),
    JSON.stringify(fetchLog.map(l => `${l.method} ${l.url}`))
  )
  runtimeConfig = {}

  // ---- 6. 本机桥接没跑时，提示要说清怎么办 ----
  setPage({
    hostname: '192.168.0.54',
    origin: 'http://192.168.0.54:8990',
    port: '8990',
    protocol: 'http:'
  })
  window.sessionStorage.clear()
  hub.setJobHubOverride('')
  fetchHandler = url => {
    if (url.includes(':8799')) return new Error('Failed to fetch')
    return { status: 200, body: { peers: [] } }
  }
  const locals = await hub.listLocalGateways()
  check(
    '本机桥接没跑：不再只回一句 Failed to fetch',
    !locals.ok && /这台电脑的桥接没在跑/.test(locals.error) && /run_bridge\.bat/.test(locals.error),
    locals.error
  )
  check('提示里带上了桥接地址', /127\.0\.0\.1:8799/.test(locals.error))

  const failed = results.filter(r => !r.ok)
  console.log(`\n共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
  if (failed.length) {
    console.log('失败项：' + failed.map(r => r.name).join(' / '))
    process.exit(1)
  }
  process.exit(0)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
