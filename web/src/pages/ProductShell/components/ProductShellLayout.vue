<template>
  <div
    class="productShell"
    :class="{
      'productShell--collapsed': shellMode === 'full' && sidebarCollapsed,
      'productShell--solo': hideSidebar,
      'productShell--focus': shellMode === 'focus',
      'productShell--embed': shellMode === 'embed',
      'productShell--dark': isDarkTheme
    }"
  >
    <button
      v-if="shellMode === 'full' && !sidebarCollapsed"
      class="sidebarBackdrop"
      aria-label="关闭展开的侧栏"
      @click="setSidebarCollapsed(true)"
    />
    <aside v-if="shellMode === 'full'" class="productSidebar">
      <div class="sidebarHeader">
        <div
          v-if="!sidebarCollapsed"
          class="productLogo"
          @click="$router.push('/files')"
        >
          <span>W</span><strong>WCPD</strong>
        </div>
        <button
          v-else
          class="collapsedLogoTrigger"
          type="button"
          aria-label="打开侧边栏"
          aria-expanded="false"
          aria-controls="product-navigation"
          data-testid="sidebar-toggle"
          @click="setSidebarCollapsed(false)"
        >
          <span class="collapsedLogoMark" aria-hidden="true">C</span>
          <svg
            class="collapsedLogoOpenIcon"
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
            focusable="false"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M9 3v18" />
          </svg>
          <span class="collapsedLogoTip" role="tooltip">打开侧边栏</span>
        </button>
        <button
          v-if="!sidebarCollapsed"
          class="sidebarToggle"
          type="button"
          title="关闭侧边栏"
          aria-label="关闭侧边栏"
          aria-expanded="true"
          aria-controls="product-navigation"
          data-testid="sidebar-toggle-close"
          @click="setSidebarCollapsed(true)"
        >
          <svg
            class="sidebarToggleIcon"
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
            focusable="false"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M9 3v18" />
          </svg>
        </button>
      </div>
      <ProductNavigation :file-nav="fileNav" :kb-enabled="kbEnabled" />
      <div class="sidebarModeSwitch">
        <button
          type="button"
          title="进入专注模式"
          aria-label="进入专注模式"
          data-testid="shell-focus-mode"
          @click="switchShellMode('focus')"
        >
          <i class="el-icon-full-screen" aria-hidden="true"></i>
          <span>专注模式</span>
        </button>
      </div>
      <AccessNotificationTrigger v-if="profile" :key="profile.id" :collapsed="sidebarCollapsed" class="sidebarNotifications" />
      <div class="sidebarFooter" v-if="profile">
        <div
          class="accountInfo"
          role="link"
          tabindex="0"
          data-testid="sidebar-profile"
          aria-label="打开个人主页"
          :title="`个人主页 · ${profile.name}（${profile.id}）`"
          @click="openProfile"
          @keydown.enter.prevent="openProfile"
          @keydown.space.prevent="openProfile"
        >
          <UserAvatar :person="profile" size="small" fallback="依" />
          <div class="accountMeta">
            <strong>{{ profile.name }}</strong
            ><span>{{ profile.id }}</span>
          </div>
        </div>
        <button
          class="accountLogout"
          type="button"
          title="退出登录"
          aria-label="退出登录"
          data-testid="sidebar-logout"
          :disabled="loggingOut"
          @click="signOut"
        >
          <i class="el-icon-switch-button" aria-hidden="true"></i>
          <span class="accountLogoutText">{{
            loggingOut ? '退出中…' : '退出'
          }}</span>
        </button>
      </div>
    </aside>
    <header v-if="shellMode !== 'embed'" class="mobileShellHeader">
      <button aria-label="打开全部功能" @click="openNavigation"><span class="mobileBrandMark">W</span><strong>WCPD</strong></button>
      <button aria-label="全部功能与设置" @click="openNavigation"><i class="el-icon-menu" /></button>
    </header>
    <nav v-if="shellMode !== 'embed'" class="mobileBottomNav" aria-label="主导航">
      <router-link to="/files"><i class="el-icon-house" /><span>脑图</span></router-link>
      <router-link to="/spaces"><i class="el-icon-office-building" /><span>空间</span></router-link>
      <button class="mobilePrimary" aria-label="新建" @click="mobileCreate"><i class="el-icon-plus" /></button>
      <AccessNotificationTrigger v-if="profile" :key="'mobile-' + profile.id" />
      <router-link to="/profile"><i class="el-icon-user" /><span>我的</span></router-link>
    </nav>
    <main class="productMain">
      <div v-if="shellMode === 'focus'" class="shellModeToolbar" role="group" aria-label="页面导航模式">
        <button
          ref="navigationTrigger"
          type="button"
          class="shellModeButton shellModeButton--navigation"
          aria-label="打开导航菜单"
          aria-haspopup="dialog"
          :aria-expanded="navigationOpen ? 'true' : 'false'"
          @click="openNavigation"
        >
          <i class="el-icon-menu" aria-hidden="true"></i>
          <span>导航</span>
        </button>
        <button
          type="button"
          class="shellModeButton"
          title="恢复完整侧栏"
          data-testid="shell-full-mode"
          @click="switchShellMode('full')"
        >
          <i class="el-icon-s-fold" aria-hidden="true"></i>
          <span>完整模式</span>
        </button>
      </div>
      <router-view />
    </main>
    <el-drawer
      v-if="shellMode === 'focus' || isMobileViewport"
      :visible.sync="navigationOpen"
      size="288px"
      direction="ltr"
      :with-header="false"
      :wrapper-closable="true"
      :close-on-press-escape="true"
      :append-to-body="false"
      custom-class="productNavigationDrawer"
      @opened="focusNavigationStart"
      @closed="restoreNavigationFocus"
    >
      <div
        class="navigationDrawerContent"
        role="dialog"
        aria-modal="true"
        aria-label="导航菜单"
        tabindex="-1"
      >
        <div class="navigationDrawerHeader">
          <strong>导航</strong>
          <button
            type="button"
            class="shellModeButton"
            aria-label="关闭导航菜单"
            @click="closeNavigation"
          >
            <i class="el-icon-close" aria-hidden="true"></i>
          </button>
        </div>
        <ProductNavigation
          :file-nav="fileNav"
          :kb-enabled="kbEnabled"
          @navigate="closeNavigation"
        />
      </div>
    </el-drawer>
  </div>
</template>

<script>
import mobileViewport from '@/utils/mobileViewport'
import productService from '@/services/productService'
import { logoutAndRedirect } from '@/utils/auth'
import UserAvatar from '@/components/UserAvatar.vue'
import AccessNotificationTrigger from '@/components/AccessNotificationTrigger.vue'
import { shellTheme, applyShellThemeToRoot } from '@/utils/shellTheme'
import { resolveShellMode } from '@/utils/shellMode'
import ProductNavigation from './ProductNavigation.vue'
const SIDEBAR_PREFERENCE_KEY = 'product-shell-sidebar-collapsed'
const isSmallScreen = () => window.matchMedia('(max-width: 760px)').matches
const readSidebarPreference = () => {
  try {
    const value = localStorage.getItem(SIDEBAR_PREFERENCE_KEY)
    return value === 'true' ? true : value === 'false' ? false : null
  } catch (error) {
    return null
  }
}
export default {
  name: 'ProductShellLayout',
  mixins: [mobileViewport],
  components: { UserAvatar, AccessNotificationTrigger, ProductNavigation },
  data() {
    const preference = readSidebarPreference()
    return {
      sidebarCollapsed: preference === null ? isSmallScreen() : preference,
      hasSidebarPreference: preference !== null,
      profile: null,
      navigationOpen: false,
      navigationTrigger: null,
      fileNav: [
        { path: '/files/recent', label: '最近', icon: 'el-icon-time' },
        { path: '/files', label: '脑图', icon: 'el-icon-files' },
        { path: '/files/favorites', label: '收藏', icon: 'el-icon-star-off' },
        { path: '/files/shared', label: '共享', icon: 'el-icon-user' },
        { path: '/files/trash', label: '回收站', icon: 'el-icon-delete' }
      ],
      loggingOut: false
    }
  },
  computed: {
    shellMode() {
      return resolveShellMode(this.$route)
    },
    kbEnabled() {
      const runtime = typeof window !== 'undefined' && window.__MIND_MAP_RUNTIME__
      if (!runtime || runtime.FILE_KB_UI_ENABLED == null) return true
      return runtime.FILE_KB_UI_ENABLED === true
    },
    hideSidebar() {
      return this.shellMode !== 'full'
    },
    isDarkTheme() {
      return shellTheme.theme === 'dark'
    }
  },
  mounted() {
    document.body.classList.remove('isDark')
    applyShellThemeToRoot(true)
    window.addEventListener('resize', this.updateAutoSidebar)
  },
  beforeDestroy() {
    applyShellThemeToRoot(false)
    window.removeEventListener('resize', this.updateAutoSidebar)
    document.removeEventListener('keydown', this.onNavigationKeydown)
  },
  watch: {
    navigationOpen(open) {
      if (open) document.addEventListener('keydown', this.onNavigationKeydown)
      else document.removeEventListener('keydown', this.onNavigationKeydown)
    },
    '$route.fullPath'() {
      if (this.navigationOpen) this.closeNavigation()
    },
    shellMode(mode) {
      if (mode !== 'focus' && this.navigationOpen) this.closeNavigation()
    }
  },
  methods: {
    async mobileCreate() {
      if (!['/files', '/my-maps'].some(path => this.$route.path === path || this.$route.path.startsWith(path + '/folder/'))) {
        await this.$router.push('/files')
      }
      this.$nextTick(() => this.$bus.$emit('mobile-create-file'))
    },
    updateAutoSidebar() {
      if (!this.hasSidebarPreference) this.sidebarCollapsed = isSmallScreen()
    },
    openProfile() {
      if (this.$route.path !== '/profile') this.$router.push('/profile')
    },
    switchShellMode(mode) {
      if (mode === this.shellMode) return
      return this.$router.push({
        path: this.$route.path,
        query: { ...this.$route.query, shell: mode },
        hash: this.$route.hash
      })
    },
    openNavigation(event) {
      if (event && event.currentTarget) {
        this.navigationTrigger = event.currentTarget
      }
      this.navigationOpen = true
    },
    closeNavigation() {
      this.navigationOpen = false
    },
    focusNavigationStart() {
      this.$nextTick(() => {
        const firstLink = document.querySelector(
          '.productNavigationDrawer .productNavigation a'
        )
        if (firstLink && typeof firstLink.focus === 'function') firstLink.focus()
      })
    },
    restoreNavigationFocus() {
      this.$nextTick(() => {
        const trigger = this.$refs.navigationTrigger || this.navigationTrigger
        if (trigger && typeof trigger.focus === 'function') trigger.focus()
      })
    },
    onNavigationKeydown(event) {
      if (!this.navigationOpen) return
      if (event.key === 'Escape') {
        event.preventDefault()
        this.closeNavigation()
        return
      }
      if (event.key !== 'Tab') return

      const drawer = document.querySelector('.productNavigationDrawer')
      if (!drawer) return
      const focusable = Array.from(
        drawer.querySelectorAll(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter(element => element.getClientRects().length > 0)
      if (focusable.length === 0) {
        event.preventDefault()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (event.shiftKey && (active === first || !drawer.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || !drawer.contains(active))) {
        event.preventDefault()
        first.focus()
      }
    },
    async signOut() {
      if (this.loggingOut) return
      try {
        await this.$confirm('确定要退出登录吗？', '退出登录', {
          confirmButtonText: '退出',
          cancelButtonText: '取消',
          type: 'warning'
        })
      } catch (error) {
        return
      }
      this.loggingOut = true
      await logoutAndRedirect('/')
    },
    setSidebarCollapsed(collapsed) {
      this.sidebarCollapsed = collapsed
      this.hasSidebarPreference = true
      try {
        localStorage.setItem(SIDEBAR_PREFERENCE_KEY, String(collapsed))
      } catch (error) {
        // Layout remains usable when browser storage is unavailable.
      }
    }
  },
  async created() {
    try {
      this.profile = await productService.getProfile()
    } catch (error) {
      this.profile = null
    }
  }
}
</script>

<style lang="less">
.productShell .el-dialog {
  max-width: calc(100vw - 24px);
}
.productShell .el-drawer {
  max-width: 100vw;
}
@media (max-width: 600px) {
  .productShell .teamGrid,
  .productShell .roomGrid,
  .productShell .folderGrid {
    grid-template-columns: 1fr;
  }
  .productShell .trashRow {
    flex-wrap: wrap;
  }
  .productShell .fileToolbar .toolbarSearch {
    min-width: 0;
    flex-basis: 100%;
  }
}
.productShell {
  min-height: 100vh;
  min-height: 100dvh;
  width: 100%;
  max-width: 100%;
  overflow-x: hidden;
  background: var(--ui-page-glow), var(--ui-bg);
  background-attachment: fixed;
  color: var(--ui-text);
  display: flex;
  transition: background-color 0.25s ease, color 0.25s ease;
  font-family: 'Microsoft YaHei', '微软雅黑', SimHei, '黑体', 'PingFang SC',
    'Hiragino Sans GB', sans-serif;
}
.productShell .sidebarBackdrop {
  display: none;
}
.productShell .sidebarToggle {
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--ui-text-secondary);
  cursor: pointer;
  box-shadow: none;
  transition: background 0.15s ease, color 0.15s ease;
  &:hover {
    background: var(--ui-hover-overlay);
    color: var(--ui-text);
  }
  &:active {
    background: var(--ui-active-overlay);
  }
  &:focus-visible {
    outline: 2px solid var(--ui-focus);
    outline-offset: 2px;
  }
}
.productShell .sidebarToggleIcon {
  display: block;
}
.productShell .sidebarModeSwitch {
  flex-shrink: 0;
  padding: 8px 0;
  border-top: 1px solid var(--ui-border);
  button {
    width: 100%;
    min-height: 36px;
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 11px;
    padding: 0 12px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--ui-text-secondary);
    font-size: 13px;
    text-align: left;
    cursor: pointer;
    &:hover {
      background: var(--ui-surface-muted);
      color: var(--ui-primary);
    }
    &:focus-visible {
      outline: 2px solid var(--ui-focus);
      outline-offset: 2px;
    }
    i { font-size: 16px; }
  }
}
.productShell .shellModeToolbar {
  min-height: 44px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 clamp(16px, 2.2vw, 44px);
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-surface);
}
.productShell .shellModeButton {
  min-height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 0 10px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--ui-text-secondary);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
  &:hover {
    background: var(--ui-hover-overlay);
    color: var(--ui-text);
  }
  &:focus-visible {
    outline: 2px solid var(--ui-focus);
    outline-offset: 2px;
  }
  i { font-size: 16px; }
}
.productShell .shellModeButton--navigation {
  color: var(--ui-primary);
  font-weight: 600;
}
.productShell .collapsedLogoTrigger {
  position: relative;
  width: 36px;
  height: 36px;
  margin: 0 auto;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--ui-text-secondary);
  cursor: pointer;
  padding: 0;
  transition: background 0.15s ease, color 0.15s ease;
  .collapsedLogoMark {
    width: 32px;
    height: 32px;
    border-radius: 9px;
    display: grid;
    place-items: center;
    color: var(--ui-on-primary);
    background: var(--ui-primary);
    font-size: 18px;
    line-height: 1;
    transition: opacity 0.12s ease;
  }
  .collapsedLogoOpenIcon {
    position: absolute;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.12s ease;
  }
  .collapsedLogoTip {
    position: absolute;
    left: calc(100% + 10px);
    top: 50%;
    transform: translateY(-50%);
    white-space: nowrap;
    padding: 6px 10px;
    border-radius: 999px;
    background: var(--ui-tooltip-bg);
    color: var(--ui-tooltip-text);
    font-size: 12px;
    line-height: 1.2;
    opacity: 0;
    pointer-events: none;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
    transition: opacity 0.12s ease;
    z-index: 30;
  }
  &:hover,
  &:focus,
  &:focus-visible {
    background: var(--ui-hover-overlay);
    color: var(--ui-text);
    .collapsedLogoMark {
      opacity: 0;
    }
    .collapsedLogoOpenIcon,
    .collapsedLogoTip {
      opacity: 1;
    }
  }
  &:focus-visible {
    outline: 2px solid var(--ui-focus);
    outline-offset: 2px;
  }
}
.productShell .productSidebar {
  width: 216px;
  height: 100vh;
  height: 100dvh;
  background: var(--ui-surface);
  border-right: 1px solid var(--ui-border);
  padding: 16px 12px 16px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  position: fixed;
  inset: 0 auto 0 0;
  z-index: 10;
  min-height: 0;
  overflow: hidden;
  .sidebarHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-height: 40px;
    margin-bottom: 16px;
    padding: 0 0 0 8px;
    flex-shrink: 0;
  }
  .productLogo {
    display: flex;
    align-items: center;
    gap: 11px;
    min-width: 0;
    cursor: pointer;
    font-size: 17px;
    span {
      width: 32px;
      height: 32px;
      border-radius: 9px;
      display: grid;
      place-items: center;
      color: var(--ui-on-primary);
      background: var(--ui-primary);
      font-size: 18px;
      flex-shrink: 0;
    }
    strong {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }
  nav {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex: 1 1 auto;
    min-height: 0;
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
    scrollbar-gutter: stable;
    &::-webkit-scrollbar {
      width: 6px;
      height: 6px;
    }
    &::-webkit-scrollbar-track {
      background: transparent;
    }
    &::-webkit-scrollbar-thumb {
      min-height: 32px;
      border: 1px solid transparent;
      border-radius: 999px;
      background: var(--ui-scrollbar-thumb, rgba(111, 130, 121, 0.24));
      background-clip: padding-box;
    }
    &:hover::-webkit-scrollbar-thumb,
    &:focus-within::-webkit-scrollbar-thumb {
      background-color: var(--ui-scrollbar-thumb-hover, rgba(111, 130, 121, 0.44));
    }
    &::-webkit-scrollbar-thumb:hover {
      background-color: var(--ui-scrollbar-thumb-active, rgba(111, 130, 121, 0.64));
    }
    @supports (-moz-appearance: none) {
      scrollbar-width: thin;
      scrollbar-color: var(--ui-scrollbar-thumb, rgba(111, 130, 121, 0.24)) transparent;
      &:hover,
      &:focus-within {
        scrollbar-color: var(--ui-scrollbar-thumb-hover, rgba(111, 130, 121, 0.44)) transparent;
      }
    }
    @media (forced-colors: active) {
      scrollbar-color: auto;
      &::-webkit-scrollbar-thumb { background-color: CanvasText; }
    }
  }
  a {
    height: 40px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 11px;
    padding: 0 12px;
    border-radius: 8px;
    color: var(--ui-text-secondary);
    text-decoration: none;
    font-size: 14px;
    border: 0;
    background: transparent;
    cursor: pointer;
    text-align: left;
    &:hover {
      background: var(--ui-surface-muted);
      color: var(--ui-primary);
    }
    &.router-link-exact-active {
      background: var(--ui-primary-soft);
      color: var(--ui-primary);
      font-weight: 600;
    }
    i {
      font-size: 17px;
    }
  }
  .navLabel {
    margin: 6px 12px 7px;
    color: var(--ui-text-muted);
    font-size: 12px;
    flex-shrink: 0;
    &--space {
      margin-top: 22px;
    }
  }
  .sidebarFooter {
    flex-shrink: 0;
    margin-top: 0;
    padding: 10px 10px 2px;
    border-top: 1px solid var(--ui-border);
  }
  .sidebarNotifications { flex-shrink: 0; }
  .accountInfo {
    display: flex;
    gap: 10px;
    align-items: center;
    min-width: 0;
    flex: 1;
    padding: 4px;
    margin: -4px;
    border-radius: 8px;
    cursor: pointer;
    transition: background 0.15s;
    &:hover {
      background: #e8f4ef;
    }
    &:focus-visible {
      outline: 2px solid #087854;
      outline-offset: 2px;
    }
  }
  .accountMeta {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    font-size: 12px;
    strong,
    span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    span {
      color: var(--ui-text-muted);
      margin-top: 2px;
    }
  }
  .accountLogout {
    margin-top: 8px;
    width: 100%;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    border: 1px solid var(--ui-border);
    border-radius: 8px;
    background: var(--ui-surface);
    color: var(--ui-text-secondary);
    font-size: 13px;
    cursor: pointer;
    &:hover:not(:disabled) {
      border-color: var(--ui-danger-border);
      background: var(--ui-danger-soft);
      color: var(--ui-danger);
    }
    &:focus-visible {
      outline: 2px solid var(--ui-focus);
      outline-offset: 2px;
    }
    &:disabled {
      cursor: wait;
      opacity: 0.6;
    }
    i {
      font-size: 15px;
    }
  }
}
.productShell .productMain {
  min-width: 0;
  flex: 1;
  width: calc(100% - 216px);
  max-width: calc(100% - 216px);
  margin-left: 216px;
  overflow-x: hidden;
}
.productShell .productPage {
  padding: 32px clamp(16px, 2.2vw, 44px) 60px;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  box-sizing: border-box;
  overflow-x: hidden;
}
.productShell .productHeader {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 16px 20px;
  margin-bottom: 24px;
  min-width: 0;
  > div {
    min-width: 0;
    max-width: 100%;
  }
  h1 {
    margin: 0;
    font-size: clamp(22px, 2.4vw, 26px);
    line-height: 1.25;
    letter-spacing: -0.4px;
  }
  p {
    margin: 7px 0 0;
    color: var(--ui-text-secondary);
    font-size: 13px;
  }
}
.productShell .sectionTitle {
  font-size: 15px;
  margin: 26px 0 14px;
  color: var(--ui-text-secondary);
}
.productShell--collapsed {
  .productSidebar {
    --rail-size: 72px;
    --rail-item: 40px;
    width: var(--rail-size);
    padding-inline: 0;
    align-items: center;
    /* Tip paints past the rail; height stays viewport-bound via fixed inset + flex */
    overflow: visible;
    .sidebarHeader,
    nav,
    .sidebarNotifications,
    .sidebarFooter {
      width: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .sidebarHeader {
      justify-content: center;
      align-items: center;
      margin-bottom: 18px;
      padding: 0;
      overflow: visible;
    }
    .collapsedLogoTrigger {
      width: var(--rail-item);
      height: var(--rail-item);
      margin: 0;
      overflow: visible;
    }
    nav {
      overflow-x: hidden;
      overflow-y: auto;
      scrollbar-gutter: auto;
      align-items: center;
      /* Keep icons on the rail center line; wheel/trackpad still scroll */
      scrollbar-width: none;
      -ms-overflow-style: none;
      &::-webkit-scrollbar {
        display: none;
        width: 0;
        height: 0;
      }
    }
    .productLogo strong,
    a:not(.router-link-exact-active)::after,
    a {
      font-size: 0;
    }
    a {
      width: var(--rail-item);
      height: var(--rail-item);
      margin-inline: auto;
      justify-content: center;
      align-items: center;
      padding: 0;
      gap: 0;
      i {
        font-size: 20px;
        margin: 0;
      }
      span {
        display: none;
      }
    }
    .navLabel,
    .accountMeta,
    .accountLogoutText,
    .sidebarModeSwitch span {
      display: none;
    }
    .sidebarNotifications {
      width: 100%;
      .notificationBadge,
      .notificationButton {
        width: var(--rail-item);
        margin-inline: auto;
      }
      .notificationButton {
        min-height: var(--rail-item);
        padding: 0;
        justify-content: center;
      }
    }
    .sidebarFooter {
      padding-inline: 0;
      gap: 8px;
      align-items: center;
    }
    .accountInfo {
      justify-content: center;
      gap: 0;
      width: var(--rail-item);
    }
    .accountLogout {
      width: var(--rail-item);
      height: var(--rail-item);
      margin-inline: auto;
      padding: 0;
      gap: 0;
      justify-content: center;
    }
    .sidebarModeSwitch {
      width: 100%;
      padding-inline: 0;
      button {
        width: var(--rail-item);
        height: var(--rail-item);
        min-height: var(--rail-item);
        margin-inline: auto;
        padding: 0;
        justify-content: center;
        gap: 0;
      }
    }
  }
  .productMain {
    margin-left: 72px;
    width: calc(100% - 72px);
    max-width: calc(100% - 72px);
  }
}
.productNavigationDrawer {
  max-width: min(288px, calc(100vw - 32px));
  background: var(--ui-surface);
  color: var(--ui-text);
  .el-drawer__body {
    height: 100%;
    padding: 0;
    overflow: hidden;
  }
  .navigationDrawerContent {
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding: 16px 12px;
    box-sizing: border-box;
  }
  .navigationDrawerHeader {
    min-height: 40px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 4px 0 12px;
    margin-bottom: 12px;
    border-bottom: 1px solid var(--ui-border);
    strong { font-size: 15px; }
  }
  .productNavigation {
    min-height: 0;
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 4px;
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
  }
  .navLabel {
    flex-shrink: 0;
    margin: 6px 12px 7px;
    color: var(--ui-text-muted);
    font-size: 12px;
    &--space { margin-top: 22px; }
  }
  .productNavigation a {
    min-height: 40px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 11px;
    padding: 0 12px;
    border-radius: 8px;
    color: var(--ui-text-secondary);
    text-decoration: none;
    font-size: 14px;
    &:hover {
      background: var(--ui-surface-muted);
      color: var(--ui-primary);
    }
    &.router-link-exact-active {
      background: var(--ui-primary-soft);
      color: var(--ui-primary);
      font-weight: 600;
    }
    &:focus-visible {
      outline: 2px solid var(--ui-focus);
      outline-offset: 2px;
    }
    i { font-size: 17px; }
  }
}
@media (max-width: 760px) {
  .productShell .productMain {
    margin-left: 72px;
    width: calc(100% - 72px);
    max-width: calc(100% - 72px);
  }
  .productShell .sidebarBackdrop {
    display: block;
    position: fixed;
    inset: 0 0 0 72px;
    background: var(--ui-backdrop);
    border: 0;
    z-index: 9;
  }
  .productShell:not(.productShell--collapsed) .sidebarBackdrop {
    inset: 0 0 0 216px;
  }
  .productShell .productPage {
    padding: 24px 16px 40px;
  }
  .productShell .shellModeToolbar {
    padding-inline: 16px;
  }
  .productShell .productHeader {
    flex-direction: column;
    align-items: stretch;
  }
}
@media (max-height: 720px) {
  .productShell .productSidebar {
    padding-top: 12px;
    padding-bottom: 12px;
    .sidebarHeader {
      margin-bottom: 10px;
    }
    .navLabel--space {
      margin-top: 12px;
    }
    a {
      height: 36px;
    }
  }
  .productShell--collapsed .productSidebar a,
  .productShell--collapsed .productSidebar .collapsedLogoTrigger,
  .productShell--collapsed .productSidebar .accountLogout {
    height: var(--rail-item);
  }
}
.productShell--solo {
  .productSidebar,
  .sidebarBackdrop {
    display: none !important;
  }
  .productMain {
    margin-left: 0 !important;
    width: 100% !important;
    max-width: 100% !important;
  }
}
@media (prefers-reduced-motion: reduce) {
  .productShell,
  .productShell .shellModeButton,
  .productNavigationDrawer,
  .productNavigationDrawer .el-drawer {
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
</style>
