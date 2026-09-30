/* eslint-env node */
/**
 * 运行按钮「转圈范围」单测。
 *
 * 用户反馈（2026-09-30）：「点击运行按钮 不要整个按钮都旋转」。
 *
 * 原因：loading 类（`el-icon-loading` 自带 rotating 动画）以前**直接挂在 `.icon` 上**，
 * 而 `.icon` 是个 26px 的白底圆角方块 —— 于是整块连边框一起转，看着像按钮坏了。
 * 正确写法：`.icon` 里再套一层 `<i>`，转圈只发生在 `<i>` 上。
 *
 * 结构说明（合并 main 之后）：顶部工具栏的文件类按钮（刷新 / 运行 / 分享 / 导出 …）
 * 已由 Toolbar.vue 的 `fileToolbarActions` 数据驱动，统一交给 ToolbarFileBtnList.vue 渲染，
 * Toolbar.vue 模板里不再有 data-testid="run-workbuddy-job" 的字面元素。所以这里：
 *   1. 用 vue-template-compiler 解析 ToolbarFileBtnList.vue 的**真模板 AST / render 代码**，
 *      断言类绑定落在内层 <i> 上、.icon 只有静态 class、按钮挂 busy 类；
 *   2. 检查 Toolbar.vue 里「运行」这条 action 数据：runIcon 类名、按 jobDispatching
 *      切 loading / 播放图标、busy 跟着 jobDispatching；
 *   3. 检查 ToolbarFileBtnList.vue 的样式：<i> inline-block、.busy 两套主题都拉回文字色。
 */
const fs = require('fs')
const path = require('path')
const compiler = require('vue-template-compiler')

const results = []
function check(name, ok, extra = '') {
  results.push({ name, ok: !!ok, extra })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  → ${extra}` : ''}`)
}

const DIR = path.join(__dirname, '..', 'src/pages/Edit/components')
const TOOLBAR = path.join(DIR, 'Toolbar.vue')
const LIST = path.join(DIR, 'ToolbarFileBtnList.vue')
const toolbarSrc = fs.readFileSync(TOOLBAR, 'utf8')
const listSrc = fs.readFileSync(LIST, 'utf8')

// ---- AST 工具 ----
const attrsOf = el => {
  const map = Object.assign({}, (el && el.attrsMap) || {})
  ;((el && el.attrs) || []).forEach(a => {
    if (!(a.name in map)) map[a.name] = a.value
  })
  return map
}
/** 类绑定（静态 class 与 :class 合并成一条文本，方便断言） */
const classBindingOf = el => {
  if (!el) return ''
  const map = attrsOf(el)
  const dynVal = map[':class'] || map['v-bind:class'] || ''
  return `${map.class || ''} ${dynVal}`.trim()
}
function walk(node, visit, seen) {
  // ifConditions[].block 会指回节点自身（v-if 的 AST 结构），不去重就无限递归
  const visited = seen || new Set()
  if (!node || typeof node !== 'object' || visited.has(node)) return
  visited.add(node)
  visit(node)
  ;(node.children || []).forEach(child => walk(child, visit, visited))
  ;(node.ifConditions || []).forEach(c => walk(c.block, visit, visited))
}

// ---- 1. Toolbar.vue：模板能编译，文件类按钮交给 ToolbarFileBtnList ----
const toolbarSfc = compiler.parseComponent(toolbarSrc)
check('Toolbar.vue 解析出 SFC 模板', !!(toolbarSfc.template && toolbarSfc.template.content))
const toolbarCompiled = compiler.compile(toolbarSfc.template.content, { comments: true })
check('Toolbar.vue 模板编译无错误', !toolbarCompiled.errors.length, toolbarCompiled.errors.join('; '))
let fileListUses = 0
walk(toolbarCompiled.ast, el => {
  if (el.tag === 'ToolbarFileBtnList' && /fileHorizontalActions|fileVerticalActions/.test(attrsOf(el)[':list'] || '')) fileListUses++
})
check('Toolbar.vue 用 ToolbarFileBtnList 渲染文件类按钮（运行按钮在其中）', fileListUses >= 1, String(fileListUses))

// ---- 2. Toolbar.vue：「运行」action 数据 ----
const script = (toolbarSfc.script && toolbarSfc.script.content) || ''
/** 取出 actions.push({ ... key: '<key>' ... }) 的对象字面量文本 */
function actionOf(key) {
  const re = /actions\.push\(\s*\{/g
  let m
  while ((m = re.exec(script))) {
    let depth = 0
    let i = m.index + m[0].length - 1
    const start = i
    for (; i < script.length; i++) {
      if (script[i] === '{') depth++
      else if (script[i] === '}' && --depth === 0) break
    }
    const body = script.slice(start, i + 1)
    if (new RegExp(`\\bkey:\\s*'${key}'`).test(body)) return body
  }
  return ''
}
const runAction = actionOf('run')
check('找得到运行 action（key: run）', !!runAction)
check('运行 action 的 testId 仍是 run-workbuddy-job', /testId:\s*'run-workbuddy-job'/.test(runAction))
check(
  '运行 action 按 jobDispatching 切 loading / 播放图标',
  /icon:\s*this\.jobDispatching\s*\?\s*'el-icon-loading'\s*:\s*'el-icon-video-play'/.test(runAction)
)
check('转圈元素带独立类名（iconClass: runIcon）', /iconClass:\s*'runIcon'/.test(runAction))
check('派发中挂 busy（busy: this.jobDispatching）', /busy:\s*this\.jobDispatching\b/.test(runAction))
check('按钮文字仍是「运行」（不随状态变字）', /label:\s*'运行'/.test(runAction))
const refreshAction = actionOf('refresh')
check('刷新 action 同样按状态切 loading（对照）', /el-icon-loading/.test(refreshAction) && /el-icon-refresh/.test(refreshAction))

// ---- 3. ToolbarFileBtnList.vue：类绑定落点 ----
const listSfc = compiler.parseComponent(listSrc)
check('ToolbarFileBtnList.vue 解析出 SFC 模板', !!(listSfc.template && listSfc.template.content))
const listCompiled = compiler.compile(listSfc.template.content, { comments: true })
check('ToolbarFileBtnList.vue 模板编译无错误', !listCompiled.errors.length, listCompiled.errors.join('; '))

let btn = null
walk(listCompiled.ast, el => {
  if (!btn && el.for && /\btoolbarBtn\b/.test(classBindingOf(el))) btn = el
})
check('找得到 v-for 渲染的 .toolbarBtn', !!btn)
const btnCls = classBindingOf(btn)
check('按钮 :class 带 busy（按 item.busy）', /busy:\s*item\.busy/.test(btnCls), btnCls)
check('按钮 data-testid 透传 item.testId', !!btn && attrsOf(btn)[':data-testid'] === 'item.testId')

const span = btn && (btn.children || []).find(c => c.type === 1 && /\bicon\b/.test(classBindingOf(c)))
check('.icon 是个独立容器', !!span, span && classBindingOf(span))
const spanAttrs = attrsOf(span)
check(
  '.icon 上**没有**动态类绑定（loading 类不再挂在外层方块上，方块不转）',
  !!span && !spanAttrs[':class'] && !spanAttrs['v-bind:class'],
  span && classBindingOf(span)
)
const icon = span && (span.children || []).find(c => c.type === 1 && (c.tag === 'i' || c.tag === 'em'))
check('图标是 .icon 里的 <i> 元素', !!icon, icon && icon.tag)
const iCls = classBindingOf(icon)
check('<i> 上绑定 item.icon（loading / 播放图标落在这里）', /item\.icon\b/.test(iCls), iCls)
check('<i> 上绑定 item.iconClass（runIcon 落在这里）', /item\.iconClass\b/.test(iCls), iCls)

const renderCode = listCompiled.render || ''
check(
  'render 代码：.icon 的 span 只有静态 class（外层方块不会被动画带走）',
  /_c\('span',\s*\{\s*staticClass:\s*"icon"\s*\}/.test(renderCode),
  (renderCode.match(/_c\('span',\s*\{\s*staticClass:\s*"icon"\s*\}/) || [''])[0]
)
check(
  'render 代码：item.icon 挂在内层 <i> 上',
  /_c\('i',\s*\{\s*class:[^}]*item\.icon\b/.test(renderCode)
)

// ---- 4. ToolbarFileBtnList.vue：样式 ----
const scoped = (listSfc.styles.find(s => s.scoped) || {}).content || ''
check(
  '样式给 .icon 里的 <i> 设了 display:inline-block（动画生效前提，别删）',
  /\.icon\s*\{[\s\S]{0,900}?\bi\s*\{[\s\S]{0,160}?display:\s*inline-block/.test(scoped)
)
check(
  '样式里没有把旋转动画加在 .icon 方块上的规则',
  !/\.icon[^{]*\{[^}]*animation/.test(scoped) && !/\.icon[^{]*\{[^}]*rotat/i.test(scoped)
)
check('派发中（.busy）只高亮图标方块、不动画', /&\.busy\s*\{[\s\S]{0,200}?\.icon\s*\{/.test(scoped))
check(
  '派发中把文字颜色也拉回来（.disabled 的灰会让「运行」两字看不见）—— 两套主题各一条',
  (scoped.match(/&\.busy\s*\{\s*color\s*:/g) || []).length >= 2,
  String((scoped.match(/&\.busy\s*\{\s*color\s*:/g) || []).length)
)

const failed = results.filter(item => !item.ok)
console.log(
  `\n共 ${results.length} 项，通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`
)
if (failed.length) {
  failed.forEach(item => console.log('  FAIL:', item.name))
  process.exit(1)
}
