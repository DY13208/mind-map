// 统一的用户显示名解析（前端）。顺序与服务端 simple-mind-map/bin/displayName.js 一致：
// 真实/显示名（不等于账号 id）→ 昵称 → 账号 id。
function clean(value) {
  return value == null ? '' : String(value).trim()
}

function accountIds(user) {
  return [
    user.username,
    user.userName,
    user.userid,
    user.user_id,
    user.userId,
    user.wecomUserId,
    user.wecom_userid,
    user.id
  ]
    .map(clean)
    .filter(Boolean)
}

export function displayName(user, fallback = '') {
  if (!user || typeof user !== 'object') return clean(user) || fallback
  const ids = accountIds(user)
  const idSet = new Set(ids.map(id => id.toLowerCase()))
  const candidates = [
    user.name,
    user.display_name,
    user.displayName,
    user.realName,
    user.real_name,
    user.nickname,
    user.nickName
  ].map(clean)
  const real = candidates.find(value => value && !idSet.has(value.toLowerCase()))
  if (real) return real
  return ids[0] || candidates.find(Boolean) || fallback
}

// 稳定颜色：同一账号在所有标签页/设备上得到同一种颜色。
export function hashString(value) {
  const text = String(value == null ? '' : value)
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function stableColor(seed, palette) {
  if (!Array.isArray(palette) || !palette.length) return ''
  return palette[hashString(seed) % palette.length]
}

export default displayName
