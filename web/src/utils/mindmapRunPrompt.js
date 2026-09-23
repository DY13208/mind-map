/**
 * 按脑图节点派发任务时的提示词组装。
 *
 * 关键点：点某个节点「运行」时，这条任务要**只做这一步**，并且拿前面几步已经跑出来的结果当输入
 * 继续往下做 —— 而不是把整个脑图当 SOP 从头再跑一遍。
 *
 * 上下文从节点自身拿：`getData('text'/'note')` + `parent` / `children`
 * （simple-mind-map 的节点对象自带 parent 链，不用拿到 mindMap 实例）。
 */

const RESULT_TITLE_RE = /^运行输出\s*[·・:：]/
const MAX_PATH_DEPTH = 6
const MAX_RESULT_CHARS = 1200
const MAX_RESULT_ROWS = 3

function cleanText(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

export function nodeText(node) {
  if (!node || typeof node.getData !== 'function') return ''
  return cleanText(node.getData('text'))
}

export function nodeNote(node) {
  if (!node || typeof node.getData !== 'function') return ''
  return String(node.getData('note') || '').trim()
}

/** 结果分支的标题长这样：运行输出 · 09-23 09:25 */
export function isResultNode(node) {
  return RESULT_TITLE_RE.test(nodeText(node))
}

// D 节点（SOP 目标节点）：标题形如「D：刘欢招聘」。
// 跟项目既有约定保持一致（见 utils/sopRegistryPrompt.js 的 D_REGISTRY_RE）：D 后面不能紧跟数字。
const D_NODE_RE = /^(D)(?!\d)\s*[：:]\s*(.+)$/i

// 下面两个正则与 utils/jobResultWriter.js 里的同名规则对应（这里保持零依赖，便于单测）
const FOLLOW_UP_PLACEHOLDER_RE = /^✍️\s*下一步/
const TASK_CONTAINER_RE = /^任务\s*[·・:：]/
const MAX_FOLLOW_UP_CHARS = 600

/** 是不是 D 节点（D：xxx / D: xxx） */
export function isDNode(node) {
  const text = nodeText(node)
    .replace(/^[-*•●]\s*/, '')
    .replace(/^【\s*/, '')
    .replace(/\s*】$/, '')
    .trim()
  return D_NODE_RE.test(text)
}

/** 一个父节点下，所有子节点身上挂的概论文本 */
function generalizationTexts(parent) {
  const rows = []
  childNodes(parent).forEach(child => {
    if (typeof child.getData !== 'function') return
    const raw = child.getData('generalization')
    const list = Array.isArray(raw) ? raw : raw ? [raw] : []
    list.forEach(item => {
      const text = cleanText(item && item.text)
      // 还是「✍️ 下一步做什么？」这句默认文案，说明用户没改过 —— 不算指令
      if (!text || FOLLOW_UP_PLACEHOLDER_RE.test(text)) return
      rows.push({ owner: nodeText(child), text })
    })
  })
  return rows
}

/**
 * 用户在图上概要里填的「下一步做什么」。
 * 优先看最后一个任务容器（D 节点会先建容器，结果与概要都在里面），
 * 没有容器就看节点自己的子节点。取最后一条（最新的一次运行留下的）。
 */
export function latestFollowUpNote(node, options = {}) {
  if (!node) return null
  const maxChars = Number(options.maxFollowUpChars) || MAX_FOLLOW_UP_CHARS
  const containers = childNodes(node).filter(child =>
    TASK_CONTAINER_RE.test(nodeText(child))
  )
  const container = containers[containers.length - 1]
  let rows = container ? generalizationTexts(container) : []
  if (!rows.length) rows = generalizationTexts(node)
  if (!rows.length) return null
  const pick = rows[rows.length - 1]
  return {
    owner: pick.owner,
    text:
      pick.text.length > maxChars
        ? pick.text.slice(0, maxChars) + '…'
        : pick.text
  }
}

export function childNodes(node) {
  return (node && node.children) || []
}

/** 从当前节点往上的祖先链（root → 当前节点，最长的 maxDepth 级） */
export function collectNodePath(node, maxDepth = MAX_PATH_DEPTH) {
  const path = []
  let cur = node
  let guard = 0
  while (cur && !cur.isRoot && guard < 40) {
    path.unshift(cur)
    cur = cur.parent
    guard += 1
  }
  return path.slice(-maxDepth)
}

/** 结果节点里的「待补充数据」分支（写回时会单独列一支） */
function missingBranch(resultNode) {
  const branch = childNodes(resultNode).find(item =>
    /^❗?\s*待补充数据/.test(nodeText(item))
  )
  if (!branch) return []
  return childNodes(branch)
    .map(item => nodeText(item))
    .filter(Boolean)
}

/**
 * 上次运行还缺的数据 —— 下次派发时带上，能补就补掉。
 * 从最后一个任务容器的「运行输出」里找「待补充数据」分支。
 */
export function latestMissingData(node, options = {}) {
  const container = lastContainer(node)
  if (!container) return []
  const results = childNodes(container).filter(isResultNode)
  const latest = results[results.length - 1]
  if (!latest) return []
  const limit = Number(options.limit) || 8
  return missingBranch(latest).slice(0, limit)
}

/** 一个节点下所有结果分支：直属的 + 任务容器里的（新结构结果在容器内） */
function resultNodesOf(node) {
  const out = []
  childNodes(node).forEach(child => {
    if (isResultNode(child)) {
      out.push(child)
      return
    }
    if (TASK_CONTAINER_RE.test(nodeText(child))) {
      childNodes(child).forEach(grand => {
        if (isResultNode(grand)) out.push(grand)
      })
    }
  })
  return out
}

/** 结果分支下面「产物文件」那一支里的文件名清单 */
function resultFiles(resultNode) {
  const branch = childNodes(resultNode).find(
    item => nodeText(item) === '产物文件'
  )
  if (!branch) return []
  return childNodes(branch)
    .map(item => nodeText(item))
    .filter(Boolean)
}

/** 结果分支的正文：把下面各层子节点的文字拼出来（节点文本本身有截断，能看个大概） */
function resultBody(resultNode) {
  const lines = []
  const walk = (parent, depth) => {
    childNodes(parent).forEach(item => {
      const text = nodeText(item)
      if (text) lines.push(`${'  '.repeat(depth)}- ${text}`)
      walk(item, depth + 1)
    })
  }
  walk(resultNode, 0)
  return lines.join('\n')
}

function pushResult(rows, seen, ownerNode, resultNode, maxChars) {
  const uid =
    (resultNode.getData && resultNode.getData('uid')) || nodeText(resultNode)
  if (seen.has(uid)) return
  seen.add(uid)
  const body = resultBody(resultNode)
  rows.push({
    owner: nodeText(ownerNode),
    title: nodeText(resultNode),
    text: body.length > maxChars ? body.slice(0, maxChars) + '…' : body,
    files: resultFiles(resultNode)
  })
}

/**
 * 上游几步的结果。只收**祖先链**上各节点的结果分支，
 * 且**跳过当前节点自己的**（否则 AI 会以为这一步已经做完）。
 */
export function collectPriorResults(pathNodes, options = {}) {
  const rows = []
  const seen = new Set()
  const maxChars = Number(options.maxResultChars) || MAX_RESULT_CHARS
  const limit = Number(options.maxResults) || MAX_RESULT_ROWS
  const list = pathNodes || []
  list.forEach((node, index) => {
    const isCurrent = index === list.length - 1
    if (isCurrent) return
    resultNodesOf(node).forEach(child => {
      pushResult(rows, seen, node, child, maxChars)
    })
  })
  return rows.slice(-limit)
}

/**
 * 当前这一步的要求：节点下面写的内容（去掉结果分支与任务容器）。
 * 递归两层 —— SOP 里常见的 C/P/D 这类一层套一层也带出来，缩进体现层级。
 */
export function collectRequirements(node, maxDepth = 2) {
  const lines = []
  const walk = (parent, depth) => {
    childNodes(parent).forEach(child => {
      if (isResultNode(child)) return
      // 任务容器是历史运行记录，不是这一步的要求
      if (TASK_CONTAINER_RE.test(nodeText(child))) return
      const text = nodeText(child)
      if (text) lines.push(`${'  '.repeat(depth)}- ${text}`)
      if (depth + 1 < maxDepth) walk(child, depth + 1)
    })
  }
  walk(node, 0)
  return lines
}

/** 某个节点下最后一个任务容器 */
function lastContainer(node) {
  const containers = childNodes(node).filter(child =>
    TASK_CONTAINER_RE.test(nodeText(child))
  )
  return containers[containers.length - 1] || null
}

/**
 * 这个节点上一次跑出来的结果（重跑时用：接着上次往下做，而不是重来）。
 * 从它最后一个任务容器里的「运行输出 · …」节点取正文（note 里存的是完整原文）。
 */
export function latestSelfResult(node, options = {}) {
  const container = lastContainer(node)
  if (!container) return null
  const results = childNodes(container).filter(isResultNode)
  const latest = results[results.length - 1]
  if (!latest) return null
  const body = resultBody(latest).trim()
  if (!body) return null
  const maxChars = Number(options.maxResultChars) || 1000
  return {
    title: nodeText(latest),
    text: body.length > maxChars ? body.slice(0, maxChars) + '…' : body
  }
}

function priorResultsBlock(results) {
  if (!results.length) return ''
  const lines = [
    '前面几步已经跑过，结果如下。请**在它们的基础上继续**，不要重头执行整个流程，也不要重复这些已经做完的事：'
  ]
  results.forEach((row, index) => {
    lines.push('')
    lines.push(
      `${index + 1}) 节点「${row.owner || '上游'}」的${row.title}`
    )
    if (row.text) lines.push(row.text)
    if (row.files.length) {
      lines.push(`产物文件：${row.files.join('、')}`)
    }
  })
  return lines.join('\n')
}

/**
 * 组装「按节点运行」的任务内容。
 * @param {Object} payload
 * @param {Object} payload.node  运行节点（simple-mind-map 节点对象）
 * @param {String} payload.room  房间 key（可选）
 * @param {String} payload.cwd   执行主机的工作目录（可选，用来告诉它产物写哪）
 */
export function buildNodeRunPrompt({ node, room = '', cwd = '' } = {}) {
  const title = nodeText(node)
  const pathNodes = collectNodePath(node)
  const pathText = pathNodes.map(nodeText).filter(Boolean).join(' → ')
  const stepIndex = pathNodes.length
  const requirements = collectRequirements(node)
  const priors = collectPriorResults(pathNodes)

  const lines = ['【脑图流程的一步 · 只做这一步，不要重头跑整张脑图】']
  if (room) lines.push(`房间：${room}`)
  // 「节点：xxx」这一行的格式别改 —— 运行历史靠它认出记录属于哪个节点
  lines.push(`节点：${title || '（未命名节点）'}`)
  if (pathText) {
    lines.push(
      `路径：${pathText}${stepIndex ? `（第 ${stepIndex} 步）` : ''}`
    )
  }

  if (requirements.length) {
    lines.push('')
    lines.push('这一步的要求：')
    requirements.forEach(line => lines.push(line))
  }

  const priorBlock = priorResultsBlock(priors)
  if (priorBlock) {
    lines.push('')
    lines.push(priorBlock)
  } else if (stepIndex > 1) {
    lines.push('')
    lines.push(
      '前面几步还没有跑出结果；如果需要上游输入，先说明缺什么，不要凭空假设。'
    )
  }

  const followUp = latestFollowUpNote(node)
  const selfResult = latestSelfResult(node)
  if (selfResult) {
    lines.push('')
    lines.push('【这个节点上一次跑出来的结果 · 接着往下做，不要重来】')
    lines.push(selfResult.title)
    lines.push(selfResult.text)
  }

  const missing = latestMissingData(node).filter(
    // 上一次的结果块里已经带了这一段就不重复了
    text => !selfResult || !selfResult.text.includes(text)
  )
  if (missing.length) {
    lines.push('')
    lines.push('【上次还缺的数据 · 这次有就补上，没有就别编】')
    missing.forEach(text => lines.push(`- ${text}`))
  }

  if (followUp) {
    lines.push('')
    lines.push('【你在图上概要里写的下一步】')
    lines.push(followUp.text)
    lines.push('这次就按这个来 —— 它比下面默认的流程描述更优先。')
  }

  lines.push('')
  lines.push(`请只完成「${title || '当前节点'}」这一步：`)
  lines.push(
    '1. 把上面的前序结果当作已知输入，不要重新收集或分析已经做过的部分；' +
      '它们是背景，不要原样复述进输出 —— 输出只写这一步的结论与产物。'
  )
  lines.push(
    `2. 需要上游文件就直接读（产物一般在 ${
      cwd || '执行主机的工作目录'
    } 下），这次要产出的文件请集中写到该工作目录的 output 子目录，文件名带上日期；`
  )
  lines.push('3. 输出要**精简**：脑图只放核心，过程、日志、代码都不要写进去。按这个结构写：')
  lines.push('   ## 一句话结论    → 1～2 句说清这一步的结果')
  lines.push('   ## 关键要点      → 最多 5 条，每条一行、不超过 60 字')
  lines.push(
    '   ## 待补充数据    → 这一步缺什么数据就单独列在这里，一行一条「字段 —— 为什么要 / 找谁拿」；不缺就写「无」'
  )
  lines.push('   ## 产出          → 这次产出的文件名 + 一句话说明；没有就写「无」')
  lines.push('4. 缺数据必须在「待补充数据」里点名，不要用假设的数字或占位内容凑答案。')
  return lines.join('\n')
}

/** 「继续执行」用：用户输入为主，后面附上当前节点与前序结果的背景 */
export function buildFollowUpPrompt(text, { node, room = '', cwd = '' } = {}) {
  const ask = String(text || '').trim()
  const title = nodeText(node)
  const pathNodes = collectNodePath(node)
  const pathText = pathNodes.map(nodeText).filter(Boolean).join(' → ')
  const priors = collectPriorResults(pathNodes)
  const lines = [ask || `继续完成「${title || '当前节点'}」`]
  lines.push('')
  lines.push('【背景 · 脑图当前节点】')
  if (room) lines.push(`房间：${room}`)
  if (pathText) lines.push(`路径：${pathText}`)
  lines.push(`当前节点：${title || '（未命名节点）'}`)
  if (cwd) lines.push(`工作目录：${cwd}`)
  const priorBlock = priorResultsBlock(priors)
  if (priorBlock) {
    lines.push('')
    lines.push(priorBlock)
  }
  const followUp = latestFollowUpNote(node)
  if (followUp) {
    lines.push('')
    lines.push('你在图上概要里写的下一步：')
    lines.push(followUp.text)
  }
  const missing = latestMissingData(node)
  if (missing.length) {
    lines.push('')
    lines.push('上次还缺的数据（有就补上，没有就别编）：')
    missing.forEach(text => lines.push(`- ${text}`))
  }
  lines.push('')
  lines.push('请接着上面的进度做，不要重头执行整个流程。')
  lines.push(
    '输出照旧精简：## 一句话结论 / ## 关键要点 / ## 待补充数据 / ## 产出，过程与日志不要写。'
  )
  return lines.join('\n')
}
