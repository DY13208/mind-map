const SHELL_MODES = new Set(['full', 'focus', 'embed'])
const INTERNAL_URL_BASE = 'http://shell-mode.local'

const getRoutePath = route => {
  if (!route) return ''
  return typeof route.path === 'string' ? route.path : ''
}

const getQueryMode = route => {
  const value = route && route.query && route.query.shell
  return typeof value === 'string' && SHELL_MODES.has(value) ? value : null
}

const isMyMapsPath = path => /^\/my-maps(?:\/|$)/.test(path || '')

export const resolveShellMode = route => {
  const explicitMode = getQueryMode(route)
  if (explicitMode) return explicitMode
  const path = getRoutePath(route)
  const isLegacyEditorRoute = path === '/' && route && route.query && route.query.room
  return isMyMapsPath(path) || isLegacyEditorRoute ? 'focus' : 'full'
}

/**
 * Resolve a navigation target mode. Browser history entries keep the mode
 * represented by their own URL (or their entry's default); new navigation
 * from an explicitly-modeled route carries the source mode forward.
 */
export const resolveNavigationShell = (
  targetRoute,
  sourceRoute,
  isHistoryNavigation = false
) => {
  const explicitTargetMode = getQueryMode(targetRoute)
  if (explicitTargetMode) return explicitTargetMode
  if (isHistoryNavigation) return resolveShellMode(targetRoute)

  if (getQueryMode(sourceRoute) || isMyMapsPath(getRoutePath(sourceRoute))) {
    return resolveShellMode(sourceRoute)
  }
  return resolveShellMode(targetRoute)
}

const parseQueryString = search => {
  const query = {}
  const params = new URLSearchParams(search || '')
  params.forEach((value, key) => {
    if (Object.prototype.hasOwnProperty.call(query, key)) {
      query[key] = Array.isArray(query[key])
        ? [...query[key], value]
        : [query[key], value]
    } else {
      query[key] = value
    }
  })
  return query
}

const locationToRouteObject = location => {
  if (typeof location !== 'string') {
    return location && typeof location === 'object' ? { ...location } : null
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(location) || location.startsWith('//')) {
    return null
  }

  try {
    const parsed = new URL(location, INTERNAL_URL_BASE)
    if (parsed.origin !== INTERNAL_URL_BASE) return null
    return {
      path: parsed.pathname,
      query: parseQueryString(parsed.search),
      ...(parsed.hash ? { hash: parsed.hash } : {})
    }
  } catch (error) {
    return null
  }
}

/**
 * Copy a router location and carry the current layout mode into its URL.
 * External string URLs are returned unchanged.
 */
export const withShell = (location, sourceRoute) => {
  const routeLocation = locationToRouteObject(location)
  if (!routeLocation) return location

  const targetMode = getQueryMode(routeLocation)
  const query = {
    ...(routeLocation.query || {}),
    shell: targetMode || resolveShellMode(sourceRoute || routeLocation)
  }
  return { ...routeLocation, query }
}

export const SHELL_MODE_VALUES = Object.freeze(['full', 'focus', 'embed'])
