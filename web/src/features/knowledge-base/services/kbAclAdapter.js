// 把 File KB 的 ACL 接口适配成脑图 ShareFolderDialog 的 adapter 形状，复用脑图的成员选择与权限列表。
// 成员 id 就是主应用 user_id（与企业通讯录 /api/wecom/contacts 返回的 id 相同），直接作为 KB principal_id。
// 部门只作为批量选人：保存时展开为逐人授权。KB 团队（kb.teams）没有任何同步来源，前端不提供新建团队授权。
import { roleLabel as kbRoleLabel } from '../constants/status'

export const KB_GRANT_ROLES = ['viewer', 'editor', 'manager']
const TEAM_PREFIX = 'team:'
const NAME_LOOKUP_LIMIT = 30

// 脑图对话框用首字母大写的 Viewer/Editor/Manager；KB 后端只接受小写 viewer/editor/manager，owner 只能转移
export function toKbRole(role) {
  const value = String(role || '').trim().toLowerCase()
  return KB_GRANT_ROLES.includes(value) ? value : null
}

export function memberKey(subjectType, subjectId) {
  return subjectType === 'team' ? TEAM_PREFIX + subjectId : String(subjectId)
}

export function subjectOfMember(member) {
  if (member && member.kbSubjectType === 'team') return { subjectType: 'team', subjectId: member.kbSubjectId }
  const id = String((member && (member.kbSubjectId || member.userId || member.id)) || '')
  if (id.startsWith(TEAM_PREFIX)) return { subjectType: 'team', subjectId: id.slice(TEAM_PREFIX.length) }
  return { subjectType: 'user', subjectId: id }
}

function folderName(row) {
  const f = (row && row.inheritedFrom) || {}
  return f.name || (f.id ? '上级文件夹' : '无权查看的上级文件夹')
}

// describeAcl 的 grants：owner 锚点 + direct（可能同时带一条 applied=false 的 inherited）+ 仅 inherited
export function membersFromAcl(acl, names = {}) {
  const grants = (acl && (acl.grants || acl.entries)) || []
  const bySubject = new Map()
  for (const g of grants) {
    if (!g || !g.subjectId) continue
    const key = memberKey(g.subjectType, g.subjectId)
    const entry = bySubject.get(key) || { subjectType: g.subjectType === 'team' ? 'team' : 'user', subjectId: String(g.subjectId) }
    if (g.source === 'owner') entry.owner = g
    else if (g.source === 'inherited' && g.via === 'folder_owner') entry.folderOwner = g
    else if (g.source === 'direct') entry.direct = g
    else if (g.source === 'inherited' && !entry.inherited) entry.inherited = g
    bySubject.set(key, entry)
  }
  const members = []
  for (const [key, e] of bySubject) {
    const isTeam = e.subjectType === 'team'
    const name = names[key] || (isTeam ? '团队 ' + e.subjectId.slice(0, 8) : e.subjectId)
    const base = { id: key, userId: isTeam ? '' : e.subjectId, name, kbSubjectType: e.subjectType, kbSubjectId: e.subjectId }
    if (e.owner) {
      members.push({ ...base, role: 'owner', department: '所有者', inheritedOnly: false, sourceLabel: '' })
      continue
    }
    // 上级文件夹的所有者至少可管理（后端 009），只读展示；直接授予的更低角色不生效
    if (e.folderOwner && !(e.direct && KB_GRANT_ROLES.indexOf(e.direct.role) >= 2)) {
      const lower = e.direct ? `；直接授予的${kbRoleLabel(e.direct.role)}不生效` : ''
      members.push({
        ...base, role: 'manager', department: '成员', inheritedOnly: true,
        sourceLabel: `上级文件夹「${folderName(e.folderOwner)}」的所有者，自动可管理${lower}`
      })
      continue
    }
    if (e.direct) {
      const over = e.inherited ? `，覆盖继承自「${folderName(e.inherited)}」的${kbRoleLabel(e.inherited.role)}` : ''
      members.push({
        ...base, role: e.direct.role, department: isTeam ? '团队' : '成员', inheritedOnly: false,
        sourceLabel: '直接授权' + over
      })
    } else if (e.inherited) {
      members.push({
        ...base, role: e.inherited.role, department: isTeam ? '团队' : '成员', inheritedOnly: true,
        sourceLabel: `继承自「${folderName(e.inherited)}」，请到该文件夹调整`
      })
    }
  }
  const order = { owner: 0, manager: 1, editor: 2, viewer: 3 }
  return members.sort((a, b) => (order[a.role] ?? 9) - (order[b.role] ?? 9) || String(a.name).localeCompare(String(b.name)))
}

export function createKbAclAdapter({ api, target, contacts, currentUser } = {}) {
  if (!api || !target) throw new Error('kb acl adapter needs api and target')
  const kind = target.type === 'folder' ? 'folder' : 'file'
  const names = {}
  if (currentUser && currentUser.id && currentUser.name) names[String(currentUser.id)] = currentUser.name
  let acl = null
  let primed = null

  // 只按需查找未知用户名，最多 NAME_LOOKUP_LIMIT 个、每次 4 个并发；查不到就显示 user_id
  async function resolveNames(list) {
    if (!contacts || typeof contacts.listContacts !== 'function') return
    const unknown = list.filter(m => m.kbSubjectType === 'user' && !names[m.id]).map(m => m.id).slice(0, NAME_LOOKUP_LIMIT)
    for (let i = 0; i < unknown.length; i += 4) {
      await Promise.all(unknown.slice(i, i + 4).map(async id => {
        try {
          const result = await contacts.listContacts({ search: id, limit: 20 })
          const hit = ((result && result.list) || []).find(c => [c.id, c.userId, c.wecomUserId].map(String).includes(id))
          names[id] = hit && hit.name ? hit.name : id
        } catch (_) {
          names[id] = id
        }
      }))
    }
  }

  async function members(fresh) {
    if (fresh) acl = await api.getAcl(kind, target.id)
    let list = membersFromAcl(acl, names)
    if (list.some(m => m.kbSubjectType === 'user' && !names[m.id])) {
      await resolveNames(list)
      list = membersFromAcl(acl, names)
    }
    return list
  }

  function noteContacts(list) {
    for (const c of list || []) {
      const id = String((c && (c.id || c.userId)) || '')
      if (id && c.name) names[id] = c.name
    }
  }

  return {
    kind,
    label: kind === 'folder' ? '文件夹' : '文件',
    icon: kind === 'folder' ? 'el-icon-folder' : 'el-icon-document',
    description: kind === 'folder'
      ? '文件知识库权限，向下继承到子文件夹和文件；单独设置优先于继承'
      : '文件知识库权限；单独设置优先于文件夹继承',
    defaultRole: 'Viewer',
    roleOptions: [
      { value: 'Viewer', title: '可查看', caption: '查看与下载' },
      { value: 'Editor', title: '可编辑', caption: '查看并编辑文件' },
      { value: 'Manager', title: '可管理', caption: '管理成员权限' }
    ],
    // 打开前预取一次，决定是否只读；随后 listMembers 第一次直接用这份结果
    async prime() {
      acl = await api.getAcl(kind, target.id)
      primed = acl
      return acl
    },
    capabilities() {
      return Array.isArray(acl && acl.capabilities) ? acl.capabilities.slice() : []
    },
    noteContacts,
    async listMembers() {
      const fresh = !primed
      primed = null
      return members(fresh)
    },
    async grant(userId, role) {
      const kbRole = toKbRole(role)
      if (!kbRole) throw new Error('该权限不能直接授予')
      acl = await api.putGrant(kind, target.id, { subjectType: 'user', subjectId: String(userId), role: kbRole })
      return acl
    },
    async updateRole(member, role) {
      const kbRole = toKbRole(role)
      if (!kbRole) throw new Error('该权限不能直接授予')
      if (member && member.inheritedOnly) throw new Error('继承的权限请到来源文件夹调整')
      acl = await api.putGrant(kind, target.id, { ...subjectOfMember(member), role: kbRole })
      return acl
    },
    async remove(member) {
      if (member && member.inheritedOnly) throw new Error('继承的权限请到来源文件夹调整')
      acl = await api.deleteGrant(kind, target.id, subjectOfMember(member))
      return acl
    },
    async transferOwnership(userId) {
      await api.transferOwner(kind, target.id, { userId: String(userId) })
      // 后端返回的是新所有者视角，这里按当前用户重新读取
      return members(true)
    }
  }
}
