/**
 * 概要虚拟子树节点「删不掉」回归测试。
 *
 * 现象：概要后面挂的节点，删除后当时消失，刷新又回来。
 *
 * 两个根因：
 * ① collectDeleteRoots 只认「概要节点自身」（isGeneralization），
 *    概要下挂的普通子节点被当成真实节点收进 roots → 生成 node.delete
 *    以虚拟 uid 提交 → 服务端 NODE_DELETED → catch 回滚 → 服务端数据没变，
 *    刷新后节点重新出现。
 * ② removeFromParentNodeData 的 fallback 分支用 `node.parent.nodeData.children = filter(...)`
 *    重新赋值。概要注意节点的 nodeData.children 就是 generalization[i].children
 *    本身，重新赋值后两者失去同步 → 删掉的数据还留在 generalization 里。
 */
const fs = require('fs')
const path = require('path')

const results = []
function check(name, ok, extra = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`)
}

const ROOT = path.join(__dirname, '../../simple-mind-map/src')
const collabDelete = require(path.join(ROOT, 'utils/collabDelete.js'))

// ---- 构造节点树：主树 owner -> 真实子节点；owner 上挂概要 -> 概要子节点 ----
function mkNode(uid, opts = {}) {
  const data = { uid, text: uid, expand: true }
  const node = {
    uid,
    isGeneralization: !!opts.isGeneralization,
    isRoot: !!opts.isRoot,
    generalizationBelongNode: opts.owner || null,
    parent: opts.parent || null,
    children: [],
    nodeData: { data, children: [] },
    getData(key) {
      if (key === undefined) return data
      return data[key]
    }
  }
  return node
}

const rootNode = mkNode('root', { isRoot: true })
const owner = mkNode('owner-1', { parent: rootNode })
const realChild = mkNode('real-1', { parent: owner })
const gen = mkNode('gen-1', { isGeneralization: true, owner, parent: owner })
const genChild = mkNode('genchild-1', { parent: gen })
const genGrandChild = mkNode('gengrand-1', { parent: genChild })

// 主树 owner 的 children（真实节点）
owner.nodeData.children = [{ data: realChild.nodeData.data, children: [] }]
rootNode.nodeData.children = [{ data: owner.nodeData.data, children: [] }]
// 概要注意节点的 children 就是 generalization[i].children
const genItem = {
  uid: 'gen-1',
  text: '概要',
  expand: true,
  children: [
    { data: genChild.nodeData.data, children: [{ data: genGrandChild.nodeData.data, children: [] }] }
  ]
}
gen.nodeData = { data: genItem, children: genItem.children }

const isVirtualSubtree = node => {
  let cur = node
  for (let i = 0; cur && i < 1000; i++) {
    if (cur.isGeneralization) return true
    cur = cur.parent
  }
  return false
}

// ---- 1. 不带选项时（旧行为）：概要子节点被当成真实节点 → 生成 node.delete ----
{
  const sel = collabDelete.collectDeleteRoots([genChild], 'REMOVE_NODE')
  check(
    '（对照）旧行为：概要子节点会被收进 roots',
    sel.roots.length === 1 && sel.roots[0].uid === 'genchild-1',
    'roots=' + JSON.stringify(sel.rootUids)
  )
  const ops = collabDelete.deleteOperationsFromRoots(sel)
  check(
    '（对照）旧行为：会生成针对虚拟 uid 的 node.delete',
    ops.length === 1 && ops[0].payload.uid === 'genchild-1'
  )
}

// ---- 2. 传入 isVirtualSubtree 后：不再生成 node.delete，改为同步 owner ----
{
  const sel = collabDelete.collectDeleteRoots([genChild], 'REMOVE_NODE', { isVirtualSubtree })
  check('修复后：概要子节点不进 roots', sel.roots.length === 0, 'roots=' + JSON.stringify(sel.rootUids))
  check('修复后：owner 被收集（走 generalization 通道）', sel.owners.length === 1 && sel.owners[0] === owner)
  const ops = collabDelete.deleteOperationsFromRoots(sel)
  check('修复后：不生成任何 node.delete', ops.length === 0)
}

// ---- 3. 深层孙节点同样处理 ----
{
  const sel = collabDelete.collectDeleteRoots([genGrandChild], 'REMOVE_NODE', { isVirtualSubtree })
  check('概要孙节点也不进 roots', sel.roots.length === 0)
  check('概要孙节点映射到同一个 owner', sel.owners.length === 1 && sel.owners[0] === owner)
}

// ---- 4. 概要节点自身（原有逻辑不能回退） ----
{
  const sel = collabDelete.collectDeleteRoots([gen], 'REMOVE_NODE', { isVirtualSubtree })
  check('概要节点自身仍走 owner 通道', sel.roots.length === 0 && sel.owners[0] === owner)
}

// ---- 5. 真实节点不受影响 ----
{
  const sel = collabDelete.collectDeleteRoots([realChild], 'REMOVE_NODE', { isVirtualSubtree })
  check('真实节点正常进 roots', sel.roots.length === 1 && sel.roots[0].uid === 'real-1')
  check('真实节点不误收 owner', sel.owners.length === 0)
  const ops = collabDelete.deleteOperationsFromRoots(sel)
  check('真实节点正常生成 node.delete', ops.length === 1 && ops[0].type === 'node.delete')
}

// ---- 6. 混选（真实 + 概要子树） ----
{
  const sel = collabDelete.collectDeleteRoots([realChild, genChild], 'REMOVE_NODE', { isVirtualSubtree })
  check('混选：只对真实节点生成删除', sel.roots.length === 1 && sel.roots[0].uid === 'real-1')
  check('混选：同时收集 owner', sel.owners.length === 1 && sel.owners[0] === owner)
}

// ---- 7. owner 自身被删时不应被当成虚拟子树 ----
{
  const sel = collabDelete.collectDeleteRoots([owner], 'REMOVE_NODE', { isVirtualSubtree })
  check('删 owner 本身仍是真实删除', sel.roots.length === 1 && sel.roots[0].uid === 'owner-1')
}

// ---- 8. Cooperate 里确实传了判定函数 ----
{
  const cooperateSrc = fs.readFileSync(path.join(ROOT, 'plugins/Cooperate.js'), 'utf8')
  check(
    'Cooperate 调用 collectDeleteRoots 时传 isVirtualSubtree',
    /collabDelete\.collectDeleteRoots\(list, name, \{[\s\S]{0,300}?isVirtualSubtree: node => isGeneralizationScopeNode\(node\)/.test(cooperateSrc)
  )
  check(
    '删除分支仍会 sync owner 的 generalization',
    /owners\.forEach\(owner => this\.syncHttpGeneralization\(owner\)\)/.test(cooperateSrc)
  )
}

// ---- 9. removeFromParentNodeData 的 fallback 必须就地 splice ----
{
  const utilsSrc = fs.readFileSync(path.join(ROOT, 'utils/index.js'), 'utf8')
  const start = utilsSrc.indexOf('export const removeFromParentNodeData')
  const body = utilsSrc.slice(start, start + 900)
  check(
    'fallback 分支不再整体重新赋值 children',
    !/node\.parent\.nodeData\.children = kids\.filter/.test(body)
  )
  check('fallback 分支改成就地 splice', /kids\.splice\(i, 1\)/.test(body))

  // 行为验证：概要注意节点的 nodeData.children 与 generalization 条目同引用
  const item = { uid: 'g', children: [{ data: { uid: 'a' }, children: [] }, { data: { uid: 'b' }, children: [] }] }
  const genNode = {
    nodeData: { data: item, children: item.children },
    parent: null
  }
  // 模拟 fallback（index 找不到）路径
  const uid = 'a'
  const kids = genNode.nodeData.children
  for (let i = kids.length - 1; i >= 0; i--) {
    const it = kids[i]
    if (it && it.data && it.data.uid === uid) kids.splice(i, 1)
  }
  check('就地删除后 item.children 同步变短', item.children.length === 1 && item.children[0].data.uid === 'b')
  check('数组引用没被换掉（nodeData.children === item.children）', genNode.nodeData.children === item.children)
}

const failed = results.filter(r => !r.ok)
console.log(failed.length ? `\n${failed.length} FAILED` : '\nall ok')
process.exit(failed.length ? 1 : 0)
