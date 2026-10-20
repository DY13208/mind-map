// Shared by the editor and the authoritative API; collapsed branches remain data.
const plain = value =>
  String(value || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim()
const label = value =>
  plain(value)
    .replace(/〔.*?〕|\[.*?\]/g, '')
    .trim()
const FIELDS = {
  请假类型: 'leaveType',
  开始时间: 'start',
  结束时间: 'end',
  工作替补人: 'replacementId',
  请假事由: 'reason',
  附件: 'attachmentIds'
}
function extractFields(nodes, rootUid, definitions) {
  const declared = definitions
    ? Object.fromEntries(definitions.map(f => [f.label, f]))
    : null
  const children = uid =>
    nodes
      .filter(n => n.parent_uid === uid)
      .sort(
        (a, b) =>
          String(a.position || '').localeCompare(String(b.position || '')) ||
          a.uid.localeCompare(b.uid)
      )
  const data = n => plain((n.data || n).text)
  const group = children(rootUid).find(n => data(n) === '申请资料')
  const values = {},
    attachments = new Set()
  const collect = n => {
    const id = (n.data || n).attachmentId
    if (id) attachments.add(String(id))
    for (const child of children(n.uid)) collect(child)
  }
  const root = nodes.find(n => n.uid === rootUid)
  if (root && (root.data || root).attachmentId)
    attachments.add(String((root.data || root).attachmentId))
  for (const n of [
    ...children(rootUid).filter(item => !group || item.uid !== group.uid),
    ...(group ? children(group.uid) : [])
  ]) {
    const text = data(n),
      split = text.match(/^([^:：]+)[:：](.*)$/),
      name = label(split ? split[1] : text),
      field = declared
        ? definitions.find(f => f.instanceUid === n.uid) || declared[name]
        : null,
      key = declared ? field && field.key : FIELDS[name]
    if (!key) continue
    if (key === 'attachmentIds' || (field && field.type === 'attachment')) {
      collect(n)
      if (key !== 'attachmentIds') {
        const ids = new Set()
        const scan = item => {
          const id = (item.data || item).attachmentId
          if (id) ids.add(String(id))
          children(item.uid).forEach(scan)
        }
        scan(n)
        values[key] = [...new Set([...(values[key] || []), ...ids])].sort()
      }
      continue
    }
    const raw =
      (split && split[2].trim()) ||
      children(n.uid)
        .map(data)
        .filter(s => !/^待填写(?:$|[（(：:])/.test(s))
        .join('\n')
    if (!raw || /^待填写(?:$|[（(：:])/.test(raw)) continue
    const value =
      key === 'replacementId' || (field && field.type === 'member')
        ? raw.replace(/^(账号|user_id)[:：]\s*/i, '').replace(/^@/, '')
        : key === 'start' ||
          key === 'end' ||
          (field && field.type === 'datetime')
        ? raw.replace(' ', 'T')
        : raw
    if (values[key] && values[key] !== value)
      throw Object.assign(
        new Error(`${name}有多个不同值，请在脑图中合并后重新检查`),
        { code: 'DUPLICATE_FIELD' }
      )
    values[key] = value
  }
  values.attachmentIds = [...attachments].sort()
  return values
}
function isWorkflowIntent(text) {
  const value = plain(text)
  return (
    value.length <= 500 &&
    /^(?:我要|我想|我需要|我准备|申请|发起|提请|需要申请|准备申请)/.test(
      value
    ) &&
    !/取消|撤回|不请|不想|不要|无需/.test(value) &&
    !/^申请(?:资料|字段|内容|事由|时间|人)\s*[:：]/.test(value)
  )
}
module.exports = { plain, label, FIELDS, extractFields, isWorkflowIntent }
