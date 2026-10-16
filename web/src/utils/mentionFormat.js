// 「@我的」消息的展示辅助：时间格式、头像首字/颜色、跳转路由。
// 纯函数，便于在 web/tests 中直接测试。
import { stableColor } from './displayName'

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
export const MENTION_AVATAR_COLORS = ['#1f8f66', '#2f80c9', '#d9822b', '#8e5bd6', '#d14d6b', '#1a9ba0', '#6f8f2b', '#b5651d']

function toDate(value) {
  if (value instanceof Date) return value
  const n = typeof value === 'number' ? value : Date.parse(value)
  return new Date(Number.isFinite(n) ? n : NaN)
}

function pad(n) {
  return String(n).padStart(2, '0')
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

// 绝对时间：今天 15:12 / 昨天 15:12 / 周四 15:12（7 天内）/ 10月3日 15:12（今年）/ 2025年10月3日
export function formatMentionAbsolute(value, now = Date.now()) {
  const d = toDate(value)
  if (Number.isNaN(d.getTime())) return ''
  const n = toDate(now)
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const days = Math.round((startOfDay(n) - startOfDay(d)) / 86400000)
  if (days === 0) return `今天 ${hm}`
  if (days === 1) return `昨天 ${hm}`
  if (days > 1 && days < 7) return `${WEEKDAYS[d.getDay()]} ${hm}`
  if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

// 相对时间：刚刚 / 5 分钟前 / 2 小时前 / 3 天前 / 2 周前 / 3 个月前 / 1 年前
export function formatMentionRelative(value, now = Date.now()) {
  const d = toDate(value)
  if (Number.isNaN(d.getTime())) return ''
  const diff = Math.max(0, toDate(now).getTime() - d.getTime())
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} 天前`
  if (days < 30) return `${Math.floor(days / 7)} 周前`
  if (days < 365) return `${Math.floor(days / 30)} 个月前`
  return `${Math.floor(days / 365)} 年前`
}

export function mentionInitial(name) {
  const text = String(name || '').trim()
  if (!text) return '?'
  const ch = Array.from(text)[0]
  return /[a-z]/i.test(ch) ? ch.toUpperCase() : ch
}

export function mentionAvatarColor(item) {
  const seed = (item && (item.author_id || item.author_name)) || ''
  return stableColor(seed, MENTION_AVATAR_COLORS)
}

// 跳转到编辑页：沿用节点分享的 ?room=&focus= 深链，额外带上评论 id
export function mentionRoute(item) {
  return {
    path: '/',
    query: {
      room: String((item && item.room_key) || ''),
      focus: String((item && item.node_uid) || ''),
      comment: String((item && (item.comment_id || item.id)) || '')
    }
  }
}

// 评论正文切片：高亮 @提及（结构化 mentions 优先，旧数据回退为匹配 @名字）
export function mentionSegments(content, mentions, fallbackNames = []) {
  const text = String(content || '')
  const names = (Array.isArray(mentions) ? mentions : [])
    .map(m => m && m.name)
    .concat(fallbackNames || [])
    .map(n => String(n || '').trim())
    .filter(Boolean)
  const uniq = Array.from(new Set(names))
  if (!uniq.length) return [{ text, mention: false }]
  const escaped = uniq.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length)
  const re = new RegExp('(@(?:' + escaped.join('|') + '))', 'g')
  return text
    .split(re)
    .filter(Boolean)
    .map(part => ({ text: part, mention: part.charAt(0) === '@' && uniq.includes(part.slice(1)) }))
}

// 节点评论列表里是否还存在某条未删除的评论（墓碑优先）
export function isLiveComment(comments, commentId) {
  if (!Array.isArray(comments) || !commentId) return false
  const id = String(commentId)
  let live = false
  for (const c of comments) {
    if (!c || String(c.id) !== id) continue
    if (c.deleted === true) return false
    live = true
  }
  return live
}
