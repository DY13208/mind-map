const MESSAGES = {
  unauthorized: '请先使用企业微信登录',
  AUTH_TIMEOUT: '登录状态确认超时，请重试',
  FORBIDDEN: '没有权限执行该操作',
  ROOM_NOT_FOUND: '找不到该脑图',
  FOLDER_NOT_FOUND: '找不到该文件夹',
  FOLDER_NOT_EMPTY: '该文件夹中还有脑图，请先移动脑图后再删除。',
  INVALID_MOVE: '无法移动到该位置',
  INVALID_FOLDER_NAME: '请输入有效的文件夹名称',
  FOLDER_NAME_CONFLICT: '已存在同名文件夹',
  HISTORY_REVISION_UNAVAILABLE: '该历史版本已不可用',
  RESTORE_CONFLICT: '脑图已有更新，请刷新后再恢复',
  VERSION_CONFLICT: '脑图已有更新，请刷新后再恢复',
  VERSION_NOT_FOUND: '找不到该历史版本',
  TRASH_BACKEND_PENDING: '回收站尚未接入，暂不可删除真实脑图'
}

export function userMessageFromError(error) {
  if (!error) return '操作失败，请重试'
  const code = String(error.code || '')
  if (MESSAGES[code]) return MESSAGES[code]
  const status = Number(error.statusCode || error.status || 0)
  if (status === 401) return MESSAGES.unauthorized
  if (status === 403) return MESSAGES.FORBIDDEN
  return error.message || '操作失败，请重试'
}

export function wrapHttpError(data, status) {
  const rawCode = String((data && (data.code || data.error)) || '')
  const err = new Error(
    (data && (data.error || data.message)) || 'request failed'
  )
  err.code = MESSAGES[rawCode] ? rawCode : (data && data.code) || (status === 401 ? 'unauthorized' : '')
  err.statusCode = status
  err.message = userMessageFromError(err)
  return err
}
