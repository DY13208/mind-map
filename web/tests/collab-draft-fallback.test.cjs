/**
 * 协作兜底草稿的判断逻辑单测。
 *
 * 回归的是这个 bug：页面带房间号时前端把持久化整个交给协作服务，
 * 协作服务挂了（nginx 502）就没有任何持久化 —— 刷新/重新部署整张图消失。
 * `shouldRestoreDraft` 决定「要不要用本地留底把图恢复出来」，覆盖判定最容易写错。
 */
const fs = require('fs')
const path = require('path')
const babel = require('@babel/core')

const results = []
function check(name, ok, extra = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`)
}

const file = path.join(__dirname, '../src/utils/collabDraftFallback.js')
const { code } = babel.transformSync(fs.readFileSync(file, 'utf8'), {
  babelrc: false,
  configFile: false,
  plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
})
const mod = { exports: {} }
new Function('require', 'module', 'exports', code)(() => ({}), mod, mod.exports)
const {
  shouldRestoreDraft,
  draftRestoredTip,
  isDraftFallbackEnabled,
  COLLAB_DRAFT_FALLBACK_MS
} = mod.exports

const draft = { root: { data: { text: '根' }, children: [{ data: { text: 'A' } }] } }
const emptyRoot = { data: { text: '根' }, children: [] }
const filledRoot = { data: { text: '根' }, children: [{ data: { text: '已有' } }] }

check('等待时间是个合理值（≥5s，给协作握手留时间）', COLLAB_DRAFT_FALLBACK_MS >= 5000, String(COLLAB_DRAFT_FALLBACK_MS))

// ---- 该恢复的情况 ----
check(
  '协作没连上 + 有草稿 + 图是空的 → 恢复',
  shouldRestoreDraft({ live: false, draft, root: emptyRoot }) === true
)
check(
  'root 都没有（还没渲染出来）也算空',
  shouldRestoreDraft({ live: false, draft, root: undefined }) === true
)

// ---- 不该恢复的情况 ----
check(
  '协作已经 LIVE → 不恢复（以协作为准）',
  shouldRestoreDraft({ live: true, draft, root: emptyRoot }) === false
)
check(
  '图上已经有内容 → 不覆盖',
  shouldRestoreDraft({ live: false, draft, root: filledRoot }) === false
)
check(
  '本地没有草稿 → 不恢复',
  shouldRestoreDraft({ live: false, draft: null, root: emptyRoot }) === false
)
check(
  '草稿结构不对（没有 root）→ 不恢复',
  shouldRestoreDraft({ live: false, draft: { view: {} }, root: emptyRoot }) === false
)
check(
  '草稿 root 不是对象 → 不恢复',
  shouldRestoreDraft({ live: false, draft: { root: 'x' }, root: emptyRoot }) === false
)
check('参数全空 → 不恢复', shouldRestoreDraft({}) === false)
check('完全不传参数也不炸', shouldRestoreDraft() === false)

// ---- 提示文案 ----
const tip = draftRestoredTip(draft)
check('提示里说明是本地留底恢复的', /本地留底/.test(tip), tip)
check('提示里带上分支数量', /顶层 1 个分支/.test(tip), tip)
check('提示告诉用户协作起来后会同步', /同步/.test(tip), tip)

// ---- 开关 ----
check('默认开着', isDraftFallbackEnabled({}) === true)
check('window 上设 false 就关掉', isDraftFallbackEnabled({ __COLLAB_DRAFT_FALLBACK__: false }) === false)
check('设 true / 其他值仍算开', isDraftFallbackEnabled({ __COLLAB_DRAFT_FALLBACK__: true }) === true)
check('传空也不炸（默认开）', isDraftFallbackEnabled() === true)

const failed = results.filter(r => !r.ok)
console.log(`\n共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
if (failed.length) {
  console.log('失败项：' + failed.map(r => r.name).join(' / '))
  process.exit(1)
}
process.exit(0)
