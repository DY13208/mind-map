const clean = value => String(value || '').normalize('NFKC').replace(/<!--.*?-->|<[^>]*>/g, '').replace(/&nbsp;|&#160;/g, ' ').replace(/^[#*\s]+|[*\s]+$/g, '').trim()
const norm = value => clean(value).replace(/\s/g, '')
const companyPattern = /(?:[\u4e00-\u9fffA-Za-z0-9()（）]+(?:有限责任公司|股份有限公司|有限公司)(?:[\u4e00-\u9fffA-Za-z0-9]*分公司)?)/g
const noise = /^(?:重要提示|营业执照|副本|正本|行政审批|资料日期|打印日期|国家企业信用|国家市场监督|https?:|\d+\s*\/\s*\d+$)/
function validCreditCode(value) {
  const alphabet = '0123456789ABCDEFGHJKLMNPQRTUWXY', weights = [1,3,9,27,19,26,16,17,20,29,25,13,8,24,10,30,28]
  if (value.length !== 18 || [...value].some(c => !alphabet.includes(c))) return false
  const sum = weights.reduce((total, weight, i) => total + alphabet.indexOf(value[i]) * weight, 0)
  return alphabet[(31 - sum % 31) % 31] === value[17]
}
function ownerOf(raw) {
  const names = [...clean(raw).matchAll(companyPattern)].map(m => norm(m[0].replace(/^(?:公司名称|企业名称|名称)/, '')))
  if (names.length !== 1) return ''
  return /^(?:公司名称|企业名称|名称|经营者中文名称)[：:\s]/.test(clean(raw)) || norm(raw) === names[0] || /^\|\s*(?:公司名称|企业名称|名称|经营者中文名称)\s*\|/.test(clean(raw)) ? names[0] : ''
}
function valueOf(raw, field) {
  let value = clean(raw).replace(/^[：:\s]+/, '')
  if (!value || /^[\\_—\-\s/]+$/.test(value) || noise.test(value) || /[：:☐□]/.test(value) || /^(住所|地址|名称|类型|负责人|法定代表人|成立日期|营业期限|注册资本|经营范围|统一社会信用代码|登记机关)(?:$|[：:\s])/.test(value)) return ''
  if (/日期|时间$/.test(field)) {
    const match = value.match(/^(\d{4})\s*(?:年|[-/.])\s*(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})\s*日?$/)
    if (!match) return ''
    const [, y, m, d] = match.map(Number), date = new Date(Date.UTC(y, m - 1, d))
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? `${y}年${m}月${d}日` : ''
  }
  if (/代码|编号|号码/.test(field) && !/^[A-Za-z0-9-]{5,}$/.test(value)) return ''
  if (field === '统一社会信用代码' && !validCreditCode(value)) return ''
  if (/数量|金额|资本|比例/.test(field) && !/\d/.test(value)) return ''
  if (/数量|金额|比例|资本/.test(field) && /^[+-]?\d+(?:\.\d+)?\s*(?:%|元|万元|天|年|个)?$/.test(value)) value = value.replace(/[+-]?\d+(?:\.\d+)?/, n => String(Number(n)))
  return value.length <= 300 ? value : ''
}
function extractValues(pages, titles) {
  const field = norm(titles[titles.length - 1]), ancestors = titles.slice(0, -1)
  const company = ancestors.slice().reverse().find(t => /公司|Limited|Ltd/i.test(t))
  const entity = company || ancestors[ancestors.length - 1]
  if (!field || !entity || /^(知识|中心主题|分支主题)$/.test(field)) return []
  const result = []
  const reportFields = ['报告编号','检验受理编号','样品中文名称','样品外文名称','受理日期','检验完成日期','送检单位','境内责任人']
  const roleNames = text => String(text || '').split(/\r?\n/).flatMap(line => {
    const m = clean(line).match(/^(送检单位|境内责任人)[：:\s]+([^\t]+)(?:\t|$)/)
    return m && /公司$/.test(norm(m[2])) ? [{role:m[1],name:norm(m[2])}] : []
  })
  const reportIds = text => [...new Set(String(text || '').split(/\r?\n/).map(line => clean(line).match(/^报告编号[：:\s]+([A-Za-z0-9-]{5,})$/)?.[1]).filter(Boolean))]
  const documentText = pages.map(p=>p.text || '').join('\n')
  const isReport = /检验报告/.test(documentText) && /报告编号|检验受理编号/.test(documentText)
  const documentRoles = roleNames(documentText), documentIds = reportIds(documentText)
  let fieldSeen = false, ownedFieldSeen = false, invalidValue = false, emptyValue = false
  let subject = '', table = null
  for (const page of pages) {
    table = null
    const lines = String(page.text || '').split(/\r?\n/)
    const owners = new Set(lines.map(ownerOf).filter(Boolean))
    // Only a single-owner business licence may bind fields before its name row.
    const notice = lines.some(l => /商标注册申请受理通知书/.test(clean(l)))
    const localRoles = roleNames(page.text), localIds = reportIds(page.text)
    const hasLocalRole = lines.some(l=>/^(送检单位|境内责任人)[：:\s]/.test(clean(l)))
    const roles = hasLocalRole ? localRoles : documentIds.length === 1 ? documentRoles : []
    const reportNames = new Set(roles.map(r=>r.name))
    const reportOwner = isReport && localIds.length <= 1 && reportFields.includes(field) && reportNames.size === 1 ? [...reportNames][0] : ''
    const recordId = localIds.length === 1 ? localIds[0] : documentIds.length === 1 ? documentIds[0] : ''
    const sample = lines.map(l=>clean(l).match(/^样品中文名称[：:\s]+([^\t]+)(?:\t|$)/)?.[1]).find(Boolean) || ''
    const pageOwner = reportOwner || (company && lines.some(l => /营业执照|对外贸易经营者备案登记表|商标注册申请受理通知书/.test(clean(l))) && owners.size === 1 ? [...owners][0] : '')
    const recipient = notice ? lines.findIndex(l => ownerOf(l) === norm(entity)) : -1
    const postalRows = notice && recipient >= 0 ? lines.slice(0,recipient).map((l,index)=>({line:l,index})).filter(r=>/^邮政编码[：:\s]/.test(clean(r.line))) : []
    const recipientPostal = postalRows.length > 1 ? postalRows[postalRows.length-1].index : -1
    const applicationIds = [...new Set(lines.map(l=>clean(l).match(/^申请号[：:\s]+(\d+)$/)?.[1]).filter(Boolean))]
    const reliableDates = [...new Set(lines.flatMap(line => {
      const match = clean(line).match(/^(?:生效日期|变更日期|变更核准日期)[：:\s]+(.+)$/)
      return match ? [valueOf(match[1], '日期')].filter(Boolean) : []
    }))]
    const effectiveDate = owners.size === 1 && reliableDates.length === 1 ? reliableDates[0] : ''
    subject = pageOwner
    for (let i = 0; i < lines.length; i++) {
      const raw = clean(lines[i]), compact = norm(raw)
      if (compact.includes(field)) fieldSeen = true
      const names = [...raw.matchAll(companyPattern)].map(m => norm(m[0].replace(/^(?:公司名称|企业名称|名称)/, '')))
      if (company && names.length) {
        const owner = ownerOf(raw)
        if (reportOwner) subject = reportOwner
        else if (owner) subject = owner
        else if (!/^(?:住所|注册地址|营业场所|经营场所)[：:\s]/.test(raw)) subject = pageOwner
      }
      if (!company && compact.includes(norm(entity))) subject = norm(entity)
      if (isReport && reportFields.includes(field) && !reportOwner) { table = null; continue }
      if (subject !== norm(entity)) { table = null; continue }
      if (compact.includes(field)) ownedFieldSeen = true
      if (notice && field === '邮政编码' && i !== recipientPostal) continue
      const add = (value, basis, quote = lines[i], line = i + 1) => {
        const text = valueOf(value, field)
        if (!clean(value).replace(/[：:\\_—\-\s/]/g,'')) emptyValue = true
        if (!text) invalidValue = true
        if (text) result.push({ text, quote, page: page.page ?? null, line, effectiveDate, recordId:reportOwner ? recordId : '', sample:reportOwner ? sample : '', reportRole:reportOwner ? roles.find(r=>r.name===reportOwner)?.role : '', matchBasis: basis, multi: basis === 'table-column' && !/日期|时间$|代码|编号|号码|资本|数量|金额|比例|类型|期限/.test(field) })
      }
      if (notice && field === '发文编号' && applicationIds.length === 1 && compact === field+':') {
        const codes = lines.map((l,index)=>({value:clean(l),index})).filter(r=>new RegExp('^TMZC'+applicationIds[0]+'[A-Z0-9]+$').test(r.value))
        if (codes.length === 1) add(codes[0].value,'application-record',lines[i]+'\n'+codes[0].value,codes[0].index+1)
        continue
      }
      if (raw.includes('\t')) {
        const cells = raw.split('\t').map(clean), at = cells.findIndex(c=>norm(c)===field)
        if (at >= 0 && at+1<cells.length) { add(cells[at+1],'table-pair'); continue }
      }
      const cells = raw.includes('|') ? raw.replace(/^\||\|$/g, '').split('|').map(clean) : null
      if (cells) {
        if (cells.every(c => /^[-:]+$/.test(c))) continue
        const column = cells.findIndex(c => norm(c) === field)
        if (column >= 0) {
          if (cells.length === 2 && column === 0 && valueOf(cells[1], field)) { add(cells[1], 'table-pair'); table = null }
          else table = { column, width: cells.length, quote: lines[i] }
        } else if (table && cells.length === table.width) add(cells[table.column], 'table-column', table.quote + '\n' + lines[i])
        else table = null
        continue
      }
      table = null
      if (compact === field) {
        let next = i + 1
        while (next < lines.length && !clean(lines[next])) next++
        if (next < lines.length && !/^[#]|<h\d|<!--/.test(lines[next]) && !/公司/.test(lines[next])) add(lines[next], 'adjacent-value', lines[i] + '\n' + lines[next])
        continue
      }
      const labelled = raw.replace(/^第[一二三四五六七八九十百\d]+条\s*/, '').replace(/^公司(?=\S)/, '')
      const at = labelled.indexOf(field)
      if (at < 0) continue
      const explicitLabel = [...labelled.matchAll(/([\u4e00-\u9fff]{2,24})[：:]/g)].some(m => m[1] === field && m.index === at)
      if (at > 0 && !explicitLabel && !/[\s，,；;]/.test(labelled[at - 1])) continue
      const tail = labelled.slice(at + field.length).split(/(?=[\u4e00-\u9fff]{2,24}[：:])/)[0]
      // Embedded labels need a self-delimiting typed value; prose matches are not evidence.
      if (/日期|时间$/.test(field)) {
        const match = tail.match(/^[：:\s]*(\d{4}\s*(?:年|[-/.])\s*\d{1,2}\s*(?:月|[-/.])\s*\d{1,2}\s*日?)(?=$|\s|[，,；;]|[\u4e00-\u9fff])/)
        if (match) add(match[1], 'label-value')
      } else if ((at === 0 || explicitLabel) && /^[：:]/.test(tail.trim())) add(tail, 'label-value')
      else if (at === 0 && /^\s*为\S/.test(tail)) add(tail.replace(/^\s*为/, '').replace(/[。.]$/, ''), 'explicit-value')
      else if (at === 0 && /^\s+/.test(tail)) add(tail, 'label-value')
    }
  }
  result.notWrittenReason = result.length ? null : !fieldSeen ? 'field_not_found' : !ownedFieldSeen ? 'subject_unconfirmed' : emptyValue ? 'field_empty' : invalidValue ? 'value_invalid' : 'field_value_unmatched'
  return result
}
function valuesConflict(rows) {
  return rows.some(r => !r.multi) && new Set(rows.map(r => norm(r.text))).size > 1
}
function latestValues(rows, field) {
  // No file timestamps, filenames, print dates or establishment dates establish recency.
  if (/成立|设立|统一社会信用代码|注册号/.test(field) || ['股东', '经营许可', '报告编号', '检验受理编号'].includes(field) || !rows.length || rows.some(r => r.multi || !r.effectiveDate)) return rows
  const stamp = value => {
    const m = String(value).match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/)
    if (!m) return NaN
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
    return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? d.getTime() : NaN
  }
  const times = rows.map(r => stamp(r.effectiveDate))
  if (times.some(t => !Number.isFinite(t))) return rows
  const latest = Math.max(...times)
  return rows.filter((r, i) => times[i] === latest)
}
module.exports = { extractValues, valuesConflict, latestValues, normalizeField: norm }
