'use strict'

// 统一的用户显示名解析（服务端）。优先级：
// 1) 已存储的显示名/真实名（不等于账号 id / userid / username）
// 2) 通讯录真实名（非 userid）
// 3) IM / WorkBuddy / OneID 昵称
// 4) userid / username
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

function resolveDisplayName(user, fallback = '') {
  if (!user || typeof user !== 'object') return clean(user) || fallback
  const ids = accountIds(user)
  const idSet = new Set(ids.map(id => id.toLowerCase()))
  const isReal = value => value && !idSet.has(value.toLowerCase())
  const candidates = [
    // 1) 已存储的显示名 / 真实名
    user.name,
    user.display_name,
    user.displayName,
    user.realName,
    user.real_name,
    // 2) 通讯录真实名
    user.directoryName,
    // 3) 昵称
    user.nickname,
    user.nickName
  ].map(clean)
  const real = candidates.find(isReal)
  if (real) return real.slice(0, 100)
  return (ids[0] || candidates.find(Boolean) || fallback).slice(0, 100)
}

// 某个名字是否只是账号 id（用于判断是否需要被更好的名字替换）
function isAccountIdName(name, user) {
  const value = clean(name)
  if (!value) return true
  return accountIds(user || {}).some(id => id.toLowerCase() === value.toLowerCase())
}

module.exports = { resolveDisplayName, isAccountIdName }
