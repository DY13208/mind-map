async function mapLimited(items, run) {
  const result = []
  for (let i = 0; i < items.length; i += 4) result.push(...await Promise.all(items.slice(i, i + 4).map(run)))
  return result
}

export async function prepareBatchTargets(api, targets) {
  const unique = new Map()
  for (const target of targets || []) {
    if (!target || !['file', 'folder'].includes(target.type) || !target.id) throw new Error('无效的授权对象')
    unique.set(`${target.type}:${target.id}`, { ...target })
  }
  if (unique.size > 100) throw new Error('每次最多选择 100 个文件或文件夹')
  return mapLimited(Array.from(unique.values()), async target => {
    try {
      const acl = await api.getAcl(target.type, target.id)
      const ready = (acl.capabilities || []).includes('grant') && (acl.capabilities || []).includes('revoke')
      return { ...target, acl, ready, message: ready ? '' : '需要该资源的管理权限' }
    } catch (e) { return { ...target, ready: false, message: e.message || '加载权限失败' } }
  })
}

export async function applyBatchPermissions(api, targets, members, { mode, role } = {}) {
  if (!['grant', 'revoke'].includes(mode) || (mode === 'grant' && !['viewer', 'editor', 'manager'].includes(role))) throw new Error('无效的权限操作')
  const users = Array.from(new Map((members || []).filter(m => m && m.id).map(m => [String(m.id), { ...m, id: String(m.id) }])).values())
  if (!targets.length || targets.length > 100 || !users.length || users.length > 500 || targets.length * users.length > 5000) throw new Error('每次选择 1–100 个资源及 1–500 位成员，最多 5000 项授权操作')
  const results = await mapLimited(targets, async target => {
    const rows = []
    for (const member of users) {
      const row = { target, member, status: 'failed', message: '' }
      const acl = target.acl || {}
      if (!target.ready) row.message = target.message || '无管理权限'
      else if (String(acl.ownerUserId || '') === member.id) { row.status = 'skipped'; row.message = '保留所有者权限' }
      else if (mode === 'revoke' && !(acl.grants || []).some(g => g.subjectType === 'user' && String(g.subjectId) === member.id && g.source === 'direct')) {
        row.status = 'skipped'; row.message = '没有直接授权；继承权限请到来源文件夹调整'
      } else {
        try {
          const subject = { subjectType: 'user', subjectId: member.id }
          if (mode === 'grant') await api.putGrant(target.type, target.id, { ...subject, role })
          else await api.deleteGrant(target.type, target.id, subject)
          row.status = 'success'; row.message = mode === 'grant' ? '已设置直接授权' : '已移除直接授权，按继承权限生效'
        } catch (e) { row.message = e.message || '操作失败' }
      }
      rows.push(row)
    }
    return rows
  })
  return results.flat()
}
