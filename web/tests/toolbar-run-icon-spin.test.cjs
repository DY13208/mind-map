/* eslint-env node */
/**
 * 运行按钮「转圈范围」单测。
 *
 * 用户反馈（2026-09-30）：「点击运行按钮 不要整个按钮都旋转」。
 *
 * 原因：loading 类（`el-icon-loading` 自带 rotating 动画）以前**直接挂在 `.icon` 上**，
 * 而 `.icon` 是个 26px 的白底圆角方块 —— 于是整块连边框一起转，看着像按钮坏了。
 * 正确写法（刷新按钮一直是对的）：`.icon` 里再套一层 `<i>`，转圈只发生在 `<i>` 上。
 *
 * 断言用 vue-template-compiler 解析 SFC 的**真模板 AST**，盯住类绑定的落点，
 * 而不是正则匹配源码文本（源码排版一变就失效）。再对样式块做两条关键检查：
 * 转圈元素必须 `display: inline-block`（否则 transform 动画不生效）。
 */
const fs = require('fs')
const path = require('path')
const compiler = require('vue-template-compiler')

const results = []
function check(name, ok, extra = '') {
  results.push({ name, ok: !!ok, extra })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  → ${extra}` : ''}`)
}

const FILE = path.join(__dirname, '..', 'src/pages/Edit/components/Toolbar.vue')
const src = fs.readFileSync(FILE, 'utf8')
const sfc = compiler.parseComponent(src)

check('解析出 SFC 模板', !!(sfc.template && sfc.template.content))
const compiled = compiler.compile(sfc.template.content, { comments: true })
check('模板编译无错误', !compiled.errors.length, compiled.errors.join('; '))

// ---- 遍历 AST ----
// 注意：compile() 之后 children 上的 attrsList 是空的，属性落在 attrsMap
// （原始名，保留 `:class`）与 attrs（规范化为 {name:'class', dynamic:true}）里。
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
  const dyn = ((el && el.attrs) || []).find(a => a.name === 'class' && a.dynamic)
  const dynVal =
    (dyn && dyn.value) || map[':class'] || map['v-bind:class'] || ''
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

const byTestId = {}
walk(compiled.ast, el => {
  const id = attrsOf(el)['data-testid']
  if (id) byTestId[id] = el
})

const runBtn = byTestId['run-workbuddy-job']
const refreshBtn = byTestId.refresh
check('找得到运行按钮（data-testid=run-workbuddy-job）', !!runBtn)
check('找得到刷新按钮（data-testid=refresh）', !!refreshBtn)

/** 取按钮里承载图标的那个 span（.icon），以及它内部的 <i> */
function iconParts(btn) {
  if (!btn) return { span: null, i: null }
  const span = (btn.children || []).find(
    c => c.type === 1 && /\bicon\b/.test(classBindingOf(c))
  )
  const i =
    span &&
    (span.children || []).find(
      c => c.type === 1 && (c.tag === 'i' || c.tag === 'em')
    )
  return { span, i }
}

// ---- 运行按钮：转圈只能在 <i> 上 ----
const run = iconParts(runBtn)
check('运行按钮里 .icon 是个独立容器', !!run.span, run.span && classBindingOf(run.span))
check(
  '.icon 上**没有**类绑定（loading 类不再挂在外层方块上，方块不转）',
  !!run.span && !classBindingOf(run.span).includes('el-icon-loading') &&
    !/jobDispatching/.test(classBindingOf(run.span)),
  run.span && classBindingOf(run.span)
)
check('运行按钮的图标是 <i> 元素', !!run.i, run.i && run.i.tag)
const runICls = classBindingOf(run.i)
check(
  '<i> 上按 jobDispatching 切 loading / 播放图标',
  /jobDispatching/.test(runICls) &&
    runICls.includes('el-icon-loading') &&
    runICls.includes('el-icon-video-play'),
  runICls
)
check(
  '转圈元素带独立类名（runIcon，便于识别与样式覆盖）',
  !!run.i && /\brunIcon\b/.test(runICls),
  runICls
)

// 整棵运行按钮子树里，只有 <i> 这一处能拿到 loading
let loadingOwners = []
walk(runBtn, el => {
  if (classBindingOf(el).includes('el-icon-loading')) loadingOwners.push(el.tag)
})
check(
  '运行按钮子树里 loading 只挂在一处，且是内层图标',
  loadingOwners.length === 1 && (loadingOwners[0] === 'i' || loadingOwners[0] === 'em'),
  JSON.stringify(loadingOwners)
)

// ---- 渲染级证据：编译出的 render 代码，类到底挂在谁身上 ----
const renderCode = compiled.render || ''
check(
  'render 代码：.icon 的 span 只有静态 class（外层方块不会被动画带走）',
  /_c\('span',\s*\{\s*staticClass:\s*"icon"\s*\}/.test(renderCode),
  (renderCode.match(/_c\('span',\s*\{\s*staticClass:\s*"icon"\s*\}/) || [''])[0]
)
check(
  'render 代码：loading 类挂在内层 <i class="runIcon"> 上',
  /_c\('i',\s*\{[^}]*runIcon[^}]*el-icon-loading/.test(renderCode)
)

// ---- 刷新按钮：同样的写法（对照，防以后又被合并回外层） ----
const ref = iconParts(refreshBtn)
check(
  '刷新按钮也是 .icon 包一层 <i>（两处写法一致，别再退回去）',
  !!ref.i && !classBindingOf(ref.span).includes('el-icon-loading'),
  ref.i && classBindingOf(ref.i)
)

// ---- 样式：转圈元素必须 inline-block ----
const scoped = (sfc.styles.find(s => s.scoped) || {}).content || ''
check(
  '样式给 .icon 里的 <i> 设了 display:inline-block（动画生效前提，别删）',
  /\.icon\s*\{[\s\S]{0,900}?\bi\s*\{[\s\S]{0,160}?display:\s*inline-block/.test(scoped)
)
check(
  '样式里没有把旋转动画加在 .icon 方块上的规则',
  !/\.icon[^{]*\{[^}]*animation/.test(scoped) &&
    !/\.icon[^{]*\{[^}]*rotat/i.test(scoped)
)
check(
  '派发中（.busy）只高亮图标方块、不动画',
  /&\.busy\s*\{[\s\S]{0,200}?\.icon\s*\{/.test(scoped)
)
check(
  '派发中把文字颜色也拉回来（.disabled 的灰会让「运行」两字看不见）—— 两套主题各一条',
  (scoped.match(/&\.busy\s*\{\s*color\s*:/g) || []).length >= 2,
  String((scoped.match(/&\.busy\s*\{\s*color\s*:/g) || []).length)
)

// ---- 模板：派发中给按钮挂 busy 类 ----
const runBtnCls = classBindingOf(runBtn)
check(
  '派发中按钮挂 busy 类（用于「在干活」的视觉，而不是纯灰掉）',
  /busy/.test(runBtnCls) && /jobDispatching/.test(runBtnCls),
  runBtnCls
)
check(
  '按钮文字仍是「运行」（不随状态变字，避免工具栏按钮位移）',
  !!runBtn &&
    (runBtn.children || []).some(
      c =>
        (c.type === 1 && String(attrsOf(c).class || '').includes('text')) ||
        (c.type === 2 && String(c.text || '').includes('运行'))
    )
)

const failed = results.filter(item => !item.ok)
console.log(
  `\n共 ${results.length} 项，通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`
)
if (failed.length) {
  failed.forEach(item => console.log('  FAIL:', item.name))
  process.exit(1)
}
