// 企业微信返回的头像是一个 URL，但列表接口在没有头像时会退化成姓名首字。
// 这两种值都放在 `avatar` 字段里，渲染前必须区分，否则 URL 会被当成文字画进头像圈。

export function isAvatarImage(value) {
  const url = String(value || '').trim()
  if (!url) return false
  return /^(https?:)?\/\//.test(url) || url.startsWith('data:image/')
}

export function avatarInitial(name, fallback = '用') {
  const text = String(name || '').trim()
  return text ? text.slice(0, 1) : fallback
}

// 头像圈需要的两个值：能直接当 <img src> 的地址，以及地址缺失时兜底的首字。
export function resolveAvatar(source = {}, fallback = '用') {
  const avatar = source.avatar
  return {
    src: isAvatarImage(avatar) ? String(avatar).trim() : '',
    initial: isAvatarImage(avatar)
      ? avatarInitial(source.name, fallback)
      : avatarInitial(avatar || source.name, fallback)
  }
}
