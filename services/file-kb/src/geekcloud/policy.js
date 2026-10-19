'use strict'
// External data source policy. kb:read never implies JackYun access: the caller's user id must be
// listed in FILE_KB_GEEKCLOUD_ALLOWED_USERS, and stock rows are limited to that user's warehouses.

// MCP tokens additionally need the opt-in geekcloud:read scope; folder-scoped tokens never get it.
// Browser sessions keep the allowlist-only behaviour.

// Reasons that mean "caller may not use JackYun" (as opposed to the data source being off).
const FORBIDDEN_REASONS = ['geekcloud_forbidden', 'token_scope_missing', 'token_folder_scoped']

function resolveAccess(config, user) {
  const deny = reason => ({ allowed: false, reason, warehouses: [], owners: [], price: false, tools: [] })
  if (!config || !config.enabled) return deny('geekcloud_disabled')
  if (!config.configured) return deny('geekcloud_not_configured')
  const id = user && user.id != null ? String(user.id) : ''
  if (user && user.via === 'token') {
    if (Array.isArray(user.scopeFolderIds)) return deny('token_folder_scoped')
    if (!Array.isArray(user.scopes) || !user.scopes.includes('geekcloud:read')) return deny('token_scope_missing')
  }
  if (!id || !config.allowedUsers.includes(id)) return deny('geekcloud_forbidden')
  const own = (map, key) => (map && Object.prototype.hasOwnProperty.call(map, key) ? [...map[key]] : [])
  return {
    allowed: true,
    reason: null,
    warehouses: own(config.warehouseScope, id),
    owners: own(config.ownerScope, id),
    price: Array.isArray(config.priceUsers) && config.priceUsers.includes(id),
    tools: [...config.allowedTools]
  }
}

module.exports = { resolveAccess, FORBIDDEN_REASONS }
