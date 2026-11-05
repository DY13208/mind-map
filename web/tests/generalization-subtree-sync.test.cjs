/**
 * 概要子树（概要节点 + 概要下挂的子节点）协同同步回归测试。
 *
 * 回归的 bug：在概要后面插入子节点，编辑这个子节点会「同步失败」。
 *
 * 概要是虚拟节点，数据存在 owner 节点的 data.generalization 里，服务端没有
 * 概要 uid 的节点行。挂在概要下面的子节点同样是虚拟的（数据在
 * generalization[i].children 里），但它的 isGeneralization 是 false
 * （概要节点不能把这个标记传给子节点，否则子节点下就没法再插节点）。
 * 结果：
 *   1. 插入时 isGeneralizationUid(parent=概要uid, uid=子uid) 判不出来 →
 *      发 node.insert，父节点不存在 → NODE_DELETED
 *   2. 编辑文字时 TextEdit 照常建编辑会话 → node.update 虚拟 uid →
 *      NODE_DELETED → 前端「同步失败」
 *
 * 修复：用 generalizationScopeOwner(node) 沿 parent 链找到概要点，把整条
 * 虚拟子树都归到 owner 的 generalization 通道。
 */
const fs = require('fs')
const path = require('path')
const babel = require('@babel/core')

const results = []
function check(name, ok, extra = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`)
}

const ROOT = path.join(__dirname, '../../simple-mind-map/src')

// ---- 1. 从 Cooperate.js 源码里取纯函数（模块依赖太重，避免整包加载） ----
const cooperateSrc = fs.readFileSync(
  path.join(ROOT, 'plugins/Cooperate.js'),
  'utf8'
)

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`)
  if (start < 0) return null
  // 从函数起点按花括号配平截取函数体
  let i = src.indexOf('{', start)
  let depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  return null
}

const scopeOwnerSrc = extractFunction(cooperateSrc, 'generalizationScopeOwner')
const scopeNodeSrc = extractFunction(cooperateSrc, 'isGeneralizationScopeNode')

check('Cooperate.js 定义了 generalizationScopeOwner', !!scopeOwnerSrc)
check('Cooperate.js 定义了 isGeneralizationScopeNode', !!scopeNodeSrc)

const factories = new Function(`
  ${scopeOwnerSrc || 'function generalizationScopeOwner(){return null}'}
  ${scopeNodeSrc || 'function isGeneralizationScopeNode(){return false}'}
  return { generalizationScopeOwner, isGeneralizationScopeNode }
`)()
const { generalizationScopeOwner, isGeneralizationScopeNode } = factories

// ---- 2. 构造节点树：owner -> 概要节点 -> 概要子节点 -> 孙节点 ----
function mkNode(uid, opts = {}) {
  return {
    uid,
    isGeneralization: !!opts.isGeneralization,
    generalizationBelongNode: opts.owner || null,
    parent: opts.parent || null,
    getData(key) {
      if (key === undefined) return { uid }
      return key === 'uid' ? uid : undefined
    }
  }
}

const owner = mkNode('owner-1')
const gen = mkNode('gen-1', { isGeneralization: true, owner, parent: owner })
const genChild = mkNode('genchild-1', { parent: gen })
const genGrandChild = mkNode('gengrand-1', { parent: genChild })
const normalChild = mkNode('n-1', { parent: owner })

// ---- 3. 纯函数判定 ----
check(
  '概要节点自身 → owner',
  generalizationScopeOwner(gen) === owner
)
check(
  '概要子节点 → 同一个 owner（本次修复的关键）',
  generalizationScopeOwner(genChild) === owner,
  String(generalizationScopeOwner(genChild) && generalizationScopeOwner(genChild).uid)
)
check(
  '概要孙节点 → 同一个 owner',
  generalizationScopeOwner(genGrandChild) === owner
)
check(
  '普通子节点 → 不是虚拟节点',
  generalizationScopeOwner(normalChild) === null
)
check('owner 自身 → 不是虚拟节点', generalizationScopeOwner(owner) === null)
check('空节点不炸', generalizationScopeOwner(null) === null && generalizationScopeOwner() === null)

check('isGeneralizationScopeNode(概要) = true', isGeneralizationScopeNode(gen) === true)
check('isGeneralizationScopeNode(概要子) = true', isGeneralizationScopeNode(genChild) === true)
check('isGeneralizationScopeNode(概要孙) = true', isGeneralizationScopeNode(genGrandChild) === true)
check('isGeneralizationScopeNode(普通子) = false', isGeneralizationScopeNode(normalChild) === false)

// ---- 4. Cooperate 原型方法：isGeneralizationUid 要能挡住概要子树的插入 ----
const cooperateClassSrc = cooperateSrc
check(
  'isGeneralizationUid 里加了「父节点在虚拟子树内」判定',
  /if \(parentNode && isGeneralizationScopeNode\(parentNode\)\) return true/.test(cooperateClassSrc)
)
check(
  'isGeneralizationUid 里加了「子节点本身在虚拟子树内」判定',
  /childNode && isGeneralizationScopeNode\(childNode\)/.test(cooperateClassSrc)
)
check(
  'hasUnsyncedLocalText 跳过虚拟子树（不再发 node.update）',
  /if \(isGeneralizationScopeNode\(node\)\) return false/.test(cooperateClassSrc)
)
check(
  'collectGeneralizationOwners 用 generalizationScopeOwner 映射 owner',
  /const owner = generalizationScopeOwner\(node\)/.test(cooperateClassSrc)
)
check(
  '_pendingTextUids 不再收集虚拟子树节点',
  /node.getData && !isGeneralizationScopeNode\(node\)/.test(cooperateClassSrc)
)
check(
  'INSERT_COMMANDS 分支会刷 owner 的 generalization',
  /const genOwnersOnInsert = this\.collectGeneralizationOwners\(name, args\)/.test(cooperateClassSrc)
)
check(
  'flushHttpInsertNow 过滤虚拟子树的 insert 记录',
  /if \(this\.isGeneralizationUid\(row\.parent, row\.uid\)\) return false/.test(cooperateClassSrc)
)

// ---- 5. TextEdit / RichText 的编辑会话守卫要覆盖整条子树 ----
for (const [label, file] of [
  ['TextEdit', path.join(ROOT, 'core/render/TextEdit.js')],
  ['RichText', path.join(ROOT, 'plugins/RichText.js')]
]) {
  const src = fs.readFileSync(file, 'utf8')
  const first = src.indexOf('beginEditSession(node, isFromScale)')
  const beginIdx = src.indexOf('beginEditSession(node, isFromScale)', first + 1)
  const body = src.slice(beginIdx, beginIdx + 2000)
  check(
    `${label}.beginEditSession 用 isVirtualGeneralizationNode 守卫`,
    beginIdx >= 0 && /isVirtualGeneralizationNode\(node, cooperate\)/.test(body)
  )
  check(
    `${label} 定义了 isVirtualGeneralizationNode 且调用 cooperate.isGeneralizationScopeNode`,
    /isVirtualGeneralizationNode\(node, cooperate\) \{[\s\S]*?cooperate\.isGeneralizationScopeNode/.test(src)
  )
}

const failed = results.filter(r => !r.ok)
console.log(failed.length ? `\n${failed.length} FAILED` : '\nall ok')
process.exit(failed.length ? 1 : 0)
