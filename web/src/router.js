import Vue from 'vue'
import VueRouter from 'vue-router'

Vue.use(VueRouter)

const roomPathRedirect = to => ({
  path: '/',
  query: {
    ...to.query,
    room: to.params.roomKey
  }
})

const routes = [
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
    path: '/',
    name: 'Edit',
    component: () => import(`./pages/Edit/Index.vue`)
  },
  {
    path: '/room-:roomSuffix',
    redirect: to => roomPathRedirect({ ...to, params: { roomKey: `room-${to.params.roomSuffix}` } })
  },
  {
    path: '/room/:roomKey',
    redirect: roomPathRedirect
  },
  {
    path: '/index',
    redirect: '/'
  },
  {
    path: '/map',
    redirect: to => ({ path: '/', query: to.query })
  },
  {
    path: '/doc/zh',
    component: () => import(`./pages/Doc.vue`)
  }
]

const router = new VueRouter({
  routes
})

export default router
