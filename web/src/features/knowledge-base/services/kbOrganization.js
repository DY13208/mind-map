const memberOf = item => {
  const id = String(item.userId || item.id || '')
  if (!id) throw new Error('部门成员数据不完整，请刷新后重试')
  return { id, name: item.name || id }
}

export function departmentTree(departments) {
  const nodes = new Map(departments.map(d => [String(d.id), { ...d, id: String(d.id), children: [] }]))
  const roots = []
  for (const node of nodes.values()) {
    const parent = nodes.get(String(node.parentId))
    if (parent && parent !== node) parent.children.push(node)
    else roots.push(node)
  }
  // Invalid cyclic structures must not be rendered as recursive Vue nodes.
  const visited = new Set()
  function visit(node, parents) {
    if (parents.has(node.id)) throw new Error('组织架构数据异常，请联系管理员')
    visited.add(node.id)
    node.children.forEach(child => visit(child, new Set([...parents, node.id])))
  }
  roots.forEach(root => visit(root, new Set()))
  if (visited.size !== nodes.size) throw new Error('组织架构数据异常，请联系管理员')
  return roots
}

export function departmentScope(departments, selectedIds, includeChildren) {
  const ids = Array.from(new Set(selectedIds.map(String)))
  if (includeChildren) {
    for (let i = 0; i < ids.length; i++) {
      for (const department of departments) {
        const id = String(department.id)
        if (String(department.parentId) === ids[i] && !ids.includes(id)) ids.push(id)
      }
    }
  }
  return ids
}

export function mergeMembers(departmentMembers, individuals, excludedIds = []) {
  const excluded = new Set(excludedIds)
  return Array.from(new Map(departmentMembers.concat(individuals).map(m => [m.id, m])).values()).filter(m => !excluded.has(m.id))
}

export async function loadDepartmentMembers(api, departmentIds) {
  const members = new Map()
  for (const departmentId of Array.from(new Set(departmentIds.map(String)))) {
    let offset = 0, cursor, previous = '', total = 0
    const seen = new Set()
    for (;;) {
      const result = await api.listContacts({ departmentId, limit: 100, offset, cursor })
      const list = result.list || []
      total = Math.max(total, Number(result.total) || 0)
      if (!list.length && (offset < total || cursor)) throw new Error('未能完整读取部门成员，请重试')
      let added = 0
      for (const item of list) {
        const member = memberOf(item)
        if (!seen.has(member.id)) { seen.add(member.id); added++ }
        members.set(member.id, member)
      }
      offset += list.length
      cursor = result.nextCursor || null
      if (!cursor && (total ? offset >= total : list.length < 100)) break
      if (!added || (cursor && cursor === previous)) throw new Error('未能完整读取部门成员，请重试')
      previous = cursor
    }
  }
  return Array.from(members.values())
}
