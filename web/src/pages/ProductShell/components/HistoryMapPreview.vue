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
      </el-button-group>
    </div>
    <div v-if="loading" class="previewState">正在加载预览…</div>
    <div v-else-if="error" class="previewState error">{{ error }}</div>
    <div
      v-show="!loading && !error"
      ref="canvas"
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
import { historyGraphToMindMap, withExpandMode } from '@/utils/historyTree'

const PREVIEW_DISABLED_PLUGINS = [
  'cooperate',
  'drag',
  'select',
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

export default {
  name: 'HistoryMapPreview',
  props: {
    tree: { type: Object, default: null },
    metadata: { type: Object, default: () => ({}) },
    loading: Boolean,
    error: { type: String, default: '' }
  },
  data() {
    return {
      preview: null,
      note: '',
      viewMode: 'fit',
      sourceTree: null,
      resizeObserver: null,
      mounting: false,
      mountAgain: false
    }
  },
  watch: {
    tree() {
      this.note = ''
      this.viewMode = 'fit'
      this.$nextTick(() => this.mount())
    },
    loading(value) {
      if (!value) this.$nextTick(() => this.mount())
    }
  },
  mounted() {
    this.mount()
  },
  beforeDestroy() {
    this.teardown()
  },
  methods: {
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
      this.unbindResize()
      if (this.preview) {
        try {
          this.preview.off('node_note_click', this.onNote)
          this.preview.destroy()
        } catch (err) {
          /* ignore */
        }
        this.preview = null
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
      this.sourceTree = historyGraphToMindMap(this.tree)
      return withExpandMode(
        this.sourceTree,
        this.viewMode === 'collapsed' ? 'collapsed' : 'expanded'
      )
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
      this.teardown()
      if (this.loading || this.error || !this.tree || !this.$refs.canvas) return
      await this.$nextTick()
      const ready = await this.waitForSize()
      if (!ready || !this.tree || !this.$refs.canvas) return
      try {
        const data = this.mapData()
        const meta = this.metadata || {}
        this.preview = new MindMap({
          el: this.$refs.canvas,
          data,
          fit: true,
          readonly: true,
          disabledPlugins: PREVIEW_DISABLED_PLUGINS,
          layout: meta.layout || 'mindMap',
          theme: meta.theme || 'default',
          themeConfig: meta.themeConfig || {},
          mousewheelAction: 'zoom',
          enableFreeDrag: false,
          initRootNodePosition: ['center', 'center']
        })
        this.preview.on('node_note_click', this.onNote)
        this.bindResize()
        this.$nextTick(() => this.fitViewOnly())
      } catch (err) {
        this.$emit('failed', err)
      }
    },
    fitViewOnly() {
      try {
        if (!this.preview) return
        if (typeof this.preview.resize === 'function') this.preview.resize()
        if (this.preview.view) this.preview.view.fit()
      } catch (err) {
        /* ignore */
      }
    },
    relayout() {
      if (!this.preview) {
        this.mount()
        return
      }
      this.fitViewOnly()
    },
    fit() {
      const needExpand = this.viewMode === 'collapsed'
      this.viewMode = 'fit'
      if (needExpand || !this.preview) this.mount()
      else this.fitViewOnly()
    },
    expandAll() {
      this.viewMode = 'expanded'
      this.mount()
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
.previewToolbar {
  display: flex;
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
