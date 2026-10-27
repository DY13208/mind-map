<template>
  <div class="fileToolbar">
    <el-tooltip v-if="shellMode === 'focus'" content="显示侧边栏" placement="bottom" popper-class="wcpdActionTooltip" :open-delay="250" :visible-arrow="false" :offset="10">
      <button type="button" class="iconGhost sidebarRestore" aria-label="显示左侧侧边栏" aria-haspopup="dialog" data-testid="shell-open-navigation" @click="showProductSidebar">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M9 4v16" />
        </svg>
      </button>
    </el-tooltip>
    <div class="toolbarTitle"><slot name="title">脑图</slot></div>
    <div class="toolbarActions">
    <el-tooltip v-if="shellMode !== 'embed'" :content="shellMode === 'focus' ? '退出专注模式' : '专注模式'" placement="bottom" popper-class="wcpdActionTooltip" :open-delay="250" :visible-arrow="false" :offset="10">
      <button
        type="button"
        class="iconGhost"
        :aria-label="shellMode === 'focus' ? '退出专注模式' : '进入专注模式'"
        :aria-pressed="shellMode === 'focus' ? 'true' : 'false'"
        data-testid="shell-focus-mode"
        @click="toggleFocusMode"
      >
        <i class="el-icon-full-screen" aria-hidden="true" />
      </button>
    </el-tooltip>
    <FileSearch
      class="toolbarSearch"
      :value="search"
      @input="$emit('update:search', $event)"
    />
    <button
      v-if="showFavorites"
      type="button"
      class="iconGhost"
      :class="{ active: favoritesActive }"
      :title="favoritesActive ? '查看全部' : '只看收藏'"
      :aria-label="favoritesActive ? '查看全部' : '只看收藏'"
      :aria-pressed="favoritesActive ? 'true' : 'false'"
      @click="$emit('toggle-favorites')"
    >
      <i :class="favoritesActive ? 'el-icon-star-on' : 'el-icon-star-off'" aria-hidden="true" />
    </button>
    <button
      type="button"
      class="iconGhost themeToggle"
      :title="isDark ? '切换到浅色模式' : '切换到深色模式'"
      :aria-label="isDark ? '切换到浅色模式' : '切换到深色模式'"
      @click="toggleTheme"
    >
      <svg
        v-if="isDark"
        viewBox="0 0 24 24"
        width="18"
        height="18"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
      <svg
        v-else
        viewBox="0 0 24 24"
        width="18"
        height="18"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
      </svg>
    </button>

    <el-dropdown
      v-if="showCreate || showCreateFolder"
      trigger="click"
      @command="create"
    >
      <button
        type="button"
        class="iconGhost createBtn"
        title="新建"
        aria-label="新建"
      >
        <i class="el-icon-plus" aria-hidden="true" />
      </button>
      <el-dropdown-menu slot="dropdown">
        <el-dropdown-item
          v-if="showCreate"
          command="room"
          icon="el-icon-document-add"
          >新建脑图</el-dropdown-item
        >
        <el-dropdown-item
          v-if="showImport"
          command="import"
          icon="el-icon-upload2"
          >导入脑图</el-dropdown-item
        >
        <el-dropdown-item
          v-if="showCreateFolder"
          command="folder"
          icon="el-icon-folder-add"
          >新建文件夹</el-dropdown-item
        >
      </el-dropdown-menu>
    </el-dropdown>
    </div>
  </div>
</template>
<script>
import FileSearch from './FileSearch.vue'
import { shellTheme, toggleShellTheme } from '@/utils/shellTheme'
import { resolveShellMode } from '@/utils/shellMode'
export default {
  name: 'FileToolbar',
  inject: { showProductSidebar: { default: () => {} } },
  components: { FileSearch },
  props: {
    search: String,
    showFavorites: { type: Boolean, default: false },
    favoritesActive: { type: Boolean, default: false },
    showCreate: { type: Boolean, default: true },
    showCreateFolder: { type: Boolean, default: true },
    showImport: { type: Boolean, default: true }
  },
  computed: {
    shellMode() {
      return resolveShellMode(this.$route)
    },
    isDark() {
      return shellTheme.theme === 'dark'
    }
  },
  methods: {
    toggleFocusMode() {
      this.$router.push({
        path: this.$route.path,
        query: { ...this.$route.query, shell: this.shellMode === 'focus' ? 'full' : 'focus' },
        hash: this.$route.hash
      })
    },
    toggleTheme() {
      toggleShellTheme()
    },
    create(command) {
      if (command === 'folder') this.$emit('create-folder')
      else if (command === 'import') this.$emit('import')
      else this.$emit('create-room')
    }
  }
}
</script>
<style lang="less" scoped>
.fileToolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  box-sizing: border-box;
  padding: 0 0 14px;
  border-bottom: 0;

  .toolbarTitle {
    flex: 0 1 auto;
    min-width: 0;
    margin: 0;
    font-size: 22px;
    font-weight: 650;
    letter-spacing: -0.3px;
    color: var(--ui-text);
    line-height: 1.2;

    /deep/ .el-breadcrumb {
      font-size: inherit;
      line-height: inherit;
    }

    /deep/ .el-breadcrumb__inner,
    /deep/ .el-breadcrumb__inner.is-link {
      font-weight: inherit;
    }
  }

  .toolbarActions {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
    min-width: 0;
  }

  .toolbarSearch {
    margin-right: 4px;
  }
  .sidebarRestore { flex-shrink: 0; margin-right: -4px; }

  .iconGhost {
    width: 36px;
    height: 36px;
    display: inline-grid;
    place-items: center;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--ui-text-secondary);
    cursor: pointer;
    font-size: 18px;
    padding: 0;
    line-height: 1;
    transition: background 0.15s ease, color 0.15s ease;

    &:hover,
    &:focus-visible {
      background: var(--ui-surface-muted);
      color: var(--ui-primary);
      outline: none;
    }

    &.active {
      background: var(--ui-primary-soft);
      color: var(--ui-star);
    }
  }

  .createBtn {
    color: var(--ui-primary);
    background: var(--ui-primary-soft);

    &:hover,
    &:focus-visible {
      background: var(--ui-primary);
      color: var(--ui-on-primary);
    }
  }
}
</style>
