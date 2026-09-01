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
