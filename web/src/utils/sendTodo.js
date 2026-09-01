import { streamChat } from './workbuddyChat'

/**
 * 通过 WorkBuddy 向流程负责人发送待办，并在节点备注中留下记录
 */
export async function dispatchTodo({
  assignee,
  title,
  detail,
  context,
  onEvent,
  signal
}) {
  const assigneeName = (assignee && assignee.name) || '负责人'
  const result = await streamChat({
    messages: [
      {
        role: 'system',
        content:
          '你是良策协作助手。根据思维导图流程节点，为指定负责人创建待办任务。用一两句话确认：已发送给谁、任务内容是什么。'
      },
      {
        role: 'user',
        content: [
          `请为「${assigneeName}」创建待办：`,
          `标题：${title}`,
          detail ? `详情：${detail}` : '',
          context ? `流程上下文：\n${context}` : ''
        ]
          .filter(Boolean)
          .join('\n')
      }
    ],
    signal,
    onEvent
  })

  return {
    assignee: assigneeName,
    content: (result && result.content) || '',
    success: true
  }
}

export function appendTodoNote(node, mindMap, { assignee, title, reply }) {
  if (!node || !mindMap) return
  const prev = (node.getData && node.getData('note')) || ''
  const stamp = new Date().toLocaleString('zh-CN', { hour12: false })
  const block = [
    `【待办 ${stamp}】`,
    `接收人：${assignee}`,
    `任务：${title}`,
    reply ? `确认：${String(reply).trim().slice(0, 200)}` : ''
  ]
    .filter(Boolean)
    .join('\n')
  const note = prev ? `${prev}\n\n${block}` : block
  mindMap.execCommand('SET_NODE_DATA', node, { note })
}
