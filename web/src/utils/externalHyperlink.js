// 需要独立窗口打开或复制链接访问的第三方登录类域名清单（匹配域名本身及所有子域）
const THIRD_PARTY_AUTH_DOMAINS = [
  'weixin.qq.com',
  'wedoc.qq.com',
  'wework.qq.com',
  'docs.qq.com',
  'feishu.cn',
  'larkoffice.com',
  'dingtalk.com',
  'yuque.com',
  'notion.so',
  'kdocs.cn',
  'shimo.im'
]

// 用于在单页路由切换后保留 URL 显式标记的 WorkBuddy 容器状态
const WORKBUDDY_CONTAINER_STORAGE_KEY = 'wcpd_container_workbuddy'

// 判断目标 URL 是否命中需外开的第三方登录类域名清单
export function isThirdPartyAuthUrl(url) {
  const host = String(url && url.hostname ? url.hostname : '').toLowerCase()
  if (!host) return false
  return THIRD_PARTY_AUTH_DOMAINS.some(
    domain => host === domain || host.endsWith(`.${domain}`)
  )
}

// 检测 URL 参数或会话标记是否显式指定了 WorkBuddy 容器环境
function hasWorkBuddyQueryFlag(win) {
  const search = win.location && win.location.search ? win.location.search : ''
  const params = new URLSearchParams(search)
  const from = String(params.get('from') || '').toLowerCase()
  const container = String(params.get('container') || '').toLowerCase()
  if (from === 'workbuddy' || container === 'workbuddy') {
    try {
      win.sessionStorage.setItem(WORKBUDDY_CONTAINER_STORAGE_KEY, '1')
    } catch (_) {
      // 存储不可用时直接按当前参数生效
    }
    return true
  }
  try {
    return win.sessionStorage.getItem(WORKBUDDY_CONTAINER_STORAGE_KEY) === '1'
  } catch (_) {
    return false
  }
}

// 检测当前页面是否被嵌套在宿主 iframe/WebView 中
function isEmbeddedFrame(win) {
  try {
    return Boolean(win.self && win.top && win.self !== win.top)
  } catch (_) {
    // 跨域访问 window.top 被拒说明当前必然处于内嵌帧中
    return true
  }
}

// 检测当前页面是否运行在 WorkBuddy 客户端内置容器中
export function isWorkBuddyContainer(win = window) {
  const ua = String(win.navigator && win.navigator.userAgent ? win.navigator.userAgent : '')
  if (/workbuddy|electron/i.test(ua)) return true
  if (win.workbuddy) return true
  if (isEmbeddedFrame(win)) return true
  if (hasWorkBuddyQueryFlag(win)) return true
  return false
}

// 尝试在普通浏览器中通过新标签页打开外链，并断开 opener 引用
function tryOpenInNewWindow(href, win = window) {
  const opened = win.open(href, '_blank')
  if (!opened) return false
  try {
    opened.opener = null
  } catch (_) {
    // 跨域窗口拒绝写入 opener 时忽略
  }
  return true
}

// 根据运行环境处理第三方登录类超链接：WorkBuddy 直接给复制链接，普通浏览器开新窗口
export function openThirdPartyAuthLink(href, win = window) {
  const inWorkBuddy = isWorkBuddyContainer(win)
  // WorkBuddy 内不再调用 window.open，避免被容器劫持为当前页跳转冲掉脑图
  if (inWorkBuddy) {
    return { opened: false, mode: 'manual-copy', inWorkBuddy: true }
  }
  // 普通浏览器直接新窗口打开，被拦截时降级为手动复制
  if (tryOpenInNewWindow(href, win)) {
    return { opened: true, mode: 'new-window', inWorkBuddy: false }
  }
  return { opened: false, mode: 'manual-copy', inWorkBuddy: false }
}
