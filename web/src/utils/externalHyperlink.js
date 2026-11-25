// 需要独立窗口或系统默认浏览器打开的第三方登录类域名清单（匹配域名本身及所有子域）
const THIRD_PARTY_AUTH_DOMAINS = [
  'weixin.qq.com',
  'docs.qq.com',
  'feishu.cn',
  'larkoffice.com',
  'dingtalk.com',
  'yuque.com',
  'notion.so',
  'kdocs.cn',
  'shimo.im'
]

// 判断目标 URL 是否命中需外开的第三方登录类域名清单
export function isThirdPartyAuthUrl(url) {
  const host = String(url && url.hostname ? url.hostname : '').toLowerCase()
  if (!host) return false
  return THIRD_PARTY_AUTH_DOMAINS.some(
    domain => host === domain || host.endsWith(`.${domain}`)
  )
}

// 检测当前页面是否运行在 WorkBuddy 客户端内置容器中
export function isWorkBuddyContainer(win = window) {
  const ua = String(win.navigator.userAgent || '')
  if (/workbuddy/i.test(ua)) return true
  if (win.workbuddy) return true
  if (/electron/i.test(ua) && (win.electronAPI || win.electron)) return true
  return false
}

// 尝试调用 WorkBuddy / Electron 宿主桥接方法直接拉起系统默认浏览器
function tryOpenViaHostBridge(href, win = window) {
  const handlers = [
    win.workbuddy && win.workbuddy.openExternal,
    win.workbuddy && win.workbuddy.openUrl,
    win.electronAPI && win.electronAPI.openExternal,
    win.electron && win.electron.shell && win.electron.shell.openExternal
  ]
  for (const handler of handlers) {
    if (typeof handler !== 'function') continue
    try {
      const result = handler(href)
      if (result && typeof result.catch === 'function') {
        result.catch(() => {})
      }
      return true
    } catch (_) {
      // 当前桥接调用失败时继续尝试下一个候选方法
    }
  }
  return false
}

// 尝试通过新窗口打开外链，并断开 opener 引用
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

// 根据运行环境打开第三方登录类超链接，返回打开结果与实际方式
export function openThirdPartyAuthLink(href, win = window) {
  const inWorkBuddy = isWorkBuddyContainer(win)
  // WorkBuddy 环境优先走宿主默认浏览器桥接，失败后再尝试 window.open
  if (inWorkBuddy) {
    if (tryOpenViaHostBridge(href, win)) {
      return { opened: true, mode: 'host-browser', inWorkBuddy: true }
    }
    if (tryOpenInNewWindow(href, win)) {
      return { opened: true, mode: 'new-window', inWorkBuddy: true }
    }
    return { opened: false, mode: 'manual-copy', inWorkBuddy: true }
  }
  // 普通浏览器直接新窗口打开，被拦截时降级为手动复制
  if (tryOpenInNewWindow(href, win)) {
    return { opened: true, mode: 'new-window', inWorkBuddy: false }
  }
  return { opened: false, mode: 'manual-copy', inWorkBuddy: false }
}
