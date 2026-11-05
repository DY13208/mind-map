/**
 * 「删除概要却把概要绑定的节点全删了」回归测试（2026-11-05 现场，数据破坏级）。
 *
 * 现场证据（room-avtdq8dl）：
 *   v179  owner 0a475d17 的 generalization 被设置（创建概要 e44da95b）
 *   v180  node.delete uid=0a475d17, keepChildren=false   ← 把 owner 连同整棵子树删了
 *   上一次同样模式：v166 设 generalization → v167 node.delete 同一个 owner
 *
 * 根因：概要只是挂在 owner 上的一条 annotation（数据在 owner.generalization 里），
 * owner 是主树上的真实节点。用户把概要一起选中（或 activeNodeList 里残留了
 * owner）时：
 *   - collectDeleteRoots 把概要映射进 owners，但 owner 仍被当作普通节点收进
 *     roots → 生成 node.delete(owner) → 服务端删掉 owner 及其整个子树；
 *   - Render.removeNode 的本地分支同样会 removeFromParentNodeData(owner)。
 *
 * 修复：两层保护
 *   1. collectDeleteRoots：有概要进入 owners 时，把这些 owner 从 roots 剔除
 *   2. Render.collectProtectedOwners + removeNode/removeCurrentNode：
 *      从本地删除列表里剔除宿主
 *
 * 红线：删概要 = 只清 owner.generalization，绝不产生任何 node.delete。
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
const renderSrc = fs.readFileSync(path.join(ROOT, 'core/render/Render.js'), 'utf8')
const deleteSrc = fs.readFileSync(path.join(ROOT, 'utils/collabDelete.js'), 'utf8')

// ---- 构造节点：owner（真实）→ 概要 → 概要子节点；owner 下还有真实子节点 ----
function mkNode(uid, opts = {}) {
  const data = { uid, text: uid, expand: true }
  return {
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
}

const root = mkNode('root', { isRoot: true })
const owner = mkNode('owner-1', { parent: root })
const realChild = mkNode('owner-child', { parent: owner })
root.children = [owner]
owner.children = [realChild]

const gen = mkNode('gen-1', { isGeneralization: true, owner, parent: owner })
const genChild = mkNode('gen-child', { parent: gen })
const genGrand = mkNode('gen-grand', { parent: genChild })
gen.children = [genChild]
genChild.children = [genGrand]
// 概要节点自身也能有 generalization（嵌套概要）
const nestedGen = mkNode('gen-1-nested', { isGeneralization: true, owner: gen, parent: gen })

const isVirtualSubtree = node => {
  let cur = node
  for (let i = 0; cur && i < 1000; i++) {
    if (cur.isGeneralization) return true
    cur = cur.parent
  }
  return false
}
const opts = { isVirtualSubtree }

// ---- 1. 核心红线：概要 + owner 一起选中，绝不删 owner ----
{
  const sel = collabDelete.collectDeleteRoots([gen, owner], 'REMOVE_NODE', opts)
  check(
    '概要+owner 同选：owner 不进删除根（数据破坏的红线）',
    sel.roots.length === 0,
    'roots=' + JSON.stringify(sel.rootUids)
  )
  const ops = collabDelete.deleteOperationsFromRoots(sel)
  check('概要+owner 同选：不生成任何 node.delete', ops.length === 0)
  check('概要+owner 同选：owner 被收进 owners（走 generalization 通道）', sel.owners.includes(owner))
  check(
    '概要+owner 同选：记录被保护的 owner uid',
    Array.isArray(sel.protectedOwnerUids) && sel.protectedOwnerUids.includes('owner-1'),
    JSON.stringify(sel.protectedOwnerUids)
  )
}

// ---- 2. 只点概要：同样不能删 owner ----
{
  const sel = collabDelete.collectDeleteRoots([gen], 'REMOVE_NODE', opts)
  check('只选概要：roots 为空', sel.roots.length === 0)
  check('只选概要：不生成 node.delete', collabDelete.deleteOperationsFromRoots(sel).length === 0)
  check('只选概要：走 owner 的 generalization 同步', sel.owners.includes(owner))
}

// ---- 3. 概要虚拟子树节点 + owner 同选：也不能删 owner ----
{
  const sel = collabDelete.collectDeleteRoots([genChild, genGrand, owner], 'REMOVE_NODE', opts)
  check('虚拟子树+owner 同选：owner 被保护', sel.roots.length === 0, JSON.stringify(sel.rootUids))
  check('虚拟子树+owner 同选：owner 进 owners', sel.owners.includes(owner))
}

// ---- 4. 不能误伤：只删真实子节点仍然正常 ----
{
  const sel = collabDelete.collectDeleteRoots([realChild], 'REMOVE_NODE', opts)
  check('只删真实子节点：仍正常生成删除根', sel.roots.length === 1 && sel.roots[0].uid === 'owner-child')
  check('只删真实子节点：不保护任何 owner', sel.protectedOwnerUids.length === 0)
  const ops = collabDelete.deleteOperationsFromRoots(sel)
  check('只删真实子节点：生成 node.delete', ops.length === 1 && ops[0].payload.uid === 'owner-child')
}

// ---- 5. 不能误伤：单独删 owner（没选概要）仍然要能删 ----
{
  const sel = collabDelete.collectDeleteRoots([owner], 'REMOVE_NODE', opts)
  check(
    '单独删 owner：正常删除（没有概要进入 owners 就不保护）',
    sel.roots.length === 1 && sel.roots[0].uid === 'owner-1',
    JSON.stringify(sel.rootUids)
  )
  check('单独删 owner：protectedOwnerUids 为空', sel.protectedOwnerUids.length === 0)
}

// ---- 6. 嵌套概要：删嵌套概要保护的是它的宿主（概要节点），不是最外层 owner ----
{
  const sel = collabDelete.collectDeleteRoots([nestedGen, gen], 'REMOVE_NODE', opts)
  check(
    '嵌套概要：被保护的是嵌套概要的宿主（概要节点）',
    sel.protectedOwnerUids.includes('gen-1'),
    JSON.stringify(sel.protectedOwnerUids)
  )
  check('嵌套概要：owner 不进删除根', !sel.rootUids.includes('owner-1'))
}

// ---- 7. Render 里的本地保护 ----
{
  check(
    'Render 定义了 collectProtectedOwners',
    /collectProtectedOwners\(list = \[\]\) \{/.test(renderSrc)
  )
  check(
    'removeNode 用 protectOwners 过滤删除列表',
    (() => {
      const s = renderSrc.indexOf('removeNode(appointNodes = [])')
      if (s < 0) return false
      const body = renderSrc.slice(s, s + 1600)
      return /const protectedOwners = this\.collectProtectedOwners\(list\)/.test(body) &&
        /list = list\.filter\(node => !protectedOwners\.has\(node\)\)/.test(body)
    })()
  )
  check(
    'removeCurrentNode 同样有保护',
    (() => {
      const s = renderSrc.indexOf('removeCurrentNode(appointNodes = [])')
      if (s < 0) return false
      const body = renderSrc.slice(s, s + 1400)
      return /const protectedOwners = this\.collectProtectedOwners\(list\)/.test(body) &&
        /list = list\.filter\(node => !protectedOwners\.has\(node\)\)/.test(body)
    })()
  )
  check(
    '保护发生后列表为空则直接返回（不再往下删）',
    (() => {
      const s = renderSrc.indexOf('removeNode(appointNodes = [])')
      const body = renderSrc.slice(s, s + 1600)
      return /if \(!list\.length\) return/.test(body)
    })()
  )

  // 行为验证：抽出 collectProtectedOwners 实跑
  const start = renderSrc.indexOf('  collectProtectedOwners(list = []) {')
  let i = renderSrc.indexOf('{', start)
  let depth = 0
  let end = -1
  for (; i < renderSrc.length; i++) {
    if (renderSrc[i] === '{') depth++
    else if (renderSrc[i] === '}') {
      depth--
      if (depth === 0) { end = i + 1; break }
    }
  }
  const fnSrc = renderSrc.slice(start, end).replace(/^\s*collectProtectedOwners/, 'return function collectProtectedOwners')
  const collectProtectedOwners = new Function(fnSrc)()
  const host = { collectProtectedOwners }

  const owners = collectProtectedOwners.call(host, [gen, owner, genChild, realChild])
  check('collectProtectedOwners：含概要时保护其宿主', owners.has(owner))
  check('collectProtectedOwners：含虚拟子树节点时保护其宿主', owners.has(owner))
  check('collectProtectedOwners：不含概要/虚拟节点时不保护', (() => {
    const only = collectProtectedOwners.call(host, [realChild, owner])
    return only.size === 0
  })())
  check('collectProtectedOwners：空列表安全', collectProtectedOwners.call(host, []).size === 0)
  check('collectProtectedOwners：null 安全', collectProtectedOwners.call(host, null).size === 0)

  // 循环 parent 保护
  const cycA = mkNode('cyc-a')
  const cycB = mkNode('cyc-b')
  cycA.parent = cycB
  cycB.parent = cycA
  let threw = null
  try { collectProtectedOwners.call(host, [cycA]) } catch (e) { threw = e }
  check('collectProtectedOwners：parent 成环不死循环', threw === null, threw ? threw.message : '')
}

// ---- 8. 集成：删除概要的完整结果是「只更新 owner.generalization」 ----
{
  const sel = collabDelete.collectDeleteRoots([gen, owner], 'REMOVE_NODE', opts)
  const ops = collabDelete.deleteOperationsFromRoots(sel)
  const summary = {
    deleteOps: ops.map(o => o.payload.uid),
    ownersToSync: sel.owners.map(o => o.getData('uid')),
    protectedOwners: sel.protectedOwnerUids
  }
  check(
    '集成：删除概要 = 0 个 node.delete + 1 个 owner 同步',
    summary.deleteOps.length === 0 &&
      summary.ownersToSync.length === 1 &&
      summary.ownersToSync[0] === 'owner-1',
    JSON.stringify(summary)
  )
  check(
    '集成：owner 的真实子树完全不受影响（数据仍在）',
    owner.children.includes(realChild) && realChild.parent === owner
  )
}

const failed = results.filter(r => !r.ok)
console.log(failed.length ? `\n${failed.length} FAILED` : '\nall ok')
process.exit(failed.length ? 1 : 0)
