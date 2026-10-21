<template>
  <div class="sidebarTriggerRoot" :class="{ touchEditorRail: isTouchEditor }">
  <div
    class="sidebarTriggerContainer "
    @click.stop
    :class="{
      hasActive: show && activeSidebar,
      show: show,
      isDark: isDark,
      rightCollapsed: rightCollapsed
    }"
    :style="{ maxHeight: maxHeight + 'px' }"
  >
    <div class="toggleShowBtn" :class="{ hide: !show }" @click="show = !show">
      <span class="iconfont iconjiantouyou"></span>
    </div>
    <div class="trigger customScrollbar">
      <div class="authSection" v-if="authUser">
        <AccessNotificationTrigger avatar :person="authUser" />
        <div class="authMeta">
          <span class="authName">{{ authUser.name }}</span>
          <button
            class="authLogout"
            @click="signOut"
            :disabled="loggingOut"
            title="退出登录"
          >
            {{ loggingOut ? '退出中…' : '退出' }}
          </button>
        </div>
      </div>
      <div
        class="triggerItem"
        v-for="item in triggerList"
        :key="item.value"
        :data-testid="
          item.value === 'structure'
            ? 'layout'
            : item.value === 'theme'
            ? 'theme'
            : 'sidebar-' + item.value
        "
        :class="{ active: activeSidebar === item.value }"
        :title="item.name"
        role="button"
        tabindex="0"
        :aria-label="item.name"
        :aria-pressed="String(activeSidebar === item.value)"
        @keydown.enter="trigger(item)"
        @keydown.space.prevent="trigger(item)"
        @click="trigger(item)"
      >
        <div class="triggerIcon iconfont" :class="[item.icon]"></div>
        <div class="triggerName">{{ item.name }}</div>
      </div>
      <div class="collapseDivider"></div>
      <div
        class="collapseBtn"
        :title="'\u6536\u8d77\u4fa7\u680f'"
        data-testid="right-sidebar-collapse"
        @click="setRightCollapsed(true)"
      >
        &rsaquo;
      </div>
    </div>
  </div>
  <div
    class="rightExpandTab"
    :class="{ show: rightCollapsed, isDark: isDark }"
    :title="'\u5c55\u5f00\u4fa7\u680f'"
    data-testid="right-sidebar-expand"
    @click.stop="setRightCollapsed(false)"
  >
    <svg class="tabWing top" width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
      <path d="M 8 0 V 8 H 0 A 8 8 0 0 0 8 0 Z" />
    </svg>
    <svg class="tabWing bottom" width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
      <path d="M 8 8 V 0 H 0 A 8 8 0 0 1 8 8 Z" />
    </svg>
    <svg class="tabChevron" width="8" height="12" viewBox="0 0 8 12" aria-hidden="true">
      <path d="M 6 1 L 2 6 L 6 11" />
    </svg>
  </div>
  </div>
</template>

<script>
import { mapState, mapMutations } from 'vuex'
import { sidebarTriggerList } from '@/config'
import { getCurrentUser, logoutAndRedirect } from '@/utils/auth'
import AccessNotificationTrigger from '@/components/AccessNotificationTrigger.vue'
import editorViewport from '@/utils/editorViewport'

const RIGHT_COLLAPSED_KEY = 'mm-right-sidebar-collapsed'
const readRightCollapsed = () => {
  try {
    return window.localStorage.getItem(RIGHT_COLLAPSED_KEY) === '1'
  } catch (e) {
    return false
  }
}

export default {
  mixins: [editorViewport],
  components: { AccessNotificationTrigger },
  data() {
    return {
      show: true,
      maxHeight: 0,
      authUser: null,
      loggingOut: false,
      rightCollapsed: readRightCollapsed()
    }
  },
  computed: {
    ...mapState({
      isDark: state => state.localConfig.isDark,
      activeSidebar: state => state.activeSidebar,
      isReadonly: state => state.isReadonly,
      enableAi: state => state.localConfig.enableAi
    }),

    triggerList() {
      let list = sidebarTriggerList[this.$i18n.locale] || sidebarTriggerList.zh
      if (this.isReadonly) {
        list = list.filter(item => {
          return ['outline', 'shortcutKey', 'ai'].includes(item.value)
        })
      }
      if (!this.enableAi) {
        list = list.filter(item => {
          return item.value !== 'ai'
        })
      }
      return list
    }
  },
  watch: {
    isReadonly(val) {
      if (val) {
        this.setActiveSidebar(null)
      }
    }
  },
  created() {
    this.authUser = getCurrentUser()
    window.addEventListener('resize', this.onResize)
    this.$bus.$on(
      'set_canvas_toolbars_collapsed',
      this.setCanvasToolbarsCollapsed
    )
    this.updateSize()
  },
  beforeDestroy() {
    window.removeEventListener('resize', this.onResize)
    this.$bus.$off(
      'set_canvas_toolbars_collapsed',
      this.setCanvasToolbarsCollapsed
    )
  },
  methods: {
    ...mapMutations(['setActiveSidebar']),

    setRightCollapsed(val) {
      this.rightCollapsed = !!val
      try {
        window.localStorage.setItem(RIGHT_COLLAPSED_KEY, val ? '1' : '0')
      } catch (e) {}
    },

    setCanvasToolbarsCollapsed(collapsed) {
      this.show = !collapsed
    },

    trigger(item) {
      if (this.activeSidebar === item.value) {
        this.setActiveSidebar(null)
        this.$bus.$emit('closeSideBar')
        return
      }
      this.setActiveSidebar(item.value)
    },

    async signOut() {
      if (this.loggingOut) return
      this.loggingOut = true
      await logoutAndRedirect('/')
    },

    onResize() {
      this.updateSize()
    },

    updateSize() {
      const topMargin = 110
      const bottomMargin = 80
      this.maxHeight = window.innerHeight - topMargin - bottomMargin
    }
  }
}
</script>

<style lang="less" scoped>
.sidebarTriggerContainer {
  position: fixed;
  top: 50%;
  right: 16px;
  z-index: 5;
  transform: translateY(-50%);
  transition: right 0.2s ease, transform 0.2s ease;
  display: flex;
  flex-direction: column;
  justify-content: center;

  &:not(.show) {
    transform: translate(140%, -50%);
  }

  &.isDark {
    .trigger {
      background-color: #262a2e;

      .authSection {
        border-bottom-color: hsla(0, 0%, 100%, 0.08);

        .authName {
          color: hsla(0, 0%, 100%, 0.88);
        }

        .authLogout {
          color: hsla(0, 0%, 100%, 0.45);

          &:hover:not(:disabled) {
            color: hsla(0, 0%, 100%, 0.72);
          }
        }
      }

      .triggerItem {
        color: hsla(0, 0%, 100%, 0.6);

        &:hover {
          background-color: hsla(0, 0%, 100%, 0.05);
        }
      }
    }
  }

  &.hasActive {
    right: 332px;
  }

  .toggleShowBtn {
    display: none;
    position: absolute;
    left: -6px;
    width: 35px;
    height: 60px;
    background: #409eff;
    top: 50%;
    transform: translateY(-50%);
    cursor: pointer;
    transition: left 0.1s linear;
    z-index: 0;
    border-top-left-radius: 10px;
    border-bottom-left-radius: 10px;
    align-items: center;
    padding-left: 4px;

    &.hide {
      left: -8px;

      span {
        transform: rotateZ(180deg);
      }
    }

    &:hover {
      left: -18px;
    }

    span {
      color: #fff;
      transition: all 0.1s;
    }
  }

  .trigger {
    position: relative;
    width: 44px;
    border: 1px solid rgba(16, 24, 40, 0.08);
    background-color: #fff;
    box-shadow: 0 8px 24px rgba(16, 24, 40, 0.08);
    border-radius: 12px;
    max-height: 100%;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .authSection {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 10px 4px 8px;
    border-bottom: 1px solid rgba(0, 0, 0, 0.06);
  }

  .authMeta {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
  }

  .authName {
    display: none;
  }

  .authLogout {
    border: 0;
    background: transparent;
    color: #8a9690;
    font-size: 11px;
    line-height: 1.2;
    cursor: pointer;
    padding: 0;

    &:hover:not(:disabled) {
      color: #5f6d67;
    }

    &:disabled {
      cursor: wait;
    }
  }

  .triggerItem {
    height: 40px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    cursor: pointer;
    color: #464646;
    user-select: none;
    white-space: nowrap;

    &:hover {
      background-color: #ededed;
    }

    &.active {
      color: #409eff;
      font-weight: bold;
    }

    .triggerIcon {
      font-size: 18px;
      margin-bottom: 0;
    }

    .triggerName {
      display: none;
    }
  }
}
@import (reference) '../../../style/notch.less';

// ===== 右侧竖向工具栏：外框色悬浮胶囊 =====
.sidebarTriggerContainer.sidebarTriggerContainer {
  right: calc(@mm-frame-width + 8px);

  &.hasActive {
    right: 332px;
  }

  .trigger,
  &.isDark .trigger {
    .mm-notch-capsule();
    width: 46px;
    padding: 6px 5px;
    box-sizing: border-box;
  }

  .authSection,
  &.isDark .trigger .authSection {
    border-bottom-color: var(--mm-notch-sep);
  }

  .triggerItem,
  &.isDark .trigger .triggerItem {
    height: 34px;
    margin: 2px 0;
    border-radius: 10px;
    color: var(--mm-notch-icon);
    font-weight: normal;
    transition: @mm-notch-transition;

    &:hover {
      background-color: var(--mm-notch-hover-bg);
      color: var(--mm-notch-icon-hover);
    }

    .triggerIcon {
      font-size: 18px;
    }

    .mm-notch-glyph();

    .triggerName {
      font-weight: 500;
    }

    // 激活项：药丸 + 显示名称（如「主题」）
    &.active {
      height: auto;
      padding: 6px 0;
      gap: 2px;
      .mm-notch-pill();

      .triggerName {
        display: block;
        font-size: 11px;
        line-height: 1.2;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
      }
    }
  }
}
// ===== Right capsule collapse =====
.sidebarTriggerContainer.sidebarTriggerContainer {
  transition: right 0.2s ease, transform 0.2s ease, opacity 0.2s ease;

  &.rightCollapsed {
    transform: translate(calc(100% + 24px), -50%);
    opacity: 0;
    pointer-events: none;
  }

  .collapseDivider {
    height: 1px;
    margin: 4px 4px;
    background-color: var(--mm-notch-sep);
  }

  .collapseBtn {
    height: 30px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 10px;
    cursor: pointer;
    user-select: none;
    font-size: 20px;
    font-weight: bold;
    line-height: 1;
    color: var(--mm-notch-icon);
    transition: @mm-notch-transition;

    &:hover {
      background-color: var(--mm-notch-hover-bg);
      color: var(--mm-notch-icon-hover);
    }
  }
}

.rightExpandTab {
  position: fixed;
  top: 50%;
  right: @mm-frame-width;
  z-index: 5;
  width: 14px;
  height: 48px;
  margin-top: -24px;
  box-sizing: border-box;
  background-color: #fff;
  border-radius: 8px 0 0 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0;
  transform: translateX(100%);
  pointer-events: none;
  transition: width 0.2s ease, box-shadow 0.2s ease, opacity 0.2s ease,
    transform 0.2s ease;

  &.show {
    opacity: 1;
    transform: none;
    pointer-events: auto;
  }

  &:hover {
    width: 20px;
    box-shadow: -4px 0 12px rgba(16, 24, 40, 0.12);
  }

  .tabWing {
    position: absolute;
    right: 0;
    width: 8px;
    height: 8px;
    pointer-events: none;

    path {
      fill: var(--mm-notch-wing-fill, #fff);
    }

    &.top {
      bottom: 100%;
    }

    &.bottom {
      top: 100%;
    }
  }

  .tabChevron path {
    fill: none;
    stroke: #3f3f46;
    stroke-width: 2px;
    stroke-linecap: round;
    stroke-linejoin: round;
    transition: stroke 0.2s ease;
  }

  &.isDark {
    background-color: #111315;

    .tabChevron path {
      stroke: #d4d4d8;
    }

    &:hover .tabChevron path {
      stroke: #fff;
    }
  }
}
</style>
