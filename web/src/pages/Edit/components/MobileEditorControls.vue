<template>
  <div v-if="isTouchEditor && mindMap" class="mobileEditorControls">
    <MobileEditorMenu v-if="isPhoneReader" :is-dark="isDark" @select="menuAction" @toggle="onMenuToggle" />
    <div v-else class="mobileCanvasControls" aria-label="画布控制">
      <button aria-label="放大" @click="mindMap.view.enlarge()"><i class="el-icon-plus" /></button>
      <button aria-label="缩小" @click="mindMap.view.narrow()"><i class="el-icon-minus" /></button>
      <button aria-label="适应画布" @click="mindMap.view.fit()"><i class="el-icon-full-screen" /></button>
      <button aria-label="定位中心" @click="mindMap.renderer.setRootNodeCenter()"><i class="el-icon-aim" /></button>
    </div>
    <el-drawer :visible="!!sheet" direction="ltr" size="320px" :with-header="false" :modal="false" :lock-scroll="false" append-to-body class="touchEditorDrawer" :custom-class="isDark ? 'touchEditorActionSidebar isDark' : 'touchEditorActionSidebar'" @close="sheet = ''">
      <header><strong>{{ sheetTitle }}</strong><button aria-label="关闭" @click="sheet = ''"><i class="el-icon-close" /></button></header>
      <p v-if="sheet === 'node' && !activeNodes.length">请先点击选择一个节点</p>
      <div class="mobileActionGrid">
        <template v-if="sheet === 'node'">
          <button :disabled="!canEdit" @click="command('INSERT_CHILD_NODE')"><i aria-hidden="true" class="el-icon-plus" />新增子节点</button>
          <button :disabled="!canEdit || activeNodes.some(n => n.isRoot)" @click="command('INSERT_NODE')"><i aria-hidden="true" class="el-icon-circle-plus-outline" />新增同级节点</button>
          <button :disabled="!canEdit" @click="editText"><i aria-hidden="true" class="el-icon-edit" />编辑文字</button>
          <button :disabled="!activeNodes.length" @click="nodeEvent('showNodeComment')"><i aria-hidden="true" class="el-icon-chat-dot-round" />节点评论</button>
          <button :disabled="!canEdit" @click="nodeEvent('selectAttachment', true)"><i aria-hidden="true" class="el-icon-paperclip" />附件</button>
          <button :disabled="!canEdit" @click="nodeEvent('showNodeLink')"><i aria-hidden="true" class="el-icon-link" />超链接</button>
          <button :disabled="!activeNodes.length" @click="context"><i aria-hidden="true" class="el-icon-more" />全部节点操作</button>
          <button :disabled="!canEdit || activeNodes.some(n => n.isRoot)" @click="remove"><i aria-hidden="true" class="el-icon-delete" />删除节点</button>
        </template>
        <template v-else-if="sheet === 'canvas'">
          <button @click="canvasAction('enlarge')"><i aria-hidden="true" class="el-icon-zoom-in" />放大</button><button @click="canvasAction('narrow')"><i aria-hidden="true" class="el-icon-zoom-out" />缩小</button>
          <button @click="canvasAction('fit')"><i aria-hidden="true" class="el-icon-full-screen" />适应画布</button><button @click="canvasAction('center')"><i aria-hidden="true" class="el-icon-aim" />定位中心</button>
          <button v-if="isPhoneReader" :disabled="readonly" :aria-pressed="String(phoneNodeDragEnabled)" @click="phoneNodeDragEnabled = !phoneNodeDragEnabled"><i aria-hidden="true" class="el-icon-rank" />{{ phoneNodeDragEnabled ? '关闭节点拖动（浏览优先）' : '启用节点拖动' }}</button>
        </template>
        <template v-else-if="sheet === 'appearance'">
          <button v-for="item in appearancePanels" :key="item.value" :disabled="readonly" @click="panel(item.value)"><i aria-hidden="true" class="iconfont" :class="item.icon" />{{ item.name }}</button>
        </template>
        <template v-else>
          <button :disabled="readonly || !canUndo" @click="history('BACK')"><i aria-hidden="true" class="el-icon-back" />撤销</button>
          <button :disabled="readonly || !canRedo" @click="history('FORWARD')"><i aria-hidden="true" class="el-icon-right" />重做</button>
          <button @click="nodeMenu"><i aria-hidden="true" class="el-icon-s-grid" />节点操作</button>
          <button @click="emit('open_mobile_file_menu')"><i aria-hidden="true" class="el-icon-folder-opened" />文件操作</button>
          <button @click="panel('outline')"><i aria-hidden="true" class="el-icon-tickets" />大纲</button>
          <button @click="emit('show_search')"><i aria-hidden="true" class="el-icon-search" />搜索节点</button>
          <button @click="emit('showShareAcl')"><i aria-hidden="true" class="el-icon-lock" />分享与权限</button>
          <button v-for="item in extraPanels" :key="item.value" @click="panel(item.value)"><i aria-hidden="true" class="iconfont" :class="item.icon" />{{ item.name }}</button>
          <button @click="emit('showExport')"><i aria-hidden="true" class="el-icon-download" />导出</button>
        </template>
      </div>
    </el-drawer>
  </div>
</template>
<script>
import editorViewport from '@/utils/editorViewport'
import { sidebarTriggerList } from '@/config'
import MobileEditorMenu from './MobileEditorMenu.vue'
import { openNotifications } from '@/services/accessNotificationState'
export default {
  components: { MobileEditorMenu },
  mixins: [editorViewport],
  props: { mindMap: Object },
  data: () => ({ sheet: '', activeNodes: [], canUndo: false, canRedo: false, collabHistoryEnabled: false, phoneNodeDragEnabled: false }),
  computed: {
    readonly() { return this.$store.state.isReadonly },
    isDark() { return this.$store.state.localConfig.isDark },
    activeSidebar() { return this.$store.state.activeSidebar },
    canEdit() { return !this.readonly && this.activeNodes.length > 0 },
    sheetTitle() { return ({ node: '节点操作', canvas: '画布', appearance: '外观' })[this.sheet] || '更多工具' },
    appearancePanels() { return (sidebarTriggerList[this.$i18n.locale] || sidebarTriggerList.zh).filter(i => ['theme', 'nodeStyle', 'baseStyle', 'structure'].includes(i.value)) },
    extraPanels() { return (sidebarTriggerList[this.$i18n.locale] || sidebarTriggerList.zh).filter(i => !['theme', 'nodeStyle', 'structure', 'outline', ...(this.isPhoneReader ? ['baseStyle'] : [])].includes(i.value) && (!this.readonly || ['shortcutKey', 'ai'].includes(i.value))) }
  },
  watch: {
    isPhoneReader() { this.sheet = ''; this.applyPhoneGestures() },
    phoneNodeDragEnabled() { this.applyPhoneGestures() },
    isTouchEditor(value) {
      if (!value) this.sheet = ''
      this.$nextTick(() => { if (this.mindMap) this.mindMap.resize() })
    },
    readonly(value) {
      if (value && this.sheet === 'node') this.sheet = ''
    }
  },
  mounted() {
    this._originalTouchNodeDrag = this.mindMap.opt.touchNodeDragEnabled
    this.applyPhoneGestures()
    this.activeNodes = [...(this.mindMap.renderer.activeNodeList || [])]
    this.$bus.$on('open_mobile_editor_sheet', this.openSheet)
    this.$bus.$on('close_mobile_editor_sheet', this.closeSheet)
    this.mindMap.on('back_forward', this.nativeHistory)
    this.$bus.$on('collab_history', this.collabHistory)
    const adapter = this.mindMap.cooperate && this.mindMap.cooperate.collabV2Adapter
    if (adapter) this.collabHistory({ ...adapter.getStatus(), enabled: true })
    else this.nativeHistory(this.mindMap.command.activeHistoryIndex, this.mindMap.command.history.length)
    this.mindMap.on('node_active', this.active)
    this.mindMap.on('node_mousedown', this.nodeDown)
    this.mindMap.on('node_touch_longpress', this.longPress)
    this.mindMap.on('before_show_text_edit', this.beforeEdit)
    this.mindMap.on('hide_text_edit', this.afterEdit)
    if (window.visualViewport) window.visualViewport.addEventListener('resize', this.keyboardResize)
  },
  beforeDestroy() {
    if (this.mindMap.opt && !this.mindMap._destroyed) this.mindMap.updateConfig({ touchNodeDragEnabled: this._originalTouchNodeDrag })
    this.$bus.$off('open_mobile_editor_sheet', this.openSheet)
    this.$bus.$off('close_mobile_editor_sheet', this.closeSheet)
    this.$bus.$off('collab_history', this.collabHistory)
    this.mindMap.off('back_forward', this.nativeHistory)
    this.mindMap.off('node_active', this.active)
    this.mindMap.off('node_mousedown', this.nodeDown)
    this.mindMap.off('node_touch_longpress', this.longPress)
    this.mindMap.off('before_show_text_edit', this.beforeEdit)
    this.mindMap.off('hide_text_edit', this.afterEdit)
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', this.keyboardResize)
    document.body.classList.remove('mobileNodeEditing')
    this._pressedNode = null
  },
  methods: {
    onMenuToggle(open) {
      if (!open) return
      this.closeSheet()
      this.$bus.$emit('close_mobile_file_menu')
      this.$bus.$emit('close_search')
      this.$bus.$emit('closeSideBar')
    },
    applyPhoneGestures() { this.mindMap.updateConfig({ touchNodeDragEnabled: this.isPhoneReader ? this.phoneNodeDragEnabled : this._originalTouchNodeDrag }) },
    menuAction(key) {
      if (key === 'file') this.emit('open_mobile_file_menu')
      else if (key === 'messages') { this.closeSheet(); openNotifications('requests') }
      else this.openSheet(key)
    },
    canvasAction(key) { if (key === 'center') this.mindMap.renderer.setRootNodeCenter(); else this.mindMap.view[key](); this.closeSheet() },
    openSheet(name) {
      if (!this.isTouchEditor) return
      this.$bus.$emit('close_mobile_file_menu')
      this.$bus.$emit('closeSideBar')
      this.$bus.$emit('close_search')
      this.sheet = ['node', 'canvas', 'appearance'].includes(name) ? name : 'more'
    },
    closeSheet() { this.sheet = '' },
    nativeHistory(index, length) {
      if (this.collabHistoryEnabled) return
      this.canUndo = index > 0; this.canRedo = index < length - 1
    },
    collabHistory({ enabled = false, undoDepth = 0, redoDepth = 0, pendingCount = 0 } = {}) {
      this.collabHistoryEnabled = enabled
      if (enabled) { this.canUndo = undoDepth > 0 || pendingCount > 0; this.canRedo = redoDepth > 0 }
      else this.nativeHistory(this.mindMap.command.activeHistoryIndex, this.mindMap.command.history.length)
    },
    history(command) {
      if (this.readonly || !(command === 'BACK' ? this.canUndo : this.canRedo)) return
      this.command(command)
    },
    nodeDown(node) { this._pressedNode = node },
    // Phones replace the desktop context menu with the node action sheet.
    longPress(e) {
      const node = this._pressedNode
      this._pressedNode = null
      if (!this.isTouchEditor || !node) return
      e.handled = true
      node.active()
      // node_active is batched by the renderer. Seed the selected node now so
      // the first long press can open the sheet before that event arrives.
      this.activeNodes = [node]
      if (this.isPhoneReader) {
        this.closeSheet()
        this.$bus.$emit('close_mobile_file_menu')
        this.$bus.$emit('close_search')
        this.$bus.$emit('closeSideBar')
        this.$bus.$emit('node_contextmenu', { clientX: e.clientX, clientY: e.clientY }, node)
      } else this.openSheet('node')
    },
    beforeEdit() { if (this.isTouchEditor) document.body.classList.add('mobileNodeEditing') },
    afterEdit() { document.body.classList.remove('mobileNodeEditing') },
    keyboardResize() {
      if (!this.isTouchEditor || !document.body.classList.contains('mobileNodeEditing')) return
      const input = document.activeElement
      if (input && input.isContentEditable) input.scrollIntoView({ block: 'center', inline: 'nearest' })
    },
    active(node, list) { this.activeNodes = list || [] },
    panel(value) { this.sheet = ''; this.$store.commit('setActiveSidebar', this.activeSidebar === value ? '' : value) },
    emit(name) { this.sheet = ''; this.$bus.$emit(name) },
    nodeMenu() { this.sheet = 'node' },
    nodeEvent(name, list) { this.sheet = ''; this.$bus.$emit(name, list ? this.activeNodes : this.activeNodes[0]) },
    command(name) { if (this.readonly || (!['BACK', 'FORWARD'].includes(name) && !this.canEdit)) return; this.sheet = ''; this.mindMap.execCommand(name) },
    editText() { if (!this.canEdit) return; this.sheet = ''; this.$nextTick(() => this.mindMap.renderer.textEdit.show({ node: this.activeNodes[0] })) },
    async remove() { try { await this.$confirm('删除所选节点及其子节点？', '删除节点'); this.command('REMOVE_NODE') } catch (e) { /* cancelled */ } },
    context() { this.sheet = ''; this.$bus.$emit('node_contextmenu', { clientX: 12, clientY: 100 }, this.activeNodes[0]) }
  }
}
</script>
