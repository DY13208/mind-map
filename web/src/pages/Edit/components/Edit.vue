<template>
  <div
    class="editContainer"
    :class="{ hasCanvasFrame: showCanvasFrame }"
    @dragenter.stop.prevent="onDragenter"
    @dragleave.stop.prevent
    @dragover.stop.prevent
    @drop.stop.prevent
  >
    <div
      class="mindMapContainer"
      :class="{
        isCanvasDarkFallback: useDarkCanvasFallback,
        isRoomCanvasPending: roomCanvasPending
      }"
      id="mindMapContainer"
      ref="mindMapContainer"
      data-testid="mindmap-canvas"
    ></div>
    <MobileEditorControls v-if="mindMap" :mind-map="mindMap" />
    <Count :mindMap="mindMap" v-if="!isZenMode"></Count>
    <Navigator v-if="mindMap && !isZenMode && showNavigator" :mindMap="mindMap"></Navigator>
    <NavigatorToolbar :mindMap="mindMap" v-if="!isZenMode && showNavigatorToolbar"></NavigatorToolbar>
    <OutlineSidebar :mindMap="mindMap"></OutlineSidebar>
    <Style v-if="mindMap && !isZenMode" :mindMap="mindMap"></Style>
    <BaseStyle
      :data="mindMapData"
      :configData="mindMapConfig"
      :mindMap="mindMap"
    ></BaseStyle>
    <AssociativeLineStyle
      v-if="mindMap"
      :mindMap="mindMap"
    ></AssociativeLineStyle>
    <Theme v-if="mindMap" :data="mindMapData" :mindMap="mindMap"></Theme>
    <Structure v-if="mindMap" :mindMap="mindMap"></Structure>
    <ShortcutKey></ShortcutKey>
    <Contextmenu v-if="mindMap" :mindMap="mindMap"></Contextmenu>
    <RichTextToolbar v-if="mindMap" :mindMap="mindMap"></RichTextToolbar>
    <NodeNoteContentShow
      v-if="mindMap"
      :mindMap="mindMap"
    ></NodeNoteContentShow>
    <NodeImgPreview v-if="mindMap" :mindMap="mindMap"></NodeImgPreview>
    <SidebarTrigger v-if="!isZenMode"></SidebarTrigger>
    <Search v-if="mindMap" :mindMap="mindMap"></Search>
    <NodeIconSidebar v-if="mindMap" :mindMap="mindMap"></NodeIconSidebar>
    <NodeIconToolbar v-if="mindMap" :mindMap="mindMap"></NodeIconToolbar>
    <OutlineEdit v-if="mindMap" :mindMap="mindMap"></OutlineEdit>
    <Scrollbar v-if="isShowScrollbar && mindMap" :mindMap="mindMap"></Scrollbar>
    <FormulaSidebar v-if="mindMap" :mindMap="mindMap"></FormulaSidebar>
    <NodeOuterFrame v-if="mindMap" :mindMap="mindMap"></NodeOuterFrame>
    <NodeTagStyle v-if="mindMap" :mindMap="mindMap"></NodeTagStyle>
    <Setting :configData="mindMapConfig" :mindMap="mindMap"></Setting>
    <NodeImgPlacementToolbar
      v-if="mindMap"
      :mindMap="mindMap"
    ></NodeImgPlacementToolbar>
    <NodeNoteSidebar v-if="mindMap" :mindMap="mindMap"></NodeNoteSidebar>
    <AiCreate v-if="mindMap && enableAi" :mindMap="mindMap"></AiCreate>
    <AiChat v-if="enableAi"></AiChat>
    <NodeAutoExpand v-if="mindMap" :mindMap="mindMap"></NodeAutoExpand>
    <NodeAttachment v-if="mindMap" :mindMap="mindMap"></NodeAttachment>
    <NodeAttachmentPreview v-if="mindMap"></NodeAttachmentPreview>
    <NodeHyperlinkPopover v-if="mindMap"></NodeHyperlinkPopover>
    <NodeCommentCard v-if="mindMap"></NodeCommentCard>
    <LeaveIntentTrigger v-if="mindMap" :mindMap="mindMap" />
    <CooperateDialog :mindMap="mindMap"></CooperateDialog>
    <!-- 保留旧分享弹窗，节点分享目前直接复制链接并继承文件权限。 -->
    <NodeShareDialog v-if="false"></NodeShareDialog>
    <MapRefDialog></MapRefDialog>
    <div
      class="dragMask"
      v-if="showDragMask"
      @dragleave.stop.prevent="onDragleave"
      @dragover.stop.prevent
      @drop.stop.prevent="onDrop"
    >
      <div class="dragTip">{{ $t('edit.dragTip') }}</div>
    </div>
  </div>
</template>

<script>
import MobileEditorControls from './MobileEditorControls.vue'
import MindMap from 'simple-mind-map'
import { startPerformanceDiagnostics } from '@/utils/performanceDiagnostics'
import MiniMap from 'simple-mind-map/src/plugins/MiniMap.js'
import Watermark from 'simple-mind-map/src/plugins/Watermark.js'
import KeyboardNavigation from 'simple-mind-map/src/plugins/KeyboardNavigation.js'
import ExportPDF from 'simple-mind-map/src/plugins/ExportPDF.js'
import ExportXMind from 'simple-mind-map/src/plugins/ExportXMind.js'
import Export from 'simple-mind-map/src/plugins/Export.js'
import Drag from 'simple-mind-map/src/plugins/Drag.js'
import Select from 'simple-mind-map/src/plugins/Select.js'
import RichText from 'simple-mind-map/src/plugins/RichText.js'
import AssociativeLine from 'simple-mind-map/src/plugins/AssociativeLine.js'
import TouchEvent from 'simple-mind-map/src/plugins/TouchEvent.js'
import NodeImgAdjust from 'simple-mind-map/src/plugins/NodeImgAdjust.js'
import SearchPlugin from 'simple-mind-map/src/plugins/Search.js'
import Painter from 'simple-mind-map/src/plugins/Painter.js'
import ScrollbarPlugin from 'simple-mind-map/src/plugins/Scrollbar.js'
import Formula from 'simple-mind-map/src/plugins/Formula.js'
import RainbowLines from 'simple-mind-map/src/plugins/RainbowLines.js'
import Demonstrate from 'simple-mind-map/src/plugins/Demonstrate.js'
import OuterFrame from 'simple-mind-map/src/plugins/OuterFrame.js'
import MindMapLayoutPro from 'simple-mind-map/src/plugins/MindMapLayoutPro.js'
import NodeBase64ImageStorage from 'simple-mind-map/src/plugins/NodeBase64ImageStorage.js'
import Themes from 'simple-mind-map-plugin-themes'
import Cooperate from 'simple-mind-map/src/plugins/Cooperate.js'
import OutlineSidebar from './OutlineSidebar.vue'
import Style from './Style.vue'
import BaseStyle from './BaseStyle.vue'
import Theme from './Theme.vue'
import Structure from './Structure.vue'
import Count from './Count.vue'
import NavigatorToolbar from './NavigatorToolbar.vue'
import ShortcutKey from './ShortcutKey.vue'
import Contextmenu from './Contextmenu.vue'
import RichTextToolbar from './RichTextToolbar.vue'
import NodeNoteContentShow from './NodeNoteContentShow.vue'
import {
  getData,
  getDataAsync,
  getConfig,
  storeData,
  getPendingRoomDraft,
  clearPendingRoomDraft
} from '@/api'
import {
  shouldRestoreDraft,
  draftRestoredTip,
  isDraftFallbackEnabled,
  COLLAB_DRAFT_FALLBACK_MS
} from '@/utils/collabDraftFallback'
import Navigator from './Navigator.vue'
import NodeImgPreview from './NodeImgPreview.vue'
import SidebarTrigger from './SidebarTrigger.vue'
import { mapState, mapMutations } from 'vuex'
import icon from '@/config/icon'
import Vue from 'vue'
import Search from './Search.vue'
import NodeIconSidebar from './NodeIconSidebar.vue'
import NodeIconToolbar from './NodeIconToolbar.vue'
import OutlineEdit from './OutlineEdit.vue'
import { showLoading, hideLoading, updateLoading } from '@/utils/loading'
import { getSaveStatus as requestSaveStatus } from '@/utils/fileApi'
import { promiseWithTimeout } from '@/utils/promiseWithTimeout'
import {
  prepareImportedTree,
  yieldToUi
} from '@/utils/importTree'
import handleClipboardText from '@/utils/handleClipboardText'
import { copyNodeAttachments } from '@/utils/copyNodeAttachments'
import { getRuntimeConfig } from '@/utils/runtimeConfig'
import { isDarkThemeValue, resolveAppearanceTheme } from '@/utils/themeAppearance'
import Scrollbar from './Scrollbar.vue'
import exampleData from 'simple-mind-map/example/exampleData'
import FormulaSidebar from './FormulaSidebar.vue'
import NodeOuterFrame from './NodeOuterFrame.vue'
import NodeTagStyle from './NodeTagStyle.vue'
import Setting from './Setting.vue'
import AssociativeLineStyle from './AssociativeLineStyle.vue'
import NodeImgPlacementToolbar from './NodeImgPlacementToolbar.vue'
import NodeNoteSidebar from './NodeNoteSidebar.vue'
import AiCreate from './AiCreate.vue'
import AiChat from './AiChat.vue'
import NodeAutoExpand from './NodeAutoExpand.vue'
import NodeAttachment from './NodeAttachment.vue'
import NodeAttachmentPreview from './NodeAttachmentPreview.vue'
import NodeHyperlinkPopover from './NodeHyperlinkPopover.vue'
import NodeCommentCard from './NodeCommentCard.vue'
import LeaveIntentTrigger from './LeaveIntentTrigger.vue'
import { isNodeCommentUnread } from '@/utils/commentRead'
import { currentCommentUser } from '@/utils/commentUser'
import CooperateDialog from './CooperateDialog.vue'
import NodeShareDialog from './NodeShareDialog.vue'
import MapRefDialog from './MapRefDialog.vue'
import { normalizeMapRef } from '@/utils/mapRefNav'
import {
  writeJobResultToMap,
  createJobContainer,
  inspectJobResult
} from '@/utils/jobResultWriter'
import { roomFromLocation } from '@/utils/roomLocation'

// 注册插件
MindMap.usePlugin(MiniMap)
  .usePlugin(Watermark)
  .usePlugin(Drag)
  .usePlugin(KeyboardNavigation)
  .usePlugin(ExportPDF)
  .usePlugin(ExportXMind)
  .usePlugin(Export)
  .usePlugin(Select)
  .usePlugin(AssociativeLine)
  .usePlugin(NodeImgAdjust)
  .usePlugin(TouchEvent)
  .usePlugin(SearchPlugin)
  .usePlugin(Painter)
  .usePlugin(Formula)
  .usePlugin(RainbowLines)
  .usePlugin(Demonstrate)
  .usePlugin(OuterFrame)
  .usePlugin(MindMapLayoutPro)
  .usePlugin(NodeBase64ImageStorage)
  .usePlugin(Cooperate)

// 注册主题
Themes.init(MindMap)
// 扩展主题列表
if (typeof window.MoreThemes !== 'undefined') {
  window.MoreThemes.init(MindMap)
}

export default {
  components: {
    MobileEditorControls,
    OutlineSidebar,
    Style,
    BaseStyle,
    Theme,
    Structure,
    Count,
    NavigatorToolbar,
    ShortcutKey,
    Contextmenu,
    RichTextToolbar,
    NodeNoteContentShow,
    Navigator,
    NodeImgPreview,
    SidebarTrigger,
    Search,
    NodeIconSidebar,
    NodeIconToolbar,
    OutlineEdit,
    Scrollbar,
    FormulaSidebar,
    NodeOuterFrame,
    NodeTagStyle,
    Setting,
    AssociativeLineStyle,
    NodeImgPlacementToolbar,
    NodeNoteSidebar,
    AiCreate,
    AiChat,
    NodeAutoExpand,
    NodeAttachment,
    NodeAttachmentPreview,
    NodeHyperlinkPopover,
    NodeCommentCard,
    LeaveIntentTrigger,
    CooperateDialog,
    NodeShareDialog,
    MapRefDialog
  },
  data() {
    return {
      isDocFullscreen: !!document.fullscreenElement,
      enableShowLoading: true,
      loadingSafetyTimer: null,
      importPersistLock: false,
      importProgressTimer: null,
      mindMap: null,
      mindMapData: null,
      mindMapConfig: {},
      isLargeMap: false,
      storeDataTimer: null,
      pendingStoreData: null,
      collabDraftFallbackTimer: null,
      prevImg: '',
      storeConfigTimer: null,
      showDragMask: false,
      useDarkCanvasFallback: false,
      adaptingAppearanceTheme: false,
      appearanceHeldDarkTheme: null,
      appearanceHeldLightTheme: null,
      appearanceTransitioning: false,
      appearanceTransitionTimer: null,
      appearanceTransitionToken: null,
      appearanceSnapshotEl: null,
      // 房间打开时画布上先放一个空根节点。在服务端树画完之前藏住它。
      roomCanvasPending: !!(
        this.$route &&
        this.$route.query &&
        this.$route.query.room
      )
    }
  },
  computed: {
    ...mapState({
      isZenMode: state => state.localConfig.isZenMode,
      openNodeRichText: state => state.localConfig.openNodeRichText,
      isShowScrollbar: state => state.localConfig.isShowScrollbar,
      showNavigator: state => state.localConfig.showNavigator,
      showNavigatorToolbar: state => state.localConfig.showNavigatorToolbar,
      enableDragImport: state => state.localConfig.enableDragImport,
      useLeftKeySelectionRightKeyDrag: state =>
        state.localConfig.useLeftKeySelectionRightKeyDrag,
      extraTextOnExport: state => state.extraTextOnExport,
      isDragOutlineTreeNode: state => state.isDragOutlineTreeNode,
      enableAi: state => state.localConfig.enableAi,
      isDark: state => state.localConfig.isDark,
      extendThemeGroupList: state => state.extendThemeGroupList
    }),
    // 刘海外框：禅模式 / 全屏（含演示模式）时隐藏，画布恢复铺满
    showCanvasFrame() {
      return !this.isZenMode && !this.isDocFullscreen
    }
  },
  watch: {
    showCanvasFrame() {
      // 外框显隐会改变画布容器尺寸，等 DOM 更新后让思维导图重新测量
      this.$nextTick(() => this.resizeMindMapSafely())
    },
    isDark() {
      // light/dark use different frame widths (--mm-frame-width), so re-measure the canvas
      this.$nextTick(() => this.resizeMindMapSafely())
      if (this.appearanceTransitioning) return
      this.syncCanvasDarkBackground()
    },
    openNodeRichText() {
      if (this.openNodeRichText) {
        this.addRichTextPlugin()
      } else {
        this.removeRichTextPlugin()
      }
    },
    isShowScrollbar() {
      if (this.isShowScrollbar) {
        this.addScrollbarPlugin()
      } else {
        this.removeScrollbarPlugin()
      }
    }
  },
  async mounted() {
    this._saveRoomKey = roomFromLocation() || (this.$route.query.room || '')
    // 先注册关闭 loading，避免 init 渲染结束事件早于监听导致遮罩锁死
    this.$bus.$on('node_tree_render_end', this.handleHideLoading)
    this.$bus.$on('showLoading', this.handleShowLoading)
    this.$bus.$on('hideLoading', this.handleForceHideLoading)
    // Opening the editor must never cover the canvas with a loading overlay.
    // Explicit imports/saves still use their own progress UI below.
    this.enableShowLoading = false
    hideLoading()
    let dataReady = true
    try {
      await promiseWithTimeout(this.getData(), 10000, 'mind map data')
    } catch (err) {
      dataReady = false
      console.warn('[edit] data load slow, using fallback:', err.message || err)
      if (!this.mindMapData || !this.mindMapData.root) {
        this.mindMapData = getData()
        const prepared = prepareImportedTree(this.mindMapData)
        this.mindMapData = prepared.data
        this.isLargeMap = prepared.collapsed
      }
      this.mindMapConfig = getConfig() || {}
    }
    if (this._editorDisposed) return
    this.init()
    if (!dataReady) {
      this.getData()
        .then(() => {
          if (this.mindMap && this.mindMapData && this.mindMapData.root) {
            this.mindMap.setData(this.mindMapData.root)
          }
        })
        .catch(err => {
          console.warn('[edit] deferred data load failed:', err.message || err)
        })
    }
    this.$bus.$on('execCommand', this.execCommand)
    this.$bus.$on('applySubMapToNode', this.applySubMapToNode)
    this.$bus.$on('write_job_result', this.onWriteJobResult)
    this.$bus.$on('create_job_container', this.onCreateJobContainer)
    this.$bus.$on('probe_job_result', this.onProbeJobResult)
    this.$bus.$on('probe_job_ack', this.onProbeJobAck)
    this.$bus.$on('read_generalization', this.onReadGeneralization)
    this.$bus.$on('paddingChange', this.onPaddingChange)
    this.$bus.$on('export', this.export)
    this.$bus.$on('setData', this.setData)
    this.$bus.$on('startTextEdit', this.handleStartTextEdit)
    this.$bus.$on('endTextEdit', this.handleEndTextEdit)
    this.$bus.$on('createAssociativeLine', this.handleCreateLineFromActiveNode)
    this.$bus.$on('startPainter', this.handleStartPainter)
    this.$bus.$on('localStorageExceeded', this.onLocalStorageExceeded)
    this.$bus.$on('toggle_appearance_mode', this.handleToggleAppearanceMode)
    this.$bus.$on('prepare_reload', this.prepareReload)
    this.$bus.$on('room_canvas_ready', this.onRoomCanvasReady)
    window.addEventListener('resize', this.handleResize)
    document.addEventListener('fullscreenchange', this.onDocFullscreenChange)
    // 房间模式下协作挂了不能等于"图没了"：等一会儿还没连上就用本地留底恢复
    this.startCollabDraftFallback()
  },

  beforeDestroy() {
    if (this._stopPerformanceDiagnostics) this._stopPerformanceDiagnostics()
    const editing = this.mindMap && this.mindMap.renderer.textEdit.isShowTextEdit()
    this.commitOpenTextEdit()
    // Hand the latest unsent collaborative text delta to the durable outbox
    // before the engine is destroyed. The normal debounced flush can still be
    // awaiting an earlier ACK at this point, so this must not go through it.
    const exitCooperate = this.mindMap && this.mindMap.cooperate
    if (exitCooperate && typeof exitCooperate.flushLatestPendingForExit === 'function') {
      exitCooperate.flushLatestPendingForExit()
    }
    if (editing) {
      this.pendingStoreData = true
      this._pendingSaveData = null
    }
    this.flushStoreData(true)
    this._editorDisposed = true
    this.stopCollabDraftFallback()
    if (this.storeDataTimer) {
      clearTimeout(this.storeDataTimer)
      this.storeDataTimer = null
    }
    clearTimeout(this.storeConfigTimer)
    this.storeConfigTimer = null
    if (this.loadingSafetyTimer) {
      clearTimeout(this.loadingSafetyTimer)
      this.loadingSafetyTimer = null
    }
    if (this.appearanceTransitionTimer) {
      clearTimeout(this.appearanceTransitionTimer)
      this.appearanceTransitionTimer = null
    }
    this.appearanceTransitionToken = null
    this.clearAppearanceSnapshot()
    this.importPersistLock = false
    this.stopImportProgressPoll()
    this.$bus.$off('execCommand', this.execCommand)
    this.$bus.$off('applySubMapToNode', this.applySubMapToNode)
    this.$bus.$off('write_job_result', this.onWriteJobResult)
    this.$bus.$off('create_job_container', this.onCreateJobContainer)
    this.$bus.$off('probe_job_result', this.onProbeJobResult)
    this.$bus.$off('probe_job_ack', this.onProbeJobAck)
    this.$bus.$off('read_generalization', this.onReadGeneralization)
    this.$bus.$off('paddingChange', this.onPaddingChange)
    this.$bus.$off('export', this.export)
    this.$bus.$off('setData', this.setData)
    this.$bus.$off('startTextEdit', this.handleStartTextEdit)
    this.$bus.$off('endTextEdit', this.handleEndTextEdit)
    this.$bus.$off('createAssociativeLine', this.handleCreateLineFromActiveNode)
    this.$bus.$off('startPainter', this.handleStartPainter)
    this.$bus.$off('node_tree_render_end', this.handleHideLoading)
    this.$bus.$off('showLoading', this.handleShowLoading)
    this.$bus.$off('hideLoading', this.handleForceHideLoading)
    this.$bus.$off('localStorageExceeded', this.onLocalStorageExceeded)
    this.$bus.$off('toggle_appearance_mode', this.handleToggleAppearanceMode)
    this.$bus.$off('prepare_reload', this.prepareReload)
    this.$bus.$off('room_canvas_ready', this.onRoomCanvasReady)
    this.$bus.$off('data_change', this.onSaveDataChange)
    this.$bus.$off('view_data_change', this.onSaveViewChange)
    window.removeEventListener('resize', this.handleResize)
    document.removeEventListener('fullscreenchange', this.onDocFullscreenChange)
    if (this.mindMap) {
      this.unbindCanvasThemeEvents()
      this.mindMap.destroy()
    }
    if (Vue.prototype.getCurrentData === this._getCurrentData) {
      delete Vue.prototype.getCurrentData
    }
    this._getCurrentData = null
    this._pendingSaveData = null
    this.mindMap = null
    this.mindMapData = null
  },
  methods: {
    onRoomCanvasReady() {
      this.roomCanvasPending = false
    },

    openHyperlink(value) {
      let url = null
      try {
        url = new URL(String(value || '').trim(), window.location.href)
      } catch (_) {
        this.$message.warning('链接地址无效，请检查超链接设置')
        return
      }
      if (!['http:', 'https:'].includes(url.protocol)) {
        this.$message.warning('仅支持 HTTP 或 HTTPS 链接')
        return
      }
      // 普通新标签页，不用弹层，也不另开小窗口。脑图留在当前标签页。
      const tab = window.open(url.href, '_blank', 'noopener,noreferrer')
      if (!tab) {
        this.$message.warning('浏览器拦截了新标签页，请允许弹窗后再打开')
      }
    },
  /**
   * 协作服务连不上时的数据兜底。
   *
   * 页面带房间号时，前端把持久化整个交给协作服务（`api` 的 storeData 在协作会话里
   * 不写 localStorage/IndexedDB）。协作服务一挂（nginx 502），那批改动就只在内存里，
   * 刷新/重新部署即消失。现在协作会话也会本地留底，这里负责恢复出来。
   */
  startCollabDraftFallback() {
    this.stopCollabDraftFallback()
    if (!roomFromLocation(this.$route)) return
    if (!isDraftFallbackEnabled(window)) return
    this.collabDraftFallbackTimer = setTimeout(() => {
      this.collabDraftFallbackTimer = null
      this.restoreCollabDraftIfNeeded()
    }, COLLAB_DRAFT_FALLBACK_MS)
  },

  stopCollabDraftFallback() {
    if (this.collabDraftFallbackTimer) {
      clearTimeout(this.collabDraftFallbackTimer)
      this.collabDraftFallbackTimer = null
    }
  },

  restoreCollabDraftIfNeeded() {
    if (!this.mindMap || typeof this.mindMap.setData !== 'function') return
    const state = this.$store && this.$store.state
    const live =
      !!state &&
      (state.collabPhase === 'LIVE' || state.cooperateStatus === 'connected')
    const draft = getPendingRoomDraft()
    const current =
      typeof this.mindMap.getData === 'function'
        ? this.mindMap.getData(true)
        : null
    if (!shouldRestoreDraft({ live, draft, root: current && current.root })) {
      return
    }
    try {
      this.mindMap.setData(draft.root)
      clearPendingRoomDraft()
      this.$message.warning({
        message: draftRestoredTip(draft),
        duration: 0,
        showClose: true
      })
    } catch (err) {
      console.warn('[edit] restore local draft failed:', err.message || err)
    }
  },

    ...mapMutations(['setLocalConfig']),

    async onHistoryRestored(restored) {
      const cooperate = this.mindMap && this.mindMap.cooperate
      if (
        cooperate &&
        cooperate.httpCollabMode &&
        typeof cooperate.recoverHttpCollab === 'function'
      ) {
        const target = Number(
          (restored && restored.newRevision) ||
            (cooperate.lastAppliedVersion || 0) + 1
        )
        const result = await cooperate.recoverHttpCollab(target, {
          reason: 'VERSION_RESTORE'
        })
        if (!result || !result.applied) {
          const error = new Error('history canvas refresh did not complete')
          error.code = (result && result.code) || 'HTTP_HISTORY_RESTORE_INCOMPLETE'
          throw error
        }
        return result
      }
    },

    onLocalStorageExceeded() {
      this.$notify({
        type: 'warning',
        title: this.$t('edit.tip'),
        message: this.$t('edit.localStorageExceededTip'),
        duration: 8000
      })
    },

    handleStartTextEdit() {
      this.mindMap.renderer.startTextEdit()
    },

    handleEndTextEdit() {
      this.mindMap.renderer.endTextEdit()
    },

    handleCreateLineFromActiveNode() {
      if (this.mindMap.cooperate && this.mindMap.cooperate.ensureActiveSelection) {
        this.mindMap.cooperate.ensureActiveSelection()
      }
      this.mindMap.associativeLine.createLineFromActiveNode()
    },

    handleStartPainter() {
      this.mindMap.painter.startPainter()
    },

    onDocFullscreenChange() {
      this.isDocFullscreen = !!document.fullscreenElement
    },

    resizeMindMapSafely() {
      if (this.mindMap && typeof this.mindMap.resize === 'function') {
        this.mindMap.resize()
      }
    },

    handleResize() {
      this.mindMap.resize()
    },

    // 显示loading
    handleShowLoading(text, durationOrOptions) {
      // Empty requests come from appearance changes; they must not cover the map.
      if (!text && !durationOrOptions) return
      this.enableShowLoading = true
      const options =
        typeof durationOrOptions === 'number'
          ? { timeout: durationOrOptions }
          : durationOrOptions || {}
      showLoading(typeof text === 'string' ? text : '', {
        percent: options.percent,
        detail: options.detail
      })
      if (this.loadingSafetyTimer) {
        clearTimeout(this.loadingSafetyTimer)
      }
      const timeout = Math.max(8000, Number(options.timeout) || 8000)
      this.loadingSafetyTimer = setTimeout(() => {
        if (this.importPersistLock) return
        this.handleHideLoading()
      }, timeout)
    },

    updateImportProgress(percent, detail, text) {
      if (!this.enableShowLoading) return
      updateLoading({
        text: text || this.$t('edit.importSavingTip'),
        percent,
        detail
      })
    },

    stopImportProgressPoll() {
      if (this.importProgressTimer) {
        clearInterval(this.importProgressTimer)
        this.importProgressTimer = null
      }
    },

    startImportProgressPoll(roomKey) {
      this.stopImportProgressPoll()
      if (!roomKey) return
      this.importProgressTimer = setInterval(async () => {
        try {
          const data = await requestSaveStatus(roomKey)
          if (!this.importPersistLock) return
          const percent = Number(data.progress)
          const detail =
            data.message ||
            (data.phase === 'writing'
              ? this.$t('edit.importSavingWrite')
              : data.phase === 'committing'
                ? this.$t('edit.importSavingCommit')
                : data.phase === 'receiving'
                  ? this.$t('edit.importSavingUpload')
                  : '')
          if (Number.isFinite(percent) && percent > 0) {
            this.updateImportProgress(
              Math.max(30, Math.min(95, percent)),
              detail
            )
          } else if (detail) {
            this.updateImportProgress(null, detail)
          }
        } catch (err) {
          // 保存中轮询失败不打断导入，避免把超时显示成失败
        }
      }, 1000)
    },

    // 渲染结束后关闭loading
    handleForceHideLoading() {
      this.handleHideLoading({ force: true })
    },

    handleHideLoading(options = {}) {
      if (this.importPersistLock && !options.force) return
      this.stopImportProgressPoll()
      if (this.loadingSafetyTimer) {
        clearTimeout(this.loadingSafetyTimer)
        this.loadingSafetyTimer = null
      }
      if (this.enableShowLoading) {
        this.enableShowLoading = false
        hideLoading()
      }
      this.syncCanvasDarkBackground()
    },

    // 深色模式只改画布背景的视觉呈现，不改主题模板/自定义配置，避免基础样式失效
    isLikelyDarkColor(color) {
      const value = String(color || '').trim()
      const hexMatch = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
      let rgb = null
      if (hexMatch) {
        let hex = hexMatch[1]
        if (hex.length === 3) {
          hex = hex
            .split('')
            .map(ch => ch + ch)
            .join('')
        }
        rgb = [
          parseInt(hex.slice(0, 2), 16),
          parseInt(hex.slice(2, 4), 16),
          parseInt(hex.slice(4, 6), 16)
        ]
      } else {
        const rgbMatch = value.match(
          /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/i
        )
        if (rgbMatch) {
          rgb = rgbMatch.slice(1, 4).map(item => Number(item))
        }
      }
      if (!rgb) return false
      const [r, g, b] = rgb
      return 0.299 * r + 0.587 * g + 0.114 * b < 140
    },

    isCurrentThemeDark(themeValue) {
      return isDarkThemeValue(
        themeValue || (this.mindMap && this.mindMap.getTheme()),
        this.extendThemeGroupList
      )
    },

    // Theme rendering already traverses the graph; avoid capturing or cloning
    // the entire canvas on top of that work, especially for large maps.
    async handleToggleAppearanceMode(nextDark) {
      if (!this.mindMap || this.appearanceTransitioning) return
      const wantDark = !!nextDark
      if (wantDark === !!this.isDark) {
        this.ensureAppearanceThemeAligned()
        return
      }

      const current = this.mindMap.getTheme()
      const resolved = resolveAppearanceTheme({
        nextDark: wantDark,
        currentTheme: current,
        heldLightTheme: this.appearanceHeldLightTheme,
        heldDarkTheme: this.appearanceHeldDarkTheme,
        extendThemeGroupList: this.extendThemeGroupList
      })
      this.appearanceHeldLightTheme = resolved.heldLightTheme
      this.appearanceHeldDarkTheme = resolved.heldDarkTheme

      this.appearanceTransitioning = true
      this.adaptingAppearanceTheme = true
      this.setCanvasDarkFallback(false)

      const el = this.mindMap.el
      const token = Symbol('appearance')
      this.appearanceTransitionToken = token
      const runChange = async () => {
        if (this.appearanceTransitionToken !== token || !this.mindMap) return
        await this.applyAppearanceModeChange(wantDark, resolved)
        await new Promise(resolve => {
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        })
      }

      try {
        await runChange()
      } finally {
        if (el) el.style.viewTransitionName = ''
        this.clearAppearanceSnapshot()
        if (el && el.classList) {
          el.classList.remove('isAppearanceTransitioning')
        }
        this.adaptingAppearanceTheme = false
        this.appearanceTransitioning = false
        this.appearanceTransitionToken = null
        this.syncCanvasDarkBackground()
      }
    },

    applyAppearanceModeChange(wantDark, resolved) {
      return new Promise(resolve => {
        if (!this.mindMap) {
          resolve()
          return
        }

        const finish = () => {
          if (this.mindMap) {
            this.mindMap.off('node_tree_render_end', finish)
          }
          if (this.appearanceTransitionTimer) {
            clearTimeout(this.appearanceTransitionTimer)
            this.appearanceTransitionTimer = null
          }
          resolve()
        }

        if (resolved.changed) {
          this.mindMap.setTheme(resolved.theme, true)
          if (typeof this.mindMap.initTheme === 'function') {
            this.mindMap.initTheme()
          }

          const config = this.mindMap.getCustomThemeConfig
            ? this.mindMap.getCustomThemeConfig()
            : {}
          storeData({
            theme: {
              template: resolved.theme,
              config: config || {}
            }
          })
          if (this.mindMapData && this.mindMapData.theme) {
            this.mindMapData.theme.template = resolved.theme
          }

          this.setLocalConfig({ isDark: wantDark })
          this.mindMap.off('node_tree_render_end', finish)
          this.mindMap.on('node_tree_render_end', finish)
          this.appearanceTransitionTimer = setTimeout(finish, 1200)
          this.mindMap.render(null, 'changeTheme')
          return
        }

        this.setLocalConfig({ isDark: wantDark })
        this.syncCanvasDarkBackground()
        resolve()
      })
    },

    showAppearanceSnapshot() {
      const el = this.mindMap && this.mindMap.el
      if (!el) return
      this.clearAppearanceSnapshot()
      const snap = el.cloneNode(true)
      snap.removeAttribute('id')
      snap.querySelectorAll('[id]').forEach(node => {
        node.removeAttribute('id')
      })
      snap
        .querySelectorAll('[data-appearance-snapshot]')
        .forEach(node => node.remove())
      Object.assign(snap.style, {
        position: 'absolute',
        left: '0',
        top: '0',
        right: '0',
        bottom: '0',
        width: '100%',
        height: '100%',
        zIndex: '2147483646',
        pointerEvents: 'none',
        margin: '0',
        opacity: '1',
        transition: 'none',
        viewTransitionName: 'none'
      })
      snap.setAttribute('data-appearance-snapshot', '1')
      snap.setAttribute('aria-hidden', 'true')
      el.appendChild(snap)
      this.appearanceSnapshotEl = snap
    },

    fadeOutAppearanceSnapshot() {
      return new Promise(resolve => {
        const snap = this.appearanceSnapshotEl
        if (!snap) {
          resolve()
          return
        }
        let settled = false
        const done = () => {
          if (settled) return
          settled = true
          this.clearAppearanceSnapshot()
          resolve()
        }
        snap.style.transition = 'opacity 0.16s ease'
        void snap.offsetHeight
        snap.style.opacity = '0'
        snap.addEventListener('transitionend', done, { once: true })
        setTimeout(done, 220)
      })
    },

    clearAppearanceSnapshot() {
      const snap = this.appearanceSnapshotEl
      if (snap && snap.parentNode) {
        snap.parentNode.removeChild(snap)
      }
      this.appearanceSnapshotEl = null
    },

    // 日间/夜间必须切换完整主题模板：只改画布底色会留下浅色主题的黑字，对比失效。
    adaptThemeToAppearance(nextDark) {
      if (!this.mindMap) return
      const current = this.mindMap.getTheme()
      const resolved = resolveAppearanceTheme({
        nextDark: !!nextDark,
        currentTheme: current,
        heldLightTheme: this.appearanceHeldLightTheme,
        heldDarkTheme: this.appearanceHeldDarkTheme,
        extendThemeGroupList: this.extendThemeGroupList
      })
      this.appearanceHeldLightTheme = resolved.heldLightTheme
      this.appearanceHeldDarkTheme = resolved.heldDarkTheme
      if (resolved.changed) this.applyAppearanceTheme(resolved.theme)
    },

    // 本地日夜间偏好与房间主题不一致时（例如浅色主题 + 夜间），启动后立刻对齐。
    ensureAppearanceThemeAligned() {
      if (!this.mindMap) return
      this.adaptThemeToAppearance(!!this.isDark)
      this.syncCanvasDarkBackground()
    },

    applyAppearanceTheme(template) {
      if (!this.mindMap || !template) return
      if (this.mindMap.getTheme() === template) return
      this.adaptingAppearanceTheme = true
      try {
        this.mindMap.setTheme(template)
        const config = this.mindMap.getCustomThemeConfig
          ? this.mindMap.getCustomThemeConfig()
          : {}
        storeData({
          theme: {
            template,
            config: config || {}
          }
        })
        if (this.mindMapData && this.mindMapData.theme) {
          this.mindMapData.theme.template = template
        }
      } finally {
        this.$nextTick(() => {
          this.adaptingAppearanceTheme = false
        })
      }
    },

    setCanvasDarkFallback(enabled) {
      this.useDarkCanvasFallback = !!enabled
      const el = this.mindMap
        ? this.mindMap.el
        : this.$refs.mindMapContainer
      if (el && el.classList) {
        el.classList.toggle('isCanvasDarkFallback', !!enabled)
      }
    },

    syncCanvasDarkBackground() {
      const mindMap = this.mindMap
      if (!mindMap || !mindMap.el) return
      const el = mindMap.el
      const themeConfig = mindMap.themeConfig || {}
      // 过渡中禁止夜间兜底，避免“浅色主题已切换但 isDark 未稳”时出现黑底黑字闪帧。
      const useFallback =
        !this.appearanceTransitioning &&
        this.isDark &&
        !this.isCurrentThemeDark() &&
        !this.isLikelyDarkColor(themeConfig.backgroundColor)
      this.setCanvasDarkFallback(useFallback)
      if (useFallback) return
      el.style.backgroundColor = themeConfig.backgroundColor || ''
      if (themeConfig.backgroundImage && themeConfig.backgroundImage !== 'none') {
        el.style.backgroundImage = `url(${themeConfig.backgroundImage})`
        el.style.backgroundRepeat = themeConfig.backgroundRepeat || ''
        el.style.backgroundPosition = themeConfig.backgroundPosition || ''
        el.style.backgroundSize = themeConfig.backgroundSize || ''
      } else {
        el.style.backgroundImage = 'none'
      }
    },

    prepareInitialCanvasBackground() {
      // 协作房间会先用默认主题创建画布，再异步恢复房间主题。先加深色兜底类，
      // 避免初始化与刷新期间出现一帧白底。
      this.setCanvasDarkFallback(this.isDark)
    },

    onViewThemeChange() {
      if (!this.adaptingAppearanceTheme && this.mindMap) {
        const current = this.mindMap.getTheme()
        if (this.isCurrentThemeDark(current)) {
          this.appearanceHeldDarkTheme = current
        } else {
          this.appearanceHeldLightTheme = current
        }
      }
      this.syncCanvasDarkBackground()
    },

    bindCanvasThemeEvents() {
      if (!this.mindMap) return
      this.mindMap.on('node_tree_render_start', this.syncCanvasDarkBackground)
      this.mindMap.on('view_theme_change', this.onViewThemeChange)
      this.mindMap.on('node_click', this.onGeneralizationNodeClick)
      this.mindMap.on('node_tree_render_end', this.markGeneralizationClickable)
    },

    unbindCanvasThemeEvents() {
      if (!this.mindMap) return
      this.mindMap.off('node_tree_render_start', this.syncCanvasDarkBackground)
      this.mindMap.off('view_theme_change', this.onViewThemeChange)
      this.mindMap.off('node_click', this.onGeneralizationNodeClick)
      this.mindMap.off('node_tree_render_end', this.markGeneralizationClickable)
    },

    /**
     * 概要点不是一个真正的节点，不能当「运行」的落点：
     * 点它之后把选中切回它所属的那个节点（点概要 = 选中「按它继续」，
     * 派发由工具栏「运行」按钮做；这里只负责把选中状态掰回来 ——
     * active() 是在 emit 之后同步跑的，所以推到下一 tick）。
     */
    onGeneralizationNodeClick(node) {
      if (!node || !node.isGeneralization || !this.mindMap) return
      const owner = node.generalizationBelongNode || node.parent
      if (!owner) return
      this.$nextTick(() => {
        const renderer = this.mindMap && this.mindMap.renderer
        if (!renderer) return
        if (renderer.clearActiveNodeList) renderer.clearActiveNodeList()
        if (renderer.addNodeToActiveList) renderer.addNodeToActiveList(owner)
        if (renderer.emitNodeActiveEvent) renderer.emitNodeActiveEvent(owner)
      })
    },

    /** 概要点做成「像能点的」：手型鼠标 + 悬停提示（渲染完顺手刷一遍） */
    markGeneralizationClickable() {
      const renderer = this.mindMap && this.mindMap.renderer
      if (!renderer || !renderer.root) return
      // 渲染结束事件比较密，200ms 内最多刷一次光标
      const now = Date.now()
      if (now - (this.genCursorAt || 0) < 200) return
      this.genCursorAt = now
      const walk = node => {
        if (!node) return
        const list = node._generalizationList || []
        list.forEach(item => {
          const gen = item && item.generalizationNode
          const el = gen && gen.group && gen.group.node
          if (!el || !el.style) return
          if (el.style.cursor !== 'pointer') el.style.cursor = 'pointer'
          const tip = '点这里选中这条概要，再点工具栏「运行」接着执行'
          if (el.getAttribute('title') !== tip) el.setAttribute('title', tip)
        })
        const children = node.children || []
        children.forEach(walk)
      }
      walk(renderer.root)
    },

    // 获取思维导图数据，实际应该调接口获取
    async getData() {
      const data = await getDataAsync()
      if (this._editorDisposed) return
      this.mindMapData = data
      const prepared = prepareImportedTree(this.mindMapData)
      this.mindMapData = prepared.data
      this.isLargeMap = prepared.collapsed
      this.mindMapConfig = getConfig() || {}
    },

    // 存储数据当数据有变时
    bindSaveEvent() {
      this.$bus.$on('data_change', this.onSaveDataChange)
      this.$bus.$on('view_data_change', this.onSaveViewChange)
    },

    onSaveDataChange(data, change) {
      if (this._editorDisposed) return
      this.pendingStoreData = true
      // Keep the live render tree outside Vue observation. A full snapshot is
      // made only when a physical draft is due, not for each content event.
      this._pendingSaveData = change && (change.incremental || change.full) ? null : data
      const collaborate = this.mindMap && this.mindMap.cooperate && this.mindMap.cooperate.collabV2Adapter
      if (collaborate && this.storeDataTimer && this._saveTimerV2) return
      clearTimeout(this.storeDataTimer)
      this._saveTimerV2 = !!collaborate
      this.storeDataTimer = setTimeout(() => this.flushStoreData(), collaborate ? 3000 : (this.isLargeMap ? 1000 : 300))
    },

    onSaveViewChange(data) {
      if (this._editorDisposed) return
      this._pendingSaveView = data
      clearTimeout(this.storeConfigTimer)
      this.storeConfigTimer = setTimeout(() => this.flushStoreData(), 300)
    },

    flushStoreData(force = false) {
      if (this._editorDisposed) return
      const pending = {}
      if (this.pendingStoreData) {
        pending.root = this._pendingSaveData || (this.mindMap && this.mindMap.command.getCopyData())
      }
      if (this._pendingSaveView) pending.view = this._pendingSaveView
      clearTimeout(this.storeDataTimer)
      clearTimeout(this.storeConfigTimer)
      this.storeDataTimer = null
      this._saveTimerV2 = false
      this.storeConfigTimer = null
      this.pendingStoreData = null
      this._pendingSaveData = null
      this._pendingSaveView = null
      if (Object.keys(pending).length) return storeData(pending, { room: this._saveRoomKey, force })
    },

    // 手动保存
    manualSave() {
      if (this.storeDataTimer) {
        clearTimeout(this.storeDataTimer)
        this.storeDataTimer = null
      }
      this.pendingStoreData = null
      if (this.mindMap) storeData(this.mindMap.getData(true), { room: this._saveRoomKey, force: true })
    },

    commitOpenTextEdit() {
      const editor =
        this.mindMap &&
        this.mindMap.renderer &&
        this.mindMap.renderer.textEdit
      if (editor && typeof editor.hideEditTextBox === 'function') {
        editor.hideEditTextBox()
      }
    },

    async prepareReload(done, options = {}) {
      try {
        this.commitOpenTextEdit()
        this.manualSave()
        if (this.storeConfigTimer) {
          clearTimeout(this.storeConfigTimer)
          this.storeConfigTimer = null
        }
        const cooperate = this.mindMap && this.mindMap.cooperate
        if (cooperate && typeof cooperate.flushPendingForReload === 'function') {
          const result = await cooperate.flushPendingForReload({ timeoutMs: 4000 })
          if (options.retryPending && result && (!result.ok || result.timeout)) {
            if (typeof done === 'function') done({ ...result, ok: false })
            return
          }
        }
        const adapter = cooperate && cooperate.collabV2Adapter
        if (options.retryPending && adapter && typeof adapter.retryPending === 'function') {
          // drain 的服务器确认由导航栏等待，不阻塞准备阶段的回调。
          Promise.resolve(adapter.retryPending()).catch(err => {
            console.warn('[mapNav] retry pending save failed', err)
          })
        }
        if (typeof done === 'function') done({ ok: true })
      } catch (err) {
        if (typeof done === 'function') done({ ok: false, error: err })
      }
    },

    // 初始化
    init() {
      let hasFileURL = this.hasFileURL()
      let { root, layout, theme, view } = this.mindMapData
      const config = this.mindMapConfig
      // 如果url中存在要打开的文件，那么思维导图数据、主题、布局都使用默认的
      if (hasFileURL || this.$route.query.room) {
        // 只用来把引擎立起来。房间模式下这个空根节点会一直藏着，
        // 直到 CooperateDialog 把服务端的树画完。
        root = {
          data: {
            text: this.$t('edit.root')
          },
          children: []
        }
        if (this.$route.query.room) {
          this.isLargeMap = true
        }
        layout = exampleData.layout
        theme = exampleData.theme
        view = null
      }
      this.prepareInitialCanvasBackground()
      this.mindMap = new MindMap({
        historyCopyRoomKey: roomFromLocation(this.$route) || '',
        el: this.$refs.mindMapContainer,
        data: root,
        fit: false,
        layout: layout,
        theme: theme.template,
        themeConfig: theme.config,
        viewData: view,
        nodeTextEditZIndex: 1000,
        nodeNoteTooltipZIndex: 1000,
        // 评论未读红点：已读时间保存在本地，按用户 + 导图 + 节点区分
        isNodeCommentUnread: node =>
          isNodeCommentUnread(
            roomFromLocation(this.$route) || '',
            node,
            currentCommentUser().userId
          ),
        customNoteContentShow: {
          show: (content, left, top, node) => {
            this.$bus.$emit('showNoteContent', content, left, top, node)
          },
          hide: () => {
            // this.$bus.$emit('hideNoteContent')
          }
        },
        openRealtimeRenderOnNodeTextEdit: true,
        enableAutoEnterTextEditWhenKeydown: true,
        onlyOneEnableActiveNodeOnCooperate: true,
        collabV2Only: getRuntimeConfig().collabV2 !== false,
        demonstrateConfig: {
          openBlankMode: false
        },
        ...(config || {}),
        customHyperlinkJump: url => this.openHyperlink(url),
        // 选中状态直接使用节点自身的边框。
        hoverRectColor: '#246bff',
        hoverRectPadding: 0,
        dragOpacityConfig: {
          beingDragNodeOpacity: 0.3,
          ...((config && config.dragOpacityConfig) || {}),
          cloneNodeOpacity: 0.9
        },
        ...(this.isLargeMap
          ? {
              openPerformance: true,
              openRealtimeRenderOnNodeTextEdit: false
            }
          : {}),
        iconList: [...icon],
        useLeftKeySelectionRightKeyDrag: this.useLeftKeySelectionRightKeyDrag,
        customInnerElsAppendTo: null,
        customHandleClipboardText: handleClipboardText,
        customHandleClipboardData: async payload => {
          const roomKey = roomFromLocation(this.$route)
          let notice = null
          try {
            const trees = await copyNodeAttachments(payload, roomKey, () => {
              notice = this.$message({ message: '正在复制附件，请稍候…', type: 'info', duration: 0 })
            })
            if (roomFromLocation(this.$route) !== roomKey) throw new Error('脑图已切换，请重新粘贴')
            return trees
          } catch (error) {
            this.$message.error('粘贴失败：' + (error.message || '附件复制失败'))
            throw error
          } finally {
            if (notice) notice.close()
          }
        },
        defaultNodeImage: require('../../../assets/img/图片加载失败.svg'),
        initRootNodePosition: ['center', 'center'],
        handleIsSplitByWrapOnPasteCreateNewNode: () => {
          return this.$confirm(
            this.$t('edit.splitByWrap'),
            this.$t('edit.tip'),
            {
              confirmButtonText: this.$t('edit.yes'),
              cancelButtonText: this.$t('edit.no'),
              type: 'warning'
            }
          )
        },
        errorHandler: (code, err) => {
          console.error(err)
          switch (code) {
            case 'export_error':
              this.$message.error(this.$t('edit.exportError'))
              break
            default:
              break
          }
        },
        addContentToFooter: () => {
          const text = this.extraTextOnExport.trim()
          if (!text) return null
          const el = document.createElement('div')
          el.className = 'footer'
          el.innerHTML = text
          const cssText = `
            .footer {
              width: 100%;
              height: 30px;
              display: flex;
              justify-content: center;
              align-items: center;
              font-size: 12px;
              color: #979797;
            }
          `
          return {
            el,
            cssText,
            height: 30
          }
        },
        beforeDeleteNodeImg: () => {
          return new Promise(resolve => {
            this.$confirm(
              this.$t('edit.deleteNodeImgTip'),
              this.$t('edit.tip'),
              {
                confirmButtonText: this.$t('edit.yes'),
                cancelButtonText: this.$t('edit.no'),
                type: 'warning'
              }
            )
              .then(() => {
                resolve(false)
              })
              .catch(() => {
                resolve(true)
              })
          })
        }
      })
      if (this._stopPerformanceDiagnostics) this._stopPerformanceDiagnostics()
      this._stopPerformanceDiagnostics = startPerformanceDiagnostics(this.mindMap, roomFromLocation(this.$route) || '', this.$bus)
      if (this.isLargeMap && !this.$route.query.room) {
        this.mindMap.renderer._forceOverviewPaintOnce = true
        const fitOverview = () => {
          this.mindMap.off('render_complete', fitOverview)
          this.mindMap.view.fit()
        }
        this.mindMap.on('render_complete', fitOverview)
      }
      this.bindCanvasThemeEvents()
      this.ensureAppearanceThemeAligned()
      this.loadPlugins()
      this.mindMap.keyCommand.addShortcut('Control+s', () => {
        this.manualSave()
      })
      // 转发事件
      ;[
        'node_active',
        'data_change',
        'view_data_change',
        'back_forward',
        'node_contextmenu',
        'node_click',
        'node_dblclick',
        'draw_click',
        'expand_btn_click',
        'svg_mousedown',
        'mouseup',
        'mode_change',
        'node_tree_render_end',
        'rich_text_selection_change',
        'transforming-dom-to-images',
        'generalization_node_contextmenu',
        'painter_start',
        'painter_end',
        'scrollbar_change',
        'scale',
        'translate',
        'node_attachmentClick',
        'node_attachmentContextmenu',
        'node_hyperlinkClick',
        'node_commentClick',
        'demonstrate_jump',
        'exit_demonstrate',
        'node_note_dblclick',
        'node_mousedown',
        'node_mouseup',
        'map_ref_click',
        'multi_select_end'
      ].forEach(event => {
        this.mindMap.on(event, (...args) => {
          this.$bus.$emit(event, ...args)
        })
      })
      this.bindSaveEvent()
      // 如果应用被接管，那么抛出事件传递思维导图实例
      if (window.takeOverApp) {
        this.$bus.$emit('app_inited', this.mindMap)
      }
      // 解析url中的文件
      if (hasFileURL) {
        this.$bus.$emit('handle_file_url')
      }
      // api/index.js文件使用
      // 当正在编辑本地文件时通过该方法获取最新数据
      this._getCurrentData = () => {
        const fullData = this.mindMap.getData(true)
        return { ...fullData }
      }
      Vue.prototype.getCurrentData = this._getCurrentData
      this.syncCanvasDarkBackground()
    },

    // 加载相关插件
    loadPlugins() {
      if (this.openNodeRichText) this.addRichTextPlugin()
      if (this.isShowScrollbar) this.addScrollbarPlugin()
    },

    // url中是否存在要打开的文件
    hasFileURL() {
      const fileURL = this.$route.query.fileURL
      if (!fileURL) return false
      return /\.(smm|json|xmind|md|xlsx)$/.test(fileURL)
    },

    // 动态设置思维导图数据
    async setData(data, options = {}) {
      const quiet = !!(options && options.quiet)
      const isUserImport = !(options && options.fromSaved)
      let prepared = null
      if (!quiet) this.handleShowLoading(this.$t('edit.importingTip'))
      await yieldToUi()
      const cooperate = this.mindMap && this.mindMap.cooperate
      const persistReplace =
        isUserImport &&
        cooperate &&
        cooperate.httpCollabMode &&
        typeof cooperate.persistHttpReplace === 'function' &&
        typeof cooperate.httpReplaceTree === 'function'
      if (!(options && options.fromSaved)) {
        prepared = prepareImportedTree(data, { prune: !persistReplace })
        data = prepared.data
      } else if (this.mindMap) {
        this.isLargeMap = true
        this.mindMap.updateConfig({
          openPerformance: true,
          openRealtimeRenderOnNodeTextEdit: false,
          isShowExpandNum: true
        })
      }
      const nodeCount = (prepared && prepared.nodeCount) || 0
      if (this.mindMap && nodeCount >= 100) {
        this.isLargeMap = true
        this.mindMap.updateConfig({
          openPerformance: true,
          openRealtimeRenderOnNodeTextEdit: false,
          isShowExpandNum: nodeCount >= 200
        })
        if (prepared && prepared.collapsed && !quiet) {
          this.$message.info(this.$t('edit.largeMapImportTip'))
        }
      }
      const loadingMs =
        nodeCount >= 400
          ? Math.min(600000, Math.max(120000, nodeCount * 20))
          : 30000
      if (!quiet && nodeCount >= 400) {
        this.handleShowLoading(this.$t('edit.importingTip'), {
          timeout: loadingMs,
          percent: 8,
          detail: this.$t('edit.importSavingParse')
        })
      }
      if (persistReplace) cooperate.beginHttpReplace()
      let rootNodeData = null
      let importDone = !isUserImport
      let savedPaint = null
      let savedPaintNotified = false
      const notifySavedPaint = () => {
        if (savedPaintNotified) return
        savedPaintNotified = true
        if (options && typeof options.onReady === 'function') options.onReady()
      }
      const prevReadonly = !!(this.mindMap && this.mindMap.opt && this.mindMap.opt.readonly)
      try {
        rootNodeData = data.root || data
        if (persistReplace) {
          this.importPersistLock = true
          if (this.mindMap && typeof this.mindMap.updateConfig === 'function') {
            this.mindMap.updateConfig({ readonly: true })
          }
          if (!quiet) {
            this.handleShowLoading(this.$t('edit.importSavingTip'), {
              timeout: loadingMs,
              percent: 12,
              detail: this.$t('edit.importSavingUpload')
            })
          }
          this.startImportProgressPoll(cooperate.httpRoomKey)
          await cooperate.persistHttpReplace(
            data.root ? { root: data.root } : { root: rootNodeData },
            {
              allowFullTree: true,
              source: 'import',
              reason: 'IMPORT',
              feature: 'import',
              parseResult: 'ok',
              onUploadProgress: evt => {
                const uploadPct = Number(evt && evt.percent) || 0
                this.updateImportProgress(
                  Math.min(35, 12 + Math.round(uploadPct * 0.23)),
                  this.$t('edit.importSavingUpload')
                )
              }
            }
          )
          this.updateImportProgress(96, this.$t('edit.importSavingApply'))
        }
        if (
          persistReplace &&
          cooperate &&
          typeof cooperate.applyAuthoritativeTreeReplace === 'function'
        ) {
          cooperate.applyAuthoritativeTreeReplace(
            rootNodeData,
            'IMPORT',
            { fullData: data.root ? data : { root: rootNodeData } }
          )
        } else if (data.root) {
          if (options && options.fromSaved) savedPaint = this.waitForNextTreePaint()
          this.mindMap.setFullData(data)
        } else {
          if (options && options.fromSaved) savedPaint = this.waitForNextTreePaint()
          this.mindMap.setData(data)
        }
        if (persistReplace && rootNodeData) {
          if (typeof cooperate.resyncHttpBaseline === 'function') {
            cooperate.resyncHttpBaseline(rootNodeData)
          } else if (typeof cooperate.markTreeUids === 'function') {
            cooperate.markTreeUids(rootNodeData)
          }
          if (typeof cooperate.seedPreviewHydration === 'function') {
            cooperate.seedPreviewHydration(rootNodeData)
          }
        }
        this.mindMap.view.reset()
        await yieldToUi()
        if (savedPaint) await savedPaint
        notifySavedPaint()
        if (persistReplace && cooperate) {
          await new Promise(resolve => {
            let settled = false
            const done = () => {
              if (settled) return
              settled = true
              this.mindMap.off('node_tree_render_end', done)
              resolve()
            }
            this.mindMap.on('node_tree_render_end', done)
            setTimeout(done, nodeCount >= 400 ? 4000 : 1200)
          })
          if (typeof cooperate.captureHttpBaselineFromRenderer === 'function') {
            cooperate.captureHttpBaselineFromRenderer()
          }
        }
        if (!persistReplace && isUserImport) {
          this.manualSave()
        }
        importDone = true
      } catch (err) {
        if (persistReplace) {
          try {
            if (typeof cooperate.restoreHttpTree === 'function') {
              await cooperate.restoreHttpTree()
            }
          } catch (restoreErr) {
            console.error('[mind-map] restore after import failed', restoreErr)
          }
          const serializeFailed =
            (err &&
              (err.code === 'OUTBOX_NON_CLONEABLE_PAYLOAD' ||
                err.code === 'IMPORT_OUTBOX_SERIALIZE_FAILED' ||
                err.stage === 'IMPORT_OUTBOX_SERIALIZE_FAILED')) ||
            /DataCloneError|OUTBOX_NON_CLONEABLE_PAYLOAD|could not be cloned/.test(
              String((err && err.message) || '')
            )
          const code = (err && err.code) || ''
          this.$message.error(
            serializeFailed
              ? 'IMPORT_OUTBOX_SERIALIZE_FAILED'
              : code === 'IMPORT_TOO_LARGE'
                ? 'IMPORT_TOO_LARGE'
                : code === 'IMPORT_APPLY_FAILED'
                  ? 'IMPORT_APPLY_FAILED'
                  : code === 'STALE_AFTER_VERSION_RESTORE'
                    ? '脑图已恢复到新版本，请刷新页面后重新导入'
                  : (err && err.message) || this.$t('edit.importPersistFailed')
          )
        }
        if (isUserImport) {
          this.$bus.$emit('setDataFailed', {
            code: (err && err.code) || 'IMPORT_APPLY_FAILED',
            stage: (err && err.stage) || 'IMPORT_APPLY_FAILED',
            message: (err && err.message) || '',
            notified: !!persistReplace
          })
        } else if (options && options.fromSaved) {
          console.error('[edit] saved tree paint failed', err)
          notifySavedPaint()
        } else {
          throw err
        }
      } finally {
        this.importPersistLock = false
        this.stopImportProgressPoll()
        if (this.mindMap && typeof this.mindMap.updateConfig === 'function') {
          this.mindMap.updateConfig({ readonly: prevReadonly })
        }
        if (persistReplace) {
          cooperate.endHttpReplace(
            importDone ? { liveImmediately: true } : {}
          )
        }
        if (!quiet) this.handleHideLoading()
      }
      if (isUserImport && importDone) {
        this.$bus.$emit('setDataComplete')
      }
      // 如果导入的是富文本内容，那么自动开启富文本模式
      if (rootNodeData && rootNodeData.data && rootNodeData.data.richText && !this.openNodeRichText) {
        this.$bus.$emit('toggleOpenNodeRichText', true)
        this.$notify.info({
          title: this.$t('edit.tip'),
          message: this.$t('edit.autoOpenNodeRichTextTip')
        })
      }
    },

    waitForNextTreePaint() {
      return new Promise(resolve => {
        if (!this.mindMap) {
          resolve()
          return
        }
        // 必须是这次 setData 触发的绘制。打开时占位根节点的绘制可能还没结束，
        // 不能把它当成真实树已经画完。
        let armed = false
        let started = false
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (!this.mindMap) {
            resolve()
            return
          }
          this.mindMap.off('set_data', onSet)
          this.mindMap.off('node_tree_render_start', onStart)
          this.mindMap.off('node_tree_render_end', onEnd)
          resolve()
        }
        const onSet = () => {
          armed = true
        }
        const onStart = () => {
          if (armed) started = true
        }
        const onEnd = () => {
          if (started) finish()
        }
        this.mindMap.on('set_data', onSet)
        this.mindMap.on('node_tree_render_start', onStart)
        this.mindMap.on('node_tree_render_end', onEnd)
        const timer = setTimeout(finish, 8000)
      })
    },

    // 重新渲染
    reRender() {
      this.mindMap.reRender()
    },

    // 执行命令
    execCommand(...args) {
      const name = args[0]
      const needsSelection = {
        ADD_GENERALIZATION: true,
        ADD_OUTER_FRAME: true,
        INSERT_NODE: true,
        INSERT_CHILD_NODE: true,
        INSERT_PARENT_NODE: true,
        REMOVE_NODE: true,
        REMOVE_CURRENT_NODE: true,
        SET_NOTATION: true
      }
      if (
        needsSelection[name] &&
        this.mindMap.cooperate &&
        typeof this.mindMap.cooperate.ensureActiveSelection === 'function'
      ) {
        this.mindMap.cooperate.ensureActiveSelection()
      }
      this.mindMap.execCommand(...args)
    },

    /** 原子写入子脑图引用 + 企业微信卡片样式 */
    applySubMapToNode(payload) {
      const result =
        payload && payload.result && typeof payload.result === 'object'
          ? payload.result
          : { ok: false }
      try {
        if (!this.mindMap || !this.mindMap.renderer) {
          result.ok = false
          result.error = 'mindMap missing'
          return result.ok
        }
        const ref = normalizeMapRef(
          payload && (payload.mapRef || payload.ref)
        )
        if (!ref) {
          result.ok = false
          result.error = 'invalid mapRef'
          return result.ok
        }
        let node = payload && payload.node
        const uid =
          (payload && payload.uid) ||
          (node && node.getData && node.getData('uid')) ||
          ''
        if (uid && typeof this.mindMap.renderer.findNodeByUid === 'function') {
          const live = this.mindMap.renderer.findNodeByUid(uid)
          if (live) node = live
        }
        if (
          !node &&
          this.mindMap.renderer.activeNodeList &&
          this.mindMap.renderer.activeNodeList[0]
        ) {
          node = this.mindMap.renderer.activeNodeList[0]
        }
        if (!node || typeof node.getData !== 'function') {
          result.ok = false
          result.error = 'node missing'
          return result.ok
        }
        const text =
          String(
            (payload && payload.title) || ref.mapId || '子脑图'
          ).trim() || '子脑图'
        // 一次写入，避免多次 command 互相覆盖
        this.mindMap.renderer.setNodeDataRender(node, {
          mapRef: ref,
          text,
          richText: false,
          resetRichText: true,
          shape: 'roundedRectangle',
          fillColor: '#F2F3F5',
          borderColor: 'transparent',
          borderWidth: 0,
          color: '#1F2329',
          fontSize: 14,
          fontWeight: 'normal',
          paddingX: 10,
          paddingY: 8
        })
        // 再显式走 SET_NODE_MAP_REF，便于协同推送 mapRef 字段
        this.mindMap.execCommand('SET_NODE_MAP_REF', node, ref)
        const saved = normalizeMapRef(node.getData('mapRef'))
        result.ok = !!saved
        result.uid = node.getData('uid') || uid
        if (!result.ok) result.error = 'mapRef not persisted'
        return result.ok
      } catch (err) {
        console.error('[applySubMapToNode]', err)
        result.ok = false
        result.error = (err && err.message) || 'apply failed'
        return result.ok
      }
    },

    /**
     * 把一次运行的结果写回导图：运行节点下追加「运行输出 · 时间」子分支，
     * 完整输出与产物文件作为附件挂在上面。
     * 调用方（Toolbar）传一个 result 对象进来拿回执，跟 applySubMapToNode 一个套路。
     */
    /**
     * 派发前先在运行节点下建「任务 · 时间」容器（D 节点走这条）。
     * 这次的任务内容与结果都挂在这个容器节点下，一次运行一个，好追溯。
     */
    onCreateJobContainer(payload) {
      const result =
        payload && payload.result && typeof payload.result === 'object'
          ? payload.result
          : { ok: false }
      const data = payload || {}
      result.promise = (async () => {
        try {
          const out = await createJobContainer({
            mindMap: this.mindMap,
            nodeUid: data.nodeUid,
            prompt: data.prompt
          })
          Object.assign(result, { ok: true }, out, { node: undefined })
        } catch (err) {
          result.ok = false
          result.error = (err && err.message) || '建任务节点失败'
        }
        return result
      })()
      return result.promise
    },

    /**
     * 让 Toolbar 查「某条运行的结果在不在图上」——刷新后自动补写的判据
     * （2026-10-09 用户要求：识别到任务内容没挂在节点、且运行已完成 → 刷新后自动重写）。
     */
    onProbeJobResult(payload) {
      const result =
        payload && payload.result && typeof payload.result === 'object'
          ? payload.result
          : { ok: false }
      const data = payload || {}
      try {
        Object.assign(
          result,
          inspectJobResult({
            mindMap: this.mindMap,
            nodeUid: data.nodeUid,
            // 记录里的 uid 会过期（重连/整树恢复后会换）→ 让探针按标题兜底找回来
            nodeTitle: data.nodeTitle
          })
        )
      } catch (err) {
        result.ok = false
        result.error = (err && err.message) || '查不到这个节点'
      }
      return result
    },

    /**
     * 让 Toolbar 问「本次写回插进去的节点，服务端**确认**了吗」。
     *
     * 为什么要这个判据（2026-10-09 用户反馈「重试写入成功显示没成功，刷新后都显示未同步」）：
     * 原来只按客户端队列判（还有没有没确认的命令 / outbox 积压条数），而那是**全客户端共享的**
     * 计数 —— 服务器 outbox 长期积压两万多条，于是每次写回都被误判成「没同步」。
     * 协同插件自己记了逐节点的账（`Cooperate.ackedUids` / `pendingUids`）：
     *   · pendingUids.has(uid) → 这条插入已提交、服务端还没确认
     *   · isPersistAcked(uid)  → 服务端已经确认过（真落库了）
     * 这里把「我这次的节点」逐一对一遍，只认这个结论。
     */
    onProbeJobAck(payload) {
      const result =
        payload && payload.result && typeof payload.result === 'object'
          ? payload.result
          : { ok: false }
      const uids = ((payload && payload.uids) || [])
        .map(uid => String(uid || '').trim())
        .filter(Boolean)
      const cooperate = this.mindMap && this.mindMap.cooperate
      if (!uids.length) {
        result.hasApi = false
        result.error = '没有要查的节点'
        return result
      }
      if (
        !cooperate ||
        (typeof cooperate.isPersistAcked !== 'function' &&
          !cooperate.pendingUids)
      ) {
        // 老版本 / 没在用协同 → 让调用方回退到原来的口径（别硬给结论）
        result.hasApi = false
        return result
      }
      const pending = cooperate.pendingUids
      const isPending = uid =>
        pending && typeof pending.has === 'function'
          ? pending.has(uid)
          : Array.isArray(pending)
          ? pending.indexOf(uid) !== -1
          : false
      result.hasApi = true
      result.ok = true
      result.pending = uids.filter(isPending)
      // 正面证据：服务端确认过（老版本没有这个 API 时就只给 pending 那份）
      result.acked =
        typeof cooperate.isPersistAcked === 'function'
          ? uids.filter(uid => {
              try {
                return !!cooperate.isPersistAcked(uid)
              } catch (err) {
                return false
              }
            })
          : null
      return result
    },

    /**
     * 给 Toolbar 读一条概要的最新文字（概要点自身的文字存在所属节点的
     * `generalization` 数组里）。点概要时记下 genUid，这里按它取最新的，
     * 所以双击改完文字再点运行，用的就是新文字。
     */
    onReadGeneralization(payload) {
      const result =
        payload && payload.result && typeof payload.result === 'object'
          ? payload.result
          : { ok: false }
      const data = payload || {}
      result.promise = (async () => {
        try {
          const renderer = this.mindMap && this.mindMap.renderer
          const node =
            renderer && typeof renderer.findNodeByUid === 'function'
              ? renderer.findNodeByUid(String(data.nodeUid || ''))
              : null
          if (!node) throw new Error('找不到这个节点')
          const raw = node.getData('generalization')
          const list = Array.isArray(raw) ? raw : raw ? [raw] : []
          if (!list.length) {
            result.ok = true
            result.text = ''
            return result
          }
          const wanted = String(data.genUid || '')
          const hit = wanted
            ? list.find(item => String((item && item.uid) || '') === wanted)
            : null
          const target = hit || list[list.length - 1]
          result.ok = true
          result.text = String((target && target.text) || '')
          result.uid = String((target && target.uid) || '')
          result.count = list.length
        } catch (err) {
          result.ok = false
          result.error = (err && err.message) || '读取概要失败'
        }
        return result
      })()
      return result.promise
    },

    onWriteJobResult(payload) {
      const result =
        payload && payload.result && typeof payload.result === 'object'
          ? payload.result
          : { ok: false }
      const data = payload || {}
      // 调用方（Toolbar）拿 result.promise 等回执，emit 本身不等异步
      result.promise = (async () => {
        try {
          if (!this.mindMap) throw new Error('导图还没准备好')
          const roomKey = data.roomKey || roomFromLocation(this.$route) || ''
          const out = await writeJobResultToMap({
            mindMap: this.mindMap,
            nodeUid: data.nodeUid,
            markdown: data.markdown,
            prompt: data.prompt,
            roomKey,
            artifacts: data.artifacts,
            artifactSkips: data.artifactSkips,
            // 「产物为什么没扫到」的诊断（扫了哪个目录、各命中几个）—— 透传给写回，
            // 产物为空时把原因写进提示，而不是静默只写正文（2026-10-08 反馈）
            artifactDiag: data.artifactDiag,
            bridgeAttach: data.bridgeAttach,
            onProgress: data.onProgress
          })
          Object.assign(result, { ok: true }, out)
        } catch (err) {
          result.ok = false
          result.error = (err && err.message) || '写入导图失败'
        }
        return result
      })()
      return result.promise
    },

    // 导出
    async export(...args) {
      try {
        showLoading()
        await this.mindMap.export(...args)
        hideLoading()
      } catch (error) {
        console.log(error)
        hideLoading()
      }
    },

    // 修改导出内边距
    onPaddingChange(data) {
      this.mindMap.updateConfig(data)
    },

    // 加载节点富文本编辑插件
    addRichTextPlugin() {
      if (!this.mindMap) return
      this.mindMap.addPlugin(RichText)
    },

    // 移除节点富文本编辑插件
    removeRichTextPlugin() {
      this.mindMap.removePlugin(RichText)
    },

    // 加载滚动条插件
    addScrollbarPlugin() {
      if (!this.mindMap) return
      this.mindMap.addPlugin(ScrollbarPlugin)
    },

    // 移除滚动条插件
    removeScrollbarPlugin() {
      this.mindMap.removePlugin(ScrollbarPlugin)
    },

    // 拖拽文件到页面导入
    onDragenter() {
      if (!this.enableDragImport || this.isDragOutlineTreeNode) return
      this.showDragMask = true
    },

    onDragleave() {
      this.showDragMask = false
    },

    onDrop(e) {
      if (!this.enableDragImport) return
      this.showDragMask = false
      const dt = e.dataTransfer
      const file = dt.files && dt.files[0]
      if (!file) return
      this.$bus.$emit('importFile', file)
    }
  }
}
</script>

<style lang="less" scoped>
@import (reference) '../../../style/notch.less';

.editContainer {
  position: fixed;
  left: 0;
  right: 0;
  top: 0;
  bottom: 0;

  // 刘海外框：8px 外框 + 圆角内画布。四角工具栏以外框色「长」在画布角上。
  &.hasCanvasFrame {
    background-color: var(--mm-notch-frame);

    .mindMapContainer {
      left: @mm-frame-width;
      top: @mm-frame-width;
      width: calc(100% - @mm-frame-width * 2);
      height: calc(100% - @mm-frame-width * 2);
      border-radius: @mm-canvas-radius;
      overflow: hidden;
    }
  }

  // 演示模式会把画布容器本身全屏，此时去掉圆角
  .mindMapContainer:fullscreen {
    border-radius: 0;
  }

  .dragMask {
    position: absolute;
    left: 0;
    top: 0;
    width: 100%;
    height: 100%;
    background-color: rgba(255, 255, 255, 0.8);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 3999;

    .dragTip {
      pointer-events: none;
      font-weight: bold;
    }
  }

  .mindMapContainer {
    position: absolute;
    left: 0px;
    top: 0px;
    width: 100%;
    height: 100%;

    // 渲染器会在每次节点树重绘前重设行内背景。夜间模式用高优先级画布类
    // 覆盖浅色主题，避免新增节点或刷新时闪出白色帧。
    &.isCanvasDarkFallback {
      background-color: #262a2e !important;
      background-image: none !important;
    }

    // 占位根节点仍会画进 SVG，但不能参与显示，否则刷新时会先闪出「根节点」。
    &.isRoomCanvasPending {
      visibility: hidden;
    }
  }
}
</style>

<style lang="less">
@import (reference) '../../../style/notch.less';

// 刘海外框 / 工具栏调色板（浅色默认，body.isDark 时切深色）
body {
  .mm-notch-palette-light();
}
body.isDark {
  .mm-notch-palette-dark();
}

/* SVG 节点由脑图库动态插入，选中框需要使用非 scoped 样式。 */
#mindMapContainer .smm-node.active .smm-hover-node {
  display: none !important;
}

#mindMapContainer .smm-drag-preview .smm-hover-node {
  display: block;
  opacity: 1;
  stroke: #246bff;
  stroke-width: 3;
  pointer-events: none;
}

#mindMapContainer rect.smm-drag-preview {
  stroke: #246bff;
  stroke-width: 3;
}

/* 日夜间画布交叉淡入（View Transition），保持短促以免感觉「闪一下」 */
::view-transition-group(mind-map-appearance) {
  animation-duration: 0.18s;
  animation-timing-function: ease;
}

::view-transition-old(mind-map-appearance),
::view-transition-new(mind-map-appearance) {
  animation-duration: 0.18s;
  animation-timing-function: ease;
  mix-blend-mode: normal;
  height: 100%;
  object-fit: none;
}

@media (prefers-reduced-motion: reduce) {
  ::view-transition-group(mind-map-appearance),
  ::view-transition-old(mind-map-appearance),
  ::view-transition-new(mind-map-appearance) {
    animation: none !important;
  }
}
</style>
