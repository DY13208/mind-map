export function summarizeAccess(access = {}) {
  const canEdit = access.canEdit !== false && access.role !== 'viewer'
  const canManage = !!access.canManage || access.role === 'owner'
  const role =
    access.role ||
    (canManage ? 'owner' : canEdit ? 'editor' : access.role === null ? '' : 'viewer')
  return {
    role,
    canView: access.canView !== false,
    canEdit,
    canManage,
    legacyOpen: !!access.legacyOpen
  }
}

export function applyRoomAccess(store, mindMap, access) {
  const wasForced = !!store.state.aclForcedReadonly
  const summary = summarizeAccess(access)
  store.commit('setRoomAcl', summary)
  if (!summary.canEdit) {
    store.commit('setIsReadonly', true)
    if (mindMap && typeof mindMap.setMode === 'function') {
      mindMap.setMode('readonly')
    }
    return summary
  }
  if (wasForced) {
    store.commit('setIsReadonly', false)
    if (mindMap && typeof mindMap.setMode === 'function') {
      mindMap.setMode('edit')
    }
  }
  return summary
}

export function fileRoleLabelKey(role) {
  if (role === 'owner') return 'acl.mine'
  if (role === 'viewer') return 'acl.viewer'
  return 'acl.editor'
}

export function memberRoleLabelKey(role) {
  if (role === 'owner') return 'acl.owner'
  if (role === 'viewer') return 'acl.viewer'
  return 'acl.editor'
}

export function roleLabelKey(role) {
  return memberRoleLabelKey(role)
}
