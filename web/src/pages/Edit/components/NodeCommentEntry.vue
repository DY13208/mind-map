<template>
  <button
    v-show="visible"
    type="button"
    class="nodeCommentEntry"
    :class="{ isDark: isDark }"
    :style="entryStyle"
    title="添加评论"
    aria-label="添加评论"
    data-testid="node-comment-entry"
    @mouseenter="cancelHide"
    @mouseleave="scheduleHide"
    @mousedown.stop.prevent
    @click.stop="openCard"
  >
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M12 3.5c4.97 0 9 3.36 9 7.5s-4.03 7.5-9 7.5c-1.1 0-2.15-.16-3.12-.46L4 20l1.33-3.6C3.89 15.04 3 13.12 3 11c0-4.14 4.03-7.5 9-7.5Z"/></svg>
    <span class="plus">+</span>
  </button>
</template>

<script>
// 幽灵标签尺寸，与节点右上角评论标签一致
const ENTRY_WIDTH = 38
const ENTRY_LIFT = 10
const HIDE_DELAY = 160
const HIDE_EVENTS = ['scale', 'translate', 'node_dragging', 'svg_mousedown', 'mode_change', 'node_contextmenu', 'node_tree_render_end']

// 悬停在无评论的节点上时，在节点右上角浮出虚线「幽灵标签」作为添加评论入口（覆盖层，不改变节点布局）
export default {
  name: 'NodeCommentEntry',
  data() {
    return {
      visible: false,
      node: null,
      isDark: false,
      left: 0,
      top: 0,
      hideTimer: null
    }
  },
  computed: {
    entryStyle() {
      return { left: this.left + 'px', top: this.top + 'px' }
    }
  },
  created() {
    this.$bus.$on('node_mouseenter', this.onNodeEnter)
    this.$bus.$on('node_mouseleave', this.scheduleHide)
    HIDE_EVENTS.forEach(event => this.$bus.$on(event, this.hide))
  },
  mounted() {
    if (typeof document !== 'undefined' && document.body && this.$el && this.$el.parentNode !== document.body) {
      document.body.appendChild(this.$el)
    }
  },
  beforeDestroy() {
    this.$bus.$off('node_mouseenter', this.onNodeEnter)
    this.$bus.$off('node_mouseleave', this.scheduleHide)
    HIDE_EVENTS.forEach(event => this.$bus.$off(event, this.hide))
    this.cancelHide()
    if (this.$el && this.$el.parentNode) this.$el.parentNode.removeChild(this.$el)
  },
  methods: {
    canComment(node) {
      if (!node || typeof node.getData !== 'function') return false
      if (node.isGeneralization) return false
      const opt = (node.mindMap && node.mindMap.opt) || {}
      if (opt.readonly) return false
      const list = node.getData('comments')
      return !(Array.isArray(list) && list.length)
    },
    onNodeEnter(node) {
      this.cancelHide()
      if (!this.canComment(node)) {
        this.hide()
        return
      }
      const shape = node.shapeNode && node.shapeNode.node
      const el = shape || (node.group && node.group.node)
      const r = el && typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null
      if (!r) return
      this.node = node
      this.isDark =
        typeof document !== 'undefined' && !!document.body && document.body.classList.contains('isDark')
      // 与评论标签同位置：右对齐节点边框，略高出节点顶部
      this.left = r.right - ENTRY_WIDTH
      this.top = r.top - ENTRY_LIFT
      this.visible = true
    },
    scheduleHide() {
      this.cancelHide()
      this.hideTimer = setTimeout(this.hide, HIDE_DELAY)
    },
    cancelHide() {
      if (this.hideTimer) clearTimeout(this.hideTimer)
      this.hideTimer = null
    },
    hide() {
      this.cancelHide()
      this.visible = false
      this.node = null
    },
    openCard() {
      const node = this.node
      this.hide()
      if (node) this.$bus.$emit('showNodeComment', node)
    }
  }
}
</script>

<style lang="less" scoped>
.nodeCommentEntry {
  position: fixed;
  z-index: 1900;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  width: 38px;
  height: 21px;
  padding: 0;
  border: 1px dashed rgba(51, 112, 255, 0.45);
  border-radius: 8px 8px 8px 10px;
  background: rgba(51, 112, 255, 0.05);
  color: rgba(51, 112, 255, 0.7);
  font: 600 12px/1 ui-sans-serif, system-ui, sans-serif;
  cursor: pointer;
  opacity: 0.8;
  transition: opacity 0.15s, background 0.15s;

  .plus {
    font-size: 13px;
    margin-top: -1px;
  }

  &:hover {
    opacity: 1;
    border-style: solid;
    color: #3370ff;
    background: rgba(51, 112, 255, 0.12);
  }

  &.isDark {
    border-color: rgba(105, 177, 255, 0.45);
    background: rgba(105, 177, 255, 0.08);
    color: rgba(105, 177, 255, 0.75);

    &:hover {
      color: #69b1ff;
      background: rgba(105, 177, 255, 0.18);
    }
  }
}
</style>
