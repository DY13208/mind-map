import { copyNodeTree, formatGetNodeGeneralization } from 'simple-mind-map/src/utils/index'

const PLACEHOLDERS = new Set([
  '',
  '分支主题',
  '子主题',
  '概要',
  '中心主题',
  'branch topic',
  'sub topic',
  'central topic'
])

const DATA_COLLECTION_TITLES = new Set(['提供', '模块', '填写', '补充数据'])

export function plainText(node) {
  if (!node || !node.getData) return ''
  return String(node.getData('text') || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

export function noteOf(node) {
  if (!node || !node.getData) return ''
  return String(node.getData('note') || '').trim()
}

export function isInvalidNodeData(text) {
  const raw = String(text || '').trim()
  if (!raw) return true
  if (PLACEHOLDERS.has(raw.toLowerCase())) return true
  if (raw.length < 2) return true
  if (/^[a-z]$/i.test(raw)) return true
  if (/^(测试|test)$/i.test(raw)) return true
  return false
}

export function isValidNodeData(text) {
  return !isInvalidNodeData(text)
}

function subtreePlain(node, depth = 0, maxDepth = 4) {
  if (!node) return ''
  const lines = [plainText(node)]
  if (depth >= maxDepth) return lines.join('\n')
  ;(node.children || []).forEach(child => {
    lines.push(subtreePlain(child, depth + 1, maxDepth))
  })
  return lines.filter(Boolean).join('\n')
}

function nodeDepthFrom(root, node) {
  let depth = 0
  let cur = node
  while (cur && cur !== root) {
    depth++
    cur = cur.parent
  }
  return depth
}

function isNodeUnder(root, node) {
  if (!root || !node) return false
  let cur = node
  while (cur) {
    if (cur === root) return true
    cur = cur.parent
  }
  return false
}

export function hasExecutionFlow(node) {
  if (!node || !node.children || node.children.length === 0) return false
  const kids = node.children.filter(item => isValidNodeData(plainText(item)))
  if (kids.length === 0) return false
  if (kids.length >= 2) return true
  if (kids.some(item => item.children && item.children.length > 0)) return true
  return kids.some(item => /^\d+[、.．)\]]/.test(plainText(item)))
}

function extractKeywords(text) {
  const raw = String(text || '').toLowerCase()
  const words = raw.match(/[\u4e00-\u9fa5]{2,}|[a-z]{2,}/gi) || []
  const uniq = [...new Set(words)]
  if (uniq.length) return uniq
  return raw.length >= 2 ? [raw] : []
}

function scoreTextAgainstQuery(text, query) {
  const keywords = extractKeywords(query)
  if (!keywords.length) return 0
  const hay = String(text || '').toLowerCase()
  let score = 0
  keywords.forEach(word => {
    if (hay.includes(word)) score += word.length >= 3 ? 3 : 2
  })
  return score
}

function isRecruitmentQuery(query) {
  return /招聘|itbp|hrbp|jd|offer|岗位|用人|逐鹿/i.test(String(query || ''))
}

function isSummaryTitle(text) {
  return String(text || '').trim() === '概要'
}

function isDataCollectionNode(node) {
  return DATA_COLLECTION_TITLES.has(plainText(node))
}

/** 是否像完整的 SOP 流程模板（含模块/提供 + 概要） */
export function isFullSopTemplate(node) {
  if (!node) return false
  return !!(
    findDataCollectionNodeInSubtree(node) && findSummaryNodeInSubtree(node)
  )
}

function scoreFlowNode(node, query, sopNode) {
  if (!node) return 0
  let score = 0
  const title = plainText(node)
  if (isValidNodeData(title)) {
    score += scoreTextAgainstQuery(title, query)
    extractKeywords(query).forEach(kw => {
      if (kw.length >= 2 && title === kw) score += 15
      else if (kw.length >= 2 && title.includes(kw)) score += 8
    })
  }
  if (isFullSopTemplate(node)) score += 12
  if (findDataCollectionNodeInSubtree(node)) score += 5
  if (findSummaryNodeInSubtree(node)) score += 5
  if (hasExecutionFlow(node)) {
    score += scoreTextAgainstQuery(subtreePlain(node, 0, 3), query)
    if (/(流程|步骤|sop|执行|招聘|offer|jd|筛选)/i.test(subtreePlain(node, 0, 2))) {
      score += 2
    }
  }
  if (isRecruitmentQuery(query) && title === '招聘') score += 25
  if (sopNode && isNodeUnder(sopNode, node)) score += 6
  if (sopNode) score -= nodeDepthFrom(sopNode, node) * 2
  return score
}

function walkNodes(node, visit) {
  if (!node) return
  visit(node)
  ;(node.children || []).forEach(child => walkNodes(child, visit))
}

function findRoot(mindMap) {
  return mindMap && mindMap.renderer && mindMap.renderer.root
}

export function findSopNode(root) {
  let found = null
  walkNodes(root, node => {
    if (found) return
    const title = plainText(node)
    if (/^sop$/i.test(title) || title.toUpperCase() === 'SOP') {
      found = node
    }
  })
  return found
}

/** 在子树中查找「提供/模块」等数据采集节点 */
export function findDataCollectionNodeInSubtree(root) {
  if (!root) return null
  let found = null
  walkNodes(root, n => {
    if (n !== root && isDataCollectionNode(n)) found = n
  })
  return found
}

export function findProvideNodeInSubtree(root) {
  return findDataCollectionNodeInSubtree(root)
}

/** 在子树中查找「概要」节点（含 generalization） */
export function findSummaryNodeInSubtree(root) {
  if (!root) return null
  let found = null
  walkNodes(root, n => {
    if (found) return
    if (isSummaryTitle(plainText(n))) {
      found = n
      return
    }
    const data = n.getData ? n.getData() : n.data || {}
    formatGetNodeGeneralization(data).forEach(item => {
      if (isSummaryTitle(item.text)) found = n
    })
  })
  return found
}

function cloneMindMapNode(node) {
  if (!node) return null
  const tree = copyNodeTree({}, node, true, true)
  if (!tree || !tree.data) return null
  return tree
}

function stripNodeText(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 同时兼容已渲染子节点与未展开的 nodeData.children */
export function getNodeChildSources(flowNode) {
  if (!flowNode) return { live: [], data: [] }
  const live = flowNode.children || []
  const data =
    (flowNode.nodeData && flowNode.nodeData.children) ||
    (flowNode.data && flowNode.data.children) ||
    []
  return { live, data }
}

export function hasTemplateChildren(flowNode) {
  const { live, data } = getNodeChildSources(flowNode)
  return live.length > 0 || data.length > 0
}

/** 深拷贝 SOP 流程入口下的完整子树 */
export function instantiateSopProcessTree(flowNode) {
  if (!flowNode) return []
  const { live, data } = getNodeChildSources(flowNode)

  if (live.length) {
    const trees = live
      .map(child => cloneMindMapNode(child))
      .filter(
        item => item && item.data && isValidNodeData(stripNodeText(item.data.text))
      )
    if (trees.length) return trees
  }

  // 节点未展开时 children 可能为空，改从 nodeData 深拷贝
  return (data || [])
    .map(child => copyNodeTree({}, child, true, true))
    .filter(
      item => item && item.data && isValidNodeData(stripNodeText(item.data.text))
    )
}

/** 克隆 SOP 中「概要」后的执行步骤 */
export function instantiateSopExecutionTree(flowNode) {
  let steps = []
  walkNodes(flowNode, n => {
    if (steps.length) return
    if (!isSummaryTitle(plainText(n))) return
    const fromChildren = cloneFlowChildren(n)
    if (fromChildren.length) {
      steps = fromChildren
      return
    }
    if (n.children && n.children.length) {
      steps = n.children.map(child => cloneMindMapNode(child)).filter(Boolean)
    }
  })
  if (steps.length) return steps

  walkNodes(flowNode, n => {
    if (steps.length) return
    const data = n.getData ? n.getData() : n.data || {}
    formatGetNodeGeneralization(data).forEach(item => {
      if (isSummaryTitle(item.text) && item.children && item.children.length) {
        steps = item.children
          .map(child => cloneMindMapNode(child))
          .filter(Boolean)
      }
    })
  })
  return steps
}

/** 在 SOP 流程上查找数据采集节点 */
export function findProvideNode(sopNode, flowNode) {
  if (!flowNode) return null
  const inFlow = findDataCollectionNodeInSubtree(flowNode)
  if (inFlow) return inFlow
  if (!sopNode) return null

  let fallback = null
  walkNodes(sopNode, n => {
    if (isDataCollectionNode(n)) fallback = n
  })
  return fallback
}

function supplementFieldNodes(collectionNode) {
  if (!collectionNode || !collectionNode.children) return []
  return collectionNode.children.filter(item => {
    const title = plainText(item)
    if (!isValidNodeData(title)) return false
    if (isSummaryTitle(title)) return false
    return true
  })
}

function queryCoversSupplementFields(query, fields) {
  if (!fields.length) return false
  let mentioned = 0
  fields.forEach(field => {
    const name = plainText(field)
    if (name.length >= 2 && query.includes(name)) mentioned++
  })
  return mentioned >= Math.min(3, Math.ceil(fields.length * 0.5))
}

function childrenCoverSupplementFields(existingChildren, fields) {
  if (!existingChildren?.length || !fields.length) return false
  const existing = new Set(
    existingChildren.map(c => plainText(c)).filter(Boolean)
  )
  const names = fields.map(f => plainText(f)).filter(Boolean)
  const overlap = names.filter(name => existing.has(name)).length
  return overlap >= Math.min(3, Math.ceil(names.length * 0.6))
}

export function analyzeSopSupplement({ sopNode, flowNode, query, node }) {
  const collectionNode = findProvideNode(sopNode, flowNode)
  const fields = supplementFieldNodes(collectionNode)

  if (!collectionNode || !fields.length) {
    return {
      needsSupplement: false,
      provideNode: collectionNode,
      fields: [],
      fieldTrees: []
    }
  }

  const existingChildren = node && node.children ? node.children : []
  const alreadyCovered = childrenCoverSupplementFields(existingChildren, fields)
  const queryComplete = queryCoversSupplementFields(query, fields)

  return {
    needsSupplement: !alreadyCovered && !queryComplete,
    provideNode: collectionNode,
    fields,
    fieldTrees: fields
      .map(field => copyNodeTree({}, field, true, true))
      .filter(item => item && item.data && isValidNodeData(item.data.text))
  }
}

const ASSIGNEE_PATTERNS = [
  { re: /推送给(.{2,30}?)(?:[（(]|$)/, group: 1 },
  { re: /负责人[：:\s]+([^\s，,；;]{2,20})/, group: 1 },
  { re: /@([\u4e00-\u9fa5a-zA-Z0-9_]{2,20})/, group: 1 },
  { re: /(?:对应|通知|发送给)(.{2,15}?)(?:的)?HRBP/i, group: 1 },
  { re: /(HRBP)/i, group: 1 },
  { re: /待办[：:\s]*([^\s，,]{2,20})/, group: 1 }
]

function findSummaryNode(root, flowNode) {
  const inFlow = findSummaryNodeInSubtree(flowNode)
  if (inFlow) return inFlow
  if (root) return findSummaryNodeInSubtree(root)
  return null
}

export function findFlowAssignee({ sopNode, flowNode }) {
  const summaryNode = findSummaryNode(sopNode, flowNode)
  const searchRoots = []
  if (summaryNode) searchRoots.push(summaryNode)
  searchRoots.push(flowNode)

  for (const root of searchRoots) {
    let match = null
    walkNodes(root, node => {
      if (match) return
      const combined = `${plainText(node)} ${noteOf(node)}`.trim()
      for (const { re, group } of ASSIGNEE_PATTERNS) {
        const m = combined.match(re)
        if (m && m[group]) {
          match = {
            name: m[group].trim(),
            source: plainText(node),
            node
          }
          return
        }
      }
    })
    if (match) return match
  }

  return {
    name: '流程负责人',
    source: plainText(flowNode),
    node: flowNode
  }
}

function isCpSibling(node) {
  return /^[cp]$/i.test(plainText(node).trim())
}

function findBestFlowInNodes(nodes, query, minScore = 1, sopNode = null) {
  let best = null
  let bestScore = 0
  nodes.forEach(node => {
    const score = scoreFlowNode(node, query, sopNode)
    if (score > bestScore && score >= minScore) {
      bestScore = score
      best = node
    }
  })
  return best ? { node: best, score: bestScore } : null
}

function isSopProcessCandidate(node, sopNode) {
  if (!node || node === sopNode) return false
  if (isFullSopTemplate(node)) return true
  if (findDataCollectionNodeInSubtree(node)) return true
  if (findSummaryNodeInSubtree(node)) return true
  const title = plainText(node)
  return /(招聘|入职|离职|审批|采购|报销)/.test(title)
}

/** 在 SOP 分支中查找与 query 最匹配的流程根节点（如 招聘） */
function searchSopFlow(root, query) {
  const sopNode = findSopNode(root)
  if (!sopNode) return null

  const candidates = []
  walkNodes(sopNode, n => {
    if (n === sopNode) return
    if (!isSopProcessCandidate(n, sopNode)) return
    if (isFullSopTemplate(n)) {
      candidates.push(n)
      return
    }
    const title = plainText(n)
    if (title === '招聘' || /招聘/.test(title)) {
      candidates.push(n)
    }
  })

  if (!candidates.length) return null

  let matched = findBestFlowInNodes(candidates, query, 1, sopNode)

  if (isRecruitmentQuery(query)) {
    let recruitRoot = null
    walkNodes(sopNode, n => {
      if (plainText(n) === '招聘') recruitRoot = n
    })
    if (recruitRoot) {
      matched = { node: recruitRoot, score: 999 }
    }
  }

  if (!matched) return null

  return {
    found: true,
    phase: 'sop',
    sopNode,
    sourceLabel: `SOP / ${plainText(matched.node)}`,
    flowNode: matched.node,
    query
  }
}

export function cloneFlowChildren(flowNode) {
  if (!flowNode || !flowNode.children) return []
  return flowNode.children
    .map(child => copyNodeTree({}, child, true, true))
    .filter(item => item && item.data && isValidNodeData(item.data.text))
}

export function flowContextLines(flowNode, maxDepth = 4) {
  if (!flowNode) return ''
  return subtreePlain(flowNode, 0, maxDepth)
}

/**
 * 查找可复用的执行流程
 * 招聘类需求优先命中 SOP「招聘」完整模板，再查同级 C/P
 */
export function searchExecutionFlow({ node, mindMap }) {
  const query = plainText(node)
  if (isInvalidNodeData(query)) {
    return {
      found: false,
      phase: 'invalid',
      message: '节点内容无效，请先填写有效需求后再补充流程'
    }
  }

  const root = findRoot(mindMap)
  if (!root) {
    return { found: false, phase: 'none', message: '缺失流程：导图未就绪' }
  }

  const sopNode = findSopNode(root)

  // 0. 招聘类：强制优先 SOP「招聘」完整流程
  if (isRecruitmentQuery(query)) {
    const sopMatch = searchSopFlow(root, query)
    if (sopMatch) return sopMatch
  }

  const parent = node.parent
  const siblings = parent ? parent.children.filter(item => item !== node) : []

  // 1. 同级 C、P（须为完整流程模板）
  const cpNodes = siblings.filter(isCpSibling)
  const cpWithFlow = cpNodes.filter(
    n => hasExecutionFlow(n) && isFullSopTemplate(n)
  )
  if (cpWithFlow.length) {
    const matched =
      findBestFlowInNodes(cpWithFlow, query, 0, sopNode) ||
      { node: cpWithFlow[0], score: 1 }
    return {
      found: true,
      phase: 'cp',
      sopNode,
      sourceLabel: `同级 ${plainText(matched.node)}`,
      flowNode: matched.node,
      query
    }
  }

  // 2. SOP 分支（非招聘类或未在步骤 0 命中）
  const sopMatch = searchSopFlow(root, query)
  if (sopMatch) return sopMatch

  // 3. 同级其它节点（须含概要或模块）
  const siblingFlows = siblings.filter(
    n => hasExecutionFlow(n) && isFullSopTemplate(n)
  )
  if (siblingFlows.length) {
    const matched = findBestFlowInNodes(siblingFlows, query, 1, sopNode)
    if (matched) {
      return {
        found: true,
        phase: 'sibling',
        sopNode,
        sourceLabel: `同级 ${plainText(matched.node)}`,
        flowNode: matched.node,
        query
      }
    }
  }

  // 4. 全局：优先 SOP 下节点
  const globalCandidates = []
  if (sopNode) {
    walkNodes(sopNode, n => {
      if (n !== sopNode && isFullSopTemplate(n)) globalCandidates.push(n)
    })
  }
  walkNodes(root, n => {
    if (n === node || n.isRoot) return
    if (node.isAncestor && node.isAncestor(n)) return
    if (sopNode && isNodeUnder(sopNode, n)) return
    if (hasExecutionFlow(n) && isFullSopTemplate(n)) globalCandidates.push(n)
  })
  const globalMatch = findBestFlowInNodes(globalCandidates, query, 2, sopNode)
  if (globalMatch) {
    const underSop = sopNode && isNodeUnder(sopNode, globalMatch.node)
    return {
      found: true,
      phase: underSop ? 'sop' : 'global',
      sopNode: underSop ? sopNode : sopNode || null,
      sourceLabel: `${underSop ? 'SOP' : '全局'} / ${plainText(globalMatch.node)}`,
      flowNode: globalMatch.node,
      query
    }
  }

  return {
    found: false,
    phase: 'none',
    message: '缺失流程：未在 SOP 中找到匹配的招聘/执行流程模板'
  }
}

export const PHASE_STATUS = {
  invalid: '节点数据无效，已跳过自动补充',
  cp: '正在对照同级 C/P 流程…',
  sibling: '正在对照同级流程…',
  sop: '正在 SOP 中检索流程…',
  sopSupplement: '正在按 SOP 实例化流程…',
  sopExecution: '正在实例化 SOP 执行步骤…',
  sopTodo: '正在发送待办…',
  global: '正在全图检索流程…',
  none: '缺失流程'
}
