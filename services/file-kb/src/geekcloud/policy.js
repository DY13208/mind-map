'use strict'
// External data source policy. kb:read never implies JackYun access: the caller's user id must be
// listed in FILE_KB_GEEKCLOUD_ALLOWED_USERS, and stock rows are limited to that user's warehouses.

// MCP tokens additionally need the opt-in geekcloud:read scope; folder-scoped tokens never get it.
// Browser sessions keep the allowlist-only behaviour.

// "*" in FILE_KB_GEEKCLOUD_ALLOWED_USERS / PRICE_USERS means every authenticated user; a "*" key in
// WAREHOUSE_SCOPE / OWNER_SCOPE is the default for users without an own key (an own key replaces it, no merge).
const ALL_USERS = '*'

// Reasons that mean "caller may not use JackYun" (as opposed to the data source being off).
const FORBIDDEN_REASONS = ['geekcloud_forbidden', 'token_scope_missing', 'token_folder_scoped']

function resolveAccess(config, user) {
  const deny = reason => ({ allowed: false, reason, warehouses: [], allWarehouses: false, owners: [], price: false, tools: [] })
  if (!config || !config.enabled) return deny('geekcloud_disabled')
  if (!config.configured) return deny('geekcloud_not_configured')
  const id = user && user.id != null ? String(user.id) : ''
  if (user && user.via === 'token') {
    if (Array.isArray(user.scopeFolderIds)) return deny('token_folder_scoped')
    if (!Array.isArray(user.scopes) || !user.scopes.includes('geekcloud:read')) return deny('token_scope_missing')
  }
  const listed = list => Array.isArray(list) && (list.includes(id) || list.includes(ALL_USERS))
  if (!id || !listed(config.allowedUsers)) return deny('geekcloud_forbidden')
  const has = (map, key) => !!map && Object.prototype.hasOwnProperty.call(map, key)
  const own = (map, key) => (has(map, key) ? [...map[key]] : has(map, ALL_USERS) ? [...map[ALL_USERS]] : [])
  const warehouses = own(config.warehouseScope, id)
  return {
    allowed: true,
    reason: null,
    // ["*"] (config-validated, never mixed) = all warehouses; warehouses stays ['*'] for older readers.
    warehouses,
    allWarehouses: warehouses.length === 1 && warehouses[0] === ALL_USERS,
    owners: own(config.ownerScope, id),
    price: listed(config.priceUsers),
    tools: [...config.allowedTools]
  }
}

module.exports = { resolveAccess, FORBIDDEN_REASONS }
