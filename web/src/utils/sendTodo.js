import { getWorkbuddyConfig } from './workbuddyChat'

/**
 * 通过本机 wecom-cli 发企业微信待办（与 WorkBuddy 客户端同一条路）。
 * 不再经 LLM/ACP，避免模型空跑或去翻仓库。
 */
export async function dispatchTodo({
  assignee,
  title,
  detail,
  context,
  onEvent,
  onDelta,
  signal,
  conversationId,
  model
} = {}) {
  const assigneeName =
    String((assignee && assignee.name) || assignee || '负责人').trim() ||
    '负责人'
  const taskTitle =
    String(title || '待办')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || '待办'
  const description = String(detail || context || '')
    .trim()
    .slice(0, 2000)

  if (onEvent) onEvent('wecom_cli', { phase: 'preparing', assignee: assigneeName })
  if (onDelta) onDelta(`正在通过 wecom-cli 给 ${assigneeName} 创建企微待办…\n`)

  const { baseUrl, apiKey } = getWorkbuddyConfig()
  let payload = null
  let httpStatus = 0
  try {
    const res = await fetch(`${baseUrl}/v1/wecom/todo`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        assignee: assigneeName,
        title: taskTitle,
        description
      }),
      signal
    })
    httpStatus = res.status
    const text = await res.text()
    try {
      payload = JSON.parse(text)
    } catch (e) {
      payload = { error: { message: text || `HTTP ${res.status}` } }
    }
    if (!res.ok) {
      const msg =
        (payload && payload.error && payload.error.message) ||
        (payload && payload.message) ||
        text ||
        `HTTP ${res.status}`
      const err = new Error(msg)
      err.status = res.status
      err.code = payload && payload.error && payload.error.code
      throw err
    }
  } catch (err) {
    const message = (err && err.message) || String(err || '派发失败')
    const authFail =
      (err && (err.status === 401 || err.code === 'wecom_unauthorized')) ||
      /未授权|unauthorized|401/i.test(message)
    const notFound =
      (err && (err.status === 404 || err.code === 'wecom_user_not_found')) ||
      /找不到|not_found/i.test(message)
    const missingCli =
      (err && err.code === 'wecom_cli_missing') ||
      /未找到 wecom-cli|wecom_cli_missing/i.test(message)
    let errHint = message
    if (authFail) {
      errHint =
        '企业微信 CLI 未授权。请打开 WorkBuddy 客户端完成企微扫码授权后再试。'
    } else if (missingCli) {
      errHint =
        '本机未找到 wecom-cli（WorkBuddy 企微连接器）。请先在客户端安装/启用企微 CLI。'
    } else if (notFound) {
      errHint = `通讯录找不到「${assigneeName}」，请确认姓名。`
    }
    if (onDelta) onDelta(`${errHint}\n`)
    return {
      assignee: assigneeName,
      title: taskTitle,
      userLine: `给${assigneeName}发个代办：${taskTitle}`,
      content: errHint,
      success: false,
      toolUsed: false,
      via: 'wecom-cli',
      error: errHint,
      detail: detail || '',
      context: context || ''
    }
  }

  const content =
    String((payload && payload.content) || '').trim() ||
    `待办创建成功：${(payload && payload.title) || taskTitle}`
  if (onEvent) {
    onEvent('wecom_cli', {
      phase: 'done',
      todo_id: payload && payload.todo_id,
      via: 'wecom-cli'
    })
  }
  if (onDelta) onDelta(`${content}\n`)

  return {
    assignee: assigneeName,
    title: (payload && payload.title) || taskTitle,
    userLine: `给${assigneeName}发个代办：${taskTitle}`,
    content,
    success: !!(payload && payload.ok),
    toolUsed: true,
    via: 'wecom-cli',
    todoId: (payload && payload.todo_id) || '',
    error: payload && payload.ok ? '' : content || '派发未确认成功',
    detail: detail || '',
    context: context || '',
    httpStatus
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
