const { visibleText } = require('./fillFacts')
function number(value) {
  const match = String(value || '')
    .trim()
    .match(/^[A-Za-z\u4e00-\u9fff（）()\-]{0,30}\d[A-Za-z0-9\-]*(?:号)?/)
  if (!match) return ''
  const candidate = match[0]
  if (
    /有效|期限|截止|发证|批准|时间|日期|地址|住所|场所|社区|大厦|邮编|路|街|镇|乡|楼|室|电话|联系人|法定代表|统一社会信用|公司|注册资本|分类目录|经营范围/.test(
      candidate
    )
  )
    return ''
  if (/^(?:19|20)\d{6}$/.test(candidate)) {
    const year = Number(candidate.slice(0, 4)),
      month = Number(candidate.slice(4, 6)),
      day = Number(candidate.slice(6))
    const d = new Date(Date.UTC(year, month - 1, day))
    if (
      d.getUTCFullYear() === year &&
      d.getUTCMonth() === month - 1 &&
      d.getUTCDate() === day
    )
      return ''
  }
  return (candidate.match(/\d/g) || []).length >= 6 ? candidate : ''
}
function licenseTexts(value, next = '') {
  const raw = visibleText(value)
  if (!raw || /^https?:|^\d+\s*\/\s*\d+$|^行政审批$/.test(raw)) return []
  const out = []
  const labels =
    /[A-Za-z\u4e00-\u9fff（）()]{0,36}(?:许可证(?:或备案凭证)?|备案凭证|备案证明|备案登记证|经营备案|网络销售备案|贸易经营者备案)(?:编号|号码|证号|号)?/g
  for (const cell of raw.split(/[\t|]+/))
    for (const m of cell.matchAll(labels)) {
      const tail = cell.slice(m.index + m[0].length)
      if (/^\s*经营范围/.test(tail)) continue
      let content = tail.replace(/^[：:\s]+/, '')
      if (!content && raw.includes('\t')) {
        const cells = raw.split('\t')
        content = cells[cells.indexOf(cell) + 1] || ''
      }
      if (!content) content = next
      const id = number(content)
      if (id) out.push(m[0] + '：' + id)
    }
  if (
    !out.length &&
    /^(?:已完成|已取得|已办理|已获准|已备案)/.test(raw) &&
    /(?:许可证|经营许可|备案登记|经营者备案)/.test(raw) &&
    !/[\t]|https?:|经营范围/.test(raw) &&
    raw.length <= 140
  )
    out.push(raw)
  return [...new Set(out)]
}
module.exports = { licenseTexts }
