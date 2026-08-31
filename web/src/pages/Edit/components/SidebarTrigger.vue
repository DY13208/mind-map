<template>
  <div
    class="sidebarTriggerContainer "
    @click.stop
    :class="{ hasActive: show && activeSidebar, show: show, isDark: isDark }"
    :style="{ maxHeight: maxHeight + 'px' }"
  >
    <div
      class="authPanel"
      v-if="authUser"
      :class="{ compact: !show, isDark: isDark }"
    >
      <div class="authAvatarWrap" :title="authUser.name">
        <img
          v-if="authUser.avatar"
          class="authAvatarImg"
          :src="authUser.avatar"
          :alt="authUser.name"
        />
        <span v-else class="authAvatar">{{ userInitial }}</span>
      </div>
      <template v-if="show">
        <span class="authName">{{ authUser.name }}</span>
        <button
          class="authLogout"
          @click="signOut"
          :disabled="loggingOut"
          title="退出登录"
        >
          {{ loggingOut ? '…' : '退出' }}
        </button>
      </template>
    </div>
    <div class="toggleShowBtn" :class="{ hide: !show }" @click="show = !show">
      <span class="iconfont iconjiantouyou"></span>
    </div>
    <div class="trigger customScrollbar">
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
    this.updateSize()
  },
  beforeDestroy() {
    window.removeEventListener('resize', this.onResize)
  },
  methods: {
    ...mapMutations(['setActiveSidebar']),

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

      .triggerItem {
        color: hsla(0, 0%, 100%, 0.6);

        &:hover {
          background-color: hsla(0, 0%, 100%, 0.05);
        }
      }
    }

    .authPanel {
      background-color: #262a2e;
      border-color: hsla(0, 0%, 100%, 0.08);
      box-shadow: 0 2px 16px rgba(0, 0, 0, 0.24);

      .authName {
        color: hsla(0, 0%, 100%, 0.88);
      }

      .authLogout {
        color: hsla(0, 0%, 100%, 0.45);
      }
    }
  }

  &.show {
    right: 0;
  }

  &.hasActive {
    right: 305px;
  }

  .authPanel {
    position: absolute;
    top: -72px;
    right: 0;
    width: 60px;
    padding: 8px 6px;
    border: 1px solid rgba(0, 0, 0, 0.06);
    border-radius: 10px;
    background: #fff;
    box-shadow: 0 2px 16px rgba(0, 0, 0, 0.06);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    z-index: 1;
    transition: all 0.3s;

    &.compact {
      top: -48px;
      padding: 6px;
      gap: 0;
    }

    .authAvatarWrap {
      flex: none;
    }

    .authAvatar,
    .authAvatarImg {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      display: block;
    }

    .authAvatar {
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(145deg, #0f9d68, #0a7a52);
      color: #fff;
      font-size: 14px;
      font-weight: 700;
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
      cursor: pointer;
      padding: 0;

      &:disabled {
        cursor: wait;
      }
    }
  }

  &.show .authPanel {
    top: -78px;
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
}
</style>
