<template>
  <div class="mobileEditorMenu" :class="{ isDark, dragging }" :style="positionStyle" @keydown.esc.stop.prevent="close">
    <button v-if="open" type="button" class="editorMenuBackdrop" tabindex="-1" aria-label="收起脑图菜单" @click="close"></button>
    <div v-if="open" ref="panel" :style="panelStyle" class="editorMenuPanel" id="phone-map-menu">
      <div class="editorMenuHeading">脑图菜单</div>
      <nav class="editorMenuItems customScrollbar" aria-label="脑图菜单">
        <button v-for="item in items" :key="item.key" type="button" class="editorMenuItem" :class="{ separated: item.key === 'messages' }" :aria-label="item.label" @click="select(item.key)">
          <i class="editorMenuIcon" :class="item.icon" aria-hidden="true"></i><span>{{ item.label }}</span><i class="el-icon-arrow-right editorMenuArrow" aria-hidden="true"></i>
        </button>
      </nav>
    </div>
    <button ref="trigger" type="button" class="editorMenuTrigger" :aria-label="open ? '关闭脑图菜单' : '打开脑图菜单'" :aria-expanded="String(open)" aria-controls="phone-map-menu" @pointerdown="startDrag" @pointermove="moveDrag" @pointerup="endDrag" @pointercancel="cancelDrag" @lostpointercapture="cancelDrag" @click="toggle"><i :class="open ? 'el-icon-close' : 'el-icon-menu'" aria-hidden="true"></i></button>
  </div>
</template>
<script>
export default {
  props: { isDark: Boolean },
  data: () => ({ open: false, position: null, dragging: false, panelStyle: {} }),
  mounted() {
    window.addEventListener('resize', this.fitViewport)
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', this.fitViewport)
      window.visualViewport.addEventListener('scroll', this.fitViewport)
    }
  },
  beforeDestroy() {
    window.removeEventListener('resize', this.fitViewport)
    if (window.visualViewport) {
      window.visualViewport.removeEventListener('resize', this.fitViewport)
      window.visualViewport.removeEventListener('scroll', this.fitViewport)
    }
  },
  watch: { open(value) { this.$emit('toggle', value); if (value) this.$nextTick(this.placePanel) } },
  computed: {
    positionStyle() { return this.position ? { left: `${this.position.x}px`, top: `${this.position.y}px`, right: 'auto', bottom: 'auto' } : {} },
    items() { return [
      { key: 'file', label: '导航', icon: 'el-icon-folder-opened' },
      { key: 'node', label: '节点', icon: 'el-icon-s-grid' },
      { key: 'canvas', label: '画布', icon: 'el-icon-full-screen' },
      { key: 'appearance', label: '外观', icon: 'el-icon-brush' },
      { key: 'more', label: '工具', icon: 'el-icon-setting' },
      { key: 'messages', label: '消息', icon: 'el-icon-bell' }
    ] }
  },
  methods: {
    viewport() {
      const v = window.visualViewport
      return { left: v ? v.offsetLeft : 0, top: v ? v.offsetTop : 0, width: v ? v.width : window.innerWidth, height: v ? v.height : window.innerHeight }
    },
    clampPosition(x, y) {
      const v = this.viewport(), edge = 12, size = 44
      return { x: Math.max(v.left + edge, Math.min(x, v.left + v.width - size - edge)), y: Math.max(v.top + edge, Math.min(y, v.top + v.height - size - edge)) }
    },
    fitViewport() {
      if (this.position) this.position = this.clampPosition(this.position.x, this.position.y)
      if (this.open) this.$nextTick(this.placePanel)
    },
    startDrag(event) {
      if (!event.isPrimary || (event.button !== undefined && event.button !== 0)) return
      const rect = this.$refs.trigger.getBoundingClientRect()
      this._drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false }
      this._suppressClick = false
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    moveDrag(event) {
      const d = this._drag
      if (!d || event.pointerId !== d.id) return
      const dx = event.clientX - d.x, dy = event.clientY - d.y
      if (!d.moved && Math.hypot(dx, dy) < 6) return
      d.moved = true
      this.dragging = true
      this._suppressClick = true
      this.open = false
      this.position = this.clampPosition(d.left + dx, d.top + dy)
    },
    endDrag(event) {
      if (!this._drag || event.pointerId !== this._drag.id) return
      this._drag = null
      this.dragging = false
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    },
    cancelDrag() { this._drag = null; this.dragging = false },
    toggle(event) {
      if (this._suppressClick && event.detail !== 0) { this._suppressClick = false; return }
      this.open = !this.open
    },
    placePanel() {
      const panel = this.$refs.panel
      if (!panel) return
      const v = this.viewport(), rect = this.$refs.trigger.getBoundingClientRect(), edge = 12, gap = 10
      const contentHeight = panel.querySelector('.editorMenuHeading').offsetHeight + panel.querySelector('.editorMenuItems').scrollHeight + 2
      const height = Math.min(contentHeight, Math.max(44, v.height - 2 * edge - 44 - gap))
      const above = rect.top - v.top - edge, below = v.top + v.height - edge - rect.bottom
      const top = above >= height || above >= below ? Math.max(v.top + edge, rect.top - gap - height) : Math.min(rect.bottom + gap, v.top + v.height - edge - height)
      this.panelStyle = { position: 'fixed', left: `${Math.max(v.left + edge, Math.min(rect.right - panel.offsetWidth, v.left + v.width - edge - panel.offsetWidth))}px`, top: `${top}px`, right: 'auto', bottom: 'auto', maxHeight: `${height}px` }
    },
    close() { this.open = false; this.$nextTick(() => { if (this.$refs.trigger) this.$refs.trigger.focus({ preventScroll: true }) }) },
    select(key) { this.open = false; this.$emit('select', key) }
  }
}
</script>
