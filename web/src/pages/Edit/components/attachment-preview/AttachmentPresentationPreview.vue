<template>
  <section class="attachmentPresentationLayout">
    <div class="attachmentFormatToolbar" role="toolbar" aria-label="幻灯片操作">
      <button type="button" aria-label="上一张幻灯片" :disabled="busy || page <= 1" @click="goToPage(page - 1)"><i class="el-icon-arrow-left"></i></button>
      <input v-model.number="pageInput" type="number" min="1" :max="count" aria-label="幻灯片页码" :disabled="busy" @change="goToPage(pageInput)" @keydown.enter.prevent="goToPage(pageInput)" />
      <span>/ {{ count || '—' }}</span>
      <button type="button" aria-label="下一张幻灯片" :disabled="busy || page >= count" @click="goToPage(page + 1)"><i class="el-icon-arrow-right"></i></button>
      <span class="formatToolbarDivider"></span>
      <button type="button" aria-label="缩小幻灯片" :disabled="busy || zoom <= 50" @click="setZoom(zoom - 25)"><i class="el-icon-zoom-out"></i></button>
      <span>{{ zoom }}%</span>
      <button type="button" aria-label="放大幻灯片" :disabled="busy || zoom >= 200" @click="setZoom(zoom + 25)"><i class="el-icon-zoom-in"></i></button>
      <button type="button" :disabled="busy" @click="setZoom(100)">适应窗口</button>
    </div>
    <div v-if="error" class="attachmentViewerState" role="alert"><i class="el-icon-warning-outline"></i><strong>{{ error }}</strong><el-button size="small" @click="$emit('download')">下载原文件</el-button></div>
    <div v-show="!error" ref="viewport" class="attachmentPresentationViewport" aria-label="幻灯片预览" tabindex="0"><div ref="slides"></div></div>
    <div v-if="busy" class="attachmentViewerState attachmentPreviewOverlay" role="status"><i class="el-icon-loading"></i><strong>正在加载幻灯片…</strong></div>
    <div v-if="partial && !error" class="attachmentSheetStatus">部分元素无法预览，可下载原文件查看</div>
  </section>
</template>
<script>
import JSZip from 'jszip'
import { fetchNodeAttachmentContent } from '@/utils/nodeAttachmentApi'
import { OFFICE_PREVIEW_MAX_BYTES, assertOfficeZipBudget } from '@/utils/nodeAttachmentPreview'
import { loadPresentationPreviewRuntime } from '@/utils/attachmentPreviewRuntime'
export default {
  props: { source: { type: Object, required: true } },
  data: () => ({ busy: true, error: '', partial: false, page: 1, pageInput: 1, count: 0, zoom: 100 }),
  mounted() { this.load() },
  beforeDestroy() { this._disposed = true; if (this._controller) this._controller.abort(); if (this._viewer) this._viewer.destroy(); this._viewer = null },
  methods: {
    async load() {
      this._controller = new AbortController()
      try {
        if (this.source.byteSize > OFFICE_PREVIEW_MAX_BYTES) throw new Error('演示文稿较大，请下载原文件查看')
        const content = await fetchNodeAttachmentContent(this.source.roomKey, this.source.id, { signal: this._controller.signal, maxBytes: OFFICE_PREVIEW_MAX_BYTES })
        if (this._disposed) return
        const zip = await JSZip.loadAsync(content.buffer)
        assertOfficeZipBudget(zip)
        const slides = Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
        if (!slides.length || slides.length > 200) throw new Error('演示文稿为空或页数超过预览上限，请下载查看')
        const { PptxViewer } = await loadPresentationPreviewRuntime()
        if (this._disposed) return
        this._viewer = new PptxViewer(this.$refs.slides, {
          scrollContainer: this.$refs.viewport, fitMode: 'contain', lazySlides: true, lazyMedia: true, pdfjs: false,
          zipLimits: { maxEntries: 2000, maxEntryUncompressedBytes: 16 * 1024 * 1024, maxTotalUncompressedBytes: 16 * 1024 * 1024, maxMediaBytes: 16 * 1024 * 1024, maxConcurrency: 2 },
          onNodeError: () => { if (!this._disposed) this.partial = true }
        })
        await this._viewer.open(content.buffer, { renderMode: 'slide', signal: this._controller.signal })
        if (!this._disposed) this.count = this._viewer.slideCount
      } catch (error) { if (!this._disposed && error.name !== 'AbortError') this.error = error.message || '幻灯片加载失败，请下载查看' }
      finally { if (!this._disposed) this.busy = false }
    },
    async goToPage(value) {
      if (this.busy || !this._viewer || this._disposed) return
      const page = Math.max(1, Math.min(this.count, Math.floor(Number(value) || 1)))
      this.busy = true
      try { await this._viewer.goToSlide(page - 1); if (!this._disposed) { this.page = page; this.pageInput = page } }
      catch (error) { if (!this._disposed) this.error = '幻灯片渲染失败，请下载原文件查看' }
      finally { if (!this._disposed) this.busy = false }
    },
    async setZoom(value) {
      if (this.busy || !this._viewer || this._disposed) return
      this.busy = true
      const zoom = Math.max(50, Math.min(200, value))
      try { await this._viewer.setZoom(zoom); if (!this._disposed) this.zoom = zoom }
      catch (error) { if (!this._disposed) this.error = '幻灯片缩放失败，请下载原文件查看' }
      finally { if (!this._disposed) this.busy = false }
    }
  }
}
</script>
