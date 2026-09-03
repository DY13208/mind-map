<template>
  <div class="canvasToolbarActions" :class="{ isDark: isDark }">
    <el-tooltip :content="actionLabel" placement="left">
      <button
        type="button"
        class="actionBtn"
        :aria-label="actionLabel"
        :aria-expanded="String(!collapsed)"
        @click.stop="setCollapsed(!collapsed)"
      >
        <span
          class="iconfont iconjiantouyou"
          :class="collapsed ? 'expandIcon' : 'collapseIcon'"
        ></span>
      </button>
    </el-tooltip>
  </div>
</template>

<script>
import { mapState } from 'vuex'

export default {
  props: {
    collapsed: {
      type: Boolean,
      default: false
    }
  },
  computed: {
    ...mapState({
      isDark: state => state.localConfig.isDark
    }),
    actionLabel() {
      return this.collapsed
        ? this.$t('toolbar.expandAllToolbars')
        : this.$t('toolbar.collapseAllToolbars')
    }
  },
  methods: {
    setCollapsed(collapsed) {
      this.$bus.$emit('set_canvas_toolbars_collapsed', collapsed)
    }
  }
}
</script>

<style lang="less" scoped>
.canvasToolbarActions {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px;
  background-color: #fff;
  border: 1px solid rgba(0, 0, 0, 0.06);
  border-radius: 6px;
  box-shadow: 0 2px 16px 0 rgba(0, 0, 0, 0.06);

  &.isDark {
    background-color: #262a2e;
    border-color: hsla(0, 0%, 100%, 0.08);

    .actionBtn {
      color: hsla(0, 0%, 100%, 0.6);

      &:hover {
        background-color: hsla(0, 0%, 100%, 0.08);
        color: #409eff;
      }
    }
  }

  .actionBtn {
    width: 34px;
    height: 34px;
    padding: 0;
    color: #606266;
    background-color: transparent;
    border: 0;
    border-radius: 4px;
    cursor: pointer;
    touch-action: manipulation;
    transition: color 0.2s ease, background-color 0.2s ease;

    &:hover {
      color: #409eff;
      background-color: #ecf5ff;
    }

    &:focus-visible {
      outline: 2px solid #409eff;
      outline-offset: 1px;
    }
  }

  .collapseIcon,
  .expandIcon {
    display: inline-block;
    font-size: 16px;
  }

  .collapseIcon {
    transform: rotateZ(90deg);
  }

  .expandIcon {
    transform: rotateZ(-90deg);
  }
}

@media screen and (max-width: 700px) {
  .canvasToolbarActions {
    position: absolute;
    right: 0;
    bottom: calc(100% + 12px);
    flex-direction: row;

    .actionBtn {
      width: 44px;
      height: 44px;
    }
  }
}

@media (prefers-reduced-motion: reduce) {
  .canvasToolbarActions .actionBtn {
    transition: none;
  }
}
</style>
