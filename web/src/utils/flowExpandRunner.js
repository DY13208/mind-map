import { plainText, isInvalidNodeData } from '@/utils/flowSearch'
import { nodeUid } from '@/utils/flowExpandPrompt'
import { streamChat } from '@/utils/agentChat'
import {
  buildAbbreviateMessages,
  buildWikiFillQuery,
  compactEvidence,
  parseAbbreviatedLines,
  resultsToChildTrees,
  searchWikiCompiler,
  wikiFillTitles
} from '@/utils/wikiNodeFill'

const PLACEHOLDERS = [
  '',
  '分支主题',
  '子主题',
  '概要',
  '中心主题',
  'branch topic',
  'sub topic',
  'central topic'
]

function isPlaceholder(text) {
  return PLACEHOLDERS.includes(String(text || '').trim().toLowerCase())
}

function dataOfNode(node) {
  if (!node) return {}
  if (node.getData) return node.getData() || {}
  return (node.nodeData && node.nodeData.data) || node.data || {}
}

function hasKnowledgePayload(node) {
  const data = dataOfNode(node)
  return !!(
    data.image ||
    data.attachmentId ||
    data.attachmentUrl ||
    data.attachmentName ||
    data.attachmentExtractedText ||
    data.imageOcrText ||
    data.imageExtractedText
  )
}

function mediaLabel(data) {
  if (!data) return '媒体节点'
  if (data.imageTitle) return String(data.imageTitle).trim()
  if (data.attachmentName) return String(data.attachmentName).trim()
  if (data.image) return '节点图片'
  if (data.attachmentId || data.attachmentUrl) return '节点附件'
  return '媒体节点'
}

export function validateFlowExpandNode(node) {
  if (!node || node.isRoot) {
    return { ok: false, code: 'no_node', message: '请先在导图中选中一个节点' }
  }
  const text = plainText(node)
  const data = dataOfNode(node)
  const hasMedia = hasKnowledgePayload(node)
  if (!hasMedia && (isPlaceholder(text) || isInvalidNodeData(text))) {
    return { ok: false, code: 'invalid_node', message: '请先填写有效的节点内容' }
  }
  const label =
    text && !isPlaceholder(text) && !isInvalidNodeData(text)
      ? text
      : hasMedia
        ? mediaLabel(data)
        : text
  return { ok: true, label }
}

async function abbreviateEvidence(query, lines, signal) {
  const controller =
    typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = setTimeout(() => {
    if (controller) controller.abort()
  }, 25000)
  const onAbort = () => {
    if (controller) controller.abort()
  }
  if (signal && controller) signal.addEventListener('abort', onAbort)
  try {
    const reply = await streamChat({
      messages: buildAbbreviateMessages(query, lines),
      stream: false,
      signal: controller ? controller.signal : signal
    })
    const parsed = parseAbbreviatedLines(reply && reply.content)
    if (parsed.length) return parsed
  } catch (error) {
    if (signal && signal.aborted) throw error
  } finally {
    clearTimeout(timer)
    if (signal && controller) signal.removeEventListener('abort', onAbort)
  }
  return compactEvidence(lines)
}

function existingChildTexts(node) {
  return (node && node.children ? node.children : [])
    .map(child => plainText(child))
    .filter(Boolean)
}

export async function runFlowExpandJob({ mindMap, node, onStatus, signal }) {
  const validation = validateFlowExpandNode(node)
  if (!validation.ok) throw new Error(validation.message)

  const setStatus = text => {
    if (onStatus) onStatus(text)
  }

  const titles = wikiFillTitles(node)
  const query = titles.join('的') || buildWikiFillQuery(node)
  if (!query) throw new Error('无法根据父节点组句')

  setStatus('正在从 wiki-compiler 检索…')
  const found = await searchWikiCompiler(query, { signal, top_k: 8 })
  const evidence = resultsToChildTrees(
    found.results,
    existingChildTexts(node),
    query,
    titles
  ).map(item => item.data.text)
  if (!evidence.length) {
    setStatus('未检索到内容，未写入')
    return {
      nodeLabel: validation.label,
      nodeUid: nodeUid(node),
      query,
      written: 0
    }
  }

  setStatus('正在简写检索结果…')
  const lines = await abbreviateEvidence(query, evidence, signal)
  const seen = new Set(existingChildTexts(node))
  const trees = []
  for (const line of lines) {
    if (!line || seen.has(line)) continue
    trees.push({ data: { text: line }, children: [] })
    seen.add(line)
  }
  if (!trees.length) {
    setStatus('未检索到内容，未写入')
    return {
      nodeLabel: validation.label,
      nodeUid: nodeUid(node),
      query,
      written: 0
    }
  }

  mindMap.execCommand('INSERT_MULTI_CHILD_NODE', [node], trees)
  setStatus('已写入 ' + trees.length + ' 条子节点')
  return {
    nodeLabel: validation.label,
    nodeUid: nodeUid(node),
    query,
    written: trees.length
  }
}
