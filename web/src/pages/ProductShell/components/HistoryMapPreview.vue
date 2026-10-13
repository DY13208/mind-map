<template>
  <div class="historyMapPreview">
    <div class="previewToolbar" role="toolbar" aria-label="预览视图">
      <el-button-group>
        <el-button
          size="mini"
          :type="viewMode === 'fit' ? 'primary' : ''"
          :aria-pressed="String(viewMode === 'fit')"
          @click="fit"
          >适应窗口</el-button
        >
        <el-button
          size="mini"
          :type="viewMode === 'expanded' ? 'primary' : ''"
          :aria-pressed="String(viewMode === 'expanded')"
          @click="expandAll"
          >展开</el-button
        >
        <el-button
          size="mini"
          :type="viewMode === 'collapsed' ? 'primary' : ''"
          :aria-pressed="String(viewMode === 'collapsed')"
          @click="collapseAll"
          >折叠</el-button
        >
        <el-button v-if="expanding" size="mini" @click="cancelExpand">取消展开 {{ expandProgress }}%</el-button>
      </el-button-group>
      <div class="copyTools">
        <span role="status">已选 {{ selection.branchCount }} 个分支，共 {{ selection.nodeCount }} 个节点</span>
        <el-button size="mini" :disabled="!selection.branchCount || loading || !!error" :loading="copying" @click="copySelected">复制选中分支</el-button>
      </div>
    </div>
    <div v-if="loading" class="previewState">正在加载预览…</div>
    <div v-else-if="error" class="previewState error">{{ error }}<el-button size="mini" @click="$emit('retry')">重试</el-button></div>
    <div
      v-show="!loading && !error"
      ref="canvas"
      tabindex="0"
      class="previewCanvas"
      data-testid="history-preview"
    ></div>
    <div v-if="note" class="noteCard">
      <strong>备注</strong>
      <p>{{ note }}</p>
      <el-button type="text" size="mini" @click="note = ''">关闭</el-button>
    </div>
  </div>
</template>
<script>
import MindMap from 'simple-mind-map'
import Select from 'simple-mind-map/src/plugins/Select'
import { prepareHistorySnapshot, extractHistoryBranches, summarizeHistoryBranches } from '@/utils/historySnapshot'
import { setHistoryCopy } from 'simple-mind-map/src/utils/historyClipboard'
import { withExpandMode } from '@/utils/historyTree'

const PREVIEW_DISABLED_PLUGINS = [
  'cooperate',
  'drag',
  'demonstrate',
  'search',
  'painter',
  'keyboardNavigation',
  'miniMap',
  'touchEvent',
  'nodeImgAdjust',
  'doExport',
  'doExportPDF',
  'doExportXMind',
  'watermark'
]
const ROOT_PAGE_SIZE = 48
const MORE_UID = '__history_preview_more__'

export default {
  name: 'HistoryMapPreview',
  props: {
    tree: { type: Object, default: null },
    metadata: { type: Object, default: () => ({}) },
    roomKey: { type: String, default: '' },
    loading: Boolean,
    error: { type: String, default: '' }
  },
  data() {
    return {
      note: '',
      viewMode: 'fit',
      resizeObserver: null,
      mounting: false,
      mountAgain: false,
      expanding: false,
      expandProgress: 0,
      selection: { branchCount: 0, nodeCount: 0, uids: [] },
      copying: false
    }
  },
  watch: {
    tree() {
      this.clearSelection()
      this.note = ''
      this.viewMode = 'fit'
      this.scheduleMount()
    },
    loading(value) {
      if (value) {
        this.clearSelection()
        this.cancelExpand()
      }
      else this.scheduleMount()
    }
  },
  mounted() {
    this.mount()
  },
  beforeDestroy() {
    this.teardown()
    window.removeEventListener('keydown', this.onCopyKey, true)
  },
  methods: {
    bindCopyKey() {
      window.removeEventListener('keydown', this.onCopyKey, true)
      window.addEventListener('keydown', this.onCopyKey, true)
    },
    clearSelection() {
      this._copyToken = (this._copyToken || 0) + 1
      this.copying = false
      this.selection = { branchCount: 0, nodeCount: 0, uids: [] }
      if (this._preview) this._preview.renderer.clearActiveNodeList()
      this.$emit('selection', this.selection)
    },
    onNodeActive(node, nodes) {
      if (!this._snapshot || this.loading) return
      const uids = (nodes || []).map(item => item.getData('uid')).filter(uid => uid && uid !== MORE_UID)
      try {
        this.selection = summarizeHistoryBranches(this._snapshot, uids)
        this.$emit('selection', this.selection)
      } catch (error) {
        this.clearSelection()
        this.$message.error(error.message || '所选历史节点不可用')
      }
    },
    onCopyKey(event) {
      if (!(event.ctrlKey || event.metaKey) || String(event.key).toLowerCase() !== 'c') return
      const canvas = this.$refs.canvas
      if (!canvas || !canvas.contains(document.activeElement) || this.loading || this.error) return
      const target = event.target
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return
      event.preventDefault()
      event.stopImmediatePropagation()
      this.copySelected()
    },
    async copySelected() {
      if (this.copying || !this.selection.branchCount || this.loading || this.error || !this._snapshot) return
      const token = this._copyToken = (this._copyToken || 0) + 1
      this.copying = true
      try {
        const result = extractHistoryBranches(this._snapshot, this.selection.uids)
        const text = JSON.stringify({ simpleMindMap: true, data: result.trees })
        let copied = false
        if (navigator.clipboard && navigator.clipboard.writeText) {
          try { await navigator.clipboard.writeText(text); copied = true } catch (error) { /* use native fallback */ }
        }
        if (token !== this._copyToken) return
        if (!copied) {
          const input = document.createElement('textarea')
          input.value = text
          input.style.cssText = 'position:fixed;left:-9999px;top:0'
          const focused = document.activeElement
          document.body.appendChild(input)
          input.select()
          try { copied = document.execCommand('copy') } catch (error) { copied = false }
          finally {
            input.remove()
            if (focused && focused.focus) focused.focus()
          }
        }
        if (token !== this._copyToken) return
        setHistoryCopy(this.roomKey, result.trees)
        this.$emit('copied', result)
        if (copied) this.$message.success(`已复制 ${result.nodeCount} 个历史节点，可关闭弹窗后粘贴`)
        else this.$message.warning('系统剪贴板不可用，已保存应用内副本；关闭弹窗后在同一脑图右键粘贴')
      } catch (error) {
        if (token === this._copyToken) this.$message.error(error.message || '复制历史节点失败')
      } finally {
        if (token === this._copyToken) this.copying = false
      }
    },
    scheduleMount() {
      if (this._mountScheduled) return
      this._mountScheduled = true
      this.$nextTick(() => {
        this._mountScheduled = false
        this.mount()
      })
    },
    unbindResize() {
      if (this.resizeObserver) {
        this.resizeObserver.disconnect()
        this.resizeObserver = null
      }
    },
    bindResize() {
      this.unbindResize()
      const el = this.$refs.canvas
      if (!el || typeof ResizeObserver === 'undefined') return
      let last = ''
      this.resizeObserver = new ResizeObserver(entries => {
        const box = entries[0] && entries[0].contentRect
        const key = box ? Math.round(box.width) + 'x' + Math.round(box.height) : ''
        if (!key || key === last) return
        last = key
        this.fitViewOnly()
      })
      this.resizeObserver.observe(el)
    },
    teardown() {
      window.removeEventListener('keydown', this.onCopyKey, true)
      this.clearSelection()
      this._snapshot = null
      this._mountToken = (this._mountToken || 0) + 1
      this.cancelExpand(false)
      this.unbindResize()
      if (this._preview) {
        try {
          if (this._preview.renderer && this._preview.renderer.cancelRender) this._preview.renderer.cancelRender()
          this._preview.off('node_note_click', this.onNote)
          this._preview.off('node_click', this.onNodeClick)
          this._preview.off('render_error', this.onRenderError)
          this._preview.off('node_active', this.onNodeActive)
          this._preview.destroy()
        } catch (err) {
          /* ignore */
        }
        this._preview = null
      }
      const el = this.$refs.canvas
      if (el) el.innerHTML = ''
      this.note = ''
    },
    onNote(node) {
      const data =
        node && typeof node.getData === 'function' ? node.getData() : {}
      this.note = String((data && data.note) || '')
    },
    onRenderError(error) {
      if (!this.loading && this.tree) this.$emit('failed', error)
    },
    onNodeClick(node) {
      if (node && node.getData && node.getData('uid') === MORE_UID) this.loadMoreBranches()
      const canvas = this.$refs.canvas
      if (canvas && canvas.focus) canvas.focus({ preventScroll: true })
    },
    loadMoreBranches() {
      if (this._loadingMoreBranches) return Promise.resolve(false)
      if (!this._preview || !this._pendingRootChildren || !this._pendingRootChildren.length) return Promise.resolve(false)
      const root = this._preview.renderer.renderTree
      if (!root || !root.children) return Promise.resolve(false)
      const index = root.children.findIndex(node => node.data && node.data.uid === MORE_UID)
      if (index < 0) return Promise.resolve(false)
      const next = this._pendingRootChildren.splice(0, ROOT_PAGE_SIZE)
      const replacement = this._pendingRootChildren.length
        ? next.concat(this.moreNode(this._pendingRootChildren.length)) : next
      root.children.splice(index, 1, ...replacement)
      this._loadingMoreBranches = true
      return new Promise(resolve => {
        let settled = false
        const finish = value => {
          if (settled) return
          settled = true
          this._loadingMoreBranches = false
          this._cancelExpandWait = null
          resolve(value)
        }
        this._cancelExpandWait = () => finish(false)
        this._preview.renderer.render(() => finish(true))
      })
    },
    moreNode(count) {
      return { data: { uid: MORE_UID, text: `加载更多（剩余 ${count} 个分支）`, expand: true }, children: [] }
    },
    waitForSize() {
      return new Promise(resolve => {
        let n = 0
        const tick = () => {
          const el = this.$refs.canvas
          if (el && el.clientWidth > 32 && el.clientHeight > 32) {
            resolve(true)
            return
          }
          if (n++ > 40) {
            resolve(false)
            return
          }
          requestAnimationFrame(tick)
        }
        tick()
      })
    },
    mapData() {
      this.clearSelection()
      this._snapshot = prepareHistorySnapshot(this.tree, this.metadata)
      this._sourceTree = this._snapshot.tree
      const data = withExpandMode(
        this._sourceTree,
        this.viewMode === 'expanded' ? 'expanded' : 'overview'
      )
      this._pendingRootChildren = []
      if (data.children && data.children.length > ROOT_PAGE_SIZE) {
        this._pendingRootChildren = data.children.slice(ROOT_PAGE_SIZE)
        data.children = data.children.slice(0, ROOT_PAGE_SIZE)
        data.children.push(this.moreNode(this._pendingRootChildren.length))
      }
      return data
    },
    async mount() {
      if (this.mounting) {
        this.mountAgain = true
        return
      }
      this.mounting = true
      try {
        do {
          this.mountAgain = false
          await this.mountOnce()
        } while (this.mountAgain)
      } finally {
        this.mounting = false
      }
    },
    async mountOnce() {
      let token = this._mountToken = (this._mountToken || 0) + 1
      this.cancelExpand()
      if (!this.loading && !this.tree) this.teardown()
      if (this.loading || this.error || !this.tree || !this.$refs.canvas) return
      await this.$nextTick()
      const ready = await this.waitForSize()
      if (!ready || token !== this._mountToken || !this.tree || !this.$refs.canvas) return
      try {
        const data = this.mapData()
        const snapshot = this._snapshot
        const meta = this.metadata || {}
        const layout = meta.layout || 'mindMap'
        const theme = meta.theme || 'default'
        const themeConfig = meta.themeConfig || {}
        const signature = JSON.stringify([layout, theme, themeConfig])
        if (this._preview && this._previewSignature !== signature) {
          this.teardown()
          token = this._mountToken
          this._snapshot = snapshot
        }
        if (this._preview) {
          if (this._preview.renderer && this._preview.renderer.cancelRender) this._preview.renderer.cancelRender()
          this._preview.updateConfig({ openPerformance: false })
          this._preview.setData(data)
        } else {
          this._preview = new MindMap({
          el: this.$refs.canvas,
          data,
          fit: false,
          readonly: true,
          allowReadonlySelection: true,
          disabledClipboard: true,
          customCheckEnableShortcut: () => false,
          // The overview is small; draw its nodes and connectors together.
          openPerformance: false,
          alwaysShowExpandBtn: true,
          isShowExpandNum: true,
          minZoomRatio: 50,
          disabledPlugins: PREVIEW_DISABLED_PLUGINS,
          layout,
          theme,
          themeConfig,
          mousewheelAction: 'zoom',
          enableFreeDrag: false,
          initRootNodePosition: ['center', 'center']
          })
          this._previewSignature = signature
          this._preview.addPlugin(Select)
          this._preview.on('node_note_click', this.onNote)
          this._preview.on('node_click', this.onNodeClick)
          this._preview.on('render_error', this.onRenderError)
          this._preview.on('node_active', this.onNodeActive)
        }
        const instance = this._preview
        this.bindCopyKey()
        const onComplete = () => {
          instance.off('node_tree_render_end', onComplete)
          if (token === this._mountToken && instance === this._preview && this.tree && !this.loading) {
            this.bindResize()
            this.fitViewOnly()
          }
        }
        instance.on('node_tree_render_end', onComplete)
      } catch (err) {
        this.$emit('failed', err)
      }
    },
    fitViewOnly() {
      try {
        if (!this._preview) return
        if (typeof this._preview.resize === 'function') this._preview.resize()
        if (this._preview.view) {
          this._preview.view.fit()
          if (this._preview.view.scale < 0.5) {
            this._preview.view.setScale(0.5, this._preview.width / 2, this._preview.height / 2)
          }
        }
      } catch (err) {
        /* ignore */
      }
    },
    relayout() {
      if (!this._preview) {
        this.mount()
        return
      }
      this.fitViewOnly()
    },
    fit() {
      this.viewMode = 'fit'
      if (!this._preview) this.mount()
      else this.fitViewOnly()
    },
    async expandAll() {
      if (!this._preview || this.expanding) return
      this._preview.updateConfig({ openPerformance: true })
      const token = this._expandToken = (this._expandToken || 0) + 1
      this.expanding = true
      this.expandProgress = 0
      while (this._pendingRootChildren && this._pendingRootChildren.length) {
        if (token !== this._expandToken || !this._preview) return
        const loaded = await this.loadMoreBranches()
        if (!loaded) break
        this.expandProgress = Math.min(20, Math.round(20 *
          (1 - this._pendingRootChildren.length / (this._sourceTree.children.length - ROOT_PAGE_SIZE))))
        await new Promise(resolve => setTimeout(resolve, 0))
      }
      if (token !== this._expandToken || !this._preview) return
      const root = this._preview.renderer.renderTree
      const pending = [root]
      const collapsed = []
      while (pending.length) {
        const node = pending.pop()
        if (!node) continue
        if (node.data && node.data.expand === false && node.children && node.children.length) collapsed.push(node)
        ;(node.children || []).forEach(child => pending.push(child))
      }
      try {
        for (let index = 0; index < collapsed.length; index += 6) {
          if (token !== this._expandToken || !this._preview) return
          collapsed.slice(index, index + 6).forEach(node => { node.data.expand = true })
          const completed = await new Promise(resolve => {
            let settled = false
            const finish = value => {
              if (settled) return
              settled = true
              this._cancelExpandWait = null
              resolve(value)
            }
            this._cancelExpandWait = () => finish(false)
            this._preview.renderer.render(() => finish(true))
          })
          if (!completed || token !== this._expandToken) return
          this.expandProgress = Math.round(Math.min(100, 20 + (index + 6) / collapsed.length * 80))
          await new Promise(resolve => setTimeout(resolve, 0))
        }
        this.expandProgress = 100
        this.viewMode = 'expanded'
      } finally {
        if (token === this._expandToken) this.expanding = false
      }
    },
    cancelExpand(repaint = true) {
      const wasExpanding = this.expanding
      this._expandToken = (this._expandToken || 0) + 1
      this.expanding = false
      if (this._cancelExpandWait) {
        this._cancelExpandWait()
        this._cancelExpandWait = null
      }
      if (wasExpanding && this._preview && this._preview.renderer) {
        if (this._preview.renderer.cancelRender) this._preview.renderer.cancelRender()
        if (repaint && this.tree && !this.loading) this._preview.render()
      }
    },
    collapseAll() {
      this.viewMode = 'collapsed'
      this.mount()
    }
  }
}
</script>
<style lang="less" scoped>
.historyMapPreview {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  background: #f4f7f5;
  border-radius: 10px;
  overflow: hidden;
  position: relative;
}
.copyTools { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12px; }
.previewToolbar {
  display: flex;
  flex-wrap: wrap;
  flex: none;
  gap: 8px;
  padding: 8px 10px;
  background: #fff;
  border-bottom: 1px solid #e3e9e6;
}
.previewToolbar /deep/ .el-button {
  min-width: 72px;
}
.previewToolbar /deep/ .el-button--primary {
  color: #fff;
  background: #3d8b6e;
  border-color: #3d8b6e;
}
.previewCanvas,
.previewState {
  flex: 1;
  min-width: 0;
  min-height: 0;
}
.previewCanvas {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}
.previewCanvas /deep/ .smm-mind-map-container {
  width: 100%;
  height: 100%;
  overflow: hidden;
}
.previewState {
  display: flex;
  align-items: center;
  justify-content: center;
  color: #73847d;
  padding: 24px;
  &.error {
    color: #c45656;
  }
}
.noteCard {
  position: absolute;
  right: 16px;
  bottom: 16px;
  max-width: 280px;
  padding: 10px 12px;
  background: #fff;
  border: 1px solid #e3e9e6;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(23, 38, 31, 0.08);
  p {
    margin: 6px 0 0;
    white-space: pre-wrap;
    color: #31463d;
    font-size: 12px;
  }
}
</style>
