import Vue from 'vue'
import App from './App.vue'
import router from './router'
import store from './store'
import ElementUI from 'element-ui'
import 'element-ui/lib/theme-chalk/index.css'
import '@/assets/icon-font/iconfont.css'
import 'viewerjs/dist/viewer.css'
import VueViewer from 'v-viewer'
import i18n from './i18n'
import { getLang } from '@/api'
// import VConsole from 'vconsole'
// const vConsole = new VConsole()

Vue.config.productionTip = false
const APP_BUILD_COMMIT = process.env.VUE_APP_BUILD_COMMIT || 'dev'
const APP_BUILD_TIME = process.env.VUE_APP_BUILD_TIME || ''
if (typeof window !== 'undefined') {
  window.__MIND_MAP_BUILD__ = {
    commit: APP_BUILD_COMMIT,
    time: APP_BUILD_TIME
  }
  console.info('[APP_BUILD_COMMIT]', APP_BUILD_COMMIT, APP_BUILD_TIME)
}
const bus = new Vue()
Vue.prototype.$bus = bus
Vue.use(ElementUI)
Vue.use(VueViewer)

const initApp = () => {
  i18n.locale = getLang()
  new Vue({
    render: h => h(App),
    router,
    store,
    i18n
  }).$mount('#app')
}

// 是否处于接管应用模式
if (window.takeOverApp) {
  window.initApp = initApp
  window.$bus = bus
} else {
  initApp()
}
