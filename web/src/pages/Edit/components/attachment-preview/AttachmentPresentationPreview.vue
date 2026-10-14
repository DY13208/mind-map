<template>
  <section class="attachmentPresentationLayout">
    <div v-if="loading" class="attachmentViewerState" role="status"><i class="el-icon-loading"></i><strong>正在加载幻灯片…</strong></div>
    <div v-else-if="error" class="attachmentViewerState" role="alert"><i class="el-icon-warning-outline"></i><strong>{{ error }}</strong><el-button size="small" @click="$emit('download')">下载原文件</el-button></div>
    <div v-show="!error" class="presentationContent" :style="{ visibility: loading ? 'hidden' : 'visible' }">
      <nav class="presentationToolbar" aria-label="幻灯片导航">
        <button type="button" :disabled="page <= 1" @click="goTo(page - 1)">上一页</button>
        <label>第 <select :value="page" aria-label="选择幻灯片" @change="goTo(Number($event.target.value))"><option v-for="n in pageCount" :key="n" :value="n">{{ n }}</option></select> / {{ pageCount }} 页</label>
        <button type="button" :disabled="page >= pageCount" @click="goTo(page + 1)">下一页</button>
        <button type="button" :disabled="zoom <= 50" @click="setZoom(zoom - 25)">缩小</button><span>{{ zoom }}%</span>
        <button type="button" :disabled="zoom >= 200" @click="setZoom(zoom + 25)">放大</button>
      </nav>
      <div class="attachmentPagedBody"><AttachmentThumbnailRail v-if="pageCount" :count="pageCount" :active="page" :render-thumbnail="renderThumbnail" @select="goTo" /><div ref="viewport" class="presentationViewport" tabindex="0" aria-label="幻灯片页面"><div ref="slides" class="presentationSlides"></div></div></div>
    </div>
  </section>
</template>
<script>
import AttachmentThumbnailRail from './AttachmentThumbnailRail.vue'
import { fetchNodeAttachmentContent } from '@/utils/nodeAttachmentApi'
import { PRESENTATION_PREVIEW_MAX_BYTES } from '@/utils/nodeAttachmentPreview'
import { loadPresentationPreviewRuntime } from '@/utils/attachmentPreviewRuntime'
export default {
  components: { AttachmentThumbnailRail },
  props: { source: { type: Object, required: true } },
  data: () => ({ loading: true, error: '', page: 1, pageCount: 0, zoom: 100 }),
  mounted() { this.load() },
  beforeDestroy() {
    this._disposed = true
    if (this._controller) this._controller.abort()
    if (this._viewer) this._viewer.destroy()
  },
  methods: {
    renderThumbnail(n, target) {
      return this._viewer.renderThumbnailToContainer(n - 1, target, { width: Math.min(136, target.clientWidth || 136) })
    },
    async load() {
      this._controller = new AbortController()
      try {
        if (this.source.byteSize > PRESENTATION_PREVIEW_MAX_BYTES) throw new Error('演示文稿较大，请下载原文件查看')
        const [content, runtime] = await Promise.all([
          fetchNodeAttachmentContent(this.source.roomKey, this.source.id, { signal: this._controller.signal, maxBytes: PRESENTATION_PREVIEW_MAX_BYTES }),
          loadPresentationPreviewRuntime()
        ])
        if (this._disposed) return
        // Keep the viewport measurable while rendering; overlay a loading state.
        await this.$nextTick()
        if (this._disposed) return
        this._viewer = new runtime.PptxViewer(this.$refs.slides, {
          fitMode: 'contain', scrollContainer: this.$refs.viewport,
          zipLimits: runtime.RECOMMENDED_ZIP_LIMITS,
          lazyMedia: true, lazySlides: true, pdfjs: false,
          onSlideChange: index => { if (!this._disposed) this.page = index + 1 },
          onSlideError: () => { if (!this._disposed) this.error = '幻灯片无法完整渲染，请下载原文件查看' }
        })
        await this._viewer.open(content.buffer, {
          signal: this._controller.signal,
          renderMode: 'slide'
        })
        if (this._disposed) return
        this.pageCount = this._viewer.slideCount
        if (!this.pageCount) throw new Error('此演示文稿没有可显示的幻灯片')
      } catch (error) {
        if (!this._disposed && error.name !== 'AbortError') this.error = '幻灯片预览失败：' + (error.message || '文件无法解析')
      } finally { if (!this._disposed) this.loading = false }
    },
    async goTo(page) {
      if (!this._viewer || page < 1 || page > this.pageCount) return
      try { await this._viewer.goToSlide(page - 1); if (!this._disposed) this.page = page }
      catch (error) { if (!this._disposed) this.error = '幻灯片加载失败，请下载原文件查看' }
    },
    async setZoom(percent) {
      if (!this._viewer) return
      try {
        const page = this.page
        await this._viewer.setZoom(percent)
        if (this._disposed) return
        await this._viewer.goToSlide(page - 1)
        if (!this._disposed) { this.zoom = percent; this.page = page }
      }
      catch (error) { if (!this._disposed) this.error = '幻灯片缩放失败，请下载原文件查看' }
    }
  }
}
</script>
