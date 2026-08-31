<template>
  <div id="app">
    <div class="authScreen" v-if="authLoading">
      <div class="authSpinner"></div>
      <p>正在确认登录状态…</p>
    </div>
    <div class="authScreen" v-else-if="authFailure">
      <div class="authCard">
        <div class="authMark error">!</div>
        <h1>认证服务暂不可用</h1>
        <p>{{ authFailure }}</p>
        <button class="authButton secondary" @click="initializeAuth">
          重新连接
        </button>
      </div>
    </div>
    <div
      class="authScreen"
      v-else-if="authState.enabled && !authState.authenticated"
    >
      <div class="authCard qrCard">
        <div class="authMark">企</div>
        <h1>企业微信扫码登录</h1>
        <p>打开企业微信扫一扫，确认身份后自动进入思维导图。</p>
        <div class="authError" v-if="authErrorMessage">
          {{ authErrorMessage }}
        </div>
        <div class="authQrShell">
          <iframe
            v-if="qrLoginUrl"
            :key="qrLoginUrl"
            ref="qrFrame"
            class="authQrFrame"
            :src="qrLoginUrl"
            title="企业微信登录二维码"
            @load="handleQrFrameLoad"
          ></iframe>
          <div class="authQrLoading" v-else-if="qrRefreshing">
            <div class="authSpinner"></div>
            <span>正在生成二维码…</span>
          </div>
          <div class="authQrFailure" v-else>
            <span>{{ qrFailure || '二维码暂时无法显示' }}</span>
            <button @click="refreshLoginQr">重新生成</button>
          </div>
        </div>
        <div class="authQrMeta">
          <span>{{ qrStatusText }}</span>
          <button @click="refreshLoginQr" :disabled="qrRefreshing">
            {{ qrRefreshing ? '刷新中…' : '刷新二维码' }}
          </button>
        </div>
        <button class="authFallbackButton" @click="openLoginPage">
          二维码无法显示？在新页面打开
        </button>
        <div class="authHint">二维码失效前会自动刷新，登录状态会安全保存</div>
      </div>
    </div>
    <template v-else>
      <router-view></router-view>
      <div class="authUser" v-if="authState.user">
        <span class="authAvatar">{{ userInitial }}</span>
        <span class="authUserName" :title="authState.user.name">{{
          authState.user.name
        }}</span>
        <button @click="signOut" :disabled="loggingOut">
          {{ loggingOut ? '退出中…' : '退出' }}
        </button>
      </div>
    </template>
  </div>
</template>

<script>
import {
  createLoginQr,
  getAuthApiUrl,
  getLoginUrl,
  loadAuthState,
  logout
} from '@/utils/auth'

const authErrors = {
  invalid_state: '登录状态校验失败，请重新发起扫码。',
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
        user: null
      },
      authErrorCode: '',
      qrLoginUrl: '',
      qrRefreshing: false,
      qrFailure: '',
      qrRefreshTimer: null,
      loggingOut: false
    }
  },
  computed: {
    authErrorMessage() {
      return authErrors[this.authErrorCode] || ''
    },
    qrStatusText() {
      if (this.qrRefreshing) return '正在更新二维码'
      if (this.qrFailure) return '生成失败，可立即重试'
      return '二维码失效前会自动更新'
    },
    userInitial() {
      const name = (this.authState.user && this.authState.user.name) || '企'
      return name
        .trim()
        .slice(0, 1)
        .toUpperCase()
    }
  },
  created() {
    window.addEventListener('message', this.handleWecomMessage)
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
  },
  beforeDestroy() {
    this.clearQrRefreshTimer()
    window.removeEventListener('message', this.handleWecomMessage)
  },
  methods: {
    async initializeAuth() {
      this.authLoading = true
      this.authFailure = ''
      try {
        this.authState = await loadAuthState()
      } catch (err) {
        this.authFailure = err.message || '请确认服务已启动后重试'
      } finally {
        this.authLoading = false
      }
      if (
        !this.authFailure &&
        this.authState.enabled &&
        !this.authState.authenticated
      ) {
        this.refreshLoginQr()
      }
    },
    clearQrRefreshTimer() {
      if (!this.qrRefreshTimer) return
      window.clearTimeout(this.qrRefreshTimer)
      this.qrRefreshTimer = null
    },
    async refreshLoginQr() {
      if (this.qrRefreshing) return
      this.clearQrRefreshTimer()
      this.qrRefreshing = true
      this.qrFailure = ''
      try {
        const challenge = await createLoginQr()
        this.qrLoginUrl = challenge.loginUrl
        const expiresIn = Number(challenge.expiresIn) || 600
        const refreshAfterSeconds = Math.max(30, expiresIn - 30)
        this.qrRefreshTimer = window.setTimeout(
          () => this.refreshLoginQr(),
          refreshAfterSeconds * 1000
        )
      } catch (err) {
        this.qrLoginUrl = ''
        this.qrFailure = err.message || '二维码生成失败'
      } finally {
        this.qrRefreshing = false
      }
    },
    handleQrFrameLoad() {
      const frame = this.$refs.qrFrame
      if (!frame || !frame.contentWindow || !this.qrLoginUrl) return
      try {
        const origin = new URL(this.qrLoginUrl).origin
        frame.contentWindow.postMessage('ask_usePostMessage', origin)
      } catch (err) {
        this.qrFailure = '二维码加载异常，请刷新后重试'
      }
    },
    handleWecomMessage(event) {
      if (!this.qrLoginUrl || typeof event.data !== 'string') return
      let expectedOrigin
      let callbackUrl
      let targetUrl
      try {
        expectedOrigin = new URL(this.qrLoginUrl).origin
        callbackUrl = new URL(getAuthApiUrl('/api/auth/wecom/callback'))
        targetUrl = new URL(event.data)
      } catch (err) {
        return
      }
      if (event.origin !== expectedOrigin) return
      if (
        targetUrl.origin !== callbackUrl.origin ||
        targetUrl.pathname !== callbackUrl.pathname ||
        !targetUrl.searchParams.get('state')
      ) {
        return
      }
      this.clearQrRefreshTimer()
      window.location.assign(targetUrl.toString())
    },
    openLoginPage() {
      window.location.assign(getLoginUrl())
    },
    async signOut() {
      if (this.loggingOut) return
      this.loggingOut = true
      try {
        await logout()
        window.location.reload()
      } catch (err) {
        this.$message.error(err.message || '退出登录失败')
        this.loggingOut = false
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
  font-family: Inter, Avenir, Helvetica, Arial, sans-serif;
  color: #2c3e50;
}

.authScreen {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 24px;
  background: radial-gradient(
      circle at 20% 10%,
      rgba(7, 193, 96, 0.12),
      transparent 30%
    ),
    linear-gradient(145deg, #f7fbf9 0%, #eef5f2 100%);
  color: #26352e;
}

.authCard {
  width: 420px;
  max-width: 100%;
  padding: 42px 38px 36px;
  border: 1px solid rgba(31, 55, 43, 0.08);
  border-radius: 20px;
  background: rgba(255, 255, 255, 0.94);
  box-shadow: 0 24px 70px rgba(35, 73, 53, 0.12);
  text-align: center;

  h1 {
    margin: 18px 0 12px;
    font-size: 26px;
    color: #17241d;
  }

  p {
    margin: 0;
    color: #66736c;
    line-height: 1.7;
  }
}

.authMark {
  width: 66px;
  height: 66px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 18px;
  background: #07c160;
  color: #fff;
  font-size: 30px;
  font-weight: 700;
  box-shadow: 0 12px 28px rgba(7, 193, 96, 0.25);

  &.error {
    background: #d95c4f;
    box-shadow: 0 12px 28px rgba(217, 92, 79, 0.2);
  }
}

.authButton {
  width: 100%;
  margin-top: 28px;
  padding: 13px 18px;
  border: 0;
  border-radius: 10px;
  background: #07c160;
  color: #fff;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  transition: transform 0.18s ease, box-shadow 0.18s ease;

  &:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px rgba(7, 193, 96, 0.24);
  }

  &.secondary {
    background: #31483d;
  }
}

.authError {
  margin-top: 18px;
  padding: 10px 12px;
  border-radius: 8px;
  background: #fff1ef;
  color: #b4473c;
  font-size: 14px;
}

.authHint {
  margin-top: 14px;
  color: #94a099;
  font-size: 12px;
}

.qrCard {
  width: 430px;
  padding: 30px 34px 26px;

  h1 {
    margin-top: 14px;
  }
}

.authQrShell {
  width: 300px;
  height: 400px;
  max-width: 100%;
  margin: 20px auto 0;
  overflow: hidden;
  border: 1px solid rgba(31, 55, 43, 0.08);
  border-radius: 12px;
  background: #fff;
}

.authQrFrame {
  width: 300px;
  height: 400px;
  display: block;
  border: 0;
}

.authQrLoading,
.authQrFailure {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  color: #7d8a83;
  font-size: 14px;

  button {
    padding: 8px 14px;
    border: 0;
    border-radius: 8px;
    background: #07c160;
    color: #fff;
    cursor: pointer;
  }
}

.authQrMeta {
  margin-top: 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  color: #87938c;
  font-size: 12px;

  button {
    flex: none;
    border: 0;
    background: transparent;
    color: #169b53;
    font-size: 12px;
    cursor: pointer;

    &:disabled {
      color: #9ca7a1;
      cursor: wait;
    }
  }
}

.authFallbackButton {
  margin-top: 13px;
  border: 0;
  background: transparent;
  color: #64736b;
  font-size: 12px;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 3px;
}

.authSpinner {
  width: 34px;
  height: 34px;
  border: 3px solid rgba(7, 193, 96, 0.18);
  border-top-color: #07c160;
  border-radius: 50%;
  animation: authSpin 0.8s linear infinite;
}

@keyframes authSpin {
  to {
    transform: rotate(360deg);
  }
}

.authUser {
  position: fixed;
  top: 10px;
  right: 14px;
  z-index: 1000;
  max-width: 210px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px 5px 5px;
  border: 1px solid rgba(32, 55, 44, 0.1);
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.94);
  box-shadow: 0 5px 18px rgba(31, 54, 43, 0.1);

  .authAvatar {
    width: 26px;
    height: 26px;
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: #07c160;
    color: #fff;
    font-size: 13px;
    font-weight: 700;
  }

  .authUserName {
    min-width: 0;
    overflow: hidden;
    color: #34463d;
    font-size: 13px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  button {
    flex: none;
    border: 0;
    background: transparent;
    color: #728078;
    font-size: 12px;
    cursor: pointer;
  }
}

@media (max-width: 720px) {
  .qrCard {
    padding-right: 22px;
    padding-left: 22px;
  }

  .authUser {
    top: auto;
    right: 10px;
    bottom: 10px;
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
