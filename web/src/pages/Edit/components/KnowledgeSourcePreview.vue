<template>
  <div class="knowledge-source-preview">
    <AttachmentPresentationPreview v-if="presentation" :source="source" @download="download" />
    <AttachmentOfficePreview v-else-if="office" :source="source" @download="download" />
    <KbSourcePreview v-else :file="file" />
  </div>
</template>
<script>
import kbApi from '@/features/knowledge-base/services/kbApi'
import KbSourcePreview from '@/features/knowledge-base/components/KbSourcePreview.vue'
import '@/style/attachment-preview.less'
export default {
  components: {
    KbSourcePreview,
    AttachmentPresentationPreview: () => import('./attachment-preview/AttachmentPresentationPreview.vue'),
    AttachmentOfficePreview: () => import('./attachment-preview/AttachmentOfficePreview.vue')
  },
  props: { file: { type: Object, required: true } },
  computed: {
    presentation() { return /\.pptx$/i.test(this.file.name || this.file.fileName || '') },
    office() { return /\.(docx?|xlsx?|xlsm|ods|csv)$/i.test(this.file.name || this.file.fileName || '') },
    source() { return { external: true, url: kbApi.rawUrl(this.file.id), fileName: this.file.name || this.file.fileName, mimeType: this.file.mimeType || this.file.mime, byteSize: this.file.size || this.file.byteSize } }
  },
  methods: {
    download() { const link = document.createElement('a'); link.href = kbApi.rawUrl(this.file.id); link.download = this.file.name || this.file.fileName || ''; link.click() }
  }
}
</script>
<style lang="less">
.knowledge-source-preview { min-height: 320px; height: 60vh; overflow: auto; .attachmentOfficeLayout { height: 100%; } }
</style>
