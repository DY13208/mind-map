function commandError(message, code, statusCode = 409) {
  const err = new Error(message)
  err.statusCode = statusCode
  err.code = code
  return err
}

function parentDeletedError(parentUid) {
  return commandError(
    parentUid
      ? `父节点已删除或不存在: ${parentUid}`
      : '父节点已删除或不存在',
    'PARENT_DELETED'
  )
}

function nodeDeletedError(uid) {
  return commandError(
    uid ? `节点已删除或不存在: ${uid}` : '节点已删除或不存在',
    'NODE_DELETED'
  )
}

function moveConflictError(uid) {
  return commandError(
    uid
      ? `节点已被删除，移动冲突: ${uid}`
      : '节点已被删除，移动冲突',
    'MOVE_CONFLICT'
  )
}

function uidReusedError(uid) {
  return commandError(
    uid
      ? `禁止复用已删除节点 UID: ${uid}`
      : '禁止复用已删除节点 UID',
    'UID_REUSED'
  )
}

function cycleError() {
  return commandError('不能把节点移动到自己的子节点下', 'CYCLE_REJECTED', 400)
}

module.exports = {
  commandError,
  parentDeletedError,
  nodeDeletedError,
  moveConflictError,
  uidReusedError,
  cycleError
}
