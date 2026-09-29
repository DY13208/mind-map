function historyDisplayTimeZone() {
  return process.env.HISTORY_DISPLAY_TZ || 'Asia/Shanghai'
}

function formatVersionTime(date, timeZone) {
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return ''
  const tz = timeZone || historyDisplayTimeZone()
  const parts = {}
  new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  })
    .formatToParts(d)
    .forEach(part => {
      parts[part.type] = part.value
    })
  return (
    parts.year +
    '-' +
    parts.month +
    '-' +
    parts.day +
    ' ' +
    parts.hour +
    ':' +
    parts.minute +
    ':' +
    parts.second
  )
}

function localizeGeneratedVersionName(row) {
  const type = String((row && row.type) || '').toUpperCase()
  const createdAt = row && (row.created_at || row.createdAt)
  const name = String((row && row.name) || '')
  if (type === 'AUTO') return '自动保存 ' + stripSeconds(formatVersionTime(createdAt))
  if (type === 'PRE_IMPORT') return '导入前 ' + stripSeconds(formatVersionTime(createdAt))
  if (type === 'PRE_RESTORE') return '恢复前 ' + stripSeconds(formatVersionTime(createdAt))
  return name
}

function stripSeconds(value) {
  return String(value || '').replace(/:\d{2}$/, '')
}

module.exports = {
  formatVersionTime,
  historyDisplayTimeZone,
  localizeGeneratedVersionName,
  stripSeconds
}
