/* eslint-env node */
/* global globalThis */
/**
 * 「运行」用哪条通道执行 —— 2026-10-08 用户要求：
 *
 *   「把运行弹窗选择用什么跑 放到右侧栏的设置里面的AI执行引擎 可以下拉选择
 *    点运行就直接按照设置的运行了 就不用弹窗」
 *
 * 断言三件事：
 *   A. utils/runChannel.js：默认助理、只认两条、落盘/读回、label（真模块，行为级）
 *   B. Setting.vue：AI 执行引擎那一行换成下拉（绑 runChannel），改动能落盘
 *   C. Toolbar.vue：运行弹窗已拆掉，点运行直接按设置分叉
 *
 * 做法照 web/tests/job-history.component.test.cjs：vue-template-compiler 拆 SFC
 * → babel 转 CJS → require stub 加载 → methods bind 到手写 vm 上跑。
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

const localStore = new Map()
globalThis.localStorage = {
  getItem: k => (localStore.has(k) ? localStore.get(k) : null),
  setItem: (k, v) => localStore.set(k, String(v)),
  removeItem: k => localStore.delete(k),
  clear: () => localStore.clear()
}

function loadCjs(file, stub) {
  const src = fs.readFileSync(file, 'utf8')
  const { code } = babel.transformSync(src, {
    babelrc: false,
    configFile: false,
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
  })
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', code)(stub || (() => ({})), mod, mod.exports)
  return mod.exports
}

// ============ A. 真模块：utils/runChannel.js ============
console.log('--- A. 运行通道取值/落盘 ---')
const rc = loadCjs(path.join(WEB, 'src/utils/runChannel.js'))
check('默认是助理（WorkBuddy）', rc.RUN_CHANNEL_DEFAULT === 'openclaw')
check(
  '只提供两条通道、且默认那条排第一',
  rc.RUN_CHANNEL_OPTIONS.length === 2 &&
    rc.RUN_CHANNEL_OPTIONS[0].value === 'openclaw' &&
    rc.RUN_CHANNEL_OPTIONS[1].value === 'bridge',
  JSON.stringify(rc.RUN_CHANNEL_OPTIONS.map(o => o.value))
)
localStore.clear()
check('没存过 → 读出来是默认', rc.readRunChannel() === 'openclaw', rc.readRunChannel())
check('写桥接 → 读回桥接', rc.writeRunChannel('bridge') === 'bridge' && rc.readRunChannel() === 'bridge')
check('非法值落盘时归一化成默认', rc.writeRunChannel('乱写的') === 'openclaw' && rc.readRunChannel() === 'openclaw')
localStore.set('mindmap:runChannel', 'openclaw')
check('与旧 key 兼容（mindmap:runChannel）', rc.readRunChannel() === 'openclaw')
check(
  'label 能对上',
  rc.runChannelLabel('bridge') === '桥接（执行机的 WorkBuddy）' &&
    rc.runChannelLabel('openclaw') === '助理（WorkBuddy）',
  rc.runChannelLabel('bridge')
)

// 并行上限（2026-10-08：助理实测能真并行，前端按这个数封顶）
localStore.clear()
check('并行上限默认 3', rc.readRunConcurrency() === 3, String(rc.readRunConcurrency()))
check(
  '选项是 1~6',
  rc.RUN_CONCURRENCY_OPTIONS.join(',') === '1,2,3,4,5,6',
  rc.RUN_CONCURRENCY_OPTIONS.join(',')
)
check(
  '写 5 → 读回 5',
  rc.writeRunConcurrency(5) === 5 && rc.readRunConcurrency() === 5,
  String(rc.readRunConcurrency())
)
check(
  '越界归一：0 → 默认 3、99 → 封顶 6、乱写 → 默认 3',
  rc.writeRunConcurrency(0) === 3 &&
    rc.writeRunConcurrency(99) === 6 &&
    rc.writeRunConcurrency('乱写') === 3
)
localStore.clear()

// ============ B. Setting.vue：AI 执行引擎换成下拉 ============
console.log('--- B. 设置面板 ---')
const settingSrc = fs.readFileSync(
  path.join(WEB, 'src/pages/Edit/components/Setting.vue'),
  'utf8'
)
const settingParsed = compiler.parseComponent(settingSrc)
assert.deepEqual(compiler.compile(settingParsed.template.content).errors, [])
const settingTpl = settingParsed.template.content
check('设置里有「AI 执行引擎」', /AI 执行引擎/.test(settingTpl))
check(
  '它是可下拉的 el-select 且绑到 runChannel',
  /<el-select[\s\S]{0,200}v-model="runChannel"/.test(settingTpl) &&
    /@change="onRunChannelChange"/.test(settingTpl)
)
check(
  '下拉选项来自统一的通道清单（不再是写死的纯文本）',
  /v-for="item in runChannelOptions"/.test(settingTpl) &&
    /:value="item.value"/.test(settingTpl) &&
    !/<span class="value">助理/.test(settingTpl)
)
check(
  '选项说明跟着当前通道变',
  /runChannelTip/.test(settingTpl)
)

const settingComponent = mod_setting()
function mod_setting() {
  const { code } = babel.transformSync(settingParsed.script.content, {
    babelrc: false,
    configFile: false,
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
  })
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', code)(
    name => {
      if (name === 'vuex') return { mapState: () => ({}), mapMutations: () => ({}) }
      if (name === './Sidebar.vue') return {}
      if (name === './Color.vue') return {}
      if (name === '@/api') return { storeConfig: async () => ({}), storeData: async () => ({}) }
      if (name === '@/utils/agentChat') {
        return {
          fetchWorkbuddyModels: async () => [],
          checkWorkbuddyRaw: async () => ({ ok: true }),
          fetchXiaoceOrganizations: async () => [],
          fetchXiaoceAgents: async () => [],
          AI_BACKEND_WORKBUDDY: 'workbuddy',
          AI_BACKEND_XIAOCE: 'xiaoce'
        }
      }
      if (name === '@/utils/runChannel') return rc
      return {}
    },
    mod,
    mod.exports
  )
  return mod.exports.default
}

check(
  '组件里真的 import 了统一模块（同一份 key）',
  /from ['"]@\/utils\/runChannel['"]/.test(settingParsed.script.content)
)
const settingMethods = settingComponent.methods || {}
check('有 onRunChannelChange 方法', typeof settingMethods.onRunChannelChange === 'function')
const toast = []
const fakeSetting = {
  runChannel: 'openclaw',
  $message: { success: m => toast.push(m) }
}
settingMethods.onRunChannelChange.call(fakeSetting, 'bridge')
check(
  '设置里改成桥接 → 立刻落盘（点运行就按它走）',
  localStore.get('mindmap:runChannel') === 'bridge' && fakeSetting.runChannel === 'bridge',
  localStore.get('mindmap:runChannel')
)
check('给了反馈提示', toast.length === 1 && /桥接/.test(toast[0]), String(toast[0]))
check(
  'computed 里那行说明跟着通道走',
  /执行机|WorkBuddy/.test(
    String(settingComponent.computed.runChannelTip.call({ runChannel: 'bridge' }))
  ) &&
    /流式|导图/.test(
      String(settingComponent.computed.runChannelTip.call({ runChannel: 'openclaw' }))
    )
)

// 「并行任务数」：只在助理通道显示，改了立刻落盘
check(
  '设置里有「并行任务数」下拉（只在助理通道显示）',
  /并行任务数/.test(settingTpl) &&
    /v-model="runConcurrency"/.test(settingTpl) &&
    /runChannel === RUN_CHANNEL_OPENCLAW/.test(settingTpl)
)
check(
  '有 onRunConcurrencyChange 方法',
  typeof settingMethods.onRunConcurrencyChange === 'function'
)
const fakeConcurrency = { runConcurrency: 3, $message: { success: () => {} } }
settingMethods.onRunConcurrencyChange.call(fakeConcurrency, 5)
check(
  '并发数改完立刻落盘（下一次点运行就按它）',
  localStore.get('mindmap:runConcurrency') === '5' && fakeConcurrency.runConcurrency === 5,
  localStore.get('mindmap:runConcurrency')
)
localStore.clear()

// ============ C. Toolbar.vue：弹窗拆了 ============
console.log('--- C. 工具栏（不再弹窗）---')
const toolbarSrc = fs.readFileSync(
  path.join(WEB, 'src/pages/Edit/components/Toolbar.vue'),
  'utf8'
)
const toolbarParsed = compiler.parseComponent(toolbarSrc)
assert.deepEqual(compiler.compile(toolbarParsed.template.content).errors, [])
check(
  '运行弹窗的模板已删除',
  !/用哪种方式执行/.test(toolbarParsed.template.content) &&
    !/runChannelBox/.test(toolbarParsed.template.content)
)
check(
  '弹窗的样式也删了（没留死代码）',
  !/runChannelBox|runChannelRadio/.test(toolbarParsed.styles.map(s => s.content).join('\n'))
)
check(
  '工具栏改成读设置（不再自选）',
  /import\s*\{[\s\S]{0,200}readRunChannel[\s\S]{0,80}\}\s*from\s*'@\/utils\/runChannel'/.test(
    toolbarParsed.script.content
  ) && /this\.recallRunChannel\(\)/.test(toolbarParsed.script.content)
)

localStore.clear()
const toolbar = loadToolbar()
function loadToolbar() {
  const { code } = babel.transformSync(toolbarParsed.script.content, {
    babelrc: false,
    configFile: false,
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
  })
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', code)(
    name => {
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
      if (name === 'simple-mind-map/src/utils/index') return { throttle: fn => fn, isMobile: () => false }
      if (name === 'simple-mind-map/src/utils') {
        return { getTextFromHtml: html => String(html || '').replace(/<[^>]+>/g, '') }
      }
      if (name === '@/utils/runChannel') return rc
      return {}
    },
    mod,
    mod.exports
  )
  return mod.exports.default
}
const toolbarMethods = (toolbar && toolbar.methods) || {}
check('工具栏没有 pickRunChannel 了', typeof toolbarMethods.pickRunChannel !== 'function')
check('工具栏没有 confirmRunChannel 了', typeof toolbarMethods.confirmRunChannel !== 'function')
const fakeToolbar = {}
const read = toolbarMethods.recallRunChannel.call(fakeToolbar)
check('工具栏读到的就是设置里存的那条', read === 'openclaw' || read === 'bridge', read)
const titleFn = toolbar.computed && toolbar.computed.runButtonTitle
check(
  '运行按钮提示里写清用哪个执行引擎',
  typeof titleFn === 'function' &&
    /执行引擎|按设置/.test(String(titleFn.call({ recallRunChannel: () => 'bridge', jobGeneralization: null })))
)

const failed = results.filter(item => !item.ok)
console.log(
  `\n共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`
)
if (failed.length) {
  failed.forEach(item => console.log('  FAIL:', item.name))
  process.exit(1)
}
