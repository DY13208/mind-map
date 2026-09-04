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
      <button
        class="sidebarToggle"
        :title="sidebarCollapsed ? '展开侧栏' : '折叠侧栏'"
        :aria-label="sidebarCollapsed ? '展开侧栏' : '折叠侧栏'"
        :aria-expanded="String(!sidebarCollapsed)"
        aria-controls="product-navigation"
        @click="setSidebarCollapsed(!sidebarCollapsed)"
      >
        <i
          :class="
            sidebarCollapsed ? 'el-icon-arrow-right' : 'el-icon-arrow-left'
          "
          aria-hidden="true"
        />
      </button>
      <div class="productLogo" @click="$router.push('/files')">
        <span>依</span><strong>依然中台</strong>
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
        <router-link to="/spaces" title="团队空间" aria-label="团队空间"
          ><i class="el-icon-office-building"></i>团队空间</router-link
        >
      </nav>
      <div class="sidebarFooter" v-if="profile">
        <el-avatar size="small">依</el-avatar>
        <div>
          <strong>{{ profile.name }}</strong
          ><span>{{ profile.id }}</span>
        </div>
      </div>
    </aside>
    <main class="productMain">
      <div class="mockNotice">
        文件、文件夹与历史已接入真实 API。最近、收藏、回收站和团队空间仍为演示数据，删除脑图暂未开放。
      </div>
      <router-view />
    </main>
  </div>
</template>

<script>
import productService from '@/services/productService'
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
      ]
    }
  },
  mounted() {
    window.addEventListener('resize', this.updateAutoSidebar)
  },
  beforeDestroy() {
    window.removeEventListener('resize', this.updateAutoSidebar)
  },
  methods: {
    updateAutoSidebar() {
      if (!this.hasSidebarPreference) this.sidebarCollapsed = isSmallScreen()
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
.productShell .mockNotice {
  padding: 10px 28px;
  background: #edf4f1;
  color: #647c71;
  font-size: 12px;
  line-height: 1.6;
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
  background: #f5f7f6;
  color: #17362c;
  display: flex;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC',
    sans-serif;
}
.productShell .sidebarBackdrop {
  display: none;
}
.productShell .sidebarToggle {
  position: absolute;
  top: 24px;
  right: -14px;
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border: 1px solid #dce7e1;
  border-radius: 50%;
  background: #fff;
  color: #52665f;
  cursor: pointer;
  &:hover {
    background: #eaf6f1;
    color: #087854;
  }
  &:focus-visible {
    outline: 2px solid #087854;
    outline-offset: 3px;
  }
}
.productShell .productSidebar {
  width: 224px;
  background: #fff;
  border-right: 1px solid #e7ece9;
  padding: 22px 14px 18px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  position: fixed;
  inset: 0 auto 0 0;
  z-index: 10;
  .productLogo {
    display: flex;
    align-items: center;
    gap: 11px;
    padding: 0 10px 24px;
    cursor: pointer;
    font-size: 17px;
    span {
      width: 32px;
      height: 32px;
      border-radius: 9px;
      display: grid;
      place-items: center;
      color: white;
      background: #0b9366;
      font-size: 18px;
    }
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
    color: #52665f;
    text-decoration: none;
    font-size: 14px;
    &:hover {
      background: #f3f8f6;
      color: #087854;
    }
    &.router-link-exact-active {
      background: #eaf6f1;
      color: #087854;
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
    display: flex;
    gap: 10px;
    padding: 14px 10px 4px;
    border-top: 1px solid #eef1ef;
    align-items: center;
    div {
      display: flex;
      flex-direction: column;
      font-size: 12px;
    }
    span {
      color: #98a59f;
      margin-top: 2px;
    }
  }
}
.productShell .productMain {
  min-width: 0;
  flex: 1;
  margin-left: 224px;
}
.productShell .productPage {
  padding: 32px 38px 60px;
  max-width: 1480px;
  margin: auto;
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
    letter-spacing: -0.4px;
  }
  p {
    margin: 7px 0 0;
    color: #819089;
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
    .productLogo strong,
    a:not(.router-link-exact-active)::after,
    a {
      font-size: 0;
    }
    .productLogo {
      padding-inline: 0;
      justify-content: center;
      gap: 0;
      strong {
        display: none;
      }
      span {
        flex-shrink: 0;
      }
    }
    a {
      justify-content: center;
      padding: 0;
      i {
        font-size: 20px;
      }
    }
    .navLabel,
    .sidebarFooter div {
      display: none;
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
