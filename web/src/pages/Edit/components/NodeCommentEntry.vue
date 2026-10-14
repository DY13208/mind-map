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
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"><path d="M11 3.6C6.6 3.9 3 7 3 11c0 2.1.9 4 2.3 5.4L4 20l4.9-1.5c1 .3 2 .5 3.1.5 4.6 0 8.4-2.9 8.9-6.7"/><path d="M18 2.5v6M15 5.5h6"/></svg>
  </button>
</template>

<script>
const ENTRY_SIZE = 24
const HIDE_DELAY = 160
const HIDE_EVENTS = ['scale', 'translate', 'node_dragging', 'svg_mousedown', 'mode_change', 'node_contextmenu', 'node_tree_render_end']

// 悬停在无评论的节点上时，在节点右上角浮出「添加评论」入口（覆盖层，不改变节点布局）
export default {
  name: 'NodeCommentEntry',
  data() {
    return {
      visible: false,
      node: null,
      isDark: false,
      left: 0,
      top: 0,
      hideTimer: null,
      editing: false
    }
  },
  computed: {
    entryStyle() {
      return { left: this.left + 'px', top: this.top + 'px' }
    }
  },
  created() {
    this.$bus.$on('node_mouseenter', this.onNodeEnter)
    this.$bus.$on('before_show_text_edit', this.onTextEditStart)
    this.$bus.$on('hide_text_edit', this.onTextEditEnd)
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
    this.$bus.$off('before_show_text_edit', this.onTextEditStart)
    this.$bus.$off('hide_text_edit', this.onTextEditEnd)
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
      // ???????????????
      return !(Array.isArray(list) && list.some(c => c && !c.deleted))
    },
    // 编辑节点文本时不显示添加评论入口
    onTextEditStart() {
      this.editing = true
      this.hide()
    },
    onTextEditEnd() {
      this.editing = false
    },
    isTextEditing(node) {
      if (this.editing) return true
      const textEdit = node && node.mindMap && node.mindMap.renderer && node.mindMap.renderer.textEdit
      try {
        return !!(textEdit && typeof textEdit.isShowTextEdit === 'function' && textEdit.isShowTextEdit())
      } catch (e) {
        return false
      }
    },
    onNodeEnter(node) {
      this.cancelHide()
      if (this.isTextEditing(node)) {
        this.hide()
        return
      }
      if (!this.canComment(node)) {
        this.hide()
        return
      }
      const el = node.group && node.group.node
      const r = el && typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null
      if (!r) return
      this.node = node
      this.isDark =
        typeof document !== 'undefined' && !!document.body && document.body.classList.contains('isDark')
      // 骑在节点右上角（一半在框外），不遮挡文字、不改变布局
      this.left = r.right - ENTRY_SIZE / 2 - 2
      this.top = r.top - ENTRY_SIZE / 2 + 2
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
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid #e4e7ec;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 2px 6px rgba(16, 24, 40, 0.1);
  color: #8f959e;
  cursor: pointer;
  opacity: 0.85;

  &:hover {
    opacity: 1;
    color: #3370ff;
    background: rgba(51, 112, 255, 0.1);
  }

  &.isDark {
    border-color: #3a3f45;
    background: #2b2f33;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);
    color: rgba(255, 255, 255, 0.5);

    &:hover {
      color: #69b1ff;
      background: rgba(64, 150, 255, 0.18);
    }
  }
}
</style>
