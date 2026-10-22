<template>
  <section class="attachmentPdfLayout">
    <div class="attachmentFormatToolbar" role="toolbar" aria-label="PDF 操作">
      <button type="button" aria-label="上一页" :disabled="currentPage <= 1" @click="goToPage(currentPage - 1)"><i class="el-icon-arrow-left"></i></button>
      <input v-model.number="pageInput" type="number" min="1" :max="pageCount" aria-label="PDF 页码" @change="goToPage(pageInput)" @keydown.enter.prevent="goToPage(pageInput)" />
      <span>/ {{ pageCount || '—' }}</span>
      <button type="button" aria-label="下一页" :disabled="currentPage >= pageCount" @click="goToPage(currentPage + 1)"><i class="el-icon-arrow-right"></i></button>
      <span class="formatToolbarDivider"></span>
      <button type="button" aria-label="缩小 PDF" :disabled="zoom <= 50" @click="setZoom(zoom - 25)"><i class="el-icon-zoom-out"></i></button>
      <span class="zoomValue">{{ zoom }}%</span>
      <button type="button" aria-label="放大 PDF" :disabled="zoom >= 200" @click="setZoom(zoom + 25)"><i class="el-icon-zoom-in"></i></button>
      <button type="button" @click="setZoom(100)">适应宽度</button>
    </div>
    <div v-if="loading" class="attachmentViewerState" role="status"><i class="el-icon-loading"></i><strong>正在加载 PDF…</strong></div>
    <div v-else-if="error" class="attachmentViewerState" role="alert">
      <i class="el-icon-warning-outline"></i><strong>{{ error }}</strong><el-button size="small" @click="$emit('download')">{{ source.external ? '外部打开' : '下载原文件' }}</el-button>
    </div>
    <div v-else class="attachmentPagedBody">
      <AttachmentThumbnailRail v-if="pageCount" :count="pageCount" :active="currentPage" :render-thumbnail="renderThumbnail" @select="goToPage" />
      <div ref="viewport" class="attachmentPdfViewport" tabindex="0" aria-label="PDF 页面" @scroll.passive="onScroll">
        <div v-for="page in loadedPages" :key="page" class="attachmentPdfPage" :data-page="page" :style="{ width: pageWidth + 'px', height: pageHeight + 'px' }">
          <canvas :data-canvas-page="page" :aria-label="'PDF 第 ' + page + ' 页'"></canvas>
          <span class="pdfPagePlaceholder">第 {{ page }} 页</span>
        </div>
        <div class="attachmentLoadSentinel" v-if="loadedPages < pageCount" role="status">向下滚动加载更多页面</div>
      </div>
    </div>
  </section>
</template>
<script>
import { loadPdfPreviewRuntime, previewAssetUrl } from '@/utils/attachmentPreviewRuntime'
import { nodeAttachmentContentUrl } from '@/utils/nodeAttachmentApi'
import { fetchPreviewAttachmentContent } from '@/utils/attachmentPreviewSource'
import { PDF_PREVIEW_MAX_BYTES } from '@/utils/nodeAttachmentPreview'
import AttachmentThumbnailRail from './AttachmentThumbnailRail.vue'
export default {
  components: { AttachmentThumbnailRail },
  props: { source: { type: Object, required: true } },
  data: () => ({ loading: true, error: '', pageCount: 0, loadedPages: 0, currentPage: 1, pageInput: 1, zoom: 100, pageWidth: 700, pageHeight: 990 }),
  mounted() {
    this._generation = 0
    this._rendered = new Set()
    this._jobs = new Map()
    this._queue = []
    this.load()
  },
  beforeDestroy() {
    this._disposed = true
    this._generation++
    if (this._observer) this._observer.disconnect()
    if (this._resize) this._resize.disconnect()
    for (const task of this._jobs.values()) task.cancel()
    if (this._task) this._task.destroy()
    if (this._controller) this._controller.abort()
    this._doc = null
  },
  methods: {
    async load() {
      try {
        if (this.source.byteSize > PDF_PREVIEW_MAX_BYTES) throw new Error('PDF 较大，请下载原文件查看')
        const pdf = await loadPdfPreviewRuntime()
        if (this._disposed) return
        let original = null
        if (this.source.external) {
          this._controller = new AbortController()
          original = await fetchPreviewAttachmentContent(this.source, { signal: this._controller.signal, maxBytes: PDF_PREVIEW_MAX_BYTES })
          if (this._disposed) return
        }
        this._task = pdf.getDocument({
          ...(original ? { data: new Uint8Array(original.buffer) } : { url: nodeAttachmentContentUrl(this.source.roomKey, this.source.id, { maxBytes: PDF_PREVIEW_MAX_BYTES }), withCredentials: true }),
          cMapUrl: previewAssetUrl('pdf/cmaps/'), cMapPacked: true,
          standardFontDataUrl: previewAssetUrl('pdf/standard_fonts/'),
          wasmUrl: previewAssetUrl('pdf/wasm/'), isEvalSupported: false,
          maxImageSize: 20 * 1000 * 1000, disableAutoFetch: true
        })
        const doc = await this._task.promise
        if (this._disposed) { doc.destroy(); return }
        if (doc.numPages > 2000) throw new Error('PDF 页数过多，请下载原文件查看')
        this._doc = doc
        const first = await doc.getPage(1)
        const dimensions = first.getViewport({ scale: 1 })
        this._ratio = dimensions.height / dimensions.width
        this.pageCount = doc.numPages
        this.loadedPages = Math.min(3, doc.numPages)
        this.loading = false
        await this.$nextTick()
        if (this._disposed) return
        this.measure()
        this._observer = new IntersectionObserver(entries => {
          for (const entry of entries) {
            const number = Number(entry.target.dataset.page)
            if (entry.isIntersecting) this.enqueue(number)
            else if (Math.abs(number - this.currentPage) > 4) this.releasePage(number)
          }
        }, { root: this.$refs.viewport, rootMargin: '300px' })
        this.observePages()
        this._lastWidth = this.$refs.viewport.clientWidth
        this._resize = new ResizeObserver(() => {
          if (this._disposed || !this.$refs.viewport) return
          const width = this.$refs.viewport.clientWidth
          if (Math.abs(width - this._lastWidth) < 1) return
          this._lastWidth = width
          this.measure()
          this.invalidate()
          this.goToPage(this.currentPage)
        })
        this._resize.observe(this.$refs.viewport)
      } catch (error) {
        if (!this._disposed) this.error = error.name === 'PasswordException' ? '此 PDF 需要密码，请下载后打开' : 'PDF 预览失败：' + (error.message || '文件无法解析')
      } finally { if (!this._disposed) this.loading = false }
    },
    measure() {
      const el = this.$refs.viewport
      if (!el) return
      this.pageWidth = Math.max(180, Math.min(1000, el.clientWidth - 48)) * this.zoom / 100
      this.pageHeight = this.pageWidth * (this._ratio || 1.414)
    },
    observePages() {
      if (this._observer) this.$refs.viewport.querySelectorAll('[data-page]').forEach(el => this._observer.observe(el))
    },
    enqueue(number) {
      if (this._rendered.has(number) || this._queue.includes(number) || this._jobs.has(number)) return
      this._queue.push(number)
      this.renderNext()
    },
    async renderNext() {
      if (this._busy || this._disposed || !this._doc) return
      const number = this._queue.shift()
      if (!number) return
      if (Math.abs(number - this.currentPage) > 4) { this.renderNext(); return }
      this._busy = true
      const generation = this._generation
      try {
        const page = await this._doc.getPage(number)
        if (this._disposed || generation !== this._generation) return
        const canvas = this.$refs.viewport.querySelector('[data-canvas-page="' + number + '"]')
        if (!canvas) return
        const scale = this.pageWidth / page.getViewport({ scale: 1 }).width
        const viewport = page.getViewport({ scale })
        const density = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(2500000 / (viewport.width * viewport.height)))
        canvas.width = Math.floor(viewport.width * density)
        canvas.height = Math.floor(viewport.height * density)
        canvas.style.width = viewport.width + 'px'
        canvas.style.height = viewport.height + 'px'
        canvas.parentElement.style.height = viewport.height + 'px'
        const task = page.render({ canvasContext: canvas.getContext('2d'), viewport, transform: [density, 0, 0, density, 0, 0] })
        this._jobs.set(number, task)
        await task.promise
        if (!this._disposed && generation === this._generation) {
          canvas.parentElement.classList.add('is-rendered')
          this._rendered.add(number)
        }
        page.cleanup()
      } catch (error) {
        if (!this._disposed && error.name !== 'RenderingCancelledException') this.error = '页面渲染失败，请下载原文件查看'
      } finally {
        this._jobs.delete(number)
        this._busy = false
        if (!this._disposed && Math.abs(number - this.currentPage) > 4) this.releasePage(number)
        if (!this._disposed && generation !== this._generation) this.enqueue(this.currentPage)
        if (!this._disposed) this.renderNext()
      }
    },
    releasePage(number) {
      const canvas = this.$refs.viewport && this.$refs.viewport.querySelector('[data-canvas-page="' + number + '"]')
      if (canvas && !this._jobs.has(number)) {
        canvas.width = 0; canvas.height = 0
        canvas.parentElement.classList.remove('is-rendered')
        this._rendered.delete(number)
      }
    },
    invalidate() {
      this._generation++
      for (const task of this._jobs.values()) task.cancel()
      this._queue = []
      for (const number of this._rendered) this.releasePage(number)
      this.$nextTick(() => {
        if (this._disposed || !this._observer) return
        this._observer.disconnect()
        this.observePages()
      })
    },
    setZoom(value) {
      const page = this.currentPage
      this.zoom = Math.max(50, Math.min(200, value))
      this.measure()
      this.invalidate()
      this.goToPage(page)
    },
    async renderThumbnail(n, target) {
      if (this._disposed || !this._doc || !target) return null
      const page = await this._doc.getPage(n)
      if (this._disposed) { page.cleanup(); return null }
      const canvas = document.createElement('canvas')
      const base = page.getViewport({ scale: 1 })
      const width = Math.min(136, target.clientWidth || 136)
      const viewport = page.getViewport({ scale: width / base.width })
      canvas.width = Math.max(1, Math.floor(viewport.width))
      canvas.height = Math.max(1, Math.floor(viewport.height))
      target.replaceChildren(canvas)
      const task = page.render({ canvasContext: canvas.getContext('2d'), viewport })
      await task.promise
      page.cleanup()
      return { dispose() { task.cancel(); canvas.width = 0; canvas.height = 0 } }
    },
    async goToPage(value) {
      const page = Math.max(1, Math.min(this.pageCount, Math.floor(Number(value) || 1)))
      if (!this._doc) return
      this.currentPage = page
      this.pageInput = page
      this.loadedPages = Math.max(this.loadedPages, Math.min(this.pageCount, page + 2))
      await this.$nextTick()
      if (this._disposed) return
      this.observePages()
      const target = this.$refs.viewport.querySelector('[data-page="' + page + '"]')
      if (target) target.scrollIntoView({ block: 'start' })
      this.enqueue(page)
    },
    async onScroll() {
      const el = this.$refs.viewport
      const pages = [...el.querySelectorAll('[data-page]')]
      const top = el.getBoundingClientRect().top
      const visible = pages.find(page => page.getBoundingClientRect().bottom > top + 50)
      if (visible) { this.currentPage = Number(visible.dataset.page); this.pageInput = this.currentPage }
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 400 && this.loadedPages < this.pageCount) {
        this.loadedPages = Math.min(this.pageCount, this.loadedPages + 3)
        await this.$nextTick()
        if (!this._disposed) this.observePages()
      }
    }
  }
}
</script>
