import Vue from 'vue'
import VueRouter from 'vue-router'
import {
  consumeSkipMyMapsRedirect,
  getLastRoom,
  isMyMapsRootPath,
  migrateLegacyHashUrl,
  rememberLastRoom
} from './utils/roomLocation'
import { resolveNavigationShell } from './utils/shellMode'
import { normalizeReturnTo, readReturnContext } from './utils/fileNavigation'

Vue.use(VueRouter)

migrateLegacyHashUrl()

const roomPathRedirect = to => ({
  path: '/',
  query: {
    ...to.query,
    room: to.params.roomKey
  }
})

const PRODUCT_SHELL_PATHS = new Set([
  '/files',
  '/my-maps',
  '/spaces',
  '/profile',
  '/mcp-access',
  '/graph',
  '/cognee',
  '/assistant',
  '/kb',
  '/sop'
])

const isProductShellRoute = route =>
  !!(route && route.matched && route.matched.some(record => PRODUCT_SHELL_PATHS.has(record.path)))

const editorRoomQuery = (to, from, isHistoryNavigation) => {
  const query = { ...(to.query || {}) }
  if (
    isHistoryNavigation ||
    to.path !== '/' ||
    from.path !== '/' ||
    !query.room ||
    !(from.query && from.query.room)
  ) {
    return query
  }

  const sourceQuery = from.query || {}
  const sourceReturnTo = normalizeReturnTo(sourceQuery.returnTo)
  if (!sourceReturnTo) return query

  const hasExplicitReturnTo =
    typeof query.returnTo === 'string' && query.returnTo.trim() !== ''
  const targetReturnTo = normalizeReturnTo(query.returnTo)
  if (!hasExplicitReturnTo) query.returnTo = sourceReturnTo

  // A new list destination starts a new navigation context; never attach the
  // prior directory's session token to a different destination.
  const sameReturnTarget = !hasExplicitReturnTo || targetReturnTo === sourceReturnTo
  if (sameReturnTarget && !query.nav) {
    const context = readReturnContext(from)
    if (context && sourceQuery.nav) query.nav = sourceQuery.nav
  }
  return query
}

const routes = [
  {
    path: '/node-share/:id',
    name: 'NodeShare',
    component: () => import('./pages/NodeShare/Index.vue')
  },
  {
    path: '/dashboards',
    redirect: '/files'
  },
  {
    path: '/dashboards/:id',
    redirect: '/files'
  },
  {
    path: '/files',
    component: () =>
      import(
        /* webpackChunkName: "product-shell" */ './pages/ProductShell/components/ProductShellLayout.vue'
      ),
    children: [
      {
        path: '',
        name: 'Files',
        component: () =>
          import(
            /* webpackChunkName: "product-shell" */ './pages/ProductShell/FilesPage.vue'
          ),
        props: { mode: 'files' }
      },
      {
        path: 'recent',
        name: 'RecentFiles',
        component: () =>
          import(
            /* webpackChunkName: "product-shell" */ './pages/ProductShell/FilesPage.vue'
          ),
        props: { mode: 'recent' }
      },
      {
        path: 'favorites',
        name: 'FavoriteFiles',
        component: () =>
          import(
            /* webpackChunkName: "product-shell" */ './pages/ProductShell/FilesPage.vue'
          ),
        props: { mode: 'favorites' }
      },
      {
        path: 'shared',
        name: 'SharedFiles',
        component: () =>
          import(
            /* webpackChunkName: "product-shell" */ './pages/ProductShell/FilesPage.vue'
          ),
        props: { mode: 'shared' }
      },
      {
        path: 'trash',
        name: 'TrashFiles',
        component: () =>
          import(
            /* webpackChunkName: "product-shell" */ './pages/ProductShell/FilesPage.vue'
          ),
        props: { mode: 'trash' }
      },
      {
        path: 'folder/:id',
        name: 'FolderFiles',
        component: () =>
          import(
            /* webpackChunkName: "product-shell" */ './pages/ProductShell/FilesPage.vue'
          ),
        props: { mode: 'folder' }
      }
    ]
  },
  {
    path: '/my-maps',
    component: () =>
      import(
        /* webpackChunkName: "product-shell" */ './pages/ProductShell/components/ProductShellLayout.vue'
      ),
    children: [
      {
        path: '',
        name: 'MyMaps',
        component: () =>
          import(
            /* webpackChunkName: "product-shell" */ './pages/ProductShell/FilesPage.vue'
          ),
        props: { mode: 'files' }
      },
      {
        path: 'favorites',
        name: 'MyMapsFavorites',
        component: () =>
          import(
            /* webpackChunkName: "product-shell" */ './pages/ProductShell/FilesPage.vue'
          ),
        props: { mode: 'favorites' }
      },
      {
        path: 'folder/:id',
        name: 'MyMapsFolder',
        component: () =>
          import(
            /* webpackChunkName: "product-shell" */ './pages/ProductShell/FilesPage.vue'
          ),
        props: { mode: 'folder' }
      }
    ]
  },
  {
    path: '/spaces',
    component: () =>
      import(
        /* webpackChunkName: "product-shell" */ './pages/ProductShell/components/ProductShellLayout.vue'
      ),
    children: [
      {
        path: '',
        name: 'Spaces',
        component: () =>
          import(
            /* webpackChunkName: "product-shell" */ './pages/ProductShell/SpacesPage.vue'
          )
      },
      {
        path: ':id',
        name: 'SpaceDetail',
        component: () =>
          import(
            /* webpackChunkName: "product-shell" */ './pages/ProductShell/SpaceDetailPage.vue'
          )
      }
    ]
  },
  {
    path: '/profile',
    component: () =>
      import(
        /* webpackChunkName: "product-shell" */ './pages/ProductShell/components/ProductShellLayout.vue'
      ),
    children: [
      {
        path: '',
        name: 'Profile',
        component: () =>
          import(
            /* webpackChunkName: "product-shell" */ './pages/ProductShell/ProfilePage.vue'
          )
      }
    ]
  },
  {
    path: '/mcp-access',
    component: () =>
      import(
        /* webpackChunkName: "product-shell" */ './pages/ProductShell/components/ProductShellLayout.vue'
      ),
    children: [
      {
        path: '',
        name: 'McpAccess',
        component: () =>
          import(
            /* webpackChunkName: "product-shell" */ './pages/ProductShell/McpAccessPage.vue'
          )
      }
    ]
  },
  {
    path: '/graph',
    component: () =>
      import(
        /* webpackChunkName: "product-shell" */ './pages/ProductShell/components/ProductShellLayout.vue'
      ),
    children: [
      {
        path: '',
        name: 'GraphService',
        component: () =>
          import(
            /* webpackChunkName: "graph-service" */ './pages/ProductShell/GraphServicePage.vue'
          )
      }
    ]
  },
  {
    path: '/cognee',
    component: () =>
      import(
        /* webpackChunkName: "product-shell" */ './pages/ProductShell/components/ProductShellLayout.vue'
      ),
    children: [
      {
        path: '',
        name: 'CogneeAccess',
        component: () =>
          import(
            /* webpackChunkName: "cognee" */ './pages/ProductShell/CogneeAccessPage.vue'
          )
      }
    ]
  },
  {
    path: '/',
    name: 'Edit',
    component: () => import(`./pages/Edit/Index.vue`),
    beforeEnter(to, from, next) {
      const room = to.query && to.query.room
      if (room == null || String(room).trim() === '') {
        next({
          path: '/files',
          query: to.query && to.query.shell ? { shell: to.query.shell } : {},
          replace: true
        })
        return
      }
      rememberLastRoom(room)
      next()
    }
  },
  {
    path: '/room-:roomSuffix',
    redirect: to =>
      roomPathRedirect({
        ...to,
        params: { roomKey: `room-${to.params.roomSuffix}` }
      })
  },
  {
    path: '/room/:roomKey',
    redirect: roomPathRedirect
  },
  {
    path: '/index',
    redirect: to =>
      to.query && to.query.room
        ? { path: '/', query: to.query }
        : { path: '/files', replace: true }
  },
  {
    path: '/map',
    redirect: to =>
      to.query && to.query.room
        ? { path: '/', query: to.query }
        : { path: '/files', replace: true }
  },
  {
    path: '/assistant',
    component: () =>
      import(
        /* webpackChunkName: "product-shell" */ './pages/ProductShell/components/ProductShellLayout.vue'
      ),
    children: [
      {
        path: '',
        name: 'Assistant',
        component: () =>
          import(
            /* webpackChunkName: "assistant" */ './pages/ProductShell/AssistantPage.vue'
          )
      }
    ]
  },
  {
    path: '/kb',
    component: () =>
      import(
        /* webpackChunkName: "product-shell" */ './pages/ProductShell/components/ProductShellLayout.vue'
      ),
    children: [
      {
        path: ':tab(files|parse|data|search|mcp)?',
        name: 'FileKb',
        component: () =>
          import(
            /* webpackChunkName: "file-kb" */ './features/knowledge-base/pages/KbIndexPage.vue'
          )
      }
    ]
  },
  {
    path: '/sop-tasks',
    redirect: '/sop'
  },
  {
    path: '/sop',
    component: () =>
      import(
        /* webpackChunkName: "product-shell" */ './pages/ProductShell/components/ProductShellLayout.vue'
      ),
    children: [
      {
        path: '',
        name: 'SopRegistry',
        component: () =>
          import(
            /* webpackChunkName: "sop-registry" */ './pages/SopRegistry/Index.vue'
          )
      }
    ]
  },
  {
    path: '/doc/zh',
    component: () => import(`./pages/Doc.vue`)
  }
]

const router = new VueRouter({
  mode: 'history',
  routes
})

let historyNavigationPending = false
if (typeof window !== 'undefined') {
  // Capture phase runs before VueRouter's popstate listener, so a Back/Forward
  // target keeps the mode encoded in that history entry instead of inheriting
  // the route being left.
  window.addEventListener(
    'popstate',
    () => {
      historyNavigationPending = true
      setTimeout(() => {
        historyNavigationPending = false
      }, 0)
    },
    true
  )
}
router.afterEach(() => {
  historyNavigationPending = false
})

// 仅 /my-maps 根路径回跳最近房间；/my-maps/folder/... 保持文件夹浏览
router.beforeEach((to, from, next) => {
  const isShellRoute = isProductShellRoute(to) || to.path === '/'
  if (isShellRoute) {
    const query = editorRoomQuery(to, from, historyNavigationPending)
    const targetWithContext = { ...to, query }
    const shell = resolveNavigationShell(targetWithContext, from, historyNavigationPending)
    if (
      !to.query ||
      to.query.shell !== shell ||
      to.query.returnTo !== query.returnTo ||
      to.query.nav !== query.nav
    ) {
      next({
        path: to.path,
        query: { ...query, shell },
        hash: to.hash,
        replace: true
      })
      return
    }
  }

  if (!isMyMapsRootPath(to.path)) {
    next()
    return
  }
  if (consumeSkipMyMapsRedirect()) {
    next()
    return
  }
  // 列表内部导航（面包屑回根目录、删除文件夹后返回等）不回跳房间
  const fromPath = String((from && from.path) || '')
  if (fromPath === '/my-maps' || fromPath.startsWith('/my-maps/')) {
    next()
    return
  }
  // Returning from an editor to the list is an intentional top-level visit;
  // do not let the recent-room shortcut send the user back into the editor.
  if (fromPath === '/' && from && from.query && from.query.room) {
    next()
    return
  }
  // A list history entry carrying a valid navigation snapshot represents an
  // intentional return destination. Let browser Back reach it instead of
  // immediately redirecting to the most recently opened room.
  if (readReturnContext(to)) {
    next()
    return
  }
  const last = getLastRoom()
  if (!last) {
    next()
    return
  }
  if (to.query && to.query.room === last) {
    next()
    return
  }
  next({
    path: '/',
    query: { ...to.query, room: last },
    replace: true
  })
})

export default router
