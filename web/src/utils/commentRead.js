// 评论已读状态：按「用户 + 导图 + 节点」保存在本地 localStorage，不写入节点数据
const PREFIX = 'smm_comment_read'

function storage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch (e) {
    return null
  }
}

export function commentReadKey(roomKey, nodeUid, userId) {
  return [PREFIX, String(userId || 'anon'), String(roomKey || 'local'), String(nodeUid || '')].join(':')
}

export function getCommentLastRead(roomKey, nodeUid, userId) {
  const store = storage()
  if (!store || !nodeUid) return 0
  return Number(store.getItem(commentReadKey(roomKey, nodeUid, userId))) || 0
}

export function markCommentsRead(roomKey, nodeUid, userId, time = Date.now()) {
  const store = storage()
  if (!store || !nodeUid) return
  try {
    const prev = getCommentLastRead(roomKey, nodeUid, userId)
    store.setItem(commentReadKey(roomKey, nodeUid, userId), String(Math.max(prev, Number(time) || 0)))
  } catch (e) {
    // 配额已满等情况忽略
  }
}

// 有别人发的、晚于上次已读时间的评论即为未读
export function hasUnreadComments(comments, lastRead, userId) {
  if (!Array.isArray(comments)) return false
  const me = String(userId || '')
  return comments.some(item => item && (Number(item.time) || 0) > (Number(lastRead) || 0) && (!me || String(item.userId || '') !== me))
}

export function isNodeCommentUnread(roomKey, node, userId) {
  if (!node || typeof node.getData !== 'function') return false
  const data = node.getData() || {}
  if (data.commentResolved) return false
  return hasUnreadComments(data.comments, getCommentLastRead(roomKey, data.uid, userId), userId)
}

// 从 @提及 中找出仍出现在正文里的成员
export function collectMentions(content, picked) {
  const text = String(content || '')
  const seen = new Set()
  return (Array.isArray(picked) ? picked : []).filter(item => {
    if (!item || !item.name || seen.has(item.userId || item.name)) return false
    if (!text.includes('@' + item.name)) return false
    seen.add(item.userId || item.name)
    return true
  }).map(item => ({ userId: String(item.userId || ''), name: String(item.name) }))
}

// 把正文切成普通文本与 @提及 片段，用于高亮
export function splitMentions(content, mentions) {
  const text = String(content || '')
  const names = (Array.isArray(mentions) ? mentions : []).map(m => m && m.name).filter(Boolean)
  if (!names.length) return [{ text, mention: false }]
  const escaped = names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length)
  const re = new RegExp('(@(?:' + escaped.join('|') + '))', 'g')
  return text.split(re).filter(Boolean).map(part => ({ text: part, mention: part.charAt(0) === '@' && names.includes(part.slice(1)) }))
}
