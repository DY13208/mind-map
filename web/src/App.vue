<template>
  <div id="app">
    <div class="authScreen authScreen--loading" v-if="authLoading">
      <div class="authSpinner"></div>
    </div>
    <div class="authScreen" v-else-if="authFailure">
      <div class="authCard authCard--compact">
        <h1 class="authBrand">CPD</h1>
        <p class="authFailureText">{{ authFailure }}</p>
        <p class="authFailureCode" v-if="authFailureCode">{{ authFailureCode }}</p>
        <button
          class="authButton"
          :disabled="authRetrying"
          @click="retryAuth"
        >
          {{ authRetrying ? '请稍候…' : '重新连接' }}
        </button>
      </div>
    </div>
    <div
      class="authScreen"
      v-else-if="authState.enabled && !authState.authenticated"
    >
      <div class="authCard authCard--login">
        <div class="authIntro">
          <div class="authBrandBlock">
            <div class="authBrandMark">依</div>
            <h1 class="authBrand">CPD</h1>
          </div>
          <p class="authSubtitle">{{ authLoginSubtitle }}</p>
          <div class="authError" v-if="authErrorMessage">{{ authErrorMessage }}</div>
        </div>
        <div class="authLoginPanel">
          <div class="authQrHeading" v-if="authState.wecomEnabled">
            <strong>企业微信扫码登录</strong>
            <span>使用企业微信扫描二维码</span>
          </div>
          <div class="authQrShell" v-if="authState.wecomEnabled">
            <div ref="qrMount" class="authQrMount"></div>
            <div class="authQrOverlay" v-if="qrRefreshing">
              <div class="authSpinner"></div>
            </div>
            <div class="authQrFailure" v-else-if="qrFailure">
              <span>{{ qrFailure }}</span>
              <button class="authButton authButton--small" @click="refreshLoginQr">
                重试
              </button>
            </div>
          </div>
          <div class="authQrTools" v-if="authState.wecomEnabled">
            <button
              class="authRefresh"
              @click="refreshLoginQr"
              :disabled="qrRefreshing"
              title="刷新二维码"
            >
              <span class="authRefreshIcon" :class="{ spinning: qrRefreshing }">↻</span>
              {{ qrRefreshing ? '刷新中' : '刷新二维码' }}
            </button>
          </div>
          <div class="authActions">
            <button
              v-if="authState.workbuddyEnabled"
              class="authButton authButton--secondary"
              type="button"
              :disabled="workbuddyRedirecting || !authState.workbuddyLoginReady"
              @click="startWorkBuddyLogin"
            >
              {{
                !authState.workbuddyLoginReady
                  ? 'WorkBuddy 单点登录配置中'
                  : workbuddyRedirecting
                    ? '正在进入 WorkBuddy…'
                    : 'WorkBuddy 单点登录'
              }}
            </button>
          </div>
          <p
            class="authOneIdHint"
            v-if="authState.workbuddyEnabled && !authState.workbuddyLoginReady"
          >
            OAuth 应用配置完成后开放
          </p>
          <div class="authDevLogin" v-if="authState.devBypassAvailable">
            <button
              class="authDevToggle"
              type="button"
              @click="showDevLogin = !showDevLogin"
            >
              {{ showDevLogin ? '收起开发者登录' : '开发者密钥登录' }}
            </button>
            <form
              v-if="showDevLogin"
              class="authDevForm"
              @submit.prevent="submitDevLogin"
            >
              <input
                v-model="devAuthKey"
                class="authDevInput"
                type="password"
                autocomplete="off"
                placeholder="输入 .env 中的 AUTH_DEV_BYPASS_KEY"
              />
              <input
                v-model="devAuthMobile"
                class="authDevInput"
                type="tel"
                inputmode="numeric"
                autocomplete="tel"
                :placeholder="
                  authState.devBypassMobileHint
                    ? `手机号（默认 ${authState.devBypassMobileHint}）`
                    : '小策已绑定成员的企微手机号'
                "
              />
              <p class="authDevHint">
                换人调试直接改手机号即可，例如黄炜龙
                <code>17388658096</code>。登录后身份以解析出的企微 userid 为准。
              </p>
              <button
                class="authButton authButton--small"
                type="submit"
                :disabled="devLoggingIn || !devAuthKey.trim()"
              >
                {{ devLoggingIn ? '登录中…' : '进入' }}
              </button>
              <p class="authDevError" v-if="devLoginError">{{ devLoginError }}</p>
            </form>
          </div>
        </div>
      </div>
    </div>
    <template v-else>
      <router-view></router-view>
    </template>
  </div>
</template>

<script>
import {
  clearWorkBuddyAutoLoginAttempt,
  clearWecomClientAutoLoginAttempt,
  createLoginQr,
  devLogin,
  getAuthApiUrl,
  getWorkBuddyLoginUrl,
  getStoredDevAuthKey,
  getWecomClientLoginUrl,
  loadAuthState,
  markWorkBuddyAutoLoginAttempted,
  markWecomClientAutoLoginAttempted,
  WORKBUDDY_AUTO_ATTEMPT_KEY,
  WECOM_CLIENT_AUTO_ATTEMPT_KEY
} from '@/utils/auth'
import { mountWecomLoginPanel } from '@/utils/wecomLogin'

const PAGE_TITLE = 'CPD'
const AUTH_BOOTSTRAP_MS = 45000
const isWecomClientEnvironment = () =>
  /\bwxwork\b/i.test(String(window.navigator.userAgent || ''))
const authErrors = {
  invalid_state: '登录状态校验失败，请重新扫码。',
  expired_state: '二维码已过期，请重新扫码。',
  missing_code: '你取消了授权，请重新扫码并确认登录。',
  not_enterprise_member: '当前账号不在该企业应用的可见范围内。',
  wecom_ip_not_allowed:
    '服务器出口 IP 未加入企业微信应用可信 IP，请联系管理员处理（错误码 60020）。',
  wecom_identity_failed: '企业微信未能确认成员身份，请稍后重试。',
  wecom_token_failed: '企业微信应用配置无效，请联系管理员。',
  wecom_timeout: '企业微信响应超时，请稍后重试。',
  wecom_unavailable: '企业微信服务暂不可用，请稍后重试。',
  oneid_access_denied: 'WorkBuddy 单点登录未完成，可重试或使用企业微信扫码。',
  oneid_missing_code: 'OneID 未返回有效授权码，请重新登录。',
  oneid_token_failed: 'OneID 登录票据交换失败，请稍后重试。',
  oneid_identity_failed: 'OneID 未返回有效成员身份，请联系管理员。',
  oneid_account_not_linked:
    'WorkBuddy 账号未匹配到现有企业微信成员。为避免产生第二套账号，已阻止登录，请联系管理员核对成员手机号。',
  oneid_invalid_response: 'OneID 返回的数据不完整，请稍后重试。',
  oneid_http_error: 'OneID 登录服务响应异常，请稍后重试。',
  oneid_timeout: 'OneID 响应超时，请稍后重试。',
  oneid_unavailable: 'OneID 服务暂不可用，可使用企业微信扫码。',
  workbuddy_access_denied:
    'WorkBuddy 单点登录未完成，可重试或使用企业微信扫码。',
  workbuddy_missing_code: 'WorkBuddy 未返回有效授权码，请重新登录。',
  workbuddy_token_failed: 'WorkBuddy 登录票据交换失败，请稍后重试。',
  workbuddy_identity_failed:
    'WorkBuddy 未返回有效成员身份，请联系管理员。',
  workbuddy_account_not_linked:
    'WorkBuddy 账号未匹配到现有企业微信成员。为避免产生第二套账号，已阻止登录，请联系管理员核对成员信息。',
  workbuddy_identity_conflict:
    '该 WorkBuddy 账号已绑定其他成员，已拒绝变更绑定。',
  workbuddy_invalid_response: 'WorkBuddy 返回的数据不完整，请稍后重试。',
  workbuddy_http_error: 'WorkBuddy 登录服务响应异常，请稍后重试。',
  workbuddy_timeout: 'WorkBuddy 响应超时，请稍后重试。',
  workbuddy_unavailable: 'WorkBuddy 服务暂不可用，可使用企业微信扫码。',
  auth_unavailable: '认证服务暂不可用，请稍后重试。'
}

export default {
  name: 'App',
  data() {
    return {
      authLoading: true,
      authFailure: '',
      authFailureCode: '',
      authRetryAttempt: 0,
      authRetrying: false,
      authState: {
        enabled: false,
        wecomEnabled: false,
        oneIdEnabled: false,
        oneIdLoginReady: false,
        oneIdAutoLogin: false,
        workbuddyEnabled: false,
        workbuddyLoginReady: false,
        workbuddyAutoLogin: false,
        authenticated: false,
        user: null,
        devBypassAvailable: false
      },
      authErrorCode: '',
      qrChallenge: null,
      qrPanel: null,
      qrRefreshing: false,
      qrFailure: '',
      qrRefreshTimer: null,
      isWecomClient: isWecomClientEnvironment(),
      wecomClientRedirecting: false,
      workbuddyRedirecting: false,
      showDevLogin: false,
      devAuthKey: '',
      devAuthMobile: '',
      devLoggingIn: false,
      devLoginError: ''
    }
  },
  computed: {
    authErrorMessage() {
      return authErrors[this.authErrorCode] || ''
    },
    authLoginSubtitle() {
      if (this.authState.wecomEnabled) return '企业微信安全登录'
      return 'WorkBuddy 单点登录'
    }
  },
  watch: {
    authLoading(loading) {
      this.syncPageTitle(loading)
    },
    authState: {
      deep: true,
      handler() {
        this.syncPageTitle(this.authLoading)
      }
    },
    authFailure() {
      this.syncPageTitle(this.authLoading)
    }
  },
  created() {
    const url = new URL(window.location.href)
    this.authErrorCode = url.searchParams.get('auth_error') || ''
    if (this.authErrorCode) {
      url.searchParams.delete('auth_error')
      window.history.replaceState(
        null,
        '',
        `${url.pathname}${url.search}${url.hash}`
      )
    }
    this.initializeAuth()
    this.devAuthKey = getStoredDevAuthKey()
  },
  beforeDestroy() {
    this.clearQrRefreshTimer()
    this.destroyQrPanel()
  },
  methods: {
    syncPageTitle(loading) {
      if (loading) return
      const onLoginScreen =
        !!this.authFailure ||
        (this.authState.enabled && !this.authState.authenticated)
      if (onLoginScreen) document.title = PAGE_TITLE
    },
    retryAuth() {
      if (this.authRetrying) return
      this.authRetrying = true
      const wait = Math.min(15000, 800 * Math.pow(2, this.authRetryAttempt))
      this.authRetryAttempt += 1
      window.setTimeout(() => {
        this.authRetrying = false
        this.initializeAuth()
      }, wait)
    },
    async initializeAuth() {
      this.authLoading = true
      this.authFailure = ''
      this.authFailureCode = ''
      let safetyTimer = null
      try {
        safetyTimer = window.setTimeout(() => {
          if (!this.authLoading) return
          this.authLoading = false
          if (!this.authFailure) {
            this.authFailure = '认证服务响应超时，请稍后重试'
            this.authFailureCode = 'AUTH_TIMEOUT'
            document.title = PAGE_TITLE
          }
        }, AUTH_BOOTSTRAP_MS)
        this.authState = await loadAuthState()
        if (this.authState.authenticated) {
          clearWorkBuddyAutoLoginAttempt()
          clearWecomClientAutoLoginAttempt()
        }
        this.authRetryAttempt = 0
      } catch (err) {
        const code =
          (err && err.code) ||
          (/AUTH_TIMEOUT/.test(err && err.message)
            ? 'AUTH_TIMEOUT'
            : /SERVICE_UNAVAILABLE/.test((err && err.code) || (err && err.message))
              ? 'SERVICE_UNAVAILABLE'
              : '')
        this.authFailureCode = code || 'AUTH_UNAVAILABLE'
        this.authFailure =
          code === 'SERVICE_UNAVAILABLE'
            ? (err && err.message) || '协作服务未启动或无法连接'
            : code === 'AUTH_TIMEOUT'
              ? '认证服务响应超时，请稍后重试'
              : (err && err.message) || '请确认服务已启动后重试'
        document.title = PAGE_TITLE
      } finally {
        if (safetyTimer) window.clearTimeout(safetyTimer)
        this.authLoading = false
      }
      if (
        !this.authFailure &&
        this.authState.enabled &&
        !this.authState.authenticated
      ) {
        document.title = PAGE_TITLE
        if (
          this.authState.wecomEnabled &&
          this.isWecomClient &&
          // 从普通浏览器唤起企业微信桌面端后，首次 OAuth 回调会进入新的
          // WebView Cookie 上下文。此时保留严格的浏览器绑定，并在桌面端
          // 自动重建一次挑战；比放宽 state 校验更安全，也避免用户手动重试。
          (!this.authErrorCode || this.authErrorCode === 'invalid_state') &&
          !this.hasAttemptedWecomClientAutoLogin()
        ) {
          this.startWecomClientLogin()
          return
        }
        if (
          this.authState.workbuddyEnabled &&
          this.authState.workbuddyLoginReady &&
          this.authState.workbuddyAutoLogin &&
          !this.authErrorCode &&
          !this.hasAttemptedWorkBuddyAutoLogin()
        ) {
          this.startWorkBuddyLogin()
          return
        }
        // 扫码始终是主登录方式：内网访问时后端会开放开发者密钥，但那只是附加入口，
        // 不能因此不加载二维码，否则内网用户会看到一个空白的登录框。
        if (this.authState.wecomEnabled) await this.refreshLoginQr()
      }
    },
    hasAttemptedWorkBuddyAutoLogin() {
      try {
        return (
          window.sessionStorage.getItem(WORKBUDDY_AUTO_ATTEMPT_KEY) === '1'
        )
      } catch (err) {
        return true
      }
    },
    hasAttemptedWecomClientAutoLogin() {
      try {
        return (
          window.sessionStorage.getItem(WECOM_CLIENT_AUTO_ATTEMPT_KEY) === '1'
        )
      } catch (err) {
        return true
      }
    },
    startWecomClientLogin() {
      if (!this.authState.wecomEnabled || this.wecomClientRedirecting) return
      this.wecomClientRedirecting = true
      markWecomClientAutoLoginAttempted()
      window.location.assign(getWecomClientLoginUrl())
    },
    startWorkBuddyLogin() {
      if (
        !this.authState.workbuddyEnabled ||
        !this.authState.workbuddyLoginReady ||
        this.workbuddyRedirecting
      )
        return
      this.workbuddyRedirecting = true
      markWorkBuddyAutoLoginAttempted()
      window.location.assign(getWorkBuddyLoginUrl())
    },
    clearQrRefreshTimer() {
      if (!this.qrRefreshTimer) return
      window.clearTimeout(this.qrRefreshTimer)
      this.qrRefreshTimer = null
    },
    destroyQrPanel() {
      if (this.qrPanel && typeof this.qrPanel.unmount === 'function') {
        this.qrPanel.unmount()
      }
      this.qrPanel = null
      const mount = this.$refs.qrMount
      if (mount) mount.innerHTML = ''
    },
    async refreshLoginQr() {
      if (this.qrRefreshing) return
      this.clearQrRefreshTimer()
      this.destroyQrPanel()
      this.qrRefreshing = true
      this.qrFailure = ''
      try {
        const challenge = await createLoginQr()
        this.qrChallenge = challenge
        const expiresIn = Number(challenge.expiresIn) || 600
        const refreshAfterSeconds = Math.max(30, expiresIn - 30)
        this.qrRefreshTimer = window.setTimeout(
          () => this.refreshLoginQr(),
          refreshAfterSeconds * 1000
        )
        await this.$nextTick()
        this.qrPanel = await mountWecomLoginPanel(this.$refs.qrMount, challenge, {
          onSuccess: code => this.completeLogin(code),
          onFail: () => {
            this.qrFailure = '二维码加载失败，请刷新重试'
          }
        })
      } catch (err) {
        this.qrFailure = err.message || '二维码生成失败'
      } finally {
        this.qrRefreshing = false
      }
    },
    completeLogin(code) {
      if (!this.qrChallenge || !code) return
      this.clearQrRefreshTimer()
      const url = new URL(getAuthApiUrl('/api/auth/wecom/callback'))
      url.searchParams.set('code', code)
      url.searchParams.set('state', this.qrChallenge.state)
      window.location.assign(url.toString())
    },
    async submitDevLogin() {
      const key = this.devAuthKey.trim()
      if (!key || this.devLoggingIn) return
      this.devLoggingIn = true
      this.devLoginError = ''
      try {
        const result = await devLogin(key, this.devAuthMobile.trim())
        this.authState = {
          ...result,
          enabled: true,
          authenticated: true,
          devBypassAvailable: true
        }
        const who =
          (result.user &&
            `${result.user.name || ''} (${result.user.wecomUserId || result.user.id})`) ||
          ''
        if (who) console.info(`[auth] logged in as ${who}`)
        this.clearQrRefreshTimer()
        this.destroyQrPanel()
      } catch (err) {
        this.devLoginError = err.message || '开发者登录失败'
      } finally {
        this.devLoggingIn = false
      }
    }
  }
}
</script>

<style lang="less">
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}
html,
body,
#app {
  height: 100%;
}
#app {
  font-family: Inter, 'PingFang SC', 'Microsoft YaHei', sans-serif;
  color: #1f2933;
}

.authScreen {
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: clamp(16px, 3vw, 32px);
  background:
    radial-gradient(circle at 18% 16%, rgba(15, 157, 104, 0.08), transparent 30%),
    linear-gradient(155deg, #f7f9f8 0%, #edf3f0 100%);

  &--loading {
    .authSpinner {
      width: 40px;
      height: 40px;
    }
  }
}

.authCard {
  width: 380px;
  max-width: 100%;
  padding: 32px;
  border: 1px solid rgba(15, 45, 35, 0.08);
  border-radius: 16px;
  background: #fbfcfb;
  box-shadow:
    0 22px 54px rgba(22, 52, 41, 0.09),
    0 2px 6px rgba(22, 52, 41, 0.03);
  text-align: center;

  &--compact {
    padding-top: 32px;
  }

  &--login {
    width: 414px;
  }
}

.authIntro,
.authLoginPanel {
  min-width: 0;
}

.authIntro {
  margin-bottom: 24px;
}

.authBrandBlock {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
}

.authBrandMark {
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  background: #0a855b;
  color: #fff;
  font-size: 21px;
  font-weight: 700;
  letter-spacing: 0.04em;
  box-shadow: 0 8px 20px rgba(10, 122, 82, 0.2);
}

.authBrand {
  font-size: 24px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: #102820;
}

.authSubtitle {
  margin-top: 10px;
  color: #6b7c74;
  font-size: 14px;
}

.authFailureText {
  margin: 16px 0 22px;
  color: #8a4b45;
  font-size: 14px;
  line-height: 1.6;
}

.authError {
  margin-top: 14px;
  padding: 10px 12px;
  border-radius: 10px;
  background: #fff1ef;
  color: #b4473c;
  font-size: 13px;
  line-height: 1.5;
}

.authQrHeading {
  width: 322px;
  max-width: 100%;
  margin: 0 auto 10px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  text-align: left;

  strong {
    color: #17352b;
    font-size: 15px;
    font-weight: 650;
  }

  span {
    color: #7b8983;
    font-size: 12px;
  }
}

.authOneIdHint {
  margin: 8px auto 0;
  width: 322px;
  max-width: 100%;
  color: #6b7c74;
  font-size: 12px;
  line-height: 1.5;
}

.authActions {
  width: 322px;
  max-width: 100%;
  display: grid;
  gap: 8px;
  margin: 14px auto 0;
}

.authQrShell {
  position: relative;
  // 企业微信 small 登录面板固定为 320 × 380，外层再预留 1px 边框。
  width: 322px;
  height: 382px;
  max-width: 100%;
  margin: 0 auto;
  overflow: hidden;
  border-radius: 12px;
  background: #fff;
  border: 1px solid rgba(15, 45, 35, 0.08);
}

.authQrMount {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;

  iframe {
    display: block;
    width: 100% !important;
    height: 100% !important;
    border: 0;
  }
}

.authQrOverlay,
.authQrFailure {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: rgba(255, 255, 255, 0.92);
  color: #6b7c74;
  font-size: 13px;
}

.authQrTools {
  width: 322px;
  max-width: 100%;
  display: flex;
  justify-content: flex-end;
  margin: 8px auto 0;
}

.authRefresh {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 4px;
  border: 0;
  background: transparent;
  color: #0a7a52;
  font-size: 12px;
  cursor: pointer;
  transition: color 0.18s ease, opacity 0.18s ease;

  &:hover:not(:disabled) {
    color: #075f40;
  }

  &:disabled {
    opacity: 0.55;
    cursor: wait;
  }
}

.authRefreshIcon {
  display: inline-block;
  font-size: 15px;
  line-height: 1;

  &.spinning {
    animation: authSpin 0.8s linear infinite;
  }
}

.authButton {
  width: 100%;
  min-height: 44px;
  padding: 10px 18px;
  border: 1px solid #0a855b;
  border-radius: 10px;
  background: #0a855b;
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.18s ease, border-color 0.18s ease, transform 0.12s ease;

  &:hover:not(:disabled) {
    border-color: #076e4a;
    background: #076e4a;
  }

  &:active:not(:disabled) {
    transform: translateY(1px);
  }

  &:disabled {
    border-color: #dfe7e3;
    background: #edf2ef;
    color: #7b8983;
    cursor: not-allowed;
  }

  &--secondary {
    border-color: #cddbd5;
    background: #fff;
    color: #315c4d;

    &:hover:not(:disabled) {
      border-color: #8fb3a4;
      background: #f3f7f5;
    }
  }

  &--small {
    width: auto;
    min-height: 36px;
    padding: 8px 14px;
    font-size: 13px;
  }
}

.authDevLogin {
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px solid rgba(15, 45, 35, 0.06);
}

@media (min-width: 900px) and (min-height: 680px) {
  .authCard--login {
    width: 760px;
    padding: 38px 44px;
    display: grid;
    grid-template-columns: 250px 322px;
    align-items: center;
    justify-content: space-between;
    gap: 48px;
    text-align: left;
  }

  .authIntro {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    margin-bottom: 0;
  }

  .authBrandBlock {
    justify-content: flex-start;
    align-items: center;
  }

  .authSubtitle {
    margin-top: 14px;
    font-size: 16px;
  }

  .authError {
    width: 100%;
    margin-top: 24px;
  }

  .authLoginPanel {
    text-align: center;
  }

}

.authDevToggle {
  border: 0;
  background: transparent;
  color: #6b7c74;
  font-size: 12px;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 3px;
}

.authDevForm {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.authDevInput {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid rgba(15, 45, 35, 0.1);
  border-radius: 10px;
  background: #fff;
  color: #1f2933;
  font-size: 13px;

  &:focus {
    outline: none;
    border-color: rgba(15, 157, 104, 0.45);
    box-shadow: 0 0 0 3px rgba(15, 157, 104, 0.08);
  }
}

.authFailureCode {
  margin: 0;
  color: #8a6d3b;
  font-size: 12px;
  letter-spacing: 0.04em;
}

.authDevError {
  color: #b4473c;
  font-size: 12px;
  line-height: 1.4;
  text-align: left;
}

.authDevHint {
  margin: 0;
  color: #6b7c85;
  font-size: 12px;
  line-height: 1.5;
  text-align: left;

  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
    color: #0f5c44;
  }
}

.authSpinner {
  width: 34px;
  height: 34px;
  border: 3px solid rgba(15, 157, 104, 0.16);
  border-top-color: #0f9d68;
  border-radius: 50%;
  animation: authSpin 0.8s linear infinite;
}

@keyframes authSpin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 720px) {
  .authCard {
    padding-right: 20px;
    padding-left: 20px;
  }

  .authQrShell {
    width: 322px;
    height: 382px;
    max-height: none;
  }
}

.customScrollbar {
  &::-webkit-scrollbar {
    width: 7px;
    height: 7px;
  }

  &::-webkit-scrollbar-thumb {
    border-radius: 7px;
    background-color: rgba(0, 0, 0, 0.3);
    cursor: pointer;
  }

  &::-webkit-scrollbar-track {
    box-shadow: none;
    background: transparent;
    display: none;
  }
}

.el-dialog {
  border-radius: 10px;
}
</style>
