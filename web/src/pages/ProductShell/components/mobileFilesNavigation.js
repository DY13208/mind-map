const MY_MAPS_UNSUPPORTED_VIEWS = new Set(['recent', 'shared'])

export function normalizeMobileFilesBase(basePath) {
  return String(basePath || '') === '/my-maps' ? '/my-maps' : '/files'
}

function withTeam(path, team) {
  const teamId = String(team || '')
  return teamId ? { path, query: { team: teamId } } : { path }
}

export function mobileViewTarget(basePath, view, options = {}) {
  const base = normalizeMobileFilesBase(basePath)
  const key = String(view || 'files')
  if (key === 'files') return withTeam(base, options.team)
  const path =
    base === '/my-maps' && MY_MAPS_UNSUPPORTED_VIEWS.has(key)
      ? `/files/${key}`
      : `${base}/${key}`
  return withTeam(path, options.team)
}

export function mobileFolderTarget(basePath, folderId, options = {}) {
  const id = String(folderId || '').trim()
  if (!id) return mobileRootTarget(basePath, options)
  return withTeam(
    `${normalizeMobileFilesBase(basePath)}/folder/${id}`,
    options.team
  )
}

export function mobileRootTarget(basePath, options = {}) {
  return withTeam(normalizeMobileFilesBase(basePath), options.team)
}

export function mobileParentTarget(basePath, folderPath, options = {}) {
  const path = Array.isArray(folderPath) ? folderPath : []
  if (path.length > 1) {
    return mobileFolderTarget(basePath, path[path.length - 2].id, options)
  }
  return mobileRootTarget(basePath, options)
}

export function isFolderPathAncestor(folderPath, index) {
  const path = Array.isArray(folderPath) ? folderPath : []
  return index >= 0 && index < path.length - 1
}

export function sameMobileLocation(target, route) {
  if (!target || !route || target.path !== route.path) return false
  const targetQuery = target.query || {}
  const routeQuery = route.query || {}
  return (
    String(targetQuery.team || '') === String(routeQuery.team || '') &&
    String(targetQuery.shell || '') === String(routeQuery.shell || '')
  )
}

export function shouldNavigateMobile(target, route) {
  return !sameMobileLocation(target, route)
}

export function toggleMobilePanel(current, next) {
  return current === next ? null : next
}

export function updateMobilePanel(current, panel, open) {
  if (open) return current === panel ? current : panel
  return current === panel ? null : current
}
