function stripHtml(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function isSopLabel(data) {
  return stripHtml(data && data.text).toLowerCase() === 'sop'
}

function findSopRootUid(nodes) {
  const obj = nodes || {}
  return (
    Object.keys(obj).find(uid => {
      const node = obj[uid]
      return node && !node.deleted && isSopLabel(node.data)
    }) || ''
  )
}

function payloadText(payload) {
  if (!payload) return undefined
  if (payload.text != null) return payload.text
  if (payload.data && payload.data.text != null) return payload.data.text
  if (payload.patch && payload.patch.text != null) return payload.patch.text
  return undefined
}

function isStructuralPayload(payload) {
  return !!(
    payload &&
    (payload.parentUid != null ||
      payload.parent_uid != null ||
      payload.parent != null ||
      payload.index != null ||
      payload.position != null ||
      payload.order != null)
  )
}

function inspectSopChange(input = {}) {
  const type = String(input.type || '')
  const payload = input.payload || {}
  const confirm = payload.confirm_sop_change === true
  const target = input.target || null
  const nodes = input.nodes || null
  const targetUid = String(
    (target && target.uid) || payload.uid || input.targetUid || ''
  )
  const targetData =
    (target && target.data) ||
    (nodes && nodes[targetUid] && nodes[targetUid].data) ||
    null
  const detectedSopChange = isSopLabel(targetData)
  let required = false
  let reason = 'not_sop_change'

  if (confirm) {
    reason = 'confirmed'
  } else if (type === 'map.replace' || type === 'map.replaced') {
    const currentSop = findSopRootUid(input.currentNodes || nodes)
    const nextSop = findSopRootUid(input.nextNodes || payload.treeNodes)
    required = !!(currentSop && (!nextSop || (nextSop !== currentSop && !(input.nextNodes || {})[currentSop])))
    reason = required ? 'map_replace_removes_sop_root' : 'map_replace_keeps_sop_or_none'
  } else if (detectedSopChange && (type === 'node.delete' || type === 'node.move')) {
    required = true
    reason = 'sop_root_' + (type === 'node.delete' ? 'delete' : 'move')
  } else if (detectedSopChange && (type === 'node.update' || type === 'node.reorder')) {
    const nextText = payloadText(payload)
    const renaming =
      nextText != null && stripHtml(nextText).toLowerCase() !== 'sop'
    required = renaming || isStructuralPayload(payload)
    reason = required ? 'sop_root_identity_change' : 'sop_root_non_identity'
  } else {
    required = false
    reason = detectedSopChange ? 'sop_adjacent_non_identity' : 'ordinary_operation'
  }

  const row = {
    operationType: type,
    targetUid,
    detectedSopChange,
    reason,
    confirm_sop_change: confirm,
    required,
    guardFile: 'collabSopGuard.js',
    guardFunction: 'inspectSopChange'
  }
  if (typeof console !== 'undefined' && console.info && required) {
    console.info('SOP_GUARD_TRACE', row)
  }
  if (typeof window !== 'undefined') window.__SOP_GUARD_TRACE__ = row
  return row
}

function sopConfirmError(trace) {
  const err = new Error('修改SOP前必须获得用户确认并设置confirm_sop_change=true')
  err.statusCode = 400
  err.code = 'SOP_CONFIRM_REQUIRED'
  err.details = trace || {}
  return err
}

const api = {
  stripHtml,
  isSopLabel,
  findSopRootUid,
  inspectSopChange,
  sopConfirmError
}

module.exports = api
module.exports.default = api
