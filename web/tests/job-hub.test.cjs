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
  fetchHandler = url => {
    if (url.startsWith('http://192.168.1.114:5000/')) return { status: 200, body: { peers: [] } }
    return new Error('connect ECONNREFUSED')
  }
  resolved = await hub.resolveJobHub({ force: true })
  check('5050 不通时退到 5000', resolved.ok && resolved.base === 'http://192.168.1.114:5000', resolved.base)

  // 返回 HTML（群晖那种）不算通讯页
  window.sessionStorage.clear()
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
