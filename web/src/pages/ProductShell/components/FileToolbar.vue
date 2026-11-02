<template>
  <div class="fileToolbar">
    <ActionTooltip v-if="shellMode === 'focus'" content="显示侧边栏">
      <button type="button" class="iconGhost sidebarRestore" aria-label="显示左侧侧边栏" aria-haspopup="dialog" data-testid="shell-open-navigation" @click="showProductSidebar">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M9 4v16" />
        </svg>
      </button>
    </ActionTooltip>
    <div class="toolbarTitle"><slot name="title">脑图</slot></div>
    <div class="toolbarActions">
    <ActionTooltip v-if="shellMode !== 'embed'" :content="shellMode === 'focus' ? '退出专注模式' : '专注模式'">
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
    </ActionTooltip>
    <FileSearch
      class="toolbarSearch"
      :value="search"
      @input="$emit('update:search', $event)"
    />
    <ActionTooltip v-if="showFavorites" :content="favoritesActive ? '查看全部' : '只看收藏'">
    <button
      type="button"
      class="iconGhost"
      :class="{ active: favoritesActive }"
      :aria-label="favoritesActive ? '查看全部' : '只看收藏'"
      :aria-pressed="favoritesActive ? 'true' : 'false'"
      @click="$emit('toggle-favorites')"
    >
      <i :class="favoritesActive ? 'el-icon-star-on' : 'el-icon-star-off'" aria-hidden="true" />
    </button>
    </ActionTooltip>
    <ThemeModeToggle />

    <el-dropdown
      v-if="showCreate || showCreateFolder"
      trigger="click"
      @command="create"
    >
      <ActionTooltip content="新建">
      <button
        type="button"
        class="iconGhost createBtn"
        aria-label="新建"
      >
        <i class="el-icon-plus" aria-hidden="true" />
      </button>
      </ActionTooltip>
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
import ActionTooltip from '@/components/ActionTooltip.vue'
import FileSearch from './FileSearch.vue'
import ThemeModeToggle from './ThemeModeToggle.vue'
import { resolveShellMode } from '@/utils/shellMode'
export default {
  name: 'FileToolbar',
  inject: { showProductSidebar: { default: () => {} } },
  components: { FileSearch, ThemeModeToggle, ActionTooltip },
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
