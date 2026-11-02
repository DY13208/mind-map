<template>
  <div
    class="productShell"
    :class="{
      'productShell--collapsed': shellMode === 'full' && sidebarCollapsed,
      'productShell--solo': hideSidebar,
      'productShell--focus': shellMode === 'focus',
      'productShell--embed': shellMode === 'embed',
      'productShell--teams': $route.path === '/spaces',
      'productShell--team-detail': $route.path.startsWith('/spaces/'),
      'productShell--dark': isDarkTheme,
      'productShell--knowledge': isKnowledgeRoute,
      'productShell--tablet': isTabletNavigation
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
          <WcpdLogoMark class="wcpdLogoImage" role="img" aria-label="WCPD" /><strong>WCPD</strong>
        </div>
        <button
          v-else
          class="collapsedLogoTrigger"
          type="button"
          :aria-label="isTabletNavigation ? '全部功能与设置' : '打开侧边栏'"
          :aria-expanded="String(isTabletNavigation && navigationOpen)"
          :aria-controls="isTabletNavigation ? 'drawer-product-navigation' : 'product-navigation'"
          data-testid="sidebar-toggle"
          @click="openSidebar"
        >
          <WcpdLogoMark class="collapsedLogoMark wcpdLogoImage" aria-hidden="true" />
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
      <div v-if="profile" class="sidebarUtilities">
        <AccessNotificationTrigger v-if="profile" :key="profile.id" :collapsed="sidebarCollapsed" label="消息" class="sidebarNotifications" />
        <el-dropdown v-if="profile" trigger="click" placement="right-end" @command="handleAccountCommand">
            <button
              class="accountInfo"
              type="button"
              data-testid="sidebar-profile"
              aria-label="个人账户菜单"
              aria-haspopup="menu"
            >
              <UserAvatar :person="profile" :size="22" fallback="依" />
              <span class="accountLabel">我的</span>
            </button>
          <el-dropdown-menu slot="dropdown" class="sidebarAccountMenu" :class="{ 'sidebarAccountMenu--dark': isDarkTheme }">
            <el-dropdown-item command="profile" class="accountMenuHeader" aria-label="打开个人主页">
              <UserAvatar :person="profile" :size="26" fallback="依" />
              <div class="accountMenuIdentity">
                <strong>{{ profile.name || profile.id }}</strong>
                <span>{{ profile.id }}</span>
              </div>
              <i class="el-icon-arrow-right accountMenuChevron" aria-hidden="true" />
            </el-dropdown-item>
            <el-dropdown-item command="logout" icon="el-icon-switch-button" class="accountMenuLogout" :disabled="loggingOut">
              {{ loggingOut ? '退出中…' : '退出登录' }}
            </el-dropdown-item>
          </el-dropdown-menu>
        </el-dropdown>
      </div>
    </aside>
    <header v-if="shellMode !== 'embed'" class="mobileShellHeader">
      <template v-if="$route.path === '/spaces'">
        <button class="mobileBrandButton mobileTeamBrand" aria-label="打开全部功能" @click="openNavigation"><WcpdLogoMark class="mobileBrandMark wcpdLogoImage" aria-hidden="true" /><strong>WCPD</strong></button>
        <div class="mobileHeaderSpacer" />
        <button aria-label="搜索团队" @click="$bus.$emit('mobile-search-teams')"><i class="el-icon-search" /></button>
        <button aria-label="全部功能与设置" @click="openNavigation"><i class="el-icon-menu" /></button>
      </template>
      <template v-else>
      <button class="mobileBrandButton" aria-label="打开全部功能" @click="openNavigation"><WcpdLogoMark class="mobileBrandMark wcpdLogoImage" aria-hidden="true" /><strong>WCPD</strong></button>
      <button v-if="$route.path.startsWith('/spaces/')" class="detailLauncher" aria-label="全部功能与设置" @click="openNavigation"><i class="el-icon-menu" /></button>
      <template v-else-if="!$route.path.startsWith('/spaces/')">
      <button aria-label="全部功能与设置" @click="openNavigation"><i class="el-icon-menu" /></button>
      </template>
      </template>
    </header>
    <nav v-if="shellMode !== 'embed'" class="mobileBottomNav" aria-label="主导航">
      <router-link to="/files" aria-label="脑图" title="脑图"><i class="el-icon-house" aria-hidden="true" /></router-link>
      <router-link to="/spaces" aria-label="团队" title="团队"><i class="el-icon-office-building" aria-hidden="true" /></router-link>
      <button type="button" class="mobilePrimary" :class="{ 'mobilePrimary--open': mobileCreateOpen }" aria-label="新建" title="新建" aria-haspopup="menu" aria-controls="mobile-create-menu" :aria-expanded="mobileCreateOpen ? 'true' : 'false'" @click="mobileCreate"><i class="el-icon-plus" aria-hidden="true" /></button>
      <AccessNotificationTrigger v-if="profile" :key="'mobile-' + profile.id" :collapsed="true" label="消息" icon="el-icon-chat-dot-round" />
      <router-link to="/profile" aria-label="我的" title="我的"><i class="el-icon-user" aria-hidden="true" /></router-link>
    </nav>
    <main class="productMain">
      <router-view />
    </main>
    <el-drawer
      v-if="navigationDrawerEnabled"
      :visible.sync="navigationOpen"
      size="224px"
      direction="ltr"
      :with-header="false"
      :wrapper-closable="true"
      :close-on-press-escape="true"
      :append-to-body="false"
      :custom-class="isTouchNavigation ? 'productNavigationDrawer touchNavigationDrawer' : 'productNavigationDrawer'"
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
          <div class="navigationDrawerBrand"><WcpdLogoMark class="wcpdLogoImage" aria-hidden="true" /><div><strong>WCPD</strong></div></div>
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
          navigation-id="drawer-product-navigation"
          :file-nav="fileNav"
          :kb-enabled="kbEnabled"
          @navigate="closeNavigation"
        />
        <div v-if="profile" class="navigationDrawerFooter">
      <div v-if="profile" class="navigationDrawerUtilities">
        <AccessNotificationTrigger v-if="profile" :key="profile.id" :collapsed="false" label="消息" class="drawerNotifications" @click.native="closeNavigation" />
        <el-dropdown v-if="profile" trigger="click" placement="right-end" @command="handleAccountCommand">
            <button
              class="accountInfo"
              type="button"
              data-testid="drawer-profile"
              aria-label="个人账户菜单"
              aria-haspopup="menu"
            >
              <UserAvatar :person="profile" :size="22" fallback="依" />
              <span class="accountLabel">我的</span>
            </button>
          <el-dropdown-menu slot="dropdown" class="sidebarAccountMenu" :class="{ 'sidebarAccountMenu--dark': isDarkTheme }">
            <el-dropdown-item command="profile" class="accountMenuHeader" aria-label="打开个人主页">
              <UserAvatar :person="profile" :size="26" fallback="依" />
              <div class="accountMenuIdentity">
                <strong>{{ profile.name || profile.id }}</strong>
                <span>{{ profile.id }}</span>
              </div>
              <i class="el-icon-arrow-right accountMenuChevron" aria-hidden="true" />
            </el-dropdown-item>
            <el-dropdown-item command="logout" icon="el-icon-switch-button" class="accountMenuLogout" :disabled="loggingOut">
              {{ loggingOut ? '退出中…' : '退出登录' }}
            </el-dropdown-item>
          </el-dropdown-menu>
        </el-dropdown>
      </div>
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<script>
import mobileViewport from '@/utils/mobileViewport'
import productService from '@/services/productService'
import { logoutAndRedirect } from '@/utils/auth'
import UserAvatar from '@/components/UserAvatar.vue'
import WcpdLogoMark from '@/components/WcpdLogoMark.vue'
import AccessNotificationTrigger from '@/components/AccessNotificationTrigger.vue'
import { shellTheme, applyShellThemeToRoot } from '@/utils/shellTheme'
import { resolveShellMode, withShell } from '@/utils/shellMode'
import ProductNavigation from './ProductNavigation.vue'
const SIDEBAR_PREFERENCE_KEY = 'product-shell-sidebar-collapsed'
const TABLET_NAVIGATION_QUERY = '(min-width: 768px) and (max-width: 1366px) and (any-pointer: coarse)'
const isSmallScreen = () => window.matchMedia('(max-width: 760px), (max-width: 1023px) and (any-pointer: coarse)').matches
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
  components: { UserAvatar, WcpdLogoMark, AccessNotificationTrigger, ProductNavigation },
  provide() {
    return { showProductSidebar: this.showProductSidebar }
  },
  data() {
    const preference = readSidebarPreference()
    return {
      sidebarCollapsed: preference === null ? isSmallScreen() : preference,
      isTabletNavigation: window.matchMedia(TABLET_NAVIGATION_QUERY).matches,
      hasSidebarPreference: preference !== null,
      profile: null,
      navigationOpen: false,
      mobileCreateOpen: false,
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
    isTouchNavigation() { return this.isMobileViewport || this.isTabletNavigation },
    navigationDrawerEnabled() { return this.shellMode === 'focus' || this.isTouchNavigation },
    isKnowledgeRoute() { return this.$route.name === 'FileKb' },
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
    this._tabletNavigationQuery = window.matchMedia(TABLET_NAVIGATION_QUERY)
    this._tabletNavigationQuery.addListener(this.updateTabletNavigation)
  },
  beforeDestroy() {
    this.$bus.$off('mobile-create-state', this.updateMobileCreateState)
    applyShellThemeToRoot(false)
    window.removeEventListener('resize', this.updateAutoSidebar)
    document.removeEventListener('keydown', this.onNavigationKeydown)
    if (this._tabletNavigationQuery) this._tabletNavigationQuery.removeListener(this.updateTabletNavigation)
  },
  watch: {
    navigationDrawerEnabled(enabled) { if (!enabled) this.closeNavigation() },
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
    showProductSidebar(event) {
      this.openNavigation(event)
    },
    updateTabletNavigation() { this.isTabletNavigation = this._tabletNavigationQuery.matches },
    openSidebar(event) {
      if (this.isTabletNavigation) this.openNavigation(event)
      else this.setSidebarCollapsed(false)
    },
    updateMobileCreateState(open) { this.mobileCreateOpen = open },
    async mobileCreate() {
      if (!['/files', '/my-maps'].some(path => this.$route.path === path || this.$route.path.startsWith(path + '/folder/'))) {
        return this.$router.push({ path: '/files', query: { mobileCreate: '1' } })
      }
      this.$nextTick(() => this.$bus.$emit('mobile-create-file'))
    },
    updateAutoSidebar() {
      if (!this.hasSidebarPreference) this.sidebarCollapsed = isSmallScreen()
    },
    handleAccountCommand(command) {
      if (command === 'profile') this.openProfile()
      else if (command === 'logout' && !this.loggingOut) this.signOut()
    },
    openProfile() {
      if (this.$route.path !== '/profile') this.$router.push(withShell('/profile', this.$route))
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
        const active = document.activeElement
        const drawer = this.$el.querySelector('.productNavigationDrawer')
        if (active && active !== document.body && active !== trigger && !(drawer && drawer.contains(active))) return
        if (trigger && trigger.isConnected && typeof trigger.focus === 'function') trigger.focus({ preventScroll: true })
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
    this.$bus.$on('mobile-create-state', this.updateMobileCreateState)
    try {
      this.profile = await productService.getProfile()
    } catch (error) {
      this.profile = null
    }
  }
}
</script>

<style lang="less">
.productShell .wcpdLogoImage {
  display: block; flex-shrink: 0;
  color: var(--ui-text-secondary);
  background: transparent; border-radius: 0; box-shadow: none;
}
.productShell .productLogo .wcpdLogoImage { width: 24px; height: 24px; }
.mobileShellHeader, .mobileBottomNav { display: none; }
// Keep shell overrides after component styles, including asynchronously loaded chunks.
@media (max-width: 767px) {
  .productShell .productSidebar, .productShell .sidebarBackdrop, .productShell .shellModeToolbar { display: none !important; }
  .productShell .productMain { margin-left: 0 !important; width: 100% !important; max-width: 100% !important; padding-top: calc(56px + env(safe-area-inset-top)); padding-bottom: calc(68px + env(safe-area-inset-bottom)); }
  .productShell--teams .productMain { padding-top: calc(64px + env(safe-area-inset-top)); }
  .productShell--embed .productMain { padding-top: 0; padding-bottom: 0; }
  .productShell .mobileShellHeader { display: flex; justify-content: flex-start; gap: 4px; height: 56px; padding-inline: 16px; background: var(--ui-bg); border-bottom: 0; }
  .productShell--teams .mobileShellHeader { height: 64px; }
  .productShell .mobileShellHeader button { padding: 0; justify-content: center; flex-shrink: 0; cursor: pointer; }
  .productShell .mobileShellHeader > button:last-child { margin-left: auto; }
  .productShell .mobileShellHeader .mobileTeamBrand { min-width: 36px; margin-right: 8px; }
  .productShell .mobileBrandMark { width: 36px; height: 36px; font-weight: 400; font-size: 25px; border-radius: 10px; }
  .mobilePageTitle { flex: 1; min-width: 0; margin: 0; font-size: 22px; line-height: 1.3; letter-spacing: -0.5px; }
  .productShell .mobileShellHeader i { font-size: 23px; }
  .productShell .mobileBottomNav { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .productShell .mobileBottomNav > a { min-width: 0; }
  .productShell .mobileBottomNav .notificationBadge { width: 100%; margin: 0; }
  .productShell .mobileBottomNav .notificationButton { height: auto; min-height: 48px; gap: 4px; }
  .productShell .mobileBottomNav .notificationButton i { font-size: 22px; }
  .productShell .mobileBottomNav .router-link-active { font-weight: 600; }
  .productShell .mobileBottomNav .router-link-active i { background: var(--ui-primary-soft); border-radius: 10px; padding: 4px 14px; margin: -4px -14px; }
  .productShell .spacesPage { padding: 12px 16px 24px !important; }
}
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
.productShell .sidebarUtilities {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  gap: 8px;
  padding: 8px 0;
  border-top: 1px solid var(--ui-border);
  .sidebarModeSwitch {
    flex: 0 0 36px;
    min-width: 0;
    padding: 0;
    border: 0;
  }
  .sidebarNotifications { width: 36px; margin: 0; }
  .sidebarModeSwitch button,
  .notificationButton {
    min-height: 36px;
    justify-content: center;
    padding: 0 4px;
    gap: 4px;
    font-size: 12px;
    white-space: nowrap;
    i { width: 16px; font-size: 16px; }
  }
  .notificationCount {
    min-width: 18px;
    height: 18px;
    padding: 0 4px;
    font-size: 10px;
    line-height: 18px;
  }
}
.productShell--collapsed .sidebarUtilities {
  flex-direction: column;
  width: 100%;
  .sidebarModeSwitch { flex: none; }
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
    width: 24px;
    height: 24px;
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
    gap: 8px;
    min-width: 0;
    cursor: pointer;
    font-size: 15px;
    span {
      width: 32px;
      height: 32px;
      border-radius: 9px;
      display: grid;
      place-items: center;
      color: var(--ui-on-primary);
      background: transparent;
      font-size: 18px;
      flex-shrink: 0;
    }
    strong {
      font-weight: 600;
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
  max-width: min(224px, calc(100vw - 40px));
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
    flex-shrink: 0;
    min-height: 56px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 4px 0 12px;
    margin-bottom: 12px;
    border-bottom: 1px solid var(--ui-border);
    strong { font-size: 15px; }
  }
  .navigationDrawerBrand {
    display: flex; align-items: center; gap: 10px; min-width: 0;
    img { width: 32px; height: 32px; }
    div { display: flex; flex-direction: column; gap: 3px; }
    strong { font-size: 16px; }
    span { font-size: 11px; color: var(--ui-text-muted); }
  }
  .navigationDrawerFooter {
    flex-shrink: 0; margin-top: 12px; padding-top: 4px; border-top: 1px solid var(--ui-border);
    .notificationButton { color: var(--ui-text-secondary); font-size: 14px; }
    .notificationButton:hover, .notificationButton:focus-visible { background: var(--ui-surface-muted); color: var(--ui-primary); }
  }
  .navigationDrawerAccount { display: flex; align-items: center; gap: 4px; padding-top: 8px; border-top: 1px solid var(--ui-border); }
  .navigationDrawerProfile {
    display: flex; align-items: center; flex: 1; min-width: 0; gap: 10px; border: 0; border-radius: 8px;
    padding: 8px; background: transparent; color: inherit; text-align: left; cursor: pointer;
    > span { display: flex; flex-direction: column; min-width: 0; gap: 4px; }
    strong, small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    strong { font-size: 13px; } small { font-size: 11px; color: var(--ui-text-muted); }
    &:hover { background: var(--ui-hover-overlay); }
    &:focus-visible { outline: 2px solid var(--ui-focus); outline-offset: -2px; }
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
.productShell--tablet {
  .sidebarToggle, .collapsedLogoTrigger, .shellModeButton, .accountLogout { min-width: 44px; min-height: 44px; }
  .productSidebar a, .productSidebar .sidebarModeSwitch button, .productSidebar .notificationButton { min-height: 44px; }
  &.productShell--collapsed .productSidebar { --rail-item: 44px; }
  .collapsedLogoTrigger .collapsedLogoMark { opacity: 0; }
  .collapsedLogoTrigger .collapsedLogoOpenIcon { opacity: 1; }
  .collapsedLogoTrigger .collapsedLogoTip { display: none; }
  .productSidebar { padding-top: max(16px, env(safe-area-inset-top)); padding-bottom: max(16px, env(safe-area-inset-bottom)); }
}
.touchNavigationDrawer {
  height: var(--mm-viewport-height, 100vh) !important;
  top: var(--mm-viewport-top, 0px) !important;
  .navigationDrawerContent { padding-top: max(12px, env(safe-area-inset-top)); padding-bottom: max(12px, env(safe-area-inset-bottom)); }
  .productNavigation a, .shellModeButton, .notificationButton, .navigationDrawerProfile { min-height: 44px; }
  .shellModeButton { min-width: 44px; }
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
<style lang="less">
@media (max-width: 767px) {
  .productShell .mobileShellHeader {
    left: 0; right: 0; transform: none; width: 100%; max-width: none; box-sizing: border-box;
    height: calc(56px + env(safe-area-inset-top)); padding: env(safe-area-inset-top) 16px 0;
    font-family: Arial, 'Microsoft YaHei', sans-serif;
    .mobileBrandButton { gap: 10px; min-width: 44px; margin: 0; padding: 0; }
    .mobileBrandButton .mobileBrandMark { width: 36px; height: 36px; flex: 0 0 36px; border-radius: 10px; font: 400 25px/1 Arial, sans-serif; background: #087854; box-shadow: none; }
    .mobileBrandButton strong { font: 700 17px/1 Arial, sans-serif; letter-spacing: normal; }
  }
}
</style>
<style lang="less">
@media (max-width: 767px) {
  .productShell--team-detail {
    --ui-bg: #f6f9f7; --ui-primary: #08785d; --ui-text: #182d29; --ui-text-secondary: #7c8e88;
    font-family: -apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;
    .productMain { padding-top: calc(65px + env(safe-area-inset-top)); }
    .spaceDetailPage { padding: 20px 15px 44px !important; }
    .mobileShellHeader { height: 65px; padding-inline: 19px; background: rgba(255,255,255,.93); border-bottom: 1px solid #e9efeb; backdrop-filter: blur(16px); }
    .mobileShellHeader .detailLauncher { margin-left: auto; }
    .mobileShellHeader > button.detailLauncher:last-child { margin-left: auto; }
    .mobileBrandMark { width: 40px; height: 40px; border-radius: 12px; font-size: 27px; font-family: Georgia,serif; }
    .mobileShellHeader strong { font-size: 20px; }
  }
}
</style>
<style lang="less">
@media (max-width: 767px) {
  .productShell--teams {
    --ui-bg: #f6f9f7; --ui-primary: #08795d; --ui-primary-soft: #e6f4ee; --ui-text: #152925; --ui-text-secondary: #83938c;
    background: #e9efeb;
    font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif;
    .productMain { max-width: 640px !important; margin-inline: auto !important; padding-top: calc(104px + env(safe-area-inset-top)); padding-bottom: calc(114px + env(safe-area-inset-bottom)); min-height: 100dvh; box-sizing: border-box; background: radial-gradient(ellipse 64% 230px at 100% -62px,rgba(212,239,224,.58),transparent 76%),#f6f9f7; box-shadow: 0 0 50px rgba(20,52,39,.10); }
    .spacesPage { padding: 0 24px 0 !important; }
    .mobileShellHeader { left: 50%; right: auto; transform: translateX(-50%); width: 100%; max-width: 640px; box-sizing: border-box; height: calc(104px + env(safe-area-inset-top)); padding-inline: 24px; background: #f6f9f7; gap: 8px; }
    .mobileShellHeader .mobileTeamBrand { min-width: 52px; margin-right: 7px; gap: 11px; }
    .mobileHeaderSpacer { flex: 1; }
    .mobileShellHeader .mobileTeamBrand strong { font-size: 20px; }
    .mobileBrandMark { width: 52px; height: 52px; border-radius: 16px; font-family: Georgia,serif; font-size: 35px; font-weight: 600; background: linear-gradient(145deg,#0a886a,#05694f); box-shadow: 0 6px 14px rgba(4,115,83,.15); }
    .mobilePageTitle { font-size: 27px; font-weight: 750; letter-spacing: -.6px; white-space: nowrap; }
    .mobileShellHeader .userAvatar { width: 45px !important; height: 45px !important; font-size: 19px !important; background: linear-gradient(135deg,#159c77,#087255); }
    .mobileShellHeader i { font-size: 26px; }
  }
}
@media (max-width: 470px) {
  .productShell--teams {
    .productMain { padding-top: calc(87px + env(safe-area-inset-top)); }
    .spacesPage { padding-inline: 17px !important; }
    .mobileShellHeader { height: calc(87px + env(safe-area-inset-top)); padding-inline: 17px; gap: 5px; }
    .mobileShellHeader .mobileTeamBrand { min-width: 46px; margin-right: 6px; }
    .mobileBrandMark { width: 46px; height: 46px; border-radius: 14px; font-size: 31px; }
    .mobilePageTitle { font-size: 23px; }
    .mobileShellHeader .userAvatar { width: 39px !important; height: 39px !important; font-size: 16px !important; }
  }
}
@media (max-width: 355px) { .productShell--teams .mobilePageTitle { font-size: 20px; } }
</style>
<style lang="less">
// Floating navigation uses the existing shell tokens in both themes.
@media (max-width: 767px) {
  .productShell { --mobile-nav-height: 104px; }
  .productShell .productMain { padding-bottom: calc(104px + env(safe-area-inset-bottom)); }
  .productShell--embed .productMain { padding-bottom: 0; }
  .productShell .mobileBottomNav {
    left: 50%; right: auto; bottom: calc(24px + env(safe-area-inset-bottom)); transform: translateX(-50%);
    display: flex; justify-content: center; gap: 16px; width: max-content; max-width: calc(100% - 32px);
    min-height: 62px; padding: 8px; border: 1px solid var(--ui-border); border-radius: 999px;
    background: var(--ui-surface); backdrop-filter: none; box-shadow: 0 6px 24px rgba(0,0,0,.12);
    > a, > button, .notificationButton {
      display: flex; align-items: center; justify-content: center; flex: 0 0 44px;
      width: 44px; height: 44px; min-height: 44px; min-width: 44px; padding: 0 !important;
      border: 0; border-radius: 50%; background: transparent; color: var(--ui-text-secondary);
      cursor: pointer; transition: background-color .18s ease-out, color .18s ease-out;
      &:hover { background: var(--ui-surface-muted); color: var(--ui-text); }
      &:focus-visible { outline: 2px solid var(--ui-focus); outline-offset: 3px; }
    }
    i, .notificationButton i { display: block; width: auto; height: auto; font-size: 22px; padding: 0; margin: 0; background: transparent; }
    .router-link-active { color: var(--ui-primary); background: var(--ui-primary-soft); }
    .router-link-active i { padding: 0; margin: 0; background: transparent; }
    > .mobilePrimary { background: var(--ui-primary); color: #fff; &:hover { background: var(--ui-primary-hover, #066646); color: #fff; } }
    > .mobilePrimary i { transition: transform .22s ease-out; }
    > .mobilePrimary--open i { transform: rotate(45deg); }
    .notificationBadge { position: relative; flex: 0 0 44px; width: 44px; margin: 0; }
    .notificationBadge > .el-badge__content.is-fixed {
      top: 3px; right: 3px; transform: translate(25%, -15%);
      min-width: 16px; height: 16px; padding: 0 4px; box-sizing: border-box;
      border: 1px solid var(--ui-surface); font-size: 10px; line-height: 14px;
    }
  }
}
@media (max-width: 359px) { .productShell .mobileBottomNav { gap: 10px; } }
@media (prefers-reduced-motion: reduce) {
  .productShell .mobileBottomNav {
    > a, > button, .notificationButton, > .mobilePrimary i { transition: none; }
  }
}
</style>
<style lang="less">
@media (max-width: 767px) {
  .productShell--teams {
    .productMain { padding-top: calc(56px + env(safe-area-inset-top)); }
    .mobileShellHeader { height: calc(56px + env(safe-area-inset-top)); padding-inline: 16px; gap: 4px; }
    .mobileShellHeader .mobileTeamBrand { margin-right: 0; min-width: 44px; gap: 10px; }
    .mobileShellHeader .mobileTeamBrand strong { font-size: 17px; }
    .mobileBrandMark { width: 36px; height: 36px; border-radius: 10px; font: 400 25px sans-serif; background: #087854; box-shadow: none; }
    .mobileShellHeader > button:last-child { margin-left: 0; }
    .mobileShellHeader i { font-size: 23px; }
  }
}
.el-dropdown-menu.el-popper.sidebarAccountMenu {
  // This menu is mounted under body, outside the shell theme token scope.
  --account-menu-bg: #fff;
  --account-menu-border: #e7ece9;
  --account-menu-text: #52645b;
  --account-menu-hover: #edf5f0;
  --account-menu-accent: #087854;
  --account-menu-danger: #b8433a;
  --account-menu-danger-bg: #fdf1ef;
  &.sidebarAccountMenu--dark {
    --account-menu-bg: #232c34;
    --account-menu-border: #3a4652;
    --account-menu-text: #d5e2ec;
    --account-menu-hover: #2b3d3b;
    --account-menu-accent: #71c6a6;
    --account-menu-danger: #f5a69c;
    --account-menu-danger-bg: #422f31;
  }
  box-sizing: border-box;
  width: 184px;
  max-width: calc(100vw - 24px);
  padding: 5px;
  border: 1px solid var(--account-menu-border);
  border-radius: 10px;
  background: var(--account-menu-bg);
  box-shadow: 0 8px 28px rgba(17, 30, 23, 0.1), 0 2px 6px rgba(17, 30, 23, 0.04);
  > .popper__arrow { display: none; }
  .accountMenuIdentity {
    display: flex;
    flex-direction: column;
    gap: 1px;
    flex: 1;
    min-width: 0;
    color: var(--account-menu-text);
    strong, span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    strong { font-size: 13px; font-weight: 600; line-height: 18px; }
    span { font-size: 11px; line-height: 16px; opacity: 0.7; }
  }
  .el-dropdown-menu__item {
    display: flex;
    align-items: center;
    gap: 8px;
    box-sizing: border-box;
    height: 32px;
    min-height: 32px;
    padding: 0 8px;
    border: 0;
    border-radius: 7px;
    color: var(--account-menu-text);
    font-size: 13px;
    line-height: 20px;
    i { width: 16px; margin: 0; font-size: 16px; text-align: center; }
    &:not(.is-disabled):hover, &:focus {
      background: var(--account-menu-hover);
      color: var(--account-menu-accent);
    }
    &.is-disabled { opacity: 0.5; cursor: not-allowed; }
  }
  .accountMenuLogout {
    position: relative;
    margin-top: 7px;
    &::before {
      content: '';
      position: absolute;
      top: -4px;
      left: 8px;
      right: 8px;
      height: 1px;
      background: var(--account-menu-border);
    }
    &:not(.is-disabled):hover, &:focus {
      color: var(--account-menu-danger);
      background: var(--account-menu-danger-bg);
    }
  }
  .el-dropdown-menu__item.accountMenuHeader {
    height: 50px;
    min-height: 50px;
    padding: 6px 8px;
    .userAvatar { flex-shrink: 0; }
    .accountMenuChevron { flex-shrink: 0; width: 12px; font-size: 12px; opacity: 0.5; }
    &:hover .accountMenuIdentity, &:focus .accountMenuIdentity { color: inherit; }
  }
}
.productShell .productNavigationDrawer {
  .navigationDrawerContent { padding: max(10px, env(safe-area-inset-top)) 8px max(10px, env(safe-area-inset-bottom)); }
  .navigationDrawerHeader { min-height: 40px; padding: 0 6px 8px; margin-bottom: 6px; }
  .navigationDrawerBrand {
    gap: 8px;
    > svg.wcpdLogoImage { width: 24px; height: 24px; flex: 0 0 24px; }
    strong { font-size: 15px; font-weight: 600; }
  }
  .navLabel { margin-top: 8px; margin-bottom: 4px; font-size: 11px; }
  .navLabel--space { margin-top: 12px; }
  .productNavigation { gap: 2px; }
  .productNavigation a { min-height: 36px; padding: 0 10px; border-radius: 7px; font-size: 13px; gap: 9px; }
  &.touchNavigationDrawer .productNavigation a { min-height: 44px; }
  .navigationDrawerFooter { padding-top: 8px; margin-top: 8px; }
  .navigationDrawerUtilities {
    display: flex;
    align-items: center;
    position: relative;
    gap: 8px;
    &::after {
      content: ''; position: absolute; left: 50%; top: 50%;
      width: 1px; height: 16px; transform: translate(-50%, -50%);
      background: var(--ui-border); pointer-events: none;
    }
    > .el-dropdown, > .drawerNotifications {
      flex: 1 1 0; min-width: 0; width: 0; margin: 0;
      display: flex; align-items: center; justify-content: center;
    }
    .accountInfo, .notificationButton {
      display: flex; align-items: center; justify-content: center;
      box-sizing: border-box; width: 100%; min-height: 40px;
      padding: 0 6px; margin: 0; gap: 6px; border: 0; border-radius: 8px;
      background: transparent; color: var(--ui-text-secondary);
      font-family: inherit; font-size: 13px; cursor: pointer;
      &:hover { background: var(--ui-surface-muted); color: var(--ui-primary); }
      &:focus-visible { outline: 2px solid var(--ui-focus); outline-offset: -2px; }
    }
    .accountLabel { display: inline; }
    .notificationCount { margin-left: 0; }
  }
}
// Override the legacy filled placeholders in every compact brand entry.
.productShell .productSidebar .sidebarUtilities {
  justify-content: flex-start;
  .accountInfo,
  .accountLogout {
    flex: 0 0 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    width: 36px;
    min-width: 36px;
    height: 36px;
    min-height: 36px;
    padding: 0;
    margin: 0;
    gap: 0;
    border: 0;
    border-radius: 8px;
    background: transparent;
    i { font-size: 16px; }
  }
  .accountInfo:hover { background: var(--ui-surface-muted); }
  .accountLogout:hover:not(:disabled) {
    background: var(--ui-danger-soft);
    color: var(--ui-danger);
  }
}
.productShell:not(.productShell--collapsed) .productSidebar .sidebarUtilities {
  position: relative;
  &::after {
    content: '';
    position: absolute;
    left: 50%;
    top: 50%;
    width: 1px;
    height: 16px;
    transform: translate(-50%, -50%);
    background: var(--ui-border, #e7ece9);
    pointer-events: none;
  }
  > .el-dropdown,
  > .sidebarNotifications {
    flex: 1 1 0;
    min-width: 0;
    width: 0;
  }
  > .el-dropdown,
  > .sidebarNotifications {
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .accountInfo,
  .notificationButton {
    flex: 0 1 auto;
    width: 100%;
    min-width: 0;
    height: 36px;
    min-height: 36px;
    padding: 0 4px;
    gap: 4px;
    border-radius: 8px;
    font-family: inherit;
    font-size: 12px;
    color: var(--ui-text-secondary);
    i { font-size: 18px; }
  }
  .notificationCount { margin-left: 0; }
  .accountLabel { white-space: nowrap; line-height: 20px; }

}
.productShell--collapsed .productSidebar .sidebarUtilities {
  justify-content: flex-start;
  .accountLabel { display: none; }
  .accountInfo, .accountLogout {
    flex-basis: var(--rail-item);
    width: var(--rail-item);
    height: var(--rail-item);
  }
}
.productShell .collapsedLogoTrigger svg.wcpdLogoImage,
.productShell .mobileShellHeader svg.wcpdLogoImage,
.productShell .navigationDrawerBrand svg.wcpdLogoImage {
  color: var(--ui-text-secondary);
  background: transparent;
  border-radius: 0;
  box-shadow: none;
}

.productShell {
  svg.wcpdLogoImage,
  .productLogo strong,
  .mobileBrandButton strong,
  .navigationDrawerBrand strong {
    color: var(--ui-text-secondary);
  }
}

</style>
