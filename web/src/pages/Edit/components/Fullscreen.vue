<template>
  <div class="fullscreenContainer" :class="{ isDark: isDark }">
    <el-tooltip
      effect="dark"
      :content="fullscreenLabel"
      placement="top"
      append-to-body
    >
      <div
        class="btn iconfont"
        :class="active ? 'iconquanping1' : 'iconquanping'"
        role="button"
        tabindex="0"
        :aria-pressed="String(active)"
        :aria-label="fullscreenLabel"
        @click="toggleFullscreen"
        @keydown.enter.prevent="toggleFullscreen"
        @keydown.space.prevent="toggleFullscreen"
      ></div>
    </el-tooltip>
  </div>
</template>

<script>
import { fullScreen } from '@/utils'

function fullscreenElement() {
  return (
    document.fullscreenElement ||
    document.webkitFullscreenElement ||
    document.mozFullScreenElement ||
    document.msFullscreenElement ||
    null
  )
}

function exitFullscreen() {
  const exit =
    document.exitFullscreen ||
    document.webkitExitFullscreen ||
    document.mozCancelFullScreen ||
    document.msExitFullscreen
  if (exit) return exit.call(document)
}

export default {
  props: {
    mindMap: {
      type: Object
    },
    isDark: {
      type: Boolean
    }
  },
  data() {
    return {
      active: false
    }
  },
  computed: {
    fullscreenLabel() {
      return this.active
        ? this.$t('fullscreen.exitFullscreen')
        : this.$t('fullscreen.fullscreen')
    }
  },
  created() {
    this.onFullscreenChange = () => {
      this.active = !!fullscreenElement()
      setTimeout(() => {
        if (this.mindMap) this.mindMap.resize()
      }, 300)
    }
    document.addEventListener('fullscreenchange', this.onFullscreenChange)
    document.addEventListener('webkitfullscreenchange', this.onFullscreenChange)
    this.active = !!fullscreenElement()
  },
  beforeDestroy() {
    document.removeEventListener('fullscreenchange', this.onFullscreenChange)
    document.removeEventListener('webkitfullscreenchange', this.onFullscreenChange)
  },
  methods: {
    toggleFullscreen() {
      if (fullscreenElement()) {
        exitFullscreen()
        return
      }
      fullScreen(document.body)
    }
  }
}
</script>

<style lang="less" scoped>
.fullscreenContainer {
  display: flex;
  align-items: center;

  &.isDark {
    .btn {
      color: hsla(0, 0%, 100%, 0.6);
    }
  }

  .btn {
    cursor: pointer;
    font-size: 18px;
  }
}
</style>
