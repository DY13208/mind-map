/**
 * SOP / 流程中的「AI发起通知」节点：
 * - 识别通知类标题
 * - 自动判断阻塞（等待/确认/审批/阻塞）或继续
 * - WorkBuddy 派发 + 写入导图 CPDA 待办树
 */
import { dispatchTodo } from './sendTodo'
import { createRoomTodo, listRoomTodos } from './fileApi'

/** 通知类节点（命中任一即可） */
export const NOTIFY_TITLE_RE =
  /AI\s*发起\s*通知|发起通知|^通知\s*[：:]|知会|请通知|发送通知|^AI\s*[:：].*通知|抄送/i

/** 阻塞语义：发完后停住，等人完成待办再继续 */
export const BLOCK_TITLE_RE = /等待|确认|审批|阻塞|签核|复核通过/i

/** 明确非阻塞（知会类） */
export const CONTINUE_HINT_RE = /知会|抄送|仅通知|不阻塞|无需等待/i

export function stripNodeText(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/^[-*•●]\s*/, '')
    .trim()
}

export function isNotifyTitle(text) {
  return NOTIFY_TITLE_RE.test(stripNodeText(text))
}

/**
 * 是否阻塞：标题/附近上下文含等待类词，且没有「仅知会」类豁免
 */
export function shouldBlockNotify(text, contextText = '') {
  const blob = `${stripNodeText(text)}\n${stripNodeText(contextText)}`
  if (CONTINUE_HINT_RE.test(blob) && !/必须等待|务必确认|强制阻塞/.test(blob)) {
    return false
  }
  return BLOCK_TITLE_RE.test(blob)
}

export function parseAssigneeFromText(text) {
  const raw = stripNodeText(text)
  const m = raw.match(
    /^(?:代办人|待办人|接收人|负责人|通知人)\s*[：:]\s*(.+)$/
  )
  if (!m) return ''
  return String(m[1] || '')
    .replace(/[|｜].*$/, '')
    .trim()
}

/**
 * 从大纲文本抽取通知节点（按缩进父子关系取代办人 / 上下文）
 */
export function extractNotifyNodesFromOutline(outline) {
  const lines = String(outline || '').split(/\r?\n/)
  const items = []
  lines.forEach((line, index) => {
    const indent = (line.match(/^(\s*)/) || ['', ''])[1].length
    const text = stripNodeText(line.replace(/^(\s*)/, '').replace(/^[-*•●]\s*/, ''))
    if (!text || !isNotifyTitle(text)) return

    const nearby = []
    let assignee = ''
    for (let i = index + 1; i < lines.length && i < index + 24; i++) {
      const l = lines[i]
      if (!l || !l.trim()) continue
      const ind = (l.match(/^(\s*)/) || ['', ''])[1].length
      if (ind <= indent && i > index) break
      const t = stripNodeText(l.replace(/^(\s*)/, '').replace(/^[-*•●]\s*/, ''))
      if (!t) continue
      nearby.push(t)
      if (!assignee) {
        const a = parseAssigneeFromText(t)
        if (a) assignee = a
      }
    }
    // 向上找同级/父级代办人
    if (!assignee) {
      for (let i = index - 1; i >= 0 && i >= index - 30; i--) {
        const l = lines[i]
        const ind = (l.match(/^(\s*)/) || ['', ''])[1].length
        const t = stripNodeText(l.replace(/^(\s*)/, '').replace(/^[-*•●]\s*/, ''))
        if (!t) continue
        if (ind < indent) {
          const a = parseAssigneeFromText(t)
          if (a) {
            assignee = a
            break
          }
          if (ind === 0) break
        }
        if (ind === indent) {
          const a = parseAssigneeFromText(t)
          if (a) {
            assignee = a
            break
          }
        }
      }
    }

    const contextText = nearby.join('\n')
    const block = shouldBlockNotify(text, contextText)
    const notifyKey = `notify:${index}:${text.slice(0, 40)}`
    items.push({
      index,
      text,
      assignee: assignee || '负责人',
      block,
      nearby,
      contextText,
      notifyKey,
      detail: nearby.filter(t => !parseAssigneeFromText(t)).slice(0, 8).join('；')
    })
  })
  return items
}

/**
 * 处理通知节点：写入 CPDA 待办 + WorkBuddy 派发
 */
export async function processNotifyNodes({
  roomKey,
  nodes,
  sop,
  conversationId,
  onStatus,
  signal
} = {}) {
  const list = Array.isArray(nodes) ? nodes : []
  const results = []
  for (let i = 0; i < list.length; i++) {
    const node = list[i]
    if (onStatus) {
      onStatus(
        `通知 ${i + 1}/${list.length}：${node.block ? '阻塞派发' : '知会派发'}「${
          node.text
        }」→ ${node.assignee}`
      )
    }
    const title = node.text
    const note = [
      node.detail || '',
      `来源：${[sop && sop.id, sop && sop.title].filter(Boolean).join('：') || 'SOP'}`,
      node.block ? '完成此待办后流程才会继续。' : '知会类通知，流程已继续执行。'
    ]
      .filter(Boolean)
      .join('\n')

    let taskUid = ''
    let cpdaOk = false
    let cpdaError = ''
    try {
      const created = await createRoomTodo(roomKey, {
        text: title,
        note,
        assignee: node.assignee,
        block: !!node.block,
        sop_id: (sop && sop.id) || '',
        sop_uid: (sop && (sop.uid || (sop.uids && sop.uids[0]))) || '',
        notify_key: node.notifyKey,
        children: node.detail
          ? [{ text: `详情：${String(node.detail).slice(0, 200)}` }]
          : []
      })
      taskUid = (created && created.task_uid) || ''
      cpdaOk = !!taskUid
    } catch (err) {
      cpdaError = (err && err.message) || String(err || '写入待办失败')
      console.warn('[sopNotify] createRoomTodo failed', err)
    }

    let dispatchReply = ''
    let dispatchOk = false
    try {
      const todo = await dispatchTodo({
        assignee: { name: node.assignee },
        title,
        detail: note,
        context: [
          `房间：${roomKey}`,
          node.block ? '模式：阻塞（需完成待办后继续）' : '模式：知会（不阻塞）',
          cpdaOk ? `已写入导图待办 uid=${taskUid}` : `导图待办写入失败：${cpdaError}`,
          '请用一两句话确认已向该负责人说明任务。'
        ].join('\n'),
        conversationId: conversationId
          ? `${conversationId}-notify-${i}`
          : undefined,
        signal
      })
      dispatchReply = (todo && todo.content) || ''
      dispatchOk = !!(todo && todo.success)
    } catch (err) {
      dispatchReply = (err && err.message) || 'WorkBuddy 派发失败'
      console.warn('[sopNotify] dispatchTodo failed', err)
    }

    results.push({
      ...node,
      taskUid,
      cpdaOk,
      cpdaError,
      dispatchOk,
      dispatchReply
    })
  }
  return results
}

export function summarizeNotifyResults(results) {
  const list = Array.isArray(results) ? results : []
  const blocking = list.filter(r => r.block)
  const continued = list.filter(r => !r.block)
  return {
    total: list.length,
    blocking,
    continued,
    hasBlocking: blocking.length > 0,
    waitingTaskUids: blocking.map(r => r.taskUid).filter(Boolean)
  }
}

/** 检查阻塞待办是否都已进入「已完成」 */
export async function areWaitingTodosDone(roomKey, taskUids) {
  const uids = (taskUids || []).filter(Boolean)
  if (!uids.length) return { done: true, pending: [], completed: [] }
  const data = await listRoomTodos(roomKey, { includeCompleted: true })
  const pendingSet = new Set(
    ((data && data.pending) || []).map(t => t.uid).filter(Boolean)
  )
  const completedSet = new Set(
    ((data && data.completed) || []).map(t => t.uid).filter(Boolean)
  )
  const stillPending = uids.filter(uid => pendingSet.has(uid))
  const doneUids = uids.filter(uid => completedSet.has(uid))
  // 已不在待办且不在已完成：视为被删/挪走，不算完成
  const missing = uids.filter(
    uid => !pendingSet.has(uid) && !completedSet.has(uid)
  )
  return {
    done: stillPending.length === 0 && missing.length === 0,
    pending: stillPending,
    completed: doneUids,
    missing
  }
}
