/**
 * 冒烟：当前脑图招聘资料批次指纹。
 * node scripts/smoke-sop-business-fingerprint.js
 */
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(
  path.join(__dirname, '../web/src/utils/sopSubmitMaterial.js'),
  'utf8'
)
const api = new Function(
  `${src.replace(/export /g, '')}; return { buildRuntimeMaterialFingerprint };`
)()

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed')
}

const materialA = {
  source: 'runtime_tree',
  providedFields: [
    { label: '招聘岗位', value: 'AI 算法工程师' },
    { label: '招聘人数', value: '1' }
  ],
  missingFields: ['招聘部门']
}
const fingerprintA = api.buildRuntimeMaterialFingerprint(materialA)
const fingerprintSame = api.buildRuntimeMaterialFingerprint({
  ...materialA,
  providedFields: [...materialA.providedFields].reverse().map(field => ({
    label: ` ${field.label} `,
    value: String(field.value).replace('AI ', 'ai')
  }))
})
const fingerprintChanged = api.buildRuntimeMaterialFingerprint({
  ...materialA,
  providedFields: materialA.providedFields.map(field =>
    field.label === '招聘人数' ? { ...field, value: '2' } : field
  )
})
const fingerprintFilled = api.buildRuntimeMaterialFingerprint({
  ...materialA,
  providedFields: [
    ...materialA.providedFields,
    { label: '招聘部门', value: 'AI部门' }
  ],
  missingFields: []
})

assert(fingerprintA, '实时脑图资料应生成指纹')
assert(fingerprintA === fingerprintSame, '顺序/空格/大小写不应改变批次')
assert(fingerprintA !== fingerprintChanged, '任一字段值变化应生成新批次')
assert(fingerprintA !== fingerprintFilled, '补齐缺失字段应生成新批次')
assert(
  api.buildRuntimeMaterialFingerprint({ source: 'outline', providedFields: [] }) === '',
  '非实时脑图入口应保持旧去重规则'
)

console.log('sop business fingerprint smoke OK', {
  fingerprintA,
  fingerprintChanged,
  fingerprintFilled
})
