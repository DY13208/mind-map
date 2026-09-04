const STALE_AFTER_VERSION_RESTORE = 'STALE_AFTER_VERSION_RESTORE'

function isVersionRestoreEvent(op) {
  const type = String((op && (op.event && op.event.type)) || (op && op.type) || '')
  const payload =
    (op && op.event && op.event.payload) || (op && op.payload) || {}
  if (type !== 'map.replaced' && type !== 'map.replace') return false
  return (
    payload.reason === 'VERSION_RESTORE' ||
    payload.fullTreeReason === 'VERSION_RESTORE' ||
    payload.restore === true
  )
}

function planPendingAfterRestore(rows) {
  return (rows || [])
    .filter(
      item =>
        item &&
        item.status !== 'acked' &&
        item.status !== 'acknowledged' &&
        item.status !== 'quarantined'
    )
    .map(item => ({
      opId: item.opId,
      status: 'quarantined',
      errorCode: STALE_AFTER_VERSION_RESTORE,
      error: 'pending operation is stale after VERSION_RESTORE'
    }))
}

async function quarantinePendingAfterRestore(outbox, clientId, roomKey) {
  if (!outbox || typeof outbox.list !== 'function') return []
  const rows = await outbox.list(clientId, roomKey)
  const planned = planPendingAfterRestore(rows)
  for (const item of planned) {
    if (typeof outbox.update === 'function') {
      await outbox.update(item.opId, {
        status: 'quarantined',
        errorCode: item.errorCode,
        error: item.error
      })
    }
  }
  return planned
}

module.exports = {
  STALE_AFTER_VERSION_RESTORE,
  isVersionRestoreEvent,
  planPendingAfterRestore,
  quarantinePendingAfterRestore
}
