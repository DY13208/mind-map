<template>
  <section class="attachmentArchiveLayout">
    <div v-if="loading" class="attachmentViewerState" role="status"><i class="el-icon-loading"></i><strong>正在读取压缩包目录…</strong></div>
    <div v-else-if="error" class="attachmentViewerState" role="alert"><i class="el-icon-warning-outline"></i><strong>{{ error }}</strong><el-button size="small" @click="$emit('download')">下载原文件</el-button></div>
    <div v-else ref="viewport" class="attachmentArchiveViewport" tabindex="0" aria-label="压缩包文件列表" @scroll.passive="onScroll">
      <table class="attachmentArchiveTable"><thead><tr><th>文件路径</th><th>原始大小</th></tr></thead><tbody><tr v-for="file in files.slice(0, limit)" :key="file.name"><td><i :class="file.directory ? 'el-icon-folder' : 'el-icon-document'"></i> {{ file.name }}</td><td>{{ file.directory ? '—' : bytes(file.size) }}</td></tr></tbody></table>
      <div class="attachmentLoadSentinel" role="status"><button v-if="limit < files.length" type="button" @click="limit += 100">继续加载</button><span v-else>{{ files.length }} 个项目</span></div>
    </div>
  </section>
</template>
<script>
import JSZip from 'jszip'
import { fetchNodeAttachmentContent } from '@/utils/nodeAttachmentApi'
import { OFFICE_PREVIEW_MAX_BYTES, assertOfficeZipBudget } from '@/utils/nodeAttachmentPreview'
import { formatPreviewBytes } from '@/utils/attachmentProgressiveText'
export default {
  props: { source: { type: Object, required: true } },
  data: () => ({ loading: true, error: '', files: [], limit: 100 }),
  mounted() { this.load() },
  beforeDestroy() { this._disposed = true; if (this._controller) this._controller.abort() },
  methods: {
    bytes: formatPreviewBytes,
    async load() {
      this._controller = new AbortController()
      try {
        if (this.source.byteSize > OFFICE_PREVIEW_MAX_BYTES) throw new Error('压缩包较大，请下载后查看')
        const content = await fetchNodeAttachmentContent(this.source.roomKey, this.source.id, { signal: this._controller.signal, maxBytes: OFFICE_PREVIEW_MAX_BYTES })
        if (this._disposed) return
        const zip = await JSZip.loadAsync(content.buffer)
        assertOfficeZipBudget(zip)
        if (this._disposed) return
        // Read the directory only. Never inflate or execute archive entries.
        this.files = Object.values(zip.files).map(file => Object.freeze({ name: file.unsafeOriginalName || file.name, directory: file.dir, size: file._data && file._data.uncompressedSize || 0 }))
      } catch (error) { if (!this._disposed && error.name !== 'AbortError') this.error = '无法预览压缩包：' + (error.message || '文件无法解析') }
      finally { if (!this._disposed) this.loading = false }
    },
    onScroll() { const el = this.$refs.viewport; if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 250) this.limit += 100 }
  }
}
</script>
