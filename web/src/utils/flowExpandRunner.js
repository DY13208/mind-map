import { selectCandidates } from 'simple-mind-map/src/utils/fillConflict'
import { licenseTexts } from 'simple-mind-map/src/utils/licenseFacts'
import {
  visibleText,
  factKey,
  factKeys,
  cleanupNodes,
  presentFillTrees,
  isAutomaticNote
} from 'simple-mind-map/src/utils/fillFacts'
import { plainText, isInvalidNodeData } from '@/utils/flowSearch'
import { nodeUid } from '@/utils/flowExpandPrompt'
import {
  fillLocalKnowledge,
  localKnowledgeStatus,
  apiRequest
} from '@/utils/fileApi'
import { extractWikiFill, fillStatus } from '@/utils/structuredWikiFill'
import {
  buildWikiFillQuery,
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
  return PLACEHOLDERS.includes(
    String(text || '')
      .trim()
      .toLowerCase()
  )
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
    return {
      ok: false,
      code: 'invalid_node',
      message: '请先填写有效的节点内容'
    }
  }
  const label =
    text && !isPlaceholder(text) && !isInvalidNodeData(text)
      ? text
      : hasMedia
      ? mediaLabel(data)
      : text
  return { ok: true, label }
}

function existingChildTexts(node) {
  const live = (node.children || []).map(child => plainText(child))
  const raw = ((node.nodeData && node.nodeData.children) || []).map(child =>
    String((child.data && child.data.text) || '')
      .replace(/<[^>]*>/g, '')
      .trim()
  )
  return [...new Set([...live, ...raw].filter(Boolean))]
}

async function hydrate(mindMap, node) {
  const cooperate = mindMap.cooperate
  if (cooperate && typeof cooperate.ensurePlacementParent === 'function') {
    await cooperate.ensurePlacementParent(node)
  }
  const uid = nodeUid(node)
  return mindMap.renderer && mindMap.renderer.findNodeByUid
    ? mindMap.renderer.findNodeByUid(uid) || node
    : node
}

async function repairExistingFill(mindMap, node, titles, displayNames, signal) {
  if (!['股东', '注册地址', '注册资本', '经营许可', '法人代表'].includes(titles[titles.length - 1])) return
  const parentId = nodeUid(node),
    children = (node.children || []).filter(child => {
      const data = dataOfNode(child)
      return (
        data &&
        typeof data === 'object' &&
        !(child.children || []).length &&
        !(child.nodeData?.children || []).length &&
        !Number(data.childCount) &&
        !data.image &&
        !data.attachmentId &&
        !data.attachmentUrl &&
        !data.attachmentName &&
        !data.hyperlink &&
        (!data.note || isAutomaticNote(data.note))
      )
    })
  if (!children.length) return
  const records = [
    { uid: parentId, data: { text: titles[titles.length - 1] } }
  ].concat(
    children.map(child => ({
      uid: nodeUid(child),
      parentId,
      data: dataOfNode(child)
    }))
  )
  const plan = cleanupNodes(records),
    drop = new Set(plan.deletes)
  const eligible = new Set(plan.updates.map(u => u.uid))
  const keys = factKeys(
    children.map(child => dataOfNode(child).text),
    titles[titles.length - 1]
  )
  if (titles[titles.length - 1] === '股东')
    children.forEach((child, index) => {
      const data = dataOfNode(child),
        key = String(data.autoFill?.key || '').replace(
          /(\d+(?:\.\d+)?)万元/g,
          (_, n) => Number(n) * 10000 + '元'
        )
      if (
        !eligible.has(nodeUid(child)) &&
        !(data.autoFill?.version === 2 && key === keys[index])
      )
        return
      const wanted = presentFillTrees(
        [{ data, children: [] }],
        titles,
        displayNames
      )
      if (!wanted.some(t => t.data.text === data.text)) drop.add(nodeUid(child))
    })
  const updates = plan.updates.filter(
    u =>
      !drop.has(u.uid) &&
      !!dataOfNode(children.find(c => nodeUid(c) === u.uid)).note
  )
  if (titles[titles.length - 1] === '经营许可')
    for (const child of children) {
      const data = dataOfNode(child)
      if (
        !(
          data.autoFill?.version === 2 &&
          data.autoFill.key === factKey(data.text, '经营许可')
        )
      )
        continue
      const wanted = licenseTexts(data.text)
      if (!wanted.length) {
        drop.add(nodeUid(child))
        continue
      }
      if (wanted.length !== 1) continue
      const prefix =
        visibleText(data.text).match(
          /^(?:资料日期[^；]{0,30}|(?:19|20)\d{2}[^；]{0,25})；/
        )?.[0] || ''
      const text = prefix + wanted[0]
      if (text !== data.text) {
        const old = updates.findIndex(u => u.uid === nodeUid(child))
        if (old >= 0) updates.splice(old, 1)
        updates.push({
          uid: nodeUid(child),
          data: {
            text,
            note: '',
            autoFill: { ...data.autoFill, key: factKey(text, '经营许可') }
          }
        })
      }
    }
  for (let i = updates.length - 1; i >= 0; i--)
    if (drop.has(updates[i].uid)) updates.splice(i, 1)
  if (!drop.size && !updates.length) return
  const roomId = mindMap.cooperate?.httpRoomKey
  const originals = new Map(
    children.map(child => [
      nodeUid(child),
      { text: dataOfNode(child).text, note: dataOfNode(child).note }
    ])
  )
  if (roomId)
    await apiRequest(`/api/files/${encodeURIComponent(roomId)}/versions`, {
      method: 'POST',
      body: JSON.stringify({ name: '补齐修复前备份' })
    })
  if (signal?.aborted)
    throw Object.assign(new Error('已取消'), { name: 'AbortError' })
  const unchanged = child => {
    const data = dataOfNode(child),
      old = originals.get(nodeUid(child))
    return (
      data.text === old.text &&
      data.note === old.note &&
      !(child.children || []).length &&
      !(child.nodeData?.children || []).length &&
      !Number(data.childCount) &&
      !data.image &&
      !data.attachmentId &&
      !data.attachmentUrl &&
      !data.attachmentName &&
      !data.hyperlink
    )
  }
  for (const update of updates) {
    const child = children.find(c => nodeUid(c) === update.uid)
    if (unchanged(child))
      mindMap.execCommand('SET_NODE_DATA', child, update.data, {
        fillRepair: true,
        expected: originals.get(update.uid)
      })
  }
  const targets = children.filter(c => drop.has(nodeUid(c)) && unchanged(c))
  if (targets.length)
    mindMap.execCommand('REMOVE_NODE', targets, { fillRepair: true })
}

export async function runFlowExpandJob({
  mindMap,
  node,
  onStatus,
  signal,
  localMode = 'commit',
  localOnly = false,
  autoCommit = false,
  revision,
  expectedContext,
  conflictSelection
}) {
  const started = Date.now()
  const validation = validateFlowExpandNode(node)
  if (!validation.ok) throw new Error(validation.message)
  const setStatus = text => {
    if (onStatus) onStatus(text)
  }
  const checkAbort = () => {
    if (signal && signal.aborted)
      throw Object.assign(new Error('已取消'), { name: 'AbortError' })
  }
  node = await hydrate(mindMap, node)
  checkAbort()
  const titles = wikiFillTitles(node)
  const requestRoom = mindMap.cooperate?.httpRoomKey
  let displayNames = {}
  if (titles[titles.length - 1] === '股东')
    displayNames =
      (await localKnowledgeStatus().catch(() => ({}))).displayNames || {}
  checkAbort()
  if (localMode === 'commit' && !localOnly)
    if (!conflictSelection) await repairExistingFill(mindMap, node, titles, displayNames, signal)
  node = await hydrate(mindMap, node)
  checkAbort()
  const query = titles.join('的') || buildWikiFillQuery(node)
  if (!query) throw new Error('无法根据父节点组句')
  if (!localOnly) setStatus('正在从 wiki-compiler 检索…')
  const found = localOnly
    ? { results: [] }
    : await searchWikiCompiler(query, { signal, top_k: 8 })
  const wikiMs = Date.now() - started
  const excludeUids = []
  const remember = n => {
    const uid = nodeUid(n)
    if (uid) excludeUids.push(uid)
    for (const child of n.children || []) remember(child)
  }
  for (const child of node.children || []) remember(child)
  for (const child of node.nodeData?.children || []) {
    if (child.data?.uid) excludeUids.push(child.data.uid)
  }
  let extracted = extractWikiFill(
    found.results,
    titles,
    existingChildTexts(node),
    { excludeUids }
  )
  const wikiSignature = JSON.stringify(found.results)
  if (conflictSelection && !localOnly) {
    if (conflictSelection.wikiSignature !== wikiSignature || JSON.stringify(titles) !== JSON.stringify(conflictSelection.titles) || requestRoom !== conflictSelection.roomId) throw new Error('候选资料或节点已经变化，请重新补齐')
    if (extracted.reason !== 'conflict') throw new Error('资料结果已变化，请重新补齐')
    const selected = selectCandidates(extracted.conflictCandidates, conflictSelection.ids, extracted.selectionMode === 'multiple')
    extracted = { ...extracted, reason:'success', trees:selected.map(c=>({data:{text:c.text},children:[]})) }
  }
  let localContext
  if (
    localOnly ||
    ['no_results', 'no_match', 'empty_field'].includes(extracted.reason)
  ) {
    const roomId = mindMap.cooperate && mindMap.cooperate.httpRoomKey
    if (!roomId) {
      extracted = { ...extracted, reason: 'local_room_required' }
    } else {
      if (
        expectedContext &&
        (roomId !== expectedContext.roomId ||
          JSON.stringify(titles) !== JSON.stringify(expectedContext.titles))
      )
        throw new Error('节点路径或脑图已经变化，请重新补齐')
      setStatus('正在查询本地缓存…')
      localContext = { roomId, titles: titles }
      extracted = await fillLocalKnowledge(
        {
          roomId,
          titles: titles,
          existingTexts: existingChildTexts(node),
          mode: localMode,
          ...(revision ? { revision } : {}),
          ...(conflictSelection ? { selectedCandidateIds: conflictSelection.ids } : {})
        },
        { signal, onStatus: setStatus }
      )
    }
  }
  if (
    localContext &&
    localMode === 'preview' &&
    autoCommit &&
    extracted.canCommit
  ) {
    checkAbort()
    setStatus('正在写入已核实原文…')
    extracted = await fillLocalKnowledge(
      {
        roomId: localContext.roomId,
        titles: titles,
        existingTexts: existingChildTexts(node),
        mode: 'commit',
        revision: extracted.revision
      },
      { signal, onStatus: setStatus }
    )
    localMode = 'commit'
  }
  checkAbort()
  node = await hydrate(mindMap, node)
  checkAbort()
  if (
    localContext &&
    (JSON.stringify(wikiFillTitles(node)) !== JSON.stringify(titles) ||
      mindMap.cooperate?.httpRoomKey !== localContext.roomId)
  )
    throw new Error('节点路径或脑图已经变化，请重新补齐')
  if (
    localContext &&
    (localMode === 'preview' ||
      extracted.reason === 'local_revision_changed' ||
      !extracted.trees?.length)
  ) {
    const result = {
      ...extracted,
      trees: [],
      ...(extracted.reason === 'conflict' ? { selectionContext:{roomId:requestRoom,titles} } : {}),
      localContext,
      nodeLabel: validation.label,
      nodeUid: nodeUid(node),
      query,
      written: 0
    }
    result.status = fillStatus(result)
    result.timings = {
      ...extracted.timings,
      wikiMs,
      jobTotalMs: Date.now() - started
    }
    setStatus(result.status)
    return result
  }
  if (
    (localContext && localMode === 'commit' && (localOnly || autoCommit)) ||
    (!localContext &&
      localMode === 'preview' &&
      ['success', 'already_exists'].includes(extracted.reason))
  ) {
    if (!conflictSelection) await repairExistingFill(mindMap, node, titles, displayNames, signal)
    node = await hydrate(mindMap, node)
    checkAbort()
  }
  if (
    JSON.stringify(wikiFillTitles(node)) !== JSON.stringify(titles) ||
    mindMap.cooperate?.httpRoomKey !== requestRoom
  )
    throw new Error('节点路径或脑图已经变化，请重新补齐')
  if (
    mindMap.renderer?.findNodeByUid &&
    !mindMap.renderer.findNodeByUid(nodeUid(node))
  )
    throw new Error('节点已删除，请重新选择节点')
  const insertStarted = Date.now()
  extracted.trees = presentFillTrees(
    extracted.trees || [],
    titles,
    displayNames
  )
  const oldTexts = existingChildTexts(node)
  const presentedOld = presentFillTrees(
    oldTexts.map(text => ({ data: { text }, children: [] })),
    titles,
    displayNames
  ).map(t => t.data.text)
  const seen = new Set(
    factKeys(oldTexts.concat(presentedOld), titles[titles.length - 1])
  )
  const incomingKeys = factKeys(
    (extracted.trees || []).map(t => t.data.text),
    titles[titles.length - 1]
  )
  const trees = (extracted.trees || []).filter((tree, index) => {
    const text = incomingKeys[index]
    if (!visibleText(tree.data.text)) return false
    delete tree.data.note
    tree.data.autoFill = {
      ...tree.data.autoFill,
      version: 2,
      field: titles[titles.length - 1],
      key: text
    }
    if (seen.has(text)) return false
    seen.add(text)
    return true
  })
  if (trees.length)
    mindMap.execCommand('INSERT_MULTI_CHILD_NODE', [node], trees)
  const result = {
    ...extracted,
    ...(extracted.reason === 'conflict' ? { selectionContext:{roomId:requestRoom,titles,wikiSignature} } : {}),
    ...(localContext ? { localContext } : {}),
    nodeLabel: validation.label,
    nodeUid: nodeUid(node),
    query,
    written: trees.length
  }
  result.timings = {
    ...extracted.timings,
    wikiMs,
    insertMs: Date.now() - insertStarted,
    jobTotalMs: Date.now() - started
  }
  if (extracted.trees.length && !trees.length) result.reason = 'already_exists'
  result.status = fillStatus(result)
  setStatus(result.status)
  return result
}
