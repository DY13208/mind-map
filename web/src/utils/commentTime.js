const pad = n => (n < 10 ? '0' + n : String(n))

// 评论时间：刚刚 / 10 分钟前 / 1 小时前 / 昨天 18:20 / 10月3日 09:05 / 2025年1月5日
export function formatCommentTime(time, now = Date.now()) {
  const t = Number(time) || 0
  if (!t) return ''
  const diff = Math.max(0, now - t)
  const minute = 60 * 1000
  const hour = 60 * minute
  if (diff < minute) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`
  const d = new Date(t)
  const n = new Date(now)
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const startOfToday = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime()
  if (t >= startOfToday) return `${Math.floor(diff / hour)} 小时前`
  if (t >= startOfToday - 24 * hour) return `昨天 ${hm}`
  if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}
