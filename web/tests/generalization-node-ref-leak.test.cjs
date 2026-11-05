/**
 * 控制台实测错误的回归测试（2026-11-05 现场）。
 *
 * 用户截图时控制台报了两条：
 *   ① OUTBOX_NON_CLONEABLE_PAYLOAD:
 *        payload.generalization.0.children.0.children.0.children.0.children.0._node ...
 *   ② Uncaught TypeError: Cannot set properties of null (setting 'isActive')
 *        at copyRenderTree / copyNodeTree（递归 forEach）
 *
 * 同一个根因：渲染期节点引用 `_node`（MindMapNode 实例，带循环引用）漏进了
 * generalization 数据。
 *   - 发出去时：postMessage 结构化克隆直接抛 OUTBOX_NON_CLONEABLE_PAYLOAD → 同步失败
 *   - 本地深拷贝：JSON.stringify 因循环抛错 → simpleDeepClone 返回 null →
 *     `tree.data.isActive = false` 往 null 上写 → TypeError → 整次渲染中断 → 画布空白
 */
const fs = require('fs')
const path = require('path')

const results = []
function check(name, ok, extra = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`)
}

const ROOT = path.join(__dirname, '../../simple-mind-map/src')
const collabGen = require(path.join(ROOT, 'utils/collabGeneralization.js'))

// 造一个「带循环引用的节点实例」，模拟真实 MindMapNode：
// 真实实例还有方法（函数）和 SVG 引用，这些同样不可结构化克隆。
function makeNodeRef() {
  const node = { uid: 'inst', children: [] }
  node.self = node // 循环
  node.parent = node
  node.getData = () => ({}) // 函数：不可克隆
  return node
}

// 真实数据形态：渲染树节点 { data, children, _node }
function makeGenTree() {
  return [
    {
      uid: 'g1',
      text: '概要',
      expand: true,
      children: [
        {
          data: { uid: 'c1', text: '<p>223</p>', expand: true, richText: true },
          children: [
            {
              data: { uid: 'c2', text: '<p>分支12主题</p>', expand: true, richText: true },
              children: [
                {
                  data: { uid: 'c3', text: '<p>分123</p>', expand: true, richText: true },
                  children: [
                    {
                      data: { uid: 'c4', text: '<p>4531</p>', expand: true, richText: true },
                      children: []
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    }
  ]
}

function attachNodeRefs(list) {
  list.forEach(node => {
    node._node = makeNodeRef()
    if (node.data) node.data._node = makeNodeRef()
    if (Array.isArray(node.children)) attachNodeRefs(node.children)
  })
  return list
}

// ---- 1. 载荷必须能被结构化克隆（① 的修复） ----
{
  const tree = attachNodeRefs(makeGenTree())
  const payload = collabGen.ownerGeneralizationPayload(tree)
  let cloneError = null
  try {
    structuredClone(payload)
  } catch (err) {
    cloneError = err
  }
  check('修复后：generalization 载荷可以被 structuredClone', cloneError === null, cloneError ? cloneError.message : '')
  const text = JSON.stringify(payload)
  check('载荷里没有任何 _node', !text.includes('_node'), text.slice(0, 120))
  check('载荷里没有 `_` 前缀字段', !/"_/.test(text), text.slice(0, 120))
  check(
    '业务字段完整保留（uid/text/嵌套结构）',
    payload[0].children[0].data.uid === 'c1' &&
      payload[0].children[0].children[0].data.text === '<p>分支12主题</p>' &&
      payload[0].children[0].children[0].children[0].children[0].data.uid === 'c4'
  )
}

// ---- 2. 修复前确实会炸（证明这个测试能抓到问题） ----
{
  const tree = attachNodeRefs(makeGenTree())
  let failed = false
  try {
    structuredClone(tree)
  } catch (err) {
    failed = true
  }
  check('（对照）原始数据带 _node（含方法引用）时 structuredClone 会失败', failed === true)
}

// ---- 3. JSON 深拷贝不再返回 null（② 的根因） ----
{
  // 模拟未清理的数据被 JSON.stringify
  const dirty = attachNodeRefs(makeGenTree())
  let jsonOk = true
  try {
    JSON.stringify(dirty)
  } catch (err) {
    jsonOk = false
  }
  check('（对照）原始数据带 _node 时 JSON.stringify 抛错（导致 simpleDeepClone 返回 null）', jsonOk === false)

  const clean = collabGen.ownerGeneralizationPayload(dirty)
  let cleanOk = true
  try {
    JSON.stringify(clean)
  } catch (err) {
    cleanOk = false
  }
  check('清理后 JSON.stringify 正常', cleanOk === true)
}

// ---- 4. stripNodeRef：nodeGeneralization.js 里不再漏 _node ----
{
  const genSrc = fs.readFileSync(path.join(ROOT, 'core/render/node/nodeGeneralization.js'), 'utf8')
  check('定义了模块级 stripNodeRef', /function stripNodeRef\(list, depth = 0\)/.test(genSrc))
  check(
    'createGeneralizationNode 末尾无条件清理（复用分支也清）',
    /stripNodeRef\(item\.children\)\s*\n\s*delete item\._node/.test(genSrc)
  )
  check('递归清理嵌套概要里的 _node', /asGeneralizationList\(data\.generalization\)/.test(genSrc))
}

// ---- 5. simpleDeepClone 的兜底：cloneNodeData 永不返回 null ----
{
  const utilsSrc = fs.readFileSync(path.join(ROOT, 'utils/index.js'), 'utf8')
  check('新增 cloneNodeData', /export const cloneNodeData = data =>/.test(utilsSrc))
  check('copyRenderTree 用 cloneNodeData + 空对象兜底', /tree\.data = cloneNodeData\(root\.data\) \|\| \{\}/.test(utilsSrc))
  check('copyNodeTree 用 cloneNodeData + 空对象兜底', /tree\.data = cloneNodeData\(rootData\.data\) \|\| \{\}/.test(utilsSrc))

  // 行为验证：把 cloneNodeData 单独跑一遍（按花括号配平截取函数体）
  const fnStart = utilsSrc.indexOf('export const cloneNodeData')
  let braceIdx = utilsSrc.indexOf('{', fnStart)
  let depth = 0
  let fnEnd = -1
  for (let i = braceIdx; i < utilsSrc.length; i++) {
    if (utilsSrc[i] === '{') depth++
    else if (utilsSrc[i] === '}') {
      depth--
      if (depth === 0) { fnEnd = i + 1; break }
    }
  }
  const helpers = utilsSrc.slice(utilsSrc.indexOf('const isCircularSafeClone'), fnStart)
  const fnBody = utilsSrc.slice(fnStart, fnEnd).replace('export const', 'const')
  const moduleSrc = `${helpers}\n${fnBody}\nmodule.exports = cloneNodeData`
  const m = { exports: {} }
  new Function('module', 'exports', moduleSrc)(m, m.exports)
  const cloneNodeData = m.exports

  const circular = { a: 1, _node: makeNodeRef(), nested: { b: 2, _node: makeNodeRef() } }
  const out = cloneNodeData(circular)
  check('cloneNodeData(循环数据) 不返回 null', out !== null && out !== undefined)
  check('cloneNodeData 剔除了 _node', out && !('_node' in out) && !('_node' in (out.nested || {})))
  check('cloneNodeData 保留了业务字段', out && out.a === 1 && out.nested && out.nested.b === 2)

  const plain = { a: 1, list: [1, 2, 3] }
  const plainOut = cloneNodeData(plain)
  check('普通数据原样深拷贝', JSON.stringify(plainOut) === JSON.stringify(plain))
  check('深拷贝是真拷贝（改副本不影响原对象）', (plainOut.list.push(4), plain.list.length === 3))
}

const failed = results.filter(r => !r.ok)
console.log(failed.length ? `\n${failed.length} FAILED` : '\nall ok')
process.exit(failed.length ? 1 : 0)
