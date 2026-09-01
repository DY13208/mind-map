<template>
  <div
    class="sidebarTriggerContainer "
    @click.stop
    :class="{ hasActive: show && activeSidebar, show: show, isDark: isDark }"
    :style="{ maxHeight: maxHeight + 'px' }"
  >
    <div class="toggleShowBtn" :class="{ hide: !show }" @click="show = !show">
      <span class="iconfont iconjiantouyou"></span>
    </div>
    <div class="trigger customScrollbar">
      <div class="authSection" v-if="authUser">
        <div class="authAvatarWrap" :title="authUser.name">
          <img
            v-if="authUser.avatar"
            class="authAvatarImg"
            :src="authUser.avatar"
            :alt="authUser.name"
          />
          <span v-else class="authAvatar">{{ userInitial }}</span>
        </div>
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
        :class="{ active: activeSidebar === item.value }"
        @click="trigger(item)"
      >
        <div class="triggerIcon iconfont" :class="[item.icon]"></div>
        <div class="triggerName">{{ item.name }}</div>
      </div>
    </div>
  </div>
</template>

<script>
import { mapState, mapMutations } from 'vuex'
import { sidebarTriggerList } from '@/config'
import { getCurrentUser, logout } from '@/utils/auth'

export default {
  data() {
    return {
      show: true,
      maxHeight: 0,
      authUser: null,
      loggingOut: false
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
    },

    userInitial() {
      const name = (this.authUser && this.authUser.name) || '依'
      return name.trim().slice(0, 1)
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

    setCanvasToolbarsCollapsed(collapsed) {
      this.show = !collapsed
    },

    trigger(item) {
      this.setActiveSidebar(item.value)
    },

    async signOut() {
      if (this.loggingOut) return
      this.loggingOut = true
      try {
        await logout()
        window.location.reload()
      } catch (err) {
        this.$message.error(err.message || '退出登录失败')
        this.loggingOut = false
      }
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
  top: 110px;
  bottom: 80px;
  right: -60px;
  transition: all 0.3s;
  display: flex;
  flex-direction: column;
  justify-content: center;

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

  &.show {
    right: 0;
  }

  &.hasActive {
    right: 305px;
  }

  .toggleShowBtn {
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
    display: flex;
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
    width: 60px;
    border-color: #eee;
    background-color: #fff;
    box-shadow: 0 2px 16px 0 rgba(0, 0, 0, 0.06);
    border-radius: 6px;
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

  .authAvatar,
  .authAvatarImg {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    display: block;
  }

  .authAvatar {
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(145deg, #0f9d68, #0a7a52);
    color: #fff;
    font-size: 13px;
    font-weight: 700;
  }

  .authMeta {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
  }

  .authName {
    width: 100%;
    overflow: hidden;
    color: #34463d;
    font-size: 11px;
    line-height: 1.3;
    text-align: center;
    text-overflow: ellipsis;
    white-space: nowrap;
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
    height: 60px;
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
      margin-bottom: 5px;
    }

    .triggerName {
      font-size: 13px;
    }
  }
}
</style>
