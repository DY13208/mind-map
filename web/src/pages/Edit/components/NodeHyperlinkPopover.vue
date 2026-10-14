<template>
  <div
    v-show="visible"
    class="nodeHyperlinkPopover"
    :class="{ isDark: isDark, placeBelow: placeBelow }"
    :style="popoverStyle"
    role="toolbar"
    @mousedown.stop
    @click.stop
  >
    <button type="button" class="hlTextBtn" @click="openLink">打开链接</button>
    <span class="hlDivider"></span>
    <el-tooltip content="复制链接" placement="top" :open-delay="300">
      <button type="button" class="hlIconBtn" aria-label="复制链接" @click="copyLink">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      </button>
    </el-tooltip>
    <template v-if="!readonly">
      <el-tooltip content="编辑" placement="top" :open-delay="300">
        <button type="button" class="hlIconBtn" aria-label="编辑链接" @click="editLink">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
        </button>
      </el-tooltip>
      <span class="hlDivider"></span>
      <el-tooltip content="删除" placement="top" :open-delay="300">
        <button type="button" class="hlIconBtn" aria-label="删除链接" @click="removeLink">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
        </button>
      </el-tooltip>
    </template>
  </div>
</template>

<script>
const POPOVER_GAP = 6
const POPOVER_MAX_WIDTH = 220
// 这些画布事件发生时（缩放、平移、拖动、模式切换）关闭操作条
const CLOSE_EVENTS = ['scale', 'translate', 'svg_mousedown', 'node_dragging', 'mode_change', 'node_contextmenu']

// 节点超链接操作条：打开 / 复制 / 编辑 / 删除
export default {
  name: 'NodeHyperlinkPopover',
  data() {
    return {
      visible: false,
      node: null,
      url: '',
      title: '',
      readonly: false,
      isDark: false,
      placeBelow: false,
      left: 0,
      top: 0
    }
  },
  computed: {
    popoverStyle() {
      return { left: this.left + 'px', top: this.top + 'px' }
    }
  },
  created() {
    this.$bus.$on('node_hyperlinkClick', this.onHyperlinkClick)
    this.$bus.$on('node_tree_render_end', this.checkNodeAlive)
    CLOSE_EVENTS.forEach(event => this.$bus.$on(event, this.close))
  },
  mounted() {
    // 挂到 body 上，避免被画布容器的 transform/overflow 影响定位
    if (typeof document !== 'undefined' && document.body && this.$el && this.$el.parentNode !== document.body) {
      document.body.appendChild(this.$el)
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('mousedown', this.onDocumentMousedown, true)
      document.addEventListener('keydown', this.onKeydown)
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', this.close)
      window.addEventListener('scroll', this.close, true)
    }
  },
  beforeDestroy() {
    this.$bus.$off('node_hyperlinkClick', this.onHyperlinkClick)
    this.$bus.$off('node_tree_render_end', this.checkNodeAlive)
    CLOSE_EVENTS.forEach(event => this.$bus.$off(event, this.close))
    if (typeof document !== 'undefined') {
      document.removeEventListener('mousedown', this.onDocumentMousedown, true)
      document.removeEventListener('keydown', this.onKeydown)
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', this.close)
      window.removeEventListener('scroll', this.close, true)
    }
    if (this.$el && this.$el.parentNode) this.$el.parentNode.removeChild(this.$el)
  },
  methods: {
    onHyperlinkClick(node, event, rect) {
      const url = node && typeof node.getData === 'function' ? node.getData('hyperlink') : ''
      if (!url) return
      const mindMap = node.mindMap
      this.node = node
      this.url = url
      this.title = node.getData('hyperlinkTitle') || ''
      this.readonly = !!(mindMap && mindMap.opt && mindMap.opt.readonly)
      this.isDark =
        typeof document !== 'undefined' && !!document.body && document.body.classList.contains('isDark')
      const target = event && event.currentTarget
      const r = rect ||
        (target && typeof target.getBoundingClientRect === 'function' ? target.getBoundingClientRect() : null) ||
        { left: 0, top: 0, right: 0, bottom: 0 }
      const viewportWidth = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : Infinity
      // 位于图标右上方；顶部空间不足时放到图标下方
      this.left = Math.max(8, Math.min(r.left, viewportWidth - POPOVER_MAX_WIDTH - 8))
      this.placeBelow = r.top < 48
      this.top = this.placeBelow ? r.bottom + POPOVER_GAP : r.top - POPOVER_GAP
      this.visible = true
    },
    close() {
      if (!this.visible && !this.node) return
      this.visible = false
      this.node = null
    },
    onDocumentMousedown(e) {
      if (!this.visible) return
      if (this.$el && e && e.target && typeof this.$el.contains === 'function' && this.$el.contains(e.target)) return
      this.close()
    },
    onKeydown(e) {
      if (this.visible && e && (e.key === 'Escape' || e.keyCode === 27)) this.close()
    },
    // 节点被删除或链接被移除后关闭
    checkNodeAlive() {
      if (!this.visible || !this.node) return
      const node = this.node
      const renderer = node.mindMap && node.mindMap.renderer
      const uid = node.getData('uid')
      const alive = renderer && typeof renderer.findNodeByUid === 'function' && uid
        ? !!renderer.findNodeByUid(uid)
        : true
      if (!alive || !node.getData('hyperlink')) this.close()
    },
    openLink() {
      const node = this.node
      const url = this.url
      const opt = (node && node.mindMap && node.mindMap.opt) || {}
      this.close()
      if (!url) return
      if (typeof opt.customHyperlinkJump === 'function') {
        opt.customHyperlinkJump(url, node)
      } else if (typeof window !== 'undefined') {
        window.open(url, '_blank', 'noopener,noreferrer')
      }
    },
    async copyLink() {
      const url = this.url
      this.close()
      if (!url) return
      try {
        await navigator.clipboard.writeText(url)
        this.$message.success('已复制')
      } catch (e) {
        if (this.copyByTextarea(url)) this.$message.success('已复制')
        else this.$message.warning('复制失败，请手动复制链接')
      }
    },
    copyByTextarea(text) {
      if (typeof document === 'undefined' || !document.body) return false
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.setAttribute('readonly', '')
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      let ok = false
      try {
        ok = document.execCommand('copy')
      } catch (e) {
        ok = false
      }
      document.body.removeChild(textarea)
      return ok
    },
    editLink() {
      if (this.readonly || !this.node) return
      const node = this.node
      this.close()
      this.$bus.$emit('showNodeLink', node)
    },
    removeLink() {
      if (this.readonly || !this.node) return
      const node = this.node
      this.close()
      // 走命令，支持撤销与协同同步
      node.mindMap.execCommand('SET_NODE_HYPERLINK', node, '', '')
    }
  }
}
</script>

<style lang="less" scoped>
.nodeHyperlinkPopover {
  position: fixed;
  z-index: 2100;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px 6px;
  background: #fff;
  border: 1px solid #e4e7ec;
  border-radius: 6px;
  box-shadow: 0 4px 14px rgba(16, 24, 40, 0.12);
  transform: translateY(-100%);
  color: #344054;
  font-size: 12px;
  user-select: none;

  &.placeBelow {
    transform: none;
  }

  .hlTextBtn,
  .hlIconBtn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 26px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: inherit;
    cursor: pointer;

    &:hover {
      background: rgba(16, 24, 40, 0.06);
    }
  }

  .hlTextBtn {
    padding: 0 8px;
    font-size: 12px;
  }

  .hlIconBtn {
    width: 26px;
    padding: 0;
  }

  .hlDivider {
    width: 1px;
    height: 14px;
    margin: 0 4px;
    background: #e4e7ec;
  }

  &.isDark {
    background: #2b2f33;
    border-color: #3a3f45;
    color: rgba(255, 255, 255, 0.86);
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);

    .hlTextBtn:hover,
    .hlIconBtn:hover {
      background: rgba(255, 255, 255, 0.08);
    }

    .hlDivider {
      background: #3a3f45;
    }
  }
}
</style>
