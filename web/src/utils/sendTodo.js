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
  onDelta,
  signal,
  conversationId
}) {
  const assigneeName = String((assignee && assignee.name) || '负责人').trim() || '负责人'
  const taskTitle = String(title || '待办').trim() || '待办'
  const result = await streamChat({
    messages: [
      {
        role: 'system',
        content: [
          '你是良策协作助手，负责通过企业微信通讯录给指定同事创建真实待办。',
          '必须先按姓名搜索通讯录拿到 userid，再创建待办；不要只口头确认。',
          '若接收人是角色名（如 HRBP/副总）而找不到真人，要明确说找不到，不要假装已发送。',
          '成功后用一两句话回显：已发给谁、标题是什么。'
        ].join('')
      },
      {
        role: 'user',
        content: [
          // 与客户端可成功的自然语言一致
          `给${assigneeName}发个代办：${taskTitle}`,
          detail ? `详情：${detail}` : '',
          context ? `流程上下文：\n${context}` : '',
          '要求：接收人必须是上面的具体姓名；创建成功后回显参与人姓名。'
        ]
          .filter(Boolean)
          .join('\n')
      }
    ],
    signal,
    conversationId,
    onEvent,
    onDelta
  })

  const content = String((result && result.content) || '').trim()
  const failed =
    !content ||
    /找不到|未找到|没有找到|无法创建|创建失败|未能|没有userid|无 userid/i.test(
      content
    )
  const succeeded =
    !failed &&
    /已发|已创建|创建成功|待办创建成功|已发给/i.test(content)

  return {
    assignee: assigneeName,
    content,
    success: succeeded
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
