/**
 * 概要子树持久化与渲染兼容回归测试。
 *
 * 回归两个 bug：
 *
 * ① 往概要下插子节点后刷新，节点显示异常。
 *    generalization.children 存的是渲染树节点 { inserting, data, children }，
 *    其中 `inserting` 是「刚插入、渲染完自动进编辑」的一次性标记
 *    （MindMapNode.js 渲染完看到它就 delete + active() + emit node_dblclick）。
 *    这个标记被原样持久化后，每次刷新都会自动弹编辑框，节点被顶掉。
 *    stripEphemeralGen 之前只清顶层，没递归清 children。
 *
 * ② 扁平结构的 children 会让整树渲染中断。
 *    walk 只认 { data, children }，遇到扁平 { uid, text, children } 时
 *    data.data 为 undefined，取 uid 抛错 → 脑图空白。
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

// ---- 1. 顶层 ephemeral 字段清理（原有行为，不能回退） ----
{
  const input = [{ uid: 'g1', text: '概要', inserting: true, isActive: true, resetRichText: true }]
  const out = collabGen.ownerGeneralizationPayload(input)
  check(
    '顶层插入态标记被清掉',
    out && out[0] && !('inserting' in out[0]) && !('isActive' in out[0]) && !('resetRichText' in out[0]),
    JSON.stringify(out && out[0])
  )
  check('顶层业务字段保留', out[0].uid === 'g1' && out[0].text === '概要')
}

// ---- 2. children 里的插入态标记也要清（本次修复的核心） ----
{
  // 真实服务端数据长这样（room-avtdq8dl）
  const input = [{
    uid: 'g1',
    text: '<p>概要</p>',
    expand: true,
    richText: true,
    childCount: 2,
    children: [
      {
        data: { uid: 'c1', text: '分支主题', expand: true, isActive: false, richText: true, resetRichText: true },
        children: [],
        inserting: true
      },
      {
        data: { uid: 'c2', text: '分支主题', expand: true, isActive: true, richText: true, resetRichText: true },
        children: []
      }
    ]
  }]
  const out = collabGen.ownerGeneralizationPayload(input)
  const kids = out[0].children
  check('children 里的外层 inserting 被清掉', !('inserting' in kids[0]), JSON.stringify(kids[0]))
  check('children.data 里的 isActive 被清掉', !('isActive' in kids[0].data))
  check('children.data 里的 resetRichText 被清掉', !('resetRichText' in kids[1].data))
  check(
    'children 的业务字段和高层结构保留',
    kids[0].data.uid === 'c1' && kids[0].data.text === '分支主题' &&
      Array.isArray(kids[0].children) && kids.length === 2
  )
  check('原始输入没被就地改坏（提交用的是快照）', input[0].children[0].inserting === true)
}

// ---- 3. 多层嵌套（概要子节点下再挂节点） ----
{
  const input = [{
    uid: 'g1',
    text: '概要',
    children: [{
      data: { uid: 'c1', text: '一级', isActive: true },
      children: [{
        data: { uid: 'c2', text: '二级', resetRichText: true },
        children: [],
        inserting: true
      }]
    }]
  }]
  const out = collabGen.ownerGeneralizationPayload(input)
  const lvl2 = out[0].children[0].children[0]
  check('深层节点的 inserting 被清掉', !('inserting' in lvl2))
  check('深层节点的 resetRichText 被清掉', !('resetRichText' in lvl2.data))
  check('深层结构完整', lvl2.data.uid === 'c2' && lvl2.data.text === '二级')
}

// ---- 4. 签名对插入态不敏感（否则每次都会多提交一次） ----
{
  const a = [{ uid: 'g1', text: '概要', children: [{ data: { uid: 'c1', text: 'x' }, children: [] }] }]
  const b = [{
    uid: 'g1', text: '概要',
    children: [{ data: { uid: 'c1', text: 'x', isActive: true, resetRichText: true }, children: [], inserting: true }]
  }]
  check(
    '同一份内容只是插入态不同 → 签名相同（不会重复提交）',
    collabGen.generalizationSignature(a) === collabGen.generalizationSignature(b)
  )
  const c = [{ uid: 'g1', text: '概要', children: [{ data: { uid: 'c1', text: '改了' }, children: [] }] }]
  check(
    '内容真变了 → 签名不同（能触发提交）',
    collabGen.generalizationSignature(a) !== collabGen.generalizationSignature(c)
  )
}

// ---- 5. 渲染侧：扁平 children 要被就地包装成 { data, children } ----
{
  const src = fs.readFileSync(path.join(ROOT, 'core/render/node/nodeGeneralization.js'), 'utf8')
  const start = src.indexOf('function normalizeGeneralizationChildren')
  const body = src.slice(start, start + 900)
  check('存在 normalizeGeneralizationChildren', start >= 0)
  check(
    '扁平节点会被包成 { data, children }',
    /list\[i\] = \{\s*data: child,\s*children:/.test(body)
  )
  check(
    'createGeneralizationNode 里对 item.children 调用了归一化',
    /normalizeGeneralizationChildren\(item\.children\)/.test(src)
  )
  // 就地替换：数组引用不变，编辑才能写回概要素材
  check('就地替换而不重建数组', !/item\.children = normalizeGeneralizationChildren/.test(src))
}

const failed = results.filter(r => !r.ok)
console.log(failed.length ? `\n${failed.length} FAILED` : '\nall ok')
process.exit(failed.length ? 1 : 0)
