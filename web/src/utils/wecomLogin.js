const WECOM_SDK_URL =
  'https://wwcdn.weixin.qq.com/node/open/js/wecom-jssdk-2.3.4.js'

let sdkPromise = null

export function loadWecomSdk() {
  if (typeof window !== 'undefined' && window.ww && window.ww.createWWLoginPanel) {
    return Promise.resolve(window.ww)
  }
  if (!sdkPromise) {
    sdkPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = WECOM_SDK_URL
      script.async = true
      script.onload = () => {
        if (window.ww && window.ww.createWWLoginPanel) {
          resolve(window.ww)
          return
        }
        reject(new Error('企业微信登录组件加载失败'))
      }
      script.onerror = () => reject(new Error('企业微信登录组件加载失败'))
      document.head.appendChild(script)
    })
  }
  return sdkPromise
}

export async function mountWecomLoginPanel(mountEl, challenge, handlers = {}) {
  const ww = await loadWecomSdk()
  return ww.createWWLoginPanel({
    el: mountEl,
    params: {
      login_type: 'CorpApp',
      appid: challenge.corpId,
      agentid: challenge.agentId,
      redirect_uri: challenge.redirectUri,
      state: challenge.state,
      redirect_type: 'callback',
      panel_size: 'small',
      lang: 'zh'
    },
    onLoginSuccess({ code }) {
      if (handlers.onSuccess) handlers.onSuccess(code)
    },
    onLoginFail(err) {
      if (handlers.onFail) handlers.onFail(err)
    }
  })
}
