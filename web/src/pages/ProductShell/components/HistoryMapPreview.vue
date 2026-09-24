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
      <el-button v-if="busy" size="mini" @click="cancelExpansion"
        >取消展开</el-button
      >
      <el-button
        v-if="remainingChildren"
        size="mini"
        :disabled="busy"
        @click="loadMore"
        >加载更多（{{ remainingChildren }}）</el-button
      >
      <input
        v-model="query"
        aria-label="搜索历史节点"
        placeholder="搜索历史节点"
        @keydown.enter="search"
      />
      <el-button size="mini" :disabled="busy" @click="search">查找</el-button>
      <span role="status">{{ status }}</span>
    </div>
    <div v-if="loading || preparing" class="previewState">正在加载预览…</div>
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
import { historyGraphToMindMap } from '@/utils/historyTree'
import { treeTask } from '@/utils/treeWorker'
import { getRuntimeConfig } from '@/utils/runtimeConfig'

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
    projection: { type: Object, default: null },
    active: { type: Boolean, default: true },
    metadata: { type: Object, default: () => ({}) },
    loading: Boolean,
    error: { type: String, default: '' }
  },
  data() {
    return {
      note: '',
      viewMode: 'fit',
      preparing: false,
      busy: false,
      status: '',
      query: '',
      remainingChildren: 0
    }
  },
  created() {
    // Renderer and trees intentionally live outside Vue's observed data graph.
    this._state = {
      generation: 0,
      expansion: 0,
      preview: null,
      tree: null,
      sessionId: null,
      owned: false,
      timer: null,
      observer: null,
      selected: null,
      controller: null,
      destroyed: false,
      source: null
    }
  },
  watch: {
    tree: 'schedule',
    loading: 'schedule',
    metadata: 'schedule',
    active(value) {
      if (value) this.schedule()
      else this.teardown()
    }
  },
  mounted() {
    this.schedule()
  },
  beforeDestroy() {
    this._state.destroyed = true
    this.teardown()
  },
  methods: {
    schedule() {
      const state = this._state
      state.generation++
      this.cancelExpansion()
      if (state.controller) state.controller.abort()
      if (state.preview) state.preview.renderer.cancelRender()
      clearTimeout(state.timer)
      state.timer = setTimeout(() => this.mount(), 0)
    },
    teardown() {
      const state = this._state
      state.generation++
      this.cancelExpansion()
      clearTimeout(state.timer)
      if (state.controller) state.controller.abort()
      if (state.observer) state.observer.disconnect()
      if (state.preview) state.preview.destroy()
      if (state.owned && state.sessionId)
        treeTask('release', { sessionId: state.sessionId }).catch(() => {})
      state.preview = state.tree = state.source = state.sessionId = null
      state.observer = null
      this.preparing = false
      this.remainingChildren = 0
    },
    async mount() {
      const state = this._state
      if (
        state.destroyed ||
        !this.active ||
        this.loading ||
        this.error ||
        !this.tree
      ) {
        if (!this.tree && !this.loading) this.teardown()
        return
      }
      const generation = state.generation
      const valid = () =>
        !state.destroyed && this.active && generation === state.generation
      state.controller = new AbortController()
      const signal = state.controller.signal
      this.preparing = true
      this.note = ''
      this.status = '正在准备概览…'
      try {
        await this.$nextTick()
        // Dialog opening animation can temporarily give the canvas zero size.
        for (let i = 0; i < 45 && valid(); i++) {
          const el = this.$refs.canvas
          if (el && el.clientWidth > 32 && el.clientHeight > 32) break
          await new Promise(resolve => setTimeout(resolve, 16))
        }
        if (!valid()) return
        if (state.owned && state.sessionId)
          await treeTask('release', { sessionId: state.sessionId })
        let projected = this.projection
        let tree = this.tree
        state.owned = !projected
        if (!projected) {
          state.sessionId = 'preview-' + this._uid + '-' + generation
          const result = await treeTask(
            'prepare',
            { graph: tree, sessionId: state.sessionId },
            { signal, revision: generation }
          )
          projected = result
          tree = result.tree
        }
        if (!valid()) return
        state.sessionId = projected.sessionId
        state.tree = historyGraphToMindMap(tree)
        state.source = this.tree
        state.count = projected.nodeCount
        const meta = this.metadata || {}
        if (!state.preview) {
          state.preview = new MindMap({
            el: this.$refs.canvas,
            data: state.tree,
            fit: true,
            readonly: true,
            disabledPlugins: PREVIEW_DISABLED_PLUGINS,
            layout: meta.layout || 'mindMap',
            theme: meta.theme || 'default',
            themeConfig: meta.themeConfig || {},
            mousewheelAction: 'zoom',
            openPerformance: true,
            cooperativeRendering: getRuntimeConfig().largeMapScheduler,
            isShowExpandNum: true,
            enableFreeDrag: false,
            initRootNodePosition: ['center', 'center']
          })
          state.preview.on('node_note_click', node => {
            this.note = String(node.getData('note') || '')
          })
          state.preview.on('node_click', node => this.selectNode(node))
          state.preview.on('expand_btn_click', node => this.expandNode(node))
          state.preview.on('node_tree_render_end', () => {
            if (!state.preview) return
            state.tree = state.preview.renderer.renderTree
          })
          state.preview.on('render_error', error => {
            this.$emit('failed', error)
            this.status = '预览失败：' + error.message
            this.preparing = false
          })
          if (typeof ResizeObserver !== 'undefined') {
            state.observer = new ResizeObserver(() => this.fitViewOnly())
            state.observer.observe(this.$refs.canvas)
          }
        } else {
          state.preview.setTheme(meta.theme || 'default', true)
          state.preview.setThemeConfig(meta.themeConfig || {}, true)
          if (state.preview.opt.layout !== (meta.layout || 'mindMap'))
            state.preview.setLayout(meta.layout || 'mindMap', true)
          state.preview.setData(state.tree)
        }
        const painted = await this.paint(generation)
        if (!valid() || !painted) return
        this.fitViewOnly()
        this.status = '共 ' + state.count + ' 个节点，点击分支按需展开'
      } catch (error) {
        if (valid() && error.name !== 'AbortError') {
          this.status = error.message
          this.$emit('failed', error)
        }
      } finally {
        if (valid()) this.preparing = false
      }
    },
    paint(generation = this._state.generation) {
      const state = this._state
      return new Promise(resolve => {
        const preview = state.preview
        if (!preview || generation !== state.generation) return resolve(false)
        const finish = () => {
          preview.off('render_cancelled', cancelled)
          preview.off('render_error', cancelled)
          resolve(generation === state.generation)
        }
        const cancelled = () => {
          preview.off('render_cancelled', cancelled)
          preview.off('render_error', cancelled)
          resolve(false)
        }
        preview.on('render_cancelled', cancelled)
        preview.on('render_error', cancelled)
        preview.render(finish)
      })
    },
    selectNode(node) {
      if (!node || !node.nodeData) return
      this._state.selected = node.nodeData
      this.remainingChildren = Math.max(
        0,
        Number(node.getData('childCount') || 0) -
          (node.nodeData.children || []).length
      )
    },
    async appendChildren(target, targetUid) {
      const state = this._state,
        generation = state.generation
      const result = await treeTask(
        'branch',
        {
          sessionId: state.sessionId,
          uid: target.data.uid,
          offset: target.children.length,
          targetUid,
          loaded: target.children.map(child => child.data.uid)
        },
        { signal: state.controller.signal, revision: generation }
      )
      if (generation !== state.generation) return false
      const loaded = new Set(target.children.map(child => child.data.uid))
      target.children.push(
        ...result.children.filter(child => !loaded.has(child.data.uid))
      )
      target.children.sort(
        (a, b) => a.data._historyIndex - b.data._historyIndex
      )
      target.data.hasMore = target.children.length < result.total
      target.data.expand = true
      return result.children.length > 0
    },
    async expandNode(node) {
      if (this.busy || !node || node.getData('expand') === false) return
      this.selectNode(node)
      if (node.nodeData.children.length || !this.remainingChildren) return
      await this.loadMore()
    },
    async loadMore() {
      const state = this._state,
        target = state.selected
      if (!target || this.busy) return
      const generation = state.generation
      this.busy = true
      try {
        await this.appendChildren(target)
        if (generation !== state.generation) return
        await this.paint(generation)
        this.remainingChildren = Math.max(
          0,
          target.data.childCount - target.children.length
        )
      } catch (error) {
        if (generation === state.generation && error.name !== 'AbortError')
          this.status = error.message
      } finally {
        if (generation === state.generation) this.busy = false
      }
    },
    cancelExpansion() {
      this._state.expansion++
      this.busy = false
    },
    async expandAll() {
      const state = this._state
      if (!state.preview || this.busy) return
      const token = ++state.expansion,
        generation = state.generation
      const valid = () =>
        token === state.expansion && generation === state.generation
      this.busy = true
      this.viewMode = 'expanded'
      const queue = [state.preview.renderer.renderTree]
      let completed = 0
      let loaded = 0
      let nextPaint = 280
      try {
        for (let i = 0; i < queue.length && valid(); i++) {
          const node = queue[i]
          while (
            node.children.length < Number(node.data.childCount || 0) &&
            valid()
          ) {
            const before = node.children.length
            if (!(await this.appendChildren(node))) break
            if (!valid()) return
            loaded += node.children.length - before
            this.status =
              '正在展开，已处理 ' +
              (completed + loaded) +
              ' / ' +
              state.count +
              ' 个节点'
            if (completed + loaded >= nextPaint) {
              await this.paint(generation)
              nextPaint =
                completed + loaded < 1000
                  ? 1000
                  : completed + loaded < 3000
                  ? 3000
                  : Infinity
            }
          }
          if (!valid()) return
          node.data.expand = true
          for (const child of node.children) queue.push(child)
          completed++
          if (completed % 48 === 0)
            await new Promise(resolve => setTimeout(resolve, 0))
        }
        if (valid()) {
          await this.paint(generation)
          this.status = '已展开 ' + completed + ' 个节点'
        }
      } catch (error) {
        if (valid() && error.name !== 'AbortError') this.status = error.message
      } finally {
        if (valid()) this.busy = false
      }
    },
    collapseAll() {
      this.cancelExpansion()
      this.viewMode = 'collapsed'
      if (this._state.preview) this._state.preview.execCommand('UNEXPAND_ALL')
    },
    async search() {
      const state = this._state,
        generation = state.generation
      if (!state.sessionId || this.busy || !this.query.trim()) return
      this.busy = true
      try {
        const hits = await treeTask(
          'search',
          { sessionId: state.sessionId, query: this.query.trim() },
          { signal: state.controller.signal, revision: generation }
        )
        if (generation !== state.generation) return
        if (!hits.length) {
          this.status = '没有找到节点'
          return
        }
        let node = state.preview.renderer.renderTree
        for (const uid of hits[0].path.slice(1)) {
          let child = node.children.find(item => item.data.uid === uid)
          while (!child && node.children.length < node.data.childCount) {
            await this.appendChildren(node, uid)
            if (generation !== state.generation) return
            child = node.children.find(item => item.data.uid === uid)
          }
          if (!child) return
          node.data.expand = true
          node = child
        }
        await this.paint(generation)
        if (generation !== state.generation) return
        state.preview.execCommand('GO_TARGET_NODE', node.data.uid)
        this.status = '找到 ' + hits.length + ' 个匹配，已定位首个结果'
      } catch (error) {
        if (generation === state.generation && error.name !== 'AbortError')
          this.status = error.message
      } finally {
        if (generation === state.generation) this.busy = false
      }
    },
    fitViewOnly() {
      const preview = this._state.preview
      if (!preview) return
      const el = this.$refs.canvas
      if (
        el &&
        (preview.width !== el.clientWidth || preview.height !== el.clientHeight)
      )
        preview.resize()
      if (!preview.renderer.isRendering && preview.renderer.root)
        preview.view.fit()
    },
    relayout() {
      this.fitViewOnly()
    },
    fit() {
      this.viewMode = 'fit'
      this.fitViewOnly()
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
  flex-wrap: wrap;
  align-items: center;
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
  position: absolute;
  inset: 48px 0 0;
  z-index: 1;
  background: #f4f7f5;
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
