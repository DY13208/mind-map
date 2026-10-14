<template>
  <section class="attachmentImageSurface">
    <div class="attachmentFormatToolbar" role="toolbar" aria-label="图片操作">
      <button type="button" aria-label="缩小图片" :disabled="zoom <= 25" @click="changeZoom(-25)"><i class="el-icon-zoom-out"></i></button>
      <span class="zoomValue">{{ zoom }}%</span>
      <button type="button" aria-label="放大图片" :disabled="zoom >= 400" @click="changeZoom(25)"><i class="el-icon-zoom-in"></i></button>
      <button type="button" @click="zoom = 100">适应窗口</button>
    </div>
    <div v-if="loading" class="attachmentViewerState" role="status"><i class="el-icon-loading"></i><strong>正在加载图片…</strong></div>
    <div v-else-if="error" class="attachmentViewerState" role="alert"><i class="el-icon-picture-outline"></i><strong>{{ error }}</strong><el-button size="small" @click="$emit('download')">下载原文件</el-button></div>
    <div v-else ref="viewport" class="attachmentImageViewport" tabindex="0" aria-label="图片预览">
      <div class="attachmentImageStage"><img :src="url" :alt="source.fileName" :style="{ width: fittedWidth ? fittedWidth * zoom / 100 + 'px' : 'auto' }" @error="error = '图片加载失败，请下载后查看'" /></div>
    </div>
  </section>
</template>
<script>
import { fetchNodeAttachmentContent } from '@/utils/nodeAttachmentApi'
import { assertImagePreviewBudget, IMAGE_PREVIEW_MAX_BYTES } from '@/utils/nodeAttachmentPreview'
export default {
  props: { source: { type: Object, required: true } },
  data: () => ({ loading: true, error: '', url: '', zoom: 100, fittedWidth: 0 }),
  mounted() { this.load() },
  beforeDestroy() { this._disposed = true; if (this._controller) this._controller.abort(); if (this._resize) this._resize.disconnect(); if (this.url) URL.revokeObjectURL(this.url) },
  methods: {
    changeZoom(delta) { this.zoom = Math.max(25, Math.min(400, this.zoom + delta)) },
    fit() {
      if (this._disposed || !this.$refs.viewport || !this._dimensions) return
      const el = this.$refs.viewport
      const ratio = Math.min(1, (el.clientWidth - 48) / this._dimensions.width, (el.clientHeight - 48) / this._dimensions.height)
      this.fittedWidth = Math.max(1, this._dimensions.width * ratio)
    },
    async load() {
      this._controller = new AbortController()
      try {
        if (this.source.byteSize > IMAGE_PREVIEW_MAX_BYTES) throw new Error('图片较大，请下载原文件查看')
        const content = await fetchNodeAttachmentContent(this.source.roomKey, this.source.id, { signal: this._controller.signal, maxBytes: IMAGE_PREVIEW_MAX_BYTES })
        if (this._disposed) return
        this._dimensions = assertImagePreviewBudget(content.buffer)
        this.url = URL.createObjectURL(new Blob([content.buffer], { type: content.contentType || this.source.mimeType }))
        this.loading = false
        await this.$nextTick()
        if (this._disposed) return
        this.fit()
        this._resize = new ResizeObserver(() => this.fit())
        this._resize.observe(this.$refs.viewport)
      } catch (error) { if (!this._disposed && error.name !== 'AbortError') this.error = error.message || '图片读取失败' }
      finally { if (!this._disposed) this.loading = false }
    }
  }
}
</script>
