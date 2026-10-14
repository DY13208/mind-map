<template>
  <div class="navigatorToolbarDock">
    <CanvasToolbarActions
      class="navigatorToolbarActions"
      :collapsed="toolbarCollapsed"
    ></CanvasToolbarActions>
    <div
      class="navigatorToolbarWrapper"
      :class="{ isDark: isDark, collapsed: toolbarCollapsed }"
    >
      <div class="navigatorContainer customScrollbar">
        <div class="item">
          <Scale :isDark="isDark" :mindMap="mindMap"></Scale>
        </div>
        <div class="item">
          <el-tooltip
            effect="dark"
            :content="$t('navigatorToolbar.backToRoot')"
            placement="top"
          >
            <div class="btn iconfont icondingwei" @click="backToRoot"></div>
          </el-tooltip>
        </div>
        <div class="item">
          <Fullscreen :isDark="isDark" :mindMap="mindMap"></Fullscreen>
        </div>
        <div class="item extraTools">
          <el-popover
            placement="top-end"
            width="220"
            trigger="click"
            :popper-class="isDark ? 'navExtraPopper isDark' : 'navExtraPopper'"
          >
            <div class="extraToolPanel" :class="{ isDark: isDark }">
              <el-select
                v-model="lang"
                size="small"
                style="width: 100%"
                @change="onLangChange"
              >
                <el-option
                  v-for="item in langList"
                  :key="item.value"
                  :label="item.name"
                  :value="item.value"
                />
              </el-select>
              <div class="extraRow">
                <el-tooltip
                  v-if="roomCanEdit"
                  effect="dark"
                  :content="
                    isReadonly
                      ? $t('navigatorToolbar.edit')
                      : $t('navigatorToolbar.readonly')
                  "
                  placement="top"
                >
                  <div
                    class="btn iconfont"
                    :class="[isReadonly ? 'iconyanjing' : 'iconbianji1']"
                    @click="readonlyChange"
                  ></div>
                </el-tooltip>
                <MouseAction :isDark="isDark" :mindMap="mindMap"></MouseAction>
                <el-tooltip
                  effect="dark"
                  :content="
                    openMiniMap
                      ? $t('navigatorToolbar.closeMiniMap')
                      : $t('navigatorToolbar.openMiniMap')
                  "
                  placement="top"
                >
                  <div class="btn iconfont icondaohang1" @click="toggleMiniMap"></div>
                </el-tooltip>
                <el-tooltip
                  effect="dark"
                  :content="darkModeActionLabel"
                  placement="top"
                >
                  <div
                    class="btn iconfont"
                    :class="[isDark ? 'iconmoon_line' : 'iconlieri']"
                    role="button"
                    tabindex="0"
                    :aria-label="darkModeActionLabel"
                    @click="toggleDark"
                  ></div>
                </el-tooltip>
                <Demonstrate :isDark="isDark" :mindMap="mindMap"></Demonstrate>
              </div>
              <div class="extraMenu">
                <button v-if="!isMobile" type="button" @click="handleCommand('directory')">
                  <span class="iconfont icondakai"></span>
                  {{ $t('toolbar.directory') }}
                </button>
                <button v-if="!isMobile" type="button" @click="handleCommand('openFile')">
                  <span class="iconfont iconwenjian1"></span>
                  {{ $t('toolbar.openFile') }}
                </button>
                <button
                  v-if="!isReadonly"
                  type="button"
                  data-testid="run-workbuddy-history"
                  @click="handleCommand('jobHistory')"
                >
                  <span class="el-icon-tickets"></span>
                  运行历史
                </button>
                <button type="button" @click="handleCommand('shortcutKey')">
                  <span class="iconfont iconjianpan"></span>
                  {{ $t('navigatorToolbar.shortcutKeys') }}
                </button>
                <button type="button" @click="handleCommand('aiChat')">
                  <span class="iconfont iconAIshengcheng"></span>
                  {{ $t('navigatorToolbar.ai') }}
                </button>
                <div class="extraVersion">{{ $t('navigatorToolbar.current') }}v{{ version }}</div>
              </div>
            </div>
            <div slot="reference" class="btn el-icon-more" aria-label="更多画布操作" title="更多"></div>
          </el-popover>
        </div>
      </div>
      <button
        type="button"
        class="collapseToggleBtn"
        :class="{ collapsed: toolbarCollapsed }"
        :title="
          toolbarCollapsed
            ? $t('navigatorToolbar.expandToolbar')
            : $t('navigatorToolbar.collapseToolbar')
        "
        :aria-label="
          toolbarCollapsed
            ? $t('navigatorToolbar.expandToolbar')
            : $t('navigatorToolbar.collapseToolbar')
        "
        :aria-expanded="String(!toolbarCollapsed)"
        @click.stop="toolbarCollapsed = !toolbarCollapsed"
      >
        <span class="iconfont iconjiantouyou"></span>
      </button>
    </div>
  </div>
</template>

<script>
import Scale from './Scale.vue'
import Fullscreen from './Fullscreen.vue'
import MouseAction from './MouseAction.vue'
import CanvasToolbarActions from './CanvasToolbarActions.vue'
import { langList } from '@/config'
import i18n from '@/i18n'
import { storeLang, getLang } from '@/api'
import { mapState, mapMutations } from 'vuex'
import pkg from 'simple-mind-map/package.json'
import { isMobile } from 'simple-mind-map/src/utils/index'
import Demonstrate from './Demonstrate.vue'

// 导航器工具栏
export default {
  components: {
    Scale,
    Fullscreen,
    MouseAction,
    CanvasToolbarActions,
    Demonstrate
  },
  props: {
    mindMap: {
      type: Object
    }
  },
  data() {
    return {
      version: pkg.version,
      langList,
      lang: '',
      openMiniMap: false,
      toolbarCollapsed: false,
      isMobile: isMobile()
    }
  },
  computed: {
    ...mapState({
      isReadonly: state => state.isReadonly,
      isDark: state => state.localConfig.isDark,
      roomCanEdit: state => state.roomCanEdit
    }),
    darkModeActionLabel() {
      return this.isDark
        ? this.$t('navigatorToolbar.switchToLight')
        : this.$t('navigatorToolbar.switchToDark')
    }
  },
  created() {
    this.lang = getLang()
    this.$bus.$on(
      'set_canvas_toolbars_collapsed',
      this.setCanvasToolbarsCollapsed
    )
    this.$bus.$on('toggle_mini_map', this.onMiniMapToggle)
  },
  beforeDestroy() {
    this.$bus.$off(
      'set_canvas_toolbars_collapsed',
      this.setCanvasToolbarsCollapsed
    )
    this.$bus.$off('toggle_mini_map', this.onMiniMapToggle)
  },
  methods: {
    ...mapMutations([
      'setLocalConfig',
      'setIsReadonly',
      'setIsSourceCodeEdit',
      'setActiveSidebar'
    ]),

    setCanvasToolbarsCollapsed(collapsed) {
      this.toolbarCollapsed = collapsed
    },

    readonlyChange() {
      if (!this.roomCanEdit) return
      this.setIsReadonly(!this.isReadonly)
      this.mindMap.setMode(this.isReadonly ? 'readonly' : 'edit')
    },

    onMiniMapToggle(show) {
      this.openMiniMap = !!show
    },

    toggleMiniMap() {
      this.$bus.$emit('toggle_mini_map', !this.openMiniMap)
    },

    onLangChange(lang) {
      i18n.locale = lang
      storeLang(lang)
      this.$bus.$emit('lang_change')
    },

    showSearch() {
      this.$bus.$emit('show_search')
    },

    toggleDark() {
      this.$bus.$emit('toggle_appearance_mode', !this.isDark)
    },

    handleCommand(command) {
      if (command === 'directory') {
        this.$bus.$emit('open_local_directory')
        return
      }
      if (command === 'openFile') {
        this.$bus.$emit('open_local_file')
        return
      }
      if (command === 'jobHistory') {
        this.$bus.$emit('open_workbuddy_job_history')
        return
      }
      if (command === 'shortcutKey') {
        this.setActiveSidebar('shortcutKey')
        return
      }
      if (command === 'aiChat') {
        this.setActiveSidebar('ai')
      }
    },

    backToRoot() {
      this.mindMap.renderer.setRootNodeCenter()
    },

    openSourceCodeEdit() {
      this.setIsSourceCodeEdit(true)
    }
  }
}
</script>

<style lang="less" scoped>
.navigatorToolbarDock {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 3;
  pointer-events: none;

  > * {
    pointer-events: auto;
  }
}

.navigatorToolbarActions {
  display: none;
}

.navigatorToolbarWrapper {
  position: relative;
  transition: transform 0.25s ease;

  &.collapsed {
    transform: translateY(calc(100% + 20px));
  }

  &.isDark {
    .navigatorContainer {
      background: #262a2e;
      border-color: hsla(0, 0%, 100%, 0.08);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    }

    .item {
      a {
        color: hsla(0, 0%, 100%, 0.6);
      }

      .btn {
        color: hsla(0, 0%, 100%, 0.6);
      }
    }
  }

  .collapseToggleBtn {
    display: none;
    position: absolute;
    left: 50%;
    bottom: calc(100% - 22px);
    width: 60px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 10px 10px 0 0;
    background-color: #409eff;
    color: #fff;
    cursor: pointer;
    align-items: center;
    justify-content: center;
    transform: translateX(-50%);
    transition: bottom 0.1s linear;
    z-index: 0;

    &:hover {
      bottom: calc(100% - 10px);
    }

    &:focus-visible {
      outline: 2px solid #409eff;
      outline-offset: 2px;
    }

    span {
      width: auto;
      height: auto;
      line-height: 1;
      font-size: 10px;
      transform: rotateZ(90deg);
      transition: transform 0.25s ease;
    }

    &.collapsed span {
      transform: rotateZ(-90deg);
    }
  }
}

.extraToolPanel {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.extraRow {
  display: flex;
  align-items: center;
  gap: 4px;
}

.extraMenu {
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-top: 1px solid rgba(16, 24, 40, 0.08);
  padding-top: 8px;

  button {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 4px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: #344054;
    font-size: 13px;
    text-align: left;
    cursor: pointer;

    &:hover {
      background: #f2f4f7;
      color: #409eff;
    }
  }
}

.extraVersion {
  padding: 6px 4px 0;
  color: #98a2b3;
  font-size: 12px;
}

.extraToolPanel.isDark {
  .extraMenu {
    border-top-color: rgba(255, 255, 255, 0.08);

    button {
      color: rgba(255, 255, 255, 0.88);

      &:hover {
        background: rgba(255, 255, 255, 0.06);
        color: #79bbff;
      }
    }
  }

  .extraVersion {
    color: rgba(255, 255, 255, 0.45);
  }
}

.navigatorContainer {
  padding: 0 8px;
  background: #fff;
  border: 1px solid rgba(16, 24, 40, 0.08);
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(16, 24, 40, 0.08);
  height: 44px;
  font-size: 12px;
  display: flex;
  align-items: center;
  position: relative;
  z-index: 1;

  .item {
    margin-right: 8px;

    &:last-of-type {
      margin-right: 0;
    }

    a {
      color: #303133;
      text-decoration: none;
    }

    .btn {
      cursor: pointer;
      font-size: 18px;
    }
  }
}

@media screen and (max-width: 700px) {
  .navigatorToolbarDock {
    left: 20px;
    right: 20px;
    bottom: 20px;
    display: block;
  }

  .navigatorToolbarActions {
    left: auto;
    right: 0;
    bottom: calc(100% + 12px);
  }

  .navigatorToolbarWrapper {
    left: auto;
    right: auto;

    .navigatorContainer {
      overflow-x: auto;
      overflow-y: hidden;
      height: 60px;
    }
  }
}

@media (prefers-reduced-motion: reduce) {
  .navigatorToolbarWrapper,
  .navigatorToolbarWrapper .collapseToggleBtn,
  .navigatorToolbarWrapper .collapseToggleBtn span {
    transition: none;
  }
}
</style>
