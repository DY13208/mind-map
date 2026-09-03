<template>
  <div class="navigatorToolbarDock">
    <CanvasToolbarActions
      class="navigatorToolbarActions"
    ></CanvasToolbarActions>
    <div
      class="navigatorToolbarWrapper"
      :class="{ isDark: isDark, collapsed: toolbarCollapsed }"
    >
      <div class="navigatorContainer customScrollbar">
        <div class="item">
          <el-select
            v-model="lang"
            size="small"
            style="width: 100px"
            @change="onLangChange"
          >
            <el-option
              v-for="item in langList"
              :key="item.value"
              :label="item.name"
              :value="item.value"
            />
          </el-select>
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
          <div class="btn iconfont iconsousuo" @click="showSearch"></div>
        </div>
        <div class="item">
          <MouseAction :isDark="isDark" :mindMap="mindMap"></MouseAction>
        </div>
        <div class="item">
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
        </div>
        <div class="item">
          <!-- <el-switch
        v-model="isReadonly"
        :active-text="$t('navigatorToolbar.readonly')"
        :inactive-text="$t('navigatorToolbar.edit')"
        @change="readonlyChange"
      >
      </el-switch> -->
          <el-tooltip
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
              v-if="roomCanEdit"
              @click="readonlyChange"
            ></div>
          </el-tooltip>
        </div>
        <div class="item">
          <Fullscreen :isDark="isDark" :mindMap="mindMap"></Fullscreen>
        </div>
        <div class="item">
          <Scale :isDark="isDark" :mindMap="mindMap"></Scale>
        </div>
        <div class="item">
          <div
            class="btn iconfont"
            :class="[isDark ? 'iconmoon_line' : 'iconlieri']"
            @click="toggleDark"
          ></div>
        </div>
        <!-- <div class="item">
      <el-tooltip
        effect="dark"
        :content="$t('navigatorToolbar.changeSourceCodeEdit')"
        placement="top"
      >
        <div class="btn iconfont iconyuanma" @click="openSourceCodeEdit"></div>
      </el-tooltip>
      </div> -->
        <div class="item">
          <Demonstrate :isDark="isDark" :mindMap="mindMap"></Demonstrate>
        </div>
        <div class="item">
          <el-dropdown @command="handleCommand">
            <div class="btn el-icon-more"></div>
            <el-dropdown-menu slot="dropdown">
              <el-dropdown-item command="shortcutKey">
                <span class="iconfont iconjianpan"></span>
                {{ $t('navigatorToolbar.shortcutKeys') }}
              </el-dropdown-item>
              <el-dropdown-item command="aiChat">
                <span class="iconfont iconAIshengcheng"></span>
                {{ $t('navigatorToolbar.ai') }}
              </el-dropdown-item>
              <el-dropdown-item command="client">
                <span class="iconfont iconxiazai"></span>
                {{ $t('navigatorToolbar.downloadClient') }}
              </el-dropdown-item>
              <el-dropdown-item command="github">
                <span class="iconfont icongithub"></span>
                Github
              </el-dropdown-item>
              <el-dropdown-item command="site">
                <span class="iconfont iconwangzhan"></span>
                {{ $t('navigatorToolbar.site') }}
              </el-dropdown-item>
              <el-dropdown-item disabled
                >{{ $t('navigatorToolbar.current') }}v{{
                  version
                }}</el-dropdown-item
              >
            </el-dropdown-menu>
          </el-dropdown>
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
      toolbarCollapsed: false
    }
  },
  computed: {
    ...mapState({
      isReadonly: state => state.isReadonly,
      isDark: state => state.localConfig.isDark,
      roomCanEdit: state => state.roomCanEdit
    })
  },
  created() {
    this.lang = getLang()
    this.$bus.$on(
      'set_canvas_toolbars_collapsed',
      this.setCanvasToolbarsCollapsed
    )
  },
  beforeDestroy() {
    this.$bus.$off(
      'set_canvas_toolbars_collapsed',
      this.setCanvasToolbarsCollapsed
    )
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

    toggleMiniMap() {
      this.openMiniMap = !this.openMiniMap
      this.$bus.$emit('toggle_mini_map', this.openMiniMap)
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
      this.setLocalConfig({
        isDark: !this.isDark
      })
    },

    handleCommand(command) {
      if (command === 'shortcutKey') {
        this.setActiveSidebar('shortcutKey')
        return
      } else if (command === 'aiChat') {
        this.setActiveSidebar('ai')
        return
      }
      let url = ''
      switch (command) {
        case 'github':
          url = 'https://github.com/wanglin2/mind-map'
          break
        case 'helpDoc':
          url = 'https://wanglin2.github.io/mind-map-docs/help/help1.html'
          break
        case 'devDoc':
          url =
            'https://wanglin2.github.io/mind-map-docs/start/introduction.html'
          break
        case 'site':
          url = 'https://sxmind.cn/'
          break
        case 'issue':
          url = 'https://github.com/wanglin2/mind-map/issues/new'
          break
        case 'client':
          url = 'https://sxmind.cn/'
          break
        default:
          break
      }
      const a = document.createElement('a')
      a.href = url
      a.target = '_blank'
      a.click()
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
  right: 68px;
  bottom: 20px;
  z-index: 3;
  pointer-events: none;

  > * {
    pointer-events: auto;
  }
}

.navigatorToolbarActions {
  position: absolute;
  left: calc(100% + 12px);
  bottom: -20px;
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
    display: flex;
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

.navigatorContainer {
  padding: 0 12px;
  background: #fff;
  border: 1px solid rgba(0, 0, 0, 0.06);
  border-radius: 6px;
  box-shadow: 0 2px 16px 0 rgba(0, 0, 0, 0.06);
  height: 44px;
  font-size: 12px;
  display: flex;
  align-items: center;
  position: relative;
  z-index: 1;

  .item {
    margin-right: 20px;

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
