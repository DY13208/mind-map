<template>
  <div id="app">
    <div class="authScreen authScreen--loading" v-if="authLoading">
      <div class="authSpinner"></div>
    </div>
    <div class="authScreen" v-else-if="authFailure">
      <div class="authCard authCard--compact">
        <h1 class="authBrand">依然中台</h1>
        <p class="authFailureText">{{ authFailure }}</p>
        <button class="authButton" @click="initializeAuth">重新连接</button>
      </div>
    </div>
    <div
      class="authScreen"
      v-else-if="authState.enabled && !authState.authenticated"
    >
      <div class="authCard">
        <div class="authBrandBlock">
          <div class="authBrandMark">依</div>
          <h1 class="authBrand">依然中台</h1>
        </div>
        <p class="authSubtitle">企业微信扫码登录</p>
        <div class="authError" v-if="authErrorMessage">{{ authErrorMessage }}</div>
        <div class="authQrShell">
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
        <button
          class="authRefresh"
          @click="refreshLoginQr"
          :disabled="qrRefreshing"
          title="刷新二维码"
        >
          <span class="authRefreshIcon" :class="{ spinning: qrRefreshing }">↻</span>
        </button>
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
    <router-view v-else></router-view>
  </div>
</template>

<script>
import {
  createLoginQr,
  devLogin,
  getAuthApiUrl,
  getStoredDevAuthKey,
  loadAuthState
} from '@/utils/auth'
import { mountWecomLoginPanel } from '@/utils/wecomLogin'

const PAGE_TITLE = '依然'
const authErrors = {
  invalid_state: '登录状态校验失败，请重新扫码。',
  expired_state: '二维码已过期，请重新扫码。',
  missing_code: '你取消了授权，请重新扫码并确认登录。',
  not_enterprise_member: '当前账号不在该企业应用的可见范围内。',
  wecom_identity_failed: '企业微信未能确认成员身份，请稍后重试。',
  wecom_token_failed: '企业微信应用配置无效，请联系管理员。',
  wecom_timeout: '企业微信响应超时，请稍后重试。',
  wecom_unavailable: '企业微信服务暂不可用，请稍后重试。',
  auth_unavailable: '认证服务暂不可用，请稍后重试。'
}

export default {
  name: 'App',
  data() {
    return {
      authLoading: true,
      authFailure: '',
      authState: {
        enabled: false,
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
      showDevLogin: false,
      devAuthKey: '',
      devLoggingIn: false,
      devLoginError: ''
    }
  },
  computed: {
    authErrorMessage() {
      return authErrors[this.authErrorCode] || ''
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
    async initializeAuth() {
      this.authLoading = true
      this.authFailure = ''
      try {
        this.authState = await loadAuthState()
      } catch (err) {
        this.authFailure = err.message || '请确认服务已启动后重试'
        document.title = PAGE_TITLE
      } finally {
        this.authLoading = false
      }
      if (
        !this.authFailure &&
        this.authState.enabled &&
        !this.authState.authenticated
      ) {
        document.title = PAGE_TITLE
        if (this.authState.devBypassAvailable) {
          this.showDevLogin = true
        } else {
          await this.refreshLoginQr()
        }
      }
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
        this.authState = await devLogin(key)
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
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background:
    radial-gradient(circle at 15% 20%, rgba(16, 122, 87, 0.14), transparent 34%),
    radial-gradient(circle at 85% 10%, rgba(64, 158, 255, 0.08), transparent 28%),
    linear-gradient(160deg, #f7faf9 0%, #eef3f1 48%, #e9f0ec 100%);

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
  padding: 36px 32px 28px;
  border: 1px solid rgba(15, 45, 35, 0.06);
  border-radius: 24px;
  background: rgba(255, 255, 255, 0.96);
  box-shadow:
    0 24px 60px rgba(22, 52, 41, 0.1),
    0 2px 8px rgba(22, 52, 41, 0.04);
  text-align: center;

  &--compact {
    padding-top: 32px;
  }
}

.authBrandBlock {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

.authBrandMark {
  width: 52px;
  height: 52px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 16px;
  background: linear-gradient(145deg, #0f9d68, #0a7a52);
  color: #fff;
  font-size: 24px;
  font-weight: 700;
  letter-spacing: 0.04em;
  box-shadow: 0 10px 24px rgba(10, 122, 82, 0.28);
}

.authBrand {
  font-size: 28px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: #102820;
}

.authSubtitle {
  margin-top: 8px;
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

.authQrShell {
  position: relative;
  width: 280px;
  height: 280px;
  max-width: 100%;
  margin: 22px auto 0;
  overflow: hidden;
  border-radius: 16px;
  background: #fff;
  border: 1px solid rgba(15, 45, 35, 0.06);
}

.authQrMount {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;

  iframe {
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

.authRefresh {
  margin-top: 16px;
  width: 36px;
  height: 36px;
  border: 0;
  border-radius: 50%;
  background: rgba(15, 157, 104, 0.08);
  color: #0a7a52;
  cursor: pointer;
  transition: background 0.18s ease, transform 0.18s ease;

  &:hover:not(:disabled) {
    background: rgba(15, 157, 104, 0.14);
    transform: rotate(-20deg);
  }

  &:disabled {
    opacity: 0.55;
    cursor: wait;
  }
}

.authRefreshIcon {
  display: inline-block;
  font-size: 18px;
  line-height: 1;

  &.spinning {
    animation: authSpin 0.8s linear infinite;
  }
}

.authButton {
  padding: 11px 18px;
  border: 0;
  border-radius: 10px;
  background: linear-gradient(145deg, #0f9d68, #0a7a52);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;

  &--small {
    padding: 8px 14px;
    font-size: 13px;
  }
}

.authDevLogin {
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px solid rgba(15, 45, 35, 0.06);
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

.authDevError {
  color: #b4473c;
  font-size: 12px;
  line-height: 1.4;
  text-align: left;
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
    width: 100%;
    height: 72vw;
    max-height: 280px;
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
