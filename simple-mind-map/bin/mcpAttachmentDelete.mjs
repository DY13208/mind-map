function required(value, label) {
  const result = String(value || '').trim()
  if (!result) {
    const err = new Error(`缺少 ${label}`)
    err.code = 'INVALID_ARGUMENT'
    err.statusCode = 400
    throw err
  }
  return result
}

export async function deleteNodeAttachment({
  api,
  roomKey,
  node,
  attachmentId,
  baseVersion,
  confirmSopChange = false
} = {}) {
  if (typeof api !== 'function') throw new TypeError('api must be a function')
  const room = required(roomKey, 'room_key')
  const nodeRef = required(node, 'node')
  const id = required(attachmentId, 'attachment_id')
  if (baseVersion == null || String(baseVersion).trim() === '') {
    const err = new Error('删除附件必须提供当前 base_version')
    err.code = 'INVALID_BASE_VERSION'
    err.statusCode = 400
    throw err
  }
  const revision = Number(baseVersion)
  if (!Number.isSafeInteger(revision) || revision < 0) {
    const err = new Error('删除附件必须提供当前 base_version')
    err.code = 'INVALID_BASE_VERSION'
    err.statusCode = 400
    throw err
  }
  const roomPath = `/api/files/${encodeURIComponent(room)}`
  const located = await api(
    `${roomPath}/locate?uid=${encodeURIComponent(nodeRef)}`,
    { timeoutMs: 15000 }
  )
  const nodeUid = String((located && located.uid) || '').trim()
  if (!nodeUid) {
    const err = new Error('找不到唯一节点，请改用节点 uid 或完整路径')
    err.code = 'NODE_NOT_FOUND'
    err.statusCode = 404
    throw err
  }

  const params = new URLSearchParams({
    node_uid: nodeUid,
    base_version: String(revision)
  })
  if (confirmSopChange === true) params.set('confirm_sop_change', '1')
  return api(
    `${roomPath}/attachments/${encodeURIComponent(id)}?${params.toString()}`,
    { method: 'DELETE', timeoutMs: 30000 }
  )
}
