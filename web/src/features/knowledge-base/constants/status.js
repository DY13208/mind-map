export const FILE_STATUS = {
  pending: { label: '等待解析', type: 'info', icon: 'el-icon-time' },
  parsing: { label: '解析中', type: '', icon: 'el-icon-loading' },
  structuring: { label: '结构化入库中', type: 'warning', icon: 'el-icon-loading' },
  done: { label: '已完成', type: 'success', icon: 'el-icon-circle-check' },
  partial: { label: '部分完成', type: 'warning', icon: 'el-icon-warning-outline' },
  failed: { label: '失败', type: 'danger', icon: 'el-icon-circle-close' }
}
export const ACTIVE_STATUSES = ['pending', 'parsing', 'structuring']
export const ROLES = [
  { value: 'viewer', label: '查看者' },
  { value: 'editor', label: '编辑者' },
  { value: 'manager', label: '管理者' },
  { value: 'owner', label: '所有者' }
]
export const GRANT_ROLES = ROLES.filter(r => r.value !== 'owner')
export function roleLabel(role) {
  const r = ROLES.find(x => x.value === role)
  return r ? r.label : role || '无权限'
}
export const KB_TABS = [
  { name: 'files', label: '文件管理', icon: 'el-icon-folder-opened' },
  { name: 'parse', label: '解析详情', icon: 'el-icon-document' },
  { name: 'data', label: '结构化数据', icon: 'el-icon-s-grid' },
  { name: 'search', label: '知识检索', icon: 'el-icon-search' },
  { name: 'mcp', label: 'MCP 管理', icon: 'el-icon-connection' }
]
