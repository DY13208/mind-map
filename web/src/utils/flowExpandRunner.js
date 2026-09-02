import { streamChat } from '@/utils/workbuddyChat'
import { plainText, isInvalidNodeData, findFlowAssignee } from '@/utils/flowSearch'
import {
  buildFlowExpandPrompt,
  resolveSopTemplate,
  nodeUid
} from '@/utils/flowExpandPrompt'
import { parseMindmapChildren, describeParseMiss } from '@/utils/mindmapChildrenParse'
import { dispatchTodo, appendTodoNote } from '@/utils/sendTodo'

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

const ADD_CHILDREN_TOOL = {
  type: 'function',
  function: {
    name: 'add_mindmap_children',
    description:
      '把补充好的子节点树写回当前思维导图节点。必须调用。须含填满的数据字段，并在其后包含「代办人：xxx」。',
    parameters: {
      type: 'object',
      properties: {
        children: {
          type: 'array',
          description:
            '子节点列表。每项 {text, note?, children?}；须包含「代办人：具体人/角色」。',
          items: { type: 'object' }
        }
      },
      required: ['children']
    }
  }
}

function isPlaceholder(text) {
  return PLACEHOLDERS.includes(String(text || '').trim().toLowerCase())
}

function stripText(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim()
}

function nodeTreeText(item) {
  if (!item) return ''
  if (item.data && item.data.text != null) return stripText(item.data.text)
  return stripText(item.text)
}

/** 去掉误复制的 SOP 索引、系统工具清单等 */
function sanitizeInstanceChildren(children) {
  const isBlockedBranch = text => {
    const t = stripText(text)
    if (!t) return false
    if (/^sop$/i.test(t)) return true
    if (/^(系统|工具|应用|软件)(清单|列表)?$/i.test(t)) return true
    if (/^(品牌立项|线上运营)$/i.test(t)) return true
    if (/^(金蝶|吉客云|企业微信|钉钉|飞书)(\s*[（(]\d+[）)])?$/i.test(t)) {
      return true
    }
    return false
  }

  const walk = list => {
    return (list || [])
      .filter(item => !isBlockedBranch(nodeTreeText(item)))
      .map(item => {
        const next = { ...item }
        if (item.data) {
          next.data = { ...item.data }
        }
        if (item.children && item.children.length) {
          next.children = walk(item.children)
        }
        return next
      })
  }

  return walk(children)
}

function insertChildTrees(mindMap, node, trees) {
  if (node.children && node.children.length) {
    mindMap.execCommand('REMOVE_NODE', [...node.children])
  }
  mindMap.execCommand('INSERT_MULTI_CHILD_NODE', [node], trees)
}

function findAssigneeInTrees(trees) {
  let found = null
  const walk = list => {
    ;(list || []).forEach(item => {
      if (found || !item || !item.data) return
      const text = stripText(item.data.text)
      if (/^代办人/.test(text) || /^待办人/.test(text)) {
        const idx = Math.max(text.indexOf('：'), text.indexOf(':'))
        found = {
          text,
          name: idx >= 0 ? text.slice(idx + 1).trim() : ''
        }
        return
      }
      walk(item.children)
    })
  }
  walk(trees)
  return found
}

function findAssigneeLiveNode(root) {
  let found = null
  const walk = n => {
    if (found || !n) return
    const text = plainText(n)
    if (/^代办人/.test(text) || /^待办人/.test(text)) {
      found = n
      return
    }
    ;(n.children || []).forEach(walk)
  }
  ;(root.children || []).forEach(walk)
  return found
}

function applyFactsToTrees(trees, facts) {
  if (!facts || !trees) return trees
  const rules = []
  if (facts.department) {
    rules.push({
      keys: ['招聘部门', '所属部门', '部门'],
      value: `招聘部门：${facts.department}`
    })
  }
  if (facts.company) {
    rules.push({
      keys: ['公司主体', '公司'],
      value: `公司主体：${facts.company}`
    })
  }
  if (facts.position) {
    rules.push({
      keys: ['招聘岗位', '岗位名称', '岗位'],
      value: `招聘岗位：${facts.position}`
    })
  }
  if (facts.level) {
    rules.push({ keys: ['职级'], value: `职级：${facts.level}` })
  }
  if (facts.city) {
    rules.push({
      keys: ['招聘城市', '工作地点', '城市'],
      value: `招聘城市：${facts.city}`
    })
  }
  if (!rules.length) return trees

  const walk = list => {
    ;(list || []).forEach(item => {
      if (!item || !item.data) return
      const raw = stripText(item.data.text)
      const label = raw.split(/[：:]/)[0].trim()
      for (const rule of rules) {
        if (rule.keys.some(k => label === k || label.startsWith(k))) {
          const curVal = raw.includes('：') || raw.includes(':') ? raw : ''
          if (
            !curVal ||
            /IT部门|HR部门|待确认|待补充/.test(curVal) ||
            (facts.department &&
              rule.keys.some(k => ['招聘部门', '所属部门', '部门'].includes(k)) &&
              (/AI部/.test(curVal) &&
                facts.department !== 'AI部' &&
                /运营|电商|人事|财务/.test(facts.department))) ||
            (facts.department &&
              rule.keys.some(k => ['招聘部门', '所属部门', '部门'].includes(k)) &&
              !curVal.includes(facts.department) &&
              (/IT部门|HR部门|AI部/.test(curVal) || !/[：:]/.test(raw)))
          ) {
            item.data.text = rule.value
          }
          break
        }
      }
      walk(item.children)
    })
  }
  walk(trees)
  return trees
}

function ensureAssigneeInTrees(trees, assigneeName) {
  const hit = findAssigneeInTrees(trees)
  if (hit && hit.name) return trees
  const name = assigneeName || '部门负责人'
  const node = {
    data: { text: `代办人：${name}` },
    children: []
  }
  const attachAfterProvide = list => {
    if (!list || !list.length) return false
    for (let i = 0; i < list.length; i++) {
      const item = list[i]
      const label = stripText(item.data && item.data.text).split(/[：:]/)[0]
      if (/^(提供|模块|字段)$/.test(label)) {
        list.splice(i + 1, 0, node)
        return true
      }
      if (item.children && attachAfterProvide(item.children)) return true
    }
    return false
  }
  if (attachAfterProvide(trees)) return trees
  if (trees[0] && Array.isArray(trees[0].children)) {
    trees[0].children.push(node)
    return trees
  }
  trees.push(node)
  return trees
}

export function validateFlowExpandNode(node) {
  if (!node || node.isRoot) {
    return { ok: false, code: 'no_node', message: '请先在导图中选中一个节点' }
  }
  const text = plainText(node)
  if (isPlaceholder(text) || isInvalidNodeData(text)) {
    return { ok: false, code: 'invalid_node', message: '请先填写有效的节点内容' }
  }
  return { ok: true, label: text }
}

export async function runFlowExpandJob({
  mindMap,
  node,
  onStatus,
  signal,
  conversationId
}) {
  const validation = validateFlowExpandNode(node)
  if (!validation.ok) {
    throw new Error(validation.message)
  }

  const setStatus = text => {
    if (onStatus) onStatus(text)
  }

  setStatus('正在组装导图上下文…')

  let system
  let user
  let meta = {}
  try {
    const prompt = buildFlowExpandPrompt(mindMap, node)
    system = prompt.system
    user = prompt.user
    meta = prompt
  } catch (buildErr) {
    console.error('[flowExpand] build prompt failed', buildErr)
    throw new Error(
      '读取导图失败：' + ((buildErr && buildErr.message) || '未知错误')
    )
  }

  setStatus(
    meta.hasTemplate
      ? `WorkBuddy 正在按 SOP「${meta.templateLabel}」实例化…`
      : '未命中 SOP，WorkBuddy 正在根据导图内容硬编流程…'
  )

  const callWb = async (compact = false) => {
    let usr = user
    if (compact) {
      usr = [
        user.slice(0, 20000),
        '',
        '【重试】上次未解析到工具参数。请再次调用 add_mindmap_children，',
        'children 尽量紧凑，但仍须含完整提供字段（字段名：值）与「代办人：xxx」。'
      ].join('\n')
    }
    return streamChat({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: usr }
      ],
      stream: false,
      conversationId,
      extra: {
        tools: [ADD_CHILDREN_TOOL],
        tool_choice: {
          type: 'function',
          function: { name: 'add_mindmap_children' }
        }
      },
      signal,
      onEvent: label => {
        if (label) setStatus(label)
      }
    })
  }

  let result = await callWb(false)
  let children = parseMindmapChildren(result)
  if (!children.length) {
    console.warn(
      '[flowExpand] first parse empty',
      describeParseMiss(result),
      result
    )
    setStatus('首次未解析到节点，正在压缩重试…')
    result = await callWb(true)
    children = parseMindmapChildren(result)
  }
  if (!children.length) {
    const miss = describeParseMiss(result)
    console.warn('[flowExpand] empty children', miss, result)
    throw new Error(
      `WorkBuddy 未返回可解析节点（tool=${miss.toolCallCount}, content=${
        miss.contentPreview ? '有文本' : '空'
      }）。请再试一次；若持续失败请缩小 SOP 子树后重试`
    )
  }

  const { sopNode, templateNode } = resolveSopTemplate(mindMap, node)
  const fallbackAssignee = findFlowAssignee({
    sopNode,
    flowNode: templateNode || sopNode || node
  })
  children = ensureAssigneeInTrees(
    children,
    (fallbackAssignee && fallbackAssignee.name) ||
      (meta.facts && meta.facts.department
        ? `${meta.facts.department}负责人`
        : '部门负责人')
  )
  children = applyFactsToTrees(children, meta.facts)
  children = sanitizeInstanceChildren(children)

  insertChildTrees(mindMap, node, children)
  setStatus('子节点已生成，正在收尾…')

  const assigneeInfo = findAssigneeInTrees(children)
  const assigneeName =
    (assigneeInfo && assigneeInfo.name) ||
    (fallbackAssignee && fallbackAssignee.name) ||
    '部门负责人'
  const liveAssignee = findAssigneeLiveNode(node)
  const noteTarget = liveAssignee || node

  appendTodoNote(noteTarget, mindMap, {
    assignee: assigneeName,
    title: `处理：${plainText(node)}`,
    reply: '待办确认中（后台发送）'
  })

  // 待办走后台，不阻塞队列结束
  dispatchTodo({
    assignee: { name: assigneeName },
    title: `处理：${plainText(node)}`,
    detail: `流程已实例化，请确认「提供」中的数据项并推进后续步骤。`,
    context: plainText(node),
    conversationId: conversationId ? `${conversationId}-todo` : undefined
  })
    .then(todo => {
      appendTodoNote(noteTarget, mindMap, {
        assignee: assigneeName,
        title: `处理：${plainText(node)}`,
        reply: todo.content
      })
    })
    .catch(todoErr => {
      console.warn('[flowExpand] 代办发送失败', todoErr)
      appendTodoNote(noteTarget, mindMap, {
        assignee: assigneeName,
        title: `处理：${plainText(node)}`,
        reply: '待办接口未确认，请人工跟进'
      })
    })

  return {
    assigneeName,
    nodeLabel: plainText(node),
    nodeUid: nodeUid(node)
  }
}
