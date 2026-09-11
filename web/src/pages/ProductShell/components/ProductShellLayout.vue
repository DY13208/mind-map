<template>
  <div
    class="productShell"
    :class="{ 'productShell--collapsed': sidebarCollapsed }"
  >
    <button
      v-if="!sidebarCollapsed"
      class="sidebarBackdrop"
      aria-label="关闭展开的侧栏"
      @click="setSidebarCollapsed(true)"
    />
    <aside class="productSidebar">
      <div class="sidebarHeader">
        <div class="productLogo" @click="$router.push('/files')">
          <span>良</span><strong>良策</strong>
        </div>
        <button
          class="sidebarToggle"
          type="button"
          :title="sidebarCollapsed ? '展开侧栏' : '折叠侧栏'"
          :aria-label="sidebarCollapsed ? '展开侧栏' : '折叠侧栏'"
          :aria-expanded="String(!sidebarCollapsed)"
          aria-controls="product-navigation"
          data-testid="sidebar-toggle"
          @click="setSidebarCollapsed(!sidebarCollapsed)"
        >
          <svg
            class="sidebarToggleIcon"
            viewBox="0 0 16 16"
            width="16"
            height="16"
            aria-hidden="true"
            focusable="false"
          >
            <rect
              x="1.75"
              y="2.25"
              width="12.5"
              height="11.5"
              rx="1.5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.25"
            />
            <path
              d="M5.75 2.25v11.5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.25"
            />
          </svg>
        </button>
      </div>
      <nav id="product-navigation" aria-label="产品导航">
        <p class="navLabel">文件</p>
        <router-link
          v-for="item in fileNav"
          :key="item.path"
          :to="item.path"
          :title="item.label"
          :aria-label="item.label"
          ><i :class="item.icon"></i>{{ item.label }}</router-link
        >
        <p class="navLabel navLabel--space">空间</p>
        <router-link to="/spaces" title="我的团队" aria-label="我的团队"
          ><i class="el-icon-office-building"></i>我的团队</router-link
        >
        <router-link to="/sop" title="SOP台账" aria-label="SOP台账"
          ><i class="el-icon-notebook-2"></i>SOP台账</router-link
        >
        <router-link to="/sop-tasks" title="SOP任务" aria-label="SOP任务"
          ><i class="el-icon-s-order"></i>任务</router-link
        >
        <router-link to="/assistant" title="助理" aria-label="助理"
          ><i class="el-icon-chat-dot-round"></i>助理</router-link
        >
        <p class="navLabel navLabel--space">工具</p>
        <router-link
          to="/mcp-access"
          title="获取 MCP 配置"
          aria-label="获取 MCP 配置"
        >
          <i class="el-icon-connection" aria-hidden="true"></i>
          <span>MCP 接入</span>
        </router-link>
      </nav>
      <div class="sidebarFooter" v-if="profile">
        <div class="accountInfo" :title="`${profile.name}（${profile.id}）`">
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
    <main class="productMain">
      <router-view />
    </main>
  </div>
</template>

<script>
import productService from '@/services/productService'
import { logoutAndRedirect } from '@/utils/auth'
import UserAvatar from '@/components/UserAvatar.vue'
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
  components: { UserAvatar },
  data() {
    const preference = readSidebarPreference()
    return {
      sidebarCollapsed: preference === null ? isSmallScreen() : preference,
      hasSidebarPreference: preference !== null,
      profile: null,
      fileNav: [
        { path: '/files/recent', label: '最近', icon: 'el-icon-time' },
        { path: '/files', label: '我的脑图', icon: 'el-icon-files' },
        { path: '/files/favorites', label: '收藏', icon: 'el-icon-star-off' },
        { path: '/files/shared', label: '与我共享', icon: 'el-icon-user' },
        { path: '/files/trash', label: '回收站', icon: 'el-icon-delete' }
      ],
      loggingOut: false
    }
  },
  mounted() {
    document.body.classList.remove('isDark')
    window.addEventListener('resize', this.updateAutoSidebar)
  },
  beforeDestroy() {
    window.removeEventListener('resize', this.updateAutoSidebar)
  },
  methods: {
    updateAutoSidebar() {
      if (!this.hasSidebarPreference) this.sidebarCollapsed = isSmallScreen()
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
  background: var(--ui-bg);
  color: var(--ui-text);
  display: flex;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC',
    sans-serif;
}
.productShell .sidebarBackdrop {
  display: none;
}
.productShell .productSidebar {
  width: 216px;
  background: var(--ui-surface);
  border-right: 1px solid var(--ui-border);
  padding: 16px 12px 16px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  position: fixed;
  inset: 0 auto 0 0;
  z-index: 10;
  .sidebarHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-height: 40px;
    margin-bottom: 16px;
    padding: 0 4px 0 8px;
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
      color: white;
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
  .sidebarToggle {
    width: 28px;
    height: 28px;
    flex: 0 0 auto;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: #6b7c74;
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease;
    &:hover {
      background: var(--ui-surface-muted);
      color: var(--ui-primary);
    }
    &:active {
      background: var(--ui-primary-soft);
    }
    &:focus-visible {
      outline: 2px solid #087854;
      outline-offset: 2px;
    }
  }
  .sidebarToggleIcon {
    display: block;
  }
  nav {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  a {
    height: 40px;
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
    color: #9aa7a2;
    font-size: 12px;
    &--space {
      margin-top: 22px;
    }
  }
  .sidebarFooter {
    margin-top: auto;
    padding: 10px 10px 2px;
    border-top: 1px solid #eef1ef;
  }
  .accountInfo {
    display: flex;
    gap: 10px;
    align-items: center;
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
      color: #98a59f;
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
    border: 1px solid #e3e9e6;
    border-radius: 8px;
    background: #fff;
    color: #52665f;
    font-size: 13px;
    cursor: pointer;
    &:hover:not(:disabled) {
      border-color: #f0c9c4;
      background: #fdf5f4;
      color: #b4473c;
    }
    &:focus-visible {
      outline: 2px solid #087854;
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
  margin-left: 216px;
}
.productShell .productPage {
  padding: 32px clamp(24px, 2.2vw, 44px) 60px;
  width: 100%;
}
.productShell .productHeader {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 20px;
  margin-bottom: 24px;
  h1 {
    margin: 0;
    font-size: 26px;
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
  color: #40564e;
}
.productShell--collapsed {
  .productSidebar {
    width: 72px;
    padding-inline: 10px;
    .sidebarHeader {
      flex-direction: column;
      align-items: center;
      justify-content: flex-start;
      gap: 10px;
      margin-bottom: 18px;
      padding: 0;
    }
    .productLogo {
      padding: 0;
      justify-content: center;
      gap: 0;
      strong {
        display: none;
      }
    }
    .productLogo strong,
    a:not(.router-link-exact-active)::after,
    a {
      font-size: 0;
    }
    a {
      justify-content: center;
      padding: 0;
      i {
        font-size: 20px;
      }
    }
    .navLabel,
    .accountMeta,
    .accountLogoutText {
      display: none;
    }
    .sidebarFooter {
      padding-inline: 0;
    }
    .accountInfo {
      justify-content: center;
    }
    .accountLogout {
      width: 36px;
      margin-inline: auto;
      padding: 0;
    }
  }
  .productMain {
    margin-left: 72px;
  }
}
@media (max-width: 760px) {
  .productShell .productMain {
    margin-left: 72px;
  }
  .productShell .sidebarBackdrop {
    display: block;
    position: fixed;
    inset: 0 0 0 224px;
    background: rgba(23, 54, 44, 0.18);
    border: 0;
    z-index: 9;
  }
  .productShell .productPage {
    padding: 24px 16px 40px;
  }
}
</style>
