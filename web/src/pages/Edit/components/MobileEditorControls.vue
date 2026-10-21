<template>
  <div v-if="isMobileViewport && mindMap" class="mobileEditorControls">
    <div class="mobileCanvasControls" aria-label="画布控制">
      <button aria-label="放大" @click="mindMap.view.enlarge()"><i class="el-icon-plus" /></button>
      <button aria-label="缩小" @click="mindMap.view.narrow()"><i class="el-icon-minus" /></button>
      <button aria-label="适应画布" @click="mindMap.view.fit()"><i class="el-icon-full-screen" /></button>
      <button aria-label="定位中心" @click="mindMap.renderer.setRootNodeCenter()"><i class="el-icon-aim" /></button>
    </div>
    <nav class="mobileEditorDock" aria-label="编辑工具">
      <button :disabled="readonly" @click="panel('theme')"><i class="el-icon-picture-outline" />主题</button>
      <button :disabled="readonly" @click="panel('nodeStyle')"><i class="el-icon-brush" />样式</button>
      <button :disabled="readonly" class="mobilePrimary" aria-label="新增节点" @click="sheet = 'node'"><i class="el-icon-plus" /></button>
      <button :disabled="readonly" @click="panel('structure')"><i class="el-icon-connection" />布局</button>
      <button @click="sheet = 'more'"><i class="el-icon-more" />更多</button>
    </nav>
    <el-drawer :visible="!!sheet" direction="btt" size="auto" :with-header="false" append-to-body custom-class="mobileActionSheet" @close="sheet = ''">
      <header><strong>{{ sheet === 'node' ? '节点操作' : '更多工具' }}</strong><button aria-label="关闭" @click="sheet = ''"><i class="el-icon-close" /></button></header>
      <p v-if="sheet === 'node' && !activeNodes.length">请先点击选择一个节点</p>
      <div class="mobileActionGrid">
        <template v-if="sheet === 'node'">
          <button :disabled="!canEdit" @click="command('INSERT_CHILD_NODE')">新增子节点</button>
          <button :disabled="!canEdit || activeNodes.some(n => n.isRoot)" @click="command('INSERT_NODE')">新增同级节点</button>
          <button :disabled="!canEdit" @click="editText">编辑文字</button>
          <button :disabled="!activeNodes.length" @click="nodeEvent('showNodeComment')">节点评论</button>
          <button :disabled="!canEdit" @click="nodeEvent('selectAttachment', true)">附件</button>
          <button :disabled="!canEdit" @click="nodeEvent('showNodeLink')">超链接</button>
          <button :disabled="!activeNodes.length" @click="context">全部节点操作</button>
          <button :disabled="!canEdit || activeNodes.some(n => n.isRoot)" @click="remove">删除节点</button>
        </template>
        <template v-else>
          <button @click="nodeMenu">节点操作</button>
          <button @click="panel('outline')">大纲</button>
          <button @click="emit('show_search')">搜索节点</button>
          <button @click="emit('showShareAcl')">分享与权限</button>
          <button v-for="item in extraPanels" :key="item.value" @click="panel(item.value)">{{ item.name }}</button>
          <button @click="emit('showExport')">导出</button>
        </template>
      </div>
    </el-drawer>
  </div>
</template>
<script>
import mobileViewport from '@/utils/mobileViewport'
import { sidebarTriggerList } from '@/config'
export default {
  mixins: [mobileViewport],
  props: { mindMap: Object },
  data: () => ({ sheet: '', activeNodes: [] }),
  computed: {
    readonly() { return this.$store.state.isReadonly },
    canEdit() { return !this.readonly && this.activeNodes.length > 0 },
    extraPanels() { return (sidebarTriggerList[this.$i18n.locale] || sidebarTriggerList.zh).filter(i => !['theme', 'nodeStyle', 'structure', 'outline'].includes(i.value) && (!this.readonly || ['shortcutKey', 'ai'].includes(i.value))) }
  },
  watch: {
    isMobileViewport(value) {
      if (value) {
        this._desktopDrag = this.mindMap.opt.useLeftKeySelectionRightKeyDrag
        this.mindMap.opt.useLeftKeySelectionRightKeyDrag = false
      } else if (this._desktopDrag !== undefined) {
        this.mindMap.opt.useLeftKeySelectionRightKeyDrag = this._desktopDrag
        this._desktopDrag = undefined
        this.sheet = ''
      }
      this.$nextTick(() => this.mindMap.resize())
    }
  },
  mounted() {
    this.mindMap.on('node_active', this.active)
    this.mindMap.on('node_mousedown', this.nodeDown)
    this.mindMap.on('before_show_text_edit', this.beforeEdit)
    this.mindMap.on('hide_text_edit', this.afterEdit)
    if (window.visualViewport) window.visualViewport.addEventListener('resize', this.keyboardResize)
    this._canvas = this.mindMap.el
    this._canvas.addEventListener('pointerdown', this.pointerDown)
    this._canvas.addEventListener('pointermove', this.pointerMove)
    this._canvas.addEventListener('pointerup', this.cancelHold)
    this._canvas.addEventListener('pointercancel', this.cancelHold)
  },
  beforeDestroy() {
    this.cancelHold()
    this.mindMap.off('node_active', this.active)
    this.mindMap.off('node_mousedown', this.nodeDown)
    this.mindMap.off('before_show_text_edit', this.beforeEdit)
    this.mindMap.off('hide_text_edit', this.afterEdit)
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', this.keyboardResize)
    if (this._desktopDrag !== undefined) this.mindMap.opt.useLeftKeySelectionRightKeyDrag = this._desktopDrag
    document.body.classList.remove('mobileNodeEditing')
    this._canvas.removeEventListener('pointerdown', this.pointerDown)
    this._canvas.removeEventListener('pointermove', this.pointerMove)
    this._canvas.removeEventListener('pointerup', this.cancelHold)
    this._canvas.removeEventListener('pointercancel', this.cancelHold)
  },
  methods: {
    nodeDown(node) { if (this._point) this._heldNode = node },
    beforeEdit() { if (this.isMobileViewport) document.body.classList.add('mobileNodeEditing') },
    afterEdit() { document.body.classList.remove('mobileNodeEditing') },
    keyboardResize() {
      if (!this.isMobileViewport || !document.body.classList.contains('mobileNodeEditing')) return
      const input = document.activeElement
      if (input && input.isContentEditable) input.scrollIntoView({ block: 'center', inline: 'nearest' })
    },
    active(node, list) { this.activeNodes = list || [] },
    panel(value) { this.sheet = ''; this.$store.commit('setActiveSidebar', value) },
    emit(name) { this.sheet = ''; this.$bus.$emit(name) },
    nodeMenu() { this.sheet = 'node' },
    nodeEvent(name, list) { this.sheet = ''; this.$bus.$emit(name, list ? this.activeNodes : this.activeNodes[0]) },
    command(name) { if (!this.canEdit) return; this.sheet = ''; this.mindMap.execCommand(name) },
    editText() { if (!this.canEdit) return; this.sheet = ''; this.$nextTick(() => this.mindMap.renderer.textEdit.show({ node: this.activeNodes[0] })) },
    async remove() { try { await this.$confirm('删除所选节点及其子节点？', '删除节点'); this.command('REMOVE_NODE') } catch (e) { /* cancelled */ } },
    context() { this.sheet = ''; this.$bus.$emit('node_contextmenu', { clientX: 12, clientY: 100 }, this.activeNodes[0]) },
    pointerDown(e) {
      this.cancelHold()
      if (!this.isMobileViewport || e.pointerType !== 'touch' || !e.isPrimary) return
      if (!e.target.closest('.smm-node')) return
      this._point = { x: e.clientX, y: e.clientY }
      this._hold = setTimeout(() => {
        if (this._heldNode) this._heldNode.active()
        if (this.activeNodes.length) this.sheet = 'node'
      }, 550)
    },
    pointerMove(e) { if (this._point && Math.hypot(e.clientX - this._point.x, e.clientY - this._point.y) > 8) this.cancelHold() },
    cancelHold() { clearTimeout(this._hold); this._point = null; this._heldNode = null }
  }
}
</script>
