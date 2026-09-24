/* eslint-env node */
/**
 * 「执行主机」默认目标的选择 —— Toolbar.prepareLocalTarget 的单测。
 *
 * 回归的坑：本机桥接（127.0.0.1:8799）没跑时，它原来是**无条件把默认目标设成本机**，
 * 于是点「运行」直接 `GET http://127.0.0.1:8799/api/gateways → ERR_CONNECTION_REFUSED`，
 * 页面报「连不上本机任务桥」，明明局域网里别的电脑是好的，整条路却被堵死。
 *
 * 做法照 web/tests/job-history.component.test.cjs：vue-template-compiler 拆 SFC
 * → babel 转 CJS → require stub → methods bind 到手写的 mock vm 上跑。
 */
const fs = require('fs')
const path = require('path')
const babel = require('@babel/core')
const compiler = require('vue-template-compiler')

const WEB = path.join(__dirname, '..')
const results = []
function check(name, ok, extra = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`)
}

const LOCAL_KEY = '127.0.0.1:8799'

// ---- 可编程的桥接 stub ----
let resolveResult = { hosts: [], defaultHost: null, hub: '', error: '' }
let gatewayResult = { ok: true, gateways: [{ url: 'http://127.0.0.1:50001', cwd: 'D:\\demo' }] }
const calls = { gateways: 0, history: 0 }

const bridgeStub = {
  resolveJobHosts: async () => resolveResult,
  listHostGateways: async () => {
    calls.gateways += 1
    return gatewayResult
  },
  listHostJobs: async () => {
    calls.history += 1
    return { ok: true, jobs: [] }
  },
  describeEmptyGateways: () => '这台主机上没有 WorkBuddy 会话',
  stopHostJob: async () => ({ ok: true }),
  fetchJobTranscript: async () => ({ ok: true, text: '' }),
  fetchJobArtifacts: async () => ({ ok: true, files: [] }),
  attachFilesViaBridge: async () => ({ ok: false, res: null })
}

const parsed = compiler.parseComponent(
  fs.readFileSync(path.join(WEB, 'src/pages/Edit/components/Toolbar.vue'), 'utf8')
)
const { code } = babel.transformSync(parsed.script.content, {
  babelrc: false,
  configFile: false,
  plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
})
const mod = { exports: {} }
// stub 清单照 web/tests/job-history.component.test.cjs —— Toolbar 顶层还会 new markdown-it 等，
// 少一个就会在加载阶段炸（不是在被测逻辑上）
new Function('require', 'module', 'exports', code)(name => {
  if (name === 'vuex') return { mapState: () => ({}) }
  if (name === 'element-ui') return { Notification: () => {} }
  if (name === 'markdown-it') {
    return class MarkdownIt {
      constructor() {
        this.renderer = { rules: {}, renderToken: () => '' }
      }
      render(text) {
        return text
      }
    }
  }
  if (name === 'simple-mind-map/example/exampleData') return {}
  if (name === 'simple-mind-map/src/utils/index') {
    return { throttle: fn => fn, isMobile: () => false }
  }
  if (name === 'simple-mind-map/src/utils') {
    return { getTextFromHtml: html => String(html || '').replace(/<[^>]+>/g, '') }
  }
  if (name === '@/utils/jobResultWriter') {
    return { writeJobResult: async () => ({ ok: true }), runJobWriteBack: async () => ({ ok: true }) }
  }
  if (name === '@/utils/mindmapRunPrompt') return {}
  if (name === '@/utils/workbuddyJobBridge') return bridgeStub
  return {}
}, mod, mod.exports)
const methods = (mod.exports.default && mod.exports.default.methods) || {}
if (!methods.prepareLocalTarget) throw new Error('拿不到 prepareLocalTarget')

function makeVm() {
  const vm = {
    jobHosts: [],
    jobHostKey: '',
    jobHostsLoading: false,
    jobHostsError: '',
    jobGateways: [],
    jobGateway: '',
    jobGatewaysError: '',
    jobHistory: [],
    jobHistoryLoading: false,
    jobHistoryError: '',
    jobStatus: '',
    jobStatusType: '',
    jobRunNodeUid: '',
    $message: Object.assign(() => {}, {
      warning: () => {},
      error: () => {},
      success: () => {}
    }),
    $bus: { $on: () => {}, $off: () => {}, $emit: () => {} }
  }
  Object.defineProperty(vm, 'jobSelectedHost', {
    get() {
      return this.jobHosts.find(item => item.key === this.jobHostKey) || null
    }
  })
  // 只 bind 需要的方法（loadJobHistory 在 job-history 测试里覆盖）
  vm.prepareLocalTarget = methods.prepareLocalTarget.bind(vm)
  vm.resetJobFullText = methods.resetJobFullText
    ? methods.resetJobFullText.bind(vm)
    : () => {}
  vm.jobHistory = []
  vm.loadJobHistory = async () => {
    calls.history += 1
    vm.jobHistory = []
    vm.jobHistoryError = ''
  }
  vm.loadJobGateways = methods.loadJobGateways.bind(vm)
  return vm
}

function host(ip, port, online, name) {
  return {
    ip,
    port,
    name: name || ip,
    online,
    self: ip === '127.0.0.1',
    manual: false,
    key: `${ip}:${port}`,
    url: `http://${ip}:${port}`,
    label: `${name || ip} · ${ip}:${port}`
  }
}

async function main() {
  // ---- 1. 本机在线 → 默认派给自己 ----
  resolveResult = {
    hosts: [host('192.168.1.114', 8799, true, 'DESKTOP'), host('127.0.0.1', 8799, true, '这台电脑')],
    hub: 'http://192.168.0.54:5000',
    error: ''
  }
  let vm = makeVm()
  await vm.prepareLocalTarget()
  check('本机在线：默认目标还是本机', vm.jobHostKey === LOCAL_KEY, vm.jobHostKey)
  check('本机在线：不报错', vm.jobHostsError === '')
  check('本机在线：顺带拉了会话列表', vm.jobGateway === 'http://127.0.0.1:50001', vm.jobGateway)

  // ---- 2. 本机离线 + 有在线主机 → 改成那台（不要卡死） ----
  resolveResult = {
    hosts: [host('192.168.1.114', 8799, true, 'DESKTOP'), host('127.0.0.1', 8799, false, '这台电脑')],
    hub: 'http://192.168.0.54:5000',
    error: ''
  }
  vm = makeVm()
  await vm.prepareLocalTarget()
  check(
    '本机桥接没跑：自动改选在线的别台电脑',
    vm.jobHostKey === '192.168.1.114:8799',
    vm.jobHostKey
  )
  check('有在线主机时不弹红字', vm.jobHostsError === '', vm.jobHostsError)
  check('选中的确实是主机列表里那台', vm.jobSelectedHost && vm.jobSelectedHost.online === true)

  // ---- 3. 本机离线 + 全都不在线 → 保持本机（好把「怎么起桥接」说清楚） ----
  resolveResult = {
    hosts: [host('127.0.0.1', 8799, false, '这台电脑'), host('192.168.0.230', 8799, false, 'LAPTOP')],
    hub: '',
    error: '连不上本机任务桥（http://127.0.0.1:8799）—— 这台电脑的桥接没在跑。'
  }
  // 本机桥接连不上时，会话列表这一路也会失败
  gatewayResult = {
    ok: false,
    gateways: [],
    error: '连不上本机任务桥（http://127.0.0.1:8799）—— 这台电脑的桥接没在跑。'
  }
  vm = makeVm()
  vm.jobGatewaysError = ''
  await vm.prepareLocalTarget()
  check('全都离线时：还选本机', vm.jobHostKey === LOCAL_KEY, vm.jobHostKey)
  check(
    '全都离线时：把原因原样留着给用户看',
    /桥接没在跑/.test(vm.jobHostsError),
    vm.jobHostsError
  )
  check(
    '没有可派会话时状态栏给的是原因',
    /桥接没在跑|没有可派/.test(vm.jobStatus),
    vm.jobStatus
  )
  gatewayResult = { ok: true, gateways: [{ url: 'http://127.0.0.1:50001', cwd: 'D:\\demo' }] }

  // ---- 4. 本机不在列表里（比如桥接根本没探测到） ----
  resolveResult = {
    hosts: [host('192.168.1.114', 8799, true, 'DESKTOP')],
    hub: 'http://192.168.0.54:5000',
    error: ''
  }
  vm = makeVm()
  await vm.prepareLocalTarget()
  check('列表里没有本机：选在线的那台', vm.jobHostKey === '192.168.1.114:8799', vm.jobHostKey)

  // ---- 5. 一台都没有 ----
  resolveResult = { hosts: [], hub: '', error: '没找到通讯页' }
  vm = makeVm()
  await vm.prepareLocalTarget()
  check('一台主机都没有：不炸、key 为空', vm.jobHostKey === '', JSON.stringify(vm.jobHostKey))
  check('一台都没有：错误信息保留', /没找到通讯页/.test(vm.jobHostsError), vm.jobHostsError)

  // ---- 6. resolveJobHosts 抛异常也不能把页面搞崩 ----
  resolveResult = null
  bridgeStub.resolveJobHosts = async () => {
    throw new Error('boom')
  }
  vm = makeVm()
  await vm.prepareLocalTarget()
  check('探测抛异常：兜住并提示', vm.jobHosts.length === 0 && /boom|读取失败/.test(vm.jobHostsError), vm.jobHostsError)
  bridgeStub.resolveJobHosts = async () => resolveResult

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
