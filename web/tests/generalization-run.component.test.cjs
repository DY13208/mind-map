/**
 * 点概要 → 再点「运行」= 接着这条概要继续执行（不是重跑 SOP）—— Toolbar 方法级单测。
 *
 * 做法照 web/tests/contextmenu.component.test.cjs：vue-template-compiler 拆 SFC
 * → babel 转 CJS → 用 require stub 加载 → 把 methods bind 到手写的 mock vm 上跑。
 */
const assert = require('assert').strict
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

// ---- 真实现：jobResultWriter（占位文案判断）+ mindmapRunPrompt（任务内容组装）----
const jobWriter = loadCjs(path.join(WEB, 'src/utils/jobResultWriter.js'), name => {
  if (name === './nodeAttachmentApi') return { uploadNodeAttachment: async () => ({}) }
  if (name === './flowExpandPrompt') return { nodeUid: n => (n && n.getData('uid')) || '' }
  return {}
})
const runPrompt = loadCjs(path.join(WEB, 'src/utils/mindmapRunPrompt.js'), () => ({}))

// ---- Toolbar.vue ----
const toolbarSrc = fs.readFileSync(
  path.join(WEB, 'src/pages/Edit/components/Toolbar.vue'),
  'utf8'
)
const parsed = compiler.parseComponent(toolbarSrc)
assert.deepEqual(compiler.compile(parsed.template.content).errors, [])

const dispatched = []
/** 概要最新文字：Edit 侧 hold generalization 数据，测试里随时改 */
const genStore = { text: '' }
const bridgeStub = {
  resolveJobHosts: async () => ({
    hosts: [
      {
        key: '127.0.0.1:8799',
        ip: '127.0.0.1',
        port: 8799,
        label: '这台电脑',
        online: true
      }
    ],
    defaultHost: { key: '127.0.0.1:8799' }
  }),
  listHostGateways: async () => ({
    ok: true,
    gateways: [{ url: 'http://127.0.0.1:50323', cwd: 'D:\\良策0010', title: 'T' }]
  }),
  listHostJobs: async () => ({ ok: true, jobs: [] }),
  stopHostJob: async () => ({ ok: true }),
  fetchJobTranscript: async () => ({ ok: true, text: '' }),
  fetchJobArtifacts: async () => ({ ok: true, files: [] }),
  attachFilesViaBridge: async () => ({ ok: false, error: 'stub' }),
  describeEmptyGateways: () => '',
  dispatchWorkbuddyJob: async args => {
    dispatched.push(args)
    return { ok: true, job: { id: 'job-' + dispatched.length } }
  }
}

const { code } = babel.transformSync(parsed.script.content, {
  babelrc: false,
  configFile: false,
  plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
})
const mod = { exports: {} }
new Function('require', 'module', 'exports', code)(name => {
  if (name === 'vuex') return { mapState: () => ({}) }
  if (name === 'element-ui') return { Notification: () => {} }
  if (name === 'markdown-it') {
    return class MarkdownIt {
      constructor() {
        this.renderer = { rules: {}, renderToken: () => '' }
      }
      render(t) {
        return t
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
  if (name === '@/utils/jobResultWriter') return jobWriter
  if (name === '@/utils/mindmapRunPrompt') return runPrompt
  if (name === '@/utils/workbuddyJobBridge') return bridgeStub
  return {}
}, mod, mod.exports)
const component = mod.exports.default
check('Toolbar 模板编译无错', true)

// ---- mock 节点 ----
function makeNode(text, data = {}, extra = {}) {
  const store = {
    text,
    uid: extra.uid || 'uid-' + Math.random().toString(16).slice(2),
    ...data
  }
  return {
    isGeneralization: !!extra.isGeneralization,
    children: extra.children || [],
    parent: extra.parent || null,
    getData: key => (key ? store[key] : store),
    setData: patch => Object.assign(store, patch)
  }
}

function makeVm(overrides = {}) {
  const events = []
  const messages = []
  const vm = {
    activeNodes: [],
    jobDispatching: false,
    jobFollowDispatching: false,
    isReadonly: false,
    jobGatewayCwd: 'D:\\良策0010',
    jobRunNodeUid: '',
    jobRunNodeTitle: '',
    jobHosts: [],
    jobHostKey: '',
    jobGateways: [],
    jobGateway: '',
    jobHostsError: '',
    jobGatewaysError: '',
    jobPending: null,
    jobPendingPrompt: '',
    jobCurrentId: '',
    jobActiveId: '',
    jobWrittenJobId: '',
    jobWriteBusy: false,
    jobWriteState: '',
    jobWriteError: '',
    jobFullText: '',
    jobHistory: [],
    jobHistoryVisible: false,
    jobGeneralization: null,
    $route: { query: { room: 'room-6un1oxbk' } },
    $bus: {
      $emit: (...args) => {
        events.push(args)
        const [evt, payload] = args
        if (evt === 'create_job_container' && payload && payload.result) {
          payload.result.ok = true
          payload.result.uid = 'container-9'
          payload.result.title = '任务 · 09-23 11:40'
          payload.result.promise = Promise.resolve(payload.result)
        }
        if (evt === 'read_generalization' && payload && payload.result) {
          payload.result.ok = true
          payload.result.text = genStore.text
          payload.result.promise = Promise.resolve(payload.result)
        }
      },
      $on: () => {},
      $off: () => {}
    },
    $message: {
      info: m => messages.push(['info', m]),
      warning: m => messages.push(['warning', m]),
      success: m => messages.push(['success', m]),
      error: m => messages.push(['error', m])
    },
    $nextTick: fn => fn(),
    events,
    messages,
    ...overrides
  }
  Object.entries(component.methods).forEach(([key, fn]) => {
    vm[key] = fn.bind(vm)
  })
  Object.defineProperty(vm, 'jobSelectedHost', {
    get: () => vm.jobHosts.find(h => h.key === vm.jobHostKey) || null,
    configurable: true
  })
  // 用组件里真的 computed，别在测试里重写一份
  ;['activeJobNode', 'runButtonTitle'].forEach(key => {
    if (component.computed && component.computed[key]) {
      Object.defineProperty(vm, key, {
        get: () => component.computed[key].call(vm),
        configurable: true
      })
    }
  })
  return vm
}

const OWNER = makeNode('D：刘欢：招聘', {}, { uid: 'owner-1' })
const OTHER = makeNode('渠道执行', {}, { uid: 'owner-2' })
const GEN_WRITTEN = makeNode('接着把投放计划细化到周，并给出预算分配', { range: [0, 1] }, {
  uid: 'gen-2',
  isGeneralization: true
})
GEN_WRITTEN.generalizationBelongNode = OWNER
const GEN_EMPTY = makeNode(jobWriter.FOLLOW_UP_PLACEHOLDER, { range: [0, 1] }, {
  uid: 'gen-1',
  isGeneralization: true
})
GEN_EMPTY.generalizationBelongNode = OWNER
const GEN_ORPHAN = makeNode('没有所属节点', {}, {
  uid: 'gen-9',
  isGeneralization: true
})

async function main() {
  // ---- 1. 点概要不再直接派发 ----
  dispatched.length = 0
  let vm = makeVm()
  vm.activeNodes = [OWNER]
  vm.onJobNodeClick(GEN_WRITTEN)
  check('点概要不会立刻派发', dispatched.length === 0)
  check(
    '点概要只记下「按这条继续」',
    !!vm.jobGeneralization &&
      vm.jobGeneralization.ownerUid === 'owner-1' &&
      vm.jobGeneralization.genUid === 'gen-2',
    JSON.stringify(vm.jobGeneralization)
  )
  check(
    '并提示去点运行',
    vm.messages.some(m => m[0] === 'success' && m[1].includes('点「运行」')),
    JSON.stringify(vm.messages.map(m => m[0]))
  )
  check(
    '运行按钮提示变成「接着…继续执行」',
    /继续执行/.test(vm.runButtonTitle) && vm.runButtonTitle.includes('刘欢'),
    vm.runButtonTitle
  )

  // ---- 2. 点普通节点不记录 ----
  vm = makeVm()
  vm.onJobNodeClick(OTHER)
  check('点普通节点不记录概要', vm.jobGeneralization === null && vm.messages.length === 0)

  // ---- 3. 点了概要再点运行 = 继续执行（用概要文字，落在所属节点）----
  dispatched.length = 0
  genStore.text = '接着把投放计划细化到周，并给出预算分配'
  vm = makeVm()
  vm.activeNodes = [OWNER]
  vm.onJobNodeClick(GEN_WRITTEN)
  await vm.runWorkbuddyJob()
  const containerEvt = vm.events.find(a => a[0] === 'create_job_container')
  check('点运行派发了一次', dispatched.length === 1, JSON.stringify(dispatched[0] && dispatched[0].name))
  check(
    '任务内容用概要里写的「下一步」',
    dispatched[0].prompt.startsWith('接着把投放计划细化到周') &&
      dispatched[0].prompt.includes('【背景 · 脑图当前节点】'),
    dispatched[0].prompt.split('\n')[0]
  )
  check(
    '落点是概要所属的节点（不是概要）',
    !!containerEvt && containerEvt[1].nodeUid === 'owner-1',
    JSON.stringify(containerEvt && containerEvt[1].nodeUid)
  )
  check('任务名标出这是继续执行', /继续$/.test(dispatched[0].name), dispatched[0].name)

  // ---- 4. 运行时现取概要最新文字（双击改完文字再点运行，用的是新文字）----
  dispatched.length = 0
  genStore.text = '改成：先算预算上限，再排周计划'
  vm = makeVm()
  vm.activeNodes = [OWNER]
  vm.onJobNodeClick(GEN_WRITTEN)
  await vm.runWorkbuddyJob()
  check(
    '用的是概要当下的文字（不是点时的快照）',
    dispatched[0].prompt.startsWith('改成：先算预算上限'),
    dispatched[0].prompt.split('\n')[0]
  )

  // ---- 5. 概要还没写内容：按节点默认任务跑，并提示怎么写 ----
  dispatched.length = 0
  genStore.text = jobWriter.FOLLOW_UP_PLACEHOLDER
  vm = makeVm()
  vm.activeNodes = [OWNER]
  vm.onJobNodeClick(GEN_EMPTY)
  check(
    '占位概要点了也给提示（写「下一步」或直接跑默认）',
    vm.messages.some(m => m[0] === 'info' && m[1].includes('双击概要')),
    JSON.stringify(vm.messages.map(m => m[0]))
  )
  await vm.runWorkbuddyJob()
  check(
    '占位概要 → 点运行走节点默认任务',
    dispatched.length === 1 && dispatched[0].prompt.includes('【脑图流程的一步'),
    dispatched[0].prompt.split('\n')[0]
  )
  check('默认任务名不带「继续」', !/继续$/.test(dispatched[0].name), dispatched[0].name)

  // ---- 6. 点过概要后换到别的节点：自动失效，走默认 ----
  dispatched.length = 0
  genStore.text = '接着把投放计划细化到周'
  vm = makeVm()
  vm.activeNodes = [OTHER]
  vm.onJobNodeClick(GEN_WRITTEN) // 记的是 owner-1
  await vm.runWorkbuddyJob()
  check(
    '换节点后概要自动失效，按新节点默认任务跑',
    dispatched.length === 1 &&
      dispatched[0].prompt.includes('【脑图流程的一步') &&
      /渠道执行/.test(dispatched[0].name),
    dispatched[0].name
  )

  // ---- 7. 没有所属节点的概要：不记录 ----
  vm = makeVm()
  vm.onJobNodeClick(GEN_ORPHAN)
  check('孤儿概要不记录', vm.jobGeneralization === null)

  // ---- 8. 概要点被选中时不能当落点 ----
  vm = makeVm({ activeNodes: [GEN_WRITTEN], jobGeneralization: null })
  check('概要被选中时 currentRunNodeUid 返回空', vm.currentRunNodeUid() === '')
  check('概要被选中时 activeJobNode 为空', vm.activeJobNode === null)

  // ---- 9. 只读态不记录 ----
  vm = makeVm({ isReadonly: true })
  vm.onJobNodeClick(GEN_WRITTEN)
  check('只读态点概要无反应', vm.jobGeneralization === null && vm.messages.length === 0)

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
