<template>
  <div
    v-show="visible"
    class="nodeQuickToolbar"
    :class="{ isDark: isDark }"
    :style="toolbarStyle"
    data-testid="node-quick-toolbar"
    @mousedown.stop.prevent
    @click.stop
  >
    <button v-if="showAi" type="button" class="nqBtn" title="AI 生成" aria-label="AI 生成" data-testid="quick-ai" @click="runAi">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M12 3c.5 3.9 2.6 6 6.5 6.5-3.9.5-6 2.6-6.5 6.5-.5-3.9-2.6-6-6.5-6.5C9.4 9 11.5 6.9 12 3Z"/><path d="M18.5 15c.2 1.6 1 2.4 2.5 2.5-1.5.2-2.3 1-2.5 2.5-.2-1.5-1-2.3-2.5-2.5 1.5-.1 2.3-.9 2.5-2.5Z"/></svg>
    </button>
    <button type="button" class="nqBtn nqComment" title="评论" aria-label="评论" data-testid="quick-comment" @click="openComment">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3.5c4.97 0 9 3.36 9 7.5s-4.03 7.5-9 7.5c-1.1 0-2.15-.16-3.12-.46L4 20l1.33-3.6C3.89 15.04 3 13.12 3 11c0-4.14 4.03-7.5 9-7.5Z"/></svg>
      <span v-if="commentCount" class="nqBadge" data-testid="quick-comment-badge">{{ commentCount > 99 ? '99+' : commentCount }}</span>
    </button>
    <template v-if="!readonly">
      <button type="button" class="nqBtn" title="图片" aria-label="图片" data-testid="quick-image" @click="emitTool('showNodeImage')">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m4 18 5.5-5 4 3.5L17 13l4 4"/></svg>
      </button>
      <button type="button" class="nqBtn" title="超链接" aria-label="超链接" data-testid="quick-link" @click="emitTool('showNodeLink')">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/></svg>
      </button>
    </template>
    <button type="button" class="nqBtn" title="更多" aria-label="更多" data-testid="quick-more" @click="openMore">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>
    </button>
    <span class="nqArrow"></span>
  </div>
</template>

<script>
const GAP = 12
const HIDE_EVENTS = ['node_dragging', 'mode_change', 'node_contextmenu', 'svg_mousedown', 'showNodeComment', 'node_commentClick']
const REPOSITION_EVENTS = ['scale', 'translate', 'node_tree_render_end']

// 选中单个节点时浮在节点上方的快捷工具条：AI / 评论(带数量) / 图片 / 超链接 / 更多
export default {
  name: 'NodeQuickToolbar',
  data() {
    return {
      visible: false,
      node: null,
      isDark: false,
      readonly: false,
      left: 0,
      top: 0,
      commentCount: 0
    }
  },
  computed: {
    toolbarStyle() {
      return { left: this.left + 'px', top: this.top + 'px' }
    },
    showAi() {
      const state = this.$store && this.$store.state
      return !this.readonly && !!(state && state.localConfig && state.localConfig.enableAi)
    }
  },
  created() {
    this.$bus.$on('node_active', this.onNodeActive)
    HIDE_EVENTS.forEach(event => this.$bus.$on(event, this.hide))
    REPOSITION_EVENTS.forEach(event => this.$bus.$on(event, this.refresh))
  },
  mounted() {
    if (typeof document !== 'undefined' && document.body && this.$el && this.$el.parentNode !== document.body) {
      document.body.appendChild(this.$el)
    }
  },
  beforeDestroy() {
    this.$bus.$off('node_active', this.onNodeActive)
    HIDE_EVENTS.forEach(event => this.$bus.$off(event, this.hide))
    REPOSITION_EVENTS.forEach(event => this.$bus.$off(event, this.refresh))
    if (this.$el && this.$el.parentNode) this.$el.parentNode.removeChild(this.$el)
  },
  methods: {
    onNodeActive(node, activeNodeList) {
      const list = Array.isArray(activeNodeList) ? activeNodeList : []
      if (!node || list.length !== 1 || list[0] !== node || node.isGeneralization) {
        this.hide()
        return
      }
      this.node = node
      this.visible = true
      this.refresh()
    },
    refresh() {
      if (!this.visible || !this.node) return
      const node = this.node
      const renderer = node.mindMap && node.mindMap.renderer
      const uid = typeof node.getData === 'function' ? node.getData('uid') : ''
      if (renderer && typeof renderer.findNodeByUid === 'function' && uid) {
        const live = renderer.findNodeByUid(uid)
        if (!live) return this.hide()
        this.node = live
      }
      const opt = (this.node.mindMap && this.node.mindMap.opt) || {}
      this.readonly = !!opt.readonly
      this.isDark =
        typeof document !== 'undefined' && !!document.body && document.body.classList.contains('isDark')
      const list = this.node.getData('comments')
      this.commentCount = Array.isArray(list) ? list.length : 0
      const el = this.node.group && this.node.group.node
      const r = el && typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null
      if (!r) return
      // 水平居中、位于节点上方（CSS 里 translate(-50%, -100%)）
      this.left = (r.left + r.right) / 2
      this.top = Math.max(52, r.top - GAP)
    },
    hide() {
      this.visible = false
      this.node = null
    },
    openComment() {
      const node = this.node
      if (!node) return
      this.hide()
      this.$bus.$emit('showNodeComment', node)
    },
    emitTool(event) {
      if (this.readonly || !this.node) return
      this.hide()
      this.$bus.$emit(event)
    },
    runAi() {
      const node = this.node
      if (!node || !this.showAi) return
      this.hide()
      this.$bus.$emit('ai_create_part', node)
    },
    // 「更多」复用节点右键菜单
    openMore(e) {
      const node = this.node
      if (!node) return
      const target = e && e.currentTarget
      const r = target && typeof target.getBoundingClientRect === 'function'
        ? target.getBoundingClientRect()
        : { left: this.left, bottom: this.top }
      this.hide()
      this.$bus.$emit('node_contextmenu', { clientX: r.left, clientY: r.bottom, preventDefault() {}, stopPropagation() {} }, node)
    }
  }
}
</script>

<style lang="less" scoped>
.nodeQuickToolbar {
  position: fixed;
  z-index: 1950;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 8px;
  border: 1px solid #eaecf0;
  border-radius: 12px;
  background: #fff;
  box-shadow: 0 6px 20px rgba(16, 24, 40, 0.12);
  color: #646a73;
  transform: translate(-50%, -100%);

  .nqBtn {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: inherit;
    cursor: pointer;

    &:hover {
      background: rgba(31, 35, 41, 0.07);
      color: #1f2329;
    }

    &.nqComment {
      color: #3370ff;
    }
  }

  .nqBadge {
    position: absolute;
    top: -2px;
    right: -3px;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    box-sizing: border-box;
    border-radius: 8px;
    background: #3370ff;
    color: #fff;
    font-size: 10px;
    line-height: 16px;
    text-align: center;
    box-shadow: 0 0 0 2px #fff;
  }

  .nqArrow {
    position: absolute;
    left: 50%;
    bottom: -6px;
    width: 10px;
    height: 10px;
    margin-left: -5px;
    background: inherit;
    border-right: 1px solid #eaecf0;
    border-bottom: 1px solid #eaecf0;
    transform: rotate(45deg);
  }

  &.isDark {
    border-color: #3a3f45;
    background: #2b2f33;
    color: rgba(255, 255, 255, 0.7);
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);

    .nqBtn:hover {
      background: rgba(255, 255, 255, 0.08);
      color: #fff;
    }

    .nqBtn.nqComment {
      color: #69b1ff;
    }

    .nqBadge {
      background: #4096ff;
      box-shadow: 0 0 0 2px #2b2f33;
    }

    .nqArrow {
      border-color: #3a3f45;
    }
  }
}
</style>
