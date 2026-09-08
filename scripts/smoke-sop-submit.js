/**
 * 冒烟：提交资料抽取 + 待补数去重
 * node scripts/smoke-sop-submit.js
 */
const fs = require('fs')
const path = require('path')

function loadExports(file, names) {
  const src = fs.readFileSync(path.join(__dirname, file), 'utf8')
  const chunk = src.replace(/export /g, '')
  return new Function(`${chunk}; return { ${names.join(', ')} };`)()
}

const submit = loadExports('../web/src/utils/sopSubmitMaterial.js', [
  'extractSubmitMaterialFields',
  'formatSubmitMaterialNote',
  'parseProvidedFieldLabels',
  'isFieldAlreadyProvided',
  'isSubmitMaterialZone'
])

// extractMissingDataNeeds 在 sopRun.js 有很多 import，单独拷贝测试文件内容太重
// 这里用 Function 截取函数体
const sopRunSrc = fs.readFileSync(
  path.join(__dirname, '../web/src/utils/sopRun.js'),
  'utf8'
)
const start = sopRunSrc.indexOf('export function extractMissingDataNeeds')
const end = sopRunSrc.indexOf('/** 判定是否像真执行')
const extractChunk = sopRunSrc
  .slice(start, end)
  .replace(/export /, '')
const { extractMissingDataNeeds } = new Function(
  `${extractChunk}; return { extractMissingDataNeeds };`
)()

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed')
}

const outline = [
  '- D：刘欢: 招聘',
  '  - 提交资料',
  '    - 公司全称：',
  '    - 带教导师姓名：',
  '    - 成长计划表是否用 AI 预起草模板：',
  '    - 硬性要求：',
  '  - AI发起通知：等待确认'
].join('\n')

const parsed = submit.extractSubmitMaterialFields(outline, {
  sopTitle: '刘欢: 招聘'
})
assert(parsed.source === 'outline_zone', `source=${parsed.source}`)
assert(parsed.fields.length >= 3, `fields ${parsed.fields.length}`)
assert(
  parsed.fields.some(f => f.label.includes('公司全称')),
  '应含公司全称'
)
assert(
  !parsed.fields.some(f => f.label === '到岗时间'),
  '不应塞招聘保底到岗时间'
)

const note = submit.formatSubmitMaterialNote(
  parsed.fields.map(f => ({ ...f, value: `测_${f.label}` }))
)
const provided = submit.parseProvidedFieldLabels(note)
assert(provided.length >= 3, '应解析已提交字段')

const reply = [
  '### 五、下一步建议',
  '1. 公司全称',
  '2. 带教导师姓名',
  '3. 成长计划表是否用 AI 预起草模板',
  '4. 硬性要求'
].join('\n')

const miss1 = extractMissingDataNeeds(reply)
assert(miss1.fields.length === 4, `expect 4 got ${miss1.fields.length}`)

const miss2 = extractMissingDataNeeds(reply, { alreadyProvided: provided })
assert(
  miss2.fields.length === 0,
  `已提供后不应再待补，got ${miss2.fields.map(f => f.label)}`
)

// 不应因全文出现「职级/城市」就扩成 10 项
const reply2 = [
  '招聘流程含职级、城市、人数等描述。',
  '### 下一步建议',
  '1. 公司全称',
  '2. 带教导师姓名'
].join('\n')
const miss3 = extractMissingDataNeeds(reply2)
assert(
  miss3.fields.length === 2,
  `显式 2 项不应扩招，got ${miss3.fields.map(f => f.label)}`
)

const outlineReal = fs.readFileSync(
  path.join(__dirname, '_tmp_recruit_outline.txt'),
  'utf8'
)
const real = submit.extractSubmitMaterialFields(outlineReal, {
  sopTitle: '刘欢：招聘'
})
assert(real.source === 'outline_zone', `real source ${real.source}`)
assert(real.fields.length >= 10, `real fields ${real.fields.length}`)
assert(
  real.fields.some(f => f.label === '试用期带教导师'),
  '应含试用期带教导师'
)
assert(real.fields.some(f => f.label === '职级'), '应含职级')
assert(
  real.fields.find(f => f.label === '招聘城市').value === '深圳',
  '城市默认深圳'
)
assert(
  submit.isSubmitMaterialZone('需求方:提交招聘需求'),
  '需求方:提交招聘需求 应为资料区'
)

console.log('smoke-sop-submit OK', {
  outlineFields: parsed.fields.map(f => f.label),
  realFields: real.fields.map(f => f.label),
  afterProvide: miss2.fields.length
})
