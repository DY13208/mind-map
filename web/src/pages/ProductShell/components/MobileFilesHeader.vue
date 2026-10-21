<template>
  <header
    ref="header"
    class="mobileFilesHeader"
    aria-label="文件页头部"
    @keydown.esc="onHeaderEscape"
  >
    <div v-if="!isFolder" class="mobileFilesTitleRow">
      <h1 class="mobileFilesTitle">{{ title }}</h1>
    </div>

    <el-popover
      v-else
      v-model="pathOpen"
      trigger="click"
      placement="bottom-start"
      popper-class="mobileFilesPathPanel"
      :width="panelWidth"
      :visible-arrow="false"
      :disabled="!canExpandPath"
      :tabindex="-1"
    >
      <div
        slot="reference"
        class="mobileFilesNavRow"
        :class="{ 'is-loading': pathLoading }"
      >
        <button
          type="button"
          class="mobileFilesBack"
          aria-label="返回上一级"
          :disabled="!canGoParent"
          @click.stop="goParent"
        >
          <i class="el-icon-arrow-left" aria-hidden="true" />
        </button>
        <button
          ref="pathTrigger"
          type="button"
          class="mobileFilesFolderTitle"
          :aria-expanded="pathOpen ? 'true' : 'false'"
          aria-haspopup="true"
          :disabled="!canExpandPath"
          @click="preparePanel"
        >
          <span>{{ titleText }}</span>
          <i
            class="el-icon-arrow-down mobileFilesFolderChevron"
            :class="{ 'is-open': pathOpen }"
            aria-hidden="true"
          />
        </button>
      </div>

      <div
        class="mobileFilesPathContent"
        @keydown.esc.stop.prevent="closePanelByKeyboard('path')"
      >
        <div class="mobileFilesPathSummary">
          <span>当前位置</span>
          <strong>{{ title }}</strong>
        </div>
        <div class="mobileFilesPathScroll">
          <div class="mobileFilesPathRow">
            <button
              type="button"
              class="mobileFilesPathItem"
              :style="{ paddingLeft: pathIndent(0) }"
              @click="chooseRoot"
            >
              {{ rootLabel }}
            </button>
          </div>
          <div
            v-for="(item, index) in folderPath"
            :key="item.id"
            class="mobileFilesPathRow"
          >
            <button
              v-if="isAncestor(index)"
              type="button"
              class="mobileFilesPathItem"
              :style="{ paddingLeft: pathIndent(index + 1) }"
              @click="chooseFolder(item)"
            >
              {{ item.name }}
            </button>
            <div
              v-else
              class="mobileFilesPathItem is-current"
              :style="{ paddingLeft: pathIndent(index + 1) }"
              aria-current="page"
            >
              <span>{{ item.name }}</span>
              <span class="mobileFilesPathCurrentTag">当前</span>
            </div>
          </div>
        </div>
      </div>
    </el-popover>

    <div class="mobileFilesSearchRow">
      <FileSearch
        ref="search"
        class="mobileFilesSearch"
        :value="search"
        always-expanded
        placeholder="搜索脑图、文件夹…"
        @input="$emit('update:search', $event)"
        @focus="closePanels"
      />
      <el-popover
        v-model="moreOpen"
        trigger="click"
        placement="bottom-end"
        popper-class="mobileFilesMorePanel"
        :width="moreWidth"
        :visible-arrow="false"
      >
        <button
          ref="moreTrigger"
          slot="reference"
          type="button"
          class="mobileFilesMoreButton"
          aria-label="页面更多操作"
          aria-haspopup="menu"
          :aria-expanded="moreOpen ? 'true' : 'false'"
          @click="preparePanel"
        >
          <i class="el-icon-more" aria-hidden="true" />
        </button>

        <div
          class="mobileFilesMoreMenu"
          role="menu"
          @keydown.esc.stop.prevent="closePanelByKeyboard('more')"
        >
          <template v-if="!isTeamView">
            <button
              v-for="option in viewOptions"
              :key="option.key"
              type="button"
              role="menuitemradio"
              class="mobileFilesMenuItem"
              :class="{ 'is-active': activeView === option.key }"
              :aria-checked="activeView === option.key ? 'true' : 'false'"
              @click="chooseView(option.key)"
            >
              <i
                class="el-icon-check mobileFilesMenuCheck"
                :class="{ 'is-visible': activeView === option.key }"
                aria-hidden="true"
              />
              <span>{{ option.label }}</span>
            </button>
            <div class="mobileFilesMenuSeparator" role="separator" />
          </template>
          <button
            type="button"
            role="menuitem"
            class="mobileFilesMenuItem"
            @click="toggleTheme"
          >
            <i class="mobileFilesMenuCheck" aria-hidden="true" />
            <span>{{ themeLabel }}</span>
          </button>
        </div>
      </el-popover>
    </div>

    <div class="mobileFilesFilters" role="group" aria-label="内容类型">
      <button
        v-for="option in kindOptions"
        :key="option.value"
        type="button"
        :aria-pressed="kind === option.value ? 'true' : 'false'"
        :class="{ active: kind === option.value }"
        @click="$emit('update:kind', option.value)"
      >
        {{ option.label }}
      </button>
    </div>
  </header>
</template>

<script>
import FileSearch from './FileSearch.vue'
import { shellTheme, toggleShellTheme } from '@/utils/shellTheme'
import {
  isFolderPathAncestor,
  updateMobilePanel
} from './mobileFilesNavigation'

export default {
  name: 'MobileFilesHeader',
  components: { FileSearch },
  props: {
    mode: { type: String, default: 'files' },
    title: { type: String, default: '' },
    search: { type: String, default: '' },
    kind: { type: String, default: 'all' },
    folderPath: { type: Array, default: () => [] },
    isFolder: { type: Boolean, default: false },
    isTeamView: { type: Boolean, default: false },
    loading: { type: Boolean, default: false },
    rootLabel: { type: String, default: '脑图' }
  },
  data() {
    return {
      activePanel: null,
      headerWidth: 0,
      moreWidth: 232,
      viewOptions: [
        { key: 'files', label: '我的脑图' },
        { key: 'recent', label: '最近打开' },
        { key: 'shared', label: '共享脑图' },
        { key: 'favorites', label: '我的收藏' }
      ],
      kindOptions: [
        { value: 'all', label: '全部' },
        { value: 'folders', label: '文件夹' },
        { value: 'rooms', label: '脑图' }
      ]
    }
  },
  computed: {
    pathLoading() {
      return this.isFolder && this.loading
    },
    titleText() {
      if (this.pathLoading) return '正在加载文件夹…'
      return this.title
    },
    canExpandPath() {
      return (
        this.isFolder && !this.pathLoading && this.folderPath.length > 0
      )
    },
    canGoParent() {
      return this.canExpandPath
    },
    panelWidth() {
      return this.headerWidth > 0 ? Math.floor(this.headerWidth) : 320
    },
    pathOpen: {
      get() {
        return this.activePanel === 'path'
      },
      set(value) {
        this.setPanelOpen('path', value)
      }
    },
    moreOpen: {
      get() {
        return this.activePanel === 'more'
      },
      set(value) {
        this.setPanelOpen('more', value)
      }
    },
    activeView() {
      return this.mode === 'folder' ? 'files' : this.mode
    },
    isDark() {
      return shellTheme.theme === 'dark'
    },
    themeLabel() {
      return this.isDark ? '切换到浅色模式' : '切换到深色模式'
    }
  },
  watch: {
    $route() {
      this.closePanels()
    },
    isFolder() {
      this.closePanels()
    },
    loading(value) {
      if (value) this.closePanels()
    },
    canExpandPath(value) {
      if (!value) this.closePanels()
    }
  },
  mounted() {
    this.updateHeaderWidth()
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(this.updateHeaderWidth)
      this.resizeObserver.observe(this.$el)
    } else {
      window.addEventListener('resize', this.updateHeaderWidth)
    }
  },
  beforeDestroy() {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect()
      this.resizeObserver = null
    }
    window.removeEventListener('resize', this.updateHeaderWidth)
  },
  methods: {
    updateHeaderWidth() {
      const width = this.$el ? this.$el.clientWidth : 0
      if (width > 0 && width !== this.headerWidth) this.headerWidth = width
    },
    isAncestor(index) {
      return isFolderPathAncestor(this.folderPath, index)
    },
    pathIndent(level) {
      return `${16 + Math.min(level * 12, 48)}px`
    },
    preparePanel() {
      this.blurSearch()
    },
    blurSearch() {
      const search = this.$refs.search
      if (search && search.blur) search.blur()
    },
    setPanelOpen(panel, open) {
      if (open) this.blurSearch()
      this.activePanel = updateMobilePanel(this.activePanel, panel, open)
    },
    closePanels() {
      this.activePanel = null
    },
    panelTrigger(panel) {
      return panel === 'path'
        ? this.$refs.pathTrigger
        : this.$refs.moreTrigger
    },
    closePanelByKeyboard(panel) {
      this.activePanel = null
      this.$nextTick(() => {
        const trigger = this.panelTrigger(panel)
        if (trigger && trigger.focus) trigger.focus()
      })
    },
    onHeaderEscape(event) {
      if (!this.activePanel) return
      event.preventDefault()
      const panel = this.activePanel
      this.closePanelByKeyboard(panel)
    },
    goParent() {
      if (!this.canGoParent) return
      this.closePanels()
      this.$emit('navigate-parent')
    },
    chooseRoot() {
      this.closePanels()
      this.$emit('navigate-root')
    },
    chooseFolder(item) {
      this.closePanels()
      this.$emit('navigate-folder', item.id)
    },
    chooseView(key) {
      this.closePanels()
      this.$emit('navigate-view', key)
    },
    toggleTheme() {
      toggleShellTheme()
      this.closePanels()
    }
  }
}
</script>

<style lang="less" scoped>
.mobileFilesHeader {
  display: flex;
  flex-direction: column;
  width: 100%;
  min-width: 0;
  margin: 0 0 12px;
  color: var(--ui-text);
}

.mobileFilesTitleRow {
  display: flex;
  align-items: center;
  min-height: 32px;
  min-width: 0;
}

.mobileFilesTitle {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: var(--ui-text);
  font-size: 18px;
  font-weight: 600;
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mobileFilesNavRow {
  display: flex;
  align-items: center;
  width: 100%;
  min-width: 0;
  min-height: 44px;
  outline: none;
}

.mobileFilesBack {
  flex: 0 0 44px;
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--ui-text);
  font-size: 20px;
  text-decoration: none;
  cursor: pointer;

  &:disabled {
    cursor: default;
    opacity: 0.4;
  }

  &:focus-visible {
    outline: 2px solid var(--ui-focus);
    outline-offset: -2px;
  }
}

.mobileFilesFolderTitle {
  flex: 1 1 auto;
  min-width: 0;
  height: 44px;
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 0;
  padding: 0 4px 0 0;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--ui-text);
  font-size: 18px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;

  > span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &:disabled {
    cursor: default;
  }

  &:focus-visible {
    outline: 2px solid var(--ui-focus);
    outline-offset: -2px;
  }
}

.mobileFilesFolderChevron {
  flex: 0 0 14px;
  width: 14px;
  font-size: 14px;
  color: var(--ui-text-secondary);
  transition: transform 0.16s ease;

  &.is-open {
    transform: rotate(180deg);
  }
}

.mobileFilesSearchRow {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  margin-top: 8px;
}

.mobileFilesSearch {
  flex: 1 1 auto;
  width: auto;
  min-width: 0;
  max-width: none;

  /deep/ .searchInput .el-input__inner {
    height: 44px;
    line-height: 44px;
    border-radius: 14px;
    font-size: 14px;
  }

  /deep/ .searchInput .el-input__icon {
    line-height: 44px;
  }
}

.mobileFilesMoreButton {
  flex: 0 0 44px;
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 12px;
  background: transparent;
  color: var(--ui-text-secondary);
  font-size: 20px;
  cursor: pointer;

  &:hover,
  &:active {
    background: var(--ui-surface-muted);
    color: var(--ui-text);
  }

  &:focus-visible {
    outline: 2px solid var(--ui-focus);
    outline-offset: -2px;
  }
}

.mobileFilesFilters {
  display: flex;
  align-items: center;
  align-self: flex-start;
  gap: 4px;
  margin-top: 8px;

  button {
    min-width: 44px;
    min-height: 44px;
    margin: 0;
    padding: 0 12px;
    border: 0;
    border-radius: 22px;
    background: transparent;
    color: var(--ui-text-secondary);
    font-size: 14px;
    white-space: nowrap;
    cursor: pointer;
  }

  button.active {
    background: var(--ui-primary-soft);
    color: var(--ui-primary);
    font-weight: 600;
  }

  button:focus-visible {
    outline: 2px solid var(--ui-focus);
    outline-offset: -2px;
  }
}
</style>

<style lang="less">
.mobileFilesMorePanel.el-popover,
.mobileFilesPathPanel.el-popover {
  --mobile-panel-bg: #ffffff;
  --mobile-panel-text: #17261f;
  --mobile-panel-muted: #66756e;
  --mobile-panel-border: #e7ece9;
  --mobile-panel-hover: #f1f5f3;
  --mobile-panel-primary: #087854;
  --mobile-panel-primary-soft: #e8f4ef;
  --mobile-panel-focus: #087854;
  box-sizing: border-box;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--mobile-panel-border);
  border-radius: 14px;
  background: var(--mobile-panel-bg);
  color: var(--mobile-panel-text);
  box-shadow: 0 14px 36px rgba(0, 0, 0, 0.16);
}

html.shellDark .mobileFilesMorePanel.el-popover,
html.shellDark .mobileFilesPathPanel.el-popover {
  --mobile-panel-bg: #232c34;
  --mobile-panel-text: #e8eef4;
  --mobile-panel-muted: #94a6b2;
  --mobile-panel-border: #3a4652;
  --mobile-panel-hover: rgba(45, 212, 191, 0.14);
  --mobile-panel-primary: #2dd4bf;
  --mobile-panel-primary-soft: rgba(45, 212, 191, 0.16);
  --mobile-panel-focus: #2dd4bf;
  box-shadow: 0 14px 36px rgba(12, 24, 36, 0.4);
}

.mobileFilesMorePanel.el-popover {
  max-width: calc(100vw - 24px);
}

.mobileFilesMoreMenu {
  display: flex;
  flex-direction: column;
  padding: 6px 0;
}

.mobileFilesMenuItem {
  width: 100%;
  min-height: 44px;
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 0 14px;
  border: 0;
  background: transparent;
  color: var(--mobile-panel-text);
  font-size: 14px;
  text-align: left;
  cursor: pointer;

  &:hover {
    background: var(--mobile-panel-hover);
  }

  &.is-active {
    color: var(--mobile-panel-primary);
    font-weight: 600;
  }

  &:focus-visible {
    outline: 2px solid var(--mobile-panel-focus);
    outline-offset: -2px;
  }
}

.mobileFilesMenuCheck {
  flex: 0 0 18px;
  width: 18px;
  font-size: 16px;
  visibility: hidden;

  &.is-visible {
    visibility: visible;
  }
}

.mobileFilesMenuSeparator {
  height: 1px;
  margin: 6px 10px;
  background: var(--mobile-panel-border);
}

.mobileFilesPathPanel.el-popover {
  max-width: calc(100vw - 24px);
}

.mobileFilesPathContent {
  display: flex;
  flex-direction: column;
  max-height: ~"min(400px, 50dvh)";
  min-height: 0;
}

.mobileFilesPathSummary {
  flex: 0 0 auto;
  padding: 14px 16px 10px;
  border-bottom: 1px solid var(--mobile-panel-border);

  span {
    display: block;
    color: var(--mobile-panel-muted);
    font-size: 12px;
    line-height: 1.4;
  }

  strong {
    display: block;
    margin-top: 4px;
    color: var(--mobile-panel-text);
    font-size: 14px;
    font-weight: 600;
    line-height: 1.45;
    overflow-wrap: anywhere;
    word-break: break-word;
    white-space: normal;
  }
}

.mobileFilesPathScroll {
  flex: 1 1 auto;
  min-height: 0;
  padding: 4px 0 8px;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}

.mobileFilesPathRow {
  min-width: 0;
}

.mobileFilesPathItem {
  box-sizing: border-box;
  width: 100%;
  min-height: 44px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 0;
  padding: 8px 16px;
  border: 0;
  background: transparent;
  color: var(--mobile-panel-text);
  font-size: 14px;
  line-height: 1.4;
  text-align: left;
  overflow-wrap: anywhere;
  word-break: break-word;
  white-space: normal;

  & + & {
    border-top: 1px solid var(--mobile-panel-border);
  }
}

button.mobileFilesPathItem {
  cursor: pointer;

  &:hover {
    background: var(--mobile-panel-hover);
  }

  &:focus-visible {
    outline: 2px solid var(--mobile-panel-focus);
    outline-offset: -2px;
  }
}

.mobileFilesPathItem.is-current {
  background: var(--mobile-panel-primary-soft);
  color: var(--mobile-panel-primary);
  font-weight: 600;
}

.mobileFilesPathCurrentTag {
  flex: 0 0 auto;
  color: var(--mobile-panel-primary);
  font-size: 12px;
  font-weight: 400;
}
</style>
