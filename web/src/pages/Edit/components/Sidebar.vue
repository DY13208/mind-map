<template>
  <div
    class="sidebarContainer"
    @click.stop
    :class="{ show: show, isDark: isDark }"
    :style="{ zIndex: zIndex }"
  >
    <span class="closeBtn el-icon-close" @click="close"></span>
    <div class="sidebarHeader" v-if="title">
      {{ title }}
    </div>
    <div class="sidebarContent customScrollbar" ref="sidebarContent">
      <slot></slot>
    </div>
  </div>
</template>

<script>
import { store } from '@/config'
import { mapState, mapMutations } from 'vuex'

// 侧边栏容器
export default {
  props: {
    title: {
      type: String,
      default: ''
    }
  },
  data() {
    return {
      show: false,
      zIndex: 0
    }
  },
  computed: {
    ...mapState({
      isDark: state => state.localConfig.isDark
    })
  },
  watch: {
    show(val, oldVal) {
      if (val && !oldVal) {
        this.zIndex = 20 + store.sidebarZIndex++
      }
    }
  },
  created() {
    this.$bus.$on('closeSideBar', this.handleCloseSidebar)
  },
  beforeDestroy() {
    this.$bus.$off('closeSideBar', this.handleCloseSidebar)
  },
  methods: {
    ...mapMutations(['setActiveSidebar']),

    handleCloseSidebar() {
      this.close()
    },

    close() {
      this.show = false
      this.setActiveSidebar(null)
    },

    getEl() {
      return this.$refs.sidebarContent
    }
  }
}
</script>

<style lang="less" scoped>
.sidebarContainer {
  position: fixed;
  right: -340px;
  top: 72px;
  bottom: 72px;
  width: 300px;
  background-color: #fff;
  border: 1px solid rgba(16, 24, 40, 0.08);
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(16, 24, 40, 0.08);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: right 0.2s ease;

  &.isDark {
    background-color: #262a2e;
    border-color: hsla(0, 0%, 100%, 0.1);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);

    .sidebarHeader {
      border-bottom-color: hsla(0, 0%, 100%, 0.1);
      color: #fff;
    }

    .closeBtn {
      color: #fff;
    }
  }

  &.show {
    right: 16px;
  }

  .closeBtn {
    position: absolute;
    right: 20px;
    top: 12px;
    font-size: 20px;
    cursor: pointer;
  }

  .sidebarHeader {
    width: 100%;
    height: 44px;
    border-bottom: 1px solid #e8e8e8;
    display: flex;
    justify-content: center;
    align-items: center;
    flex-grow: 0;
    flex-shrink: 0;
  }

  .sidebarContent {
    width: 100%;
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
}
</style>
