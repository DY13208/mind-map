<template>
  <el-dialog :visible.sync="visible" :title="title" width="92vw" top="5vh" append-to-body
    :custom-class="isMaximized ? 'attachmentViewer is-maximized' : 'attachmentViewer'"
    :show-close="false" :close-on-click-modal="true" :close-on-press-escape="true" @close="onClosed">
    <header slot="title" class="attachmentViewerHeader">
      <div class="attachmentFileIcon" :class="'is-' + kind"><i :class="fileIcon" aria-hidden="true"></i></div>
      <div class="attachmentFileInfo">
        <h2 :title="title">{{ title }}</h2>
        <p><span>{{ fileSize }}</span><span class="fileMetaDivider">·</span><span>{{ typeLabel }}</span></p>
      </div>
      <div class="attachmentViewerActions" role="toolbar" aria-label="附件操作">
        <el-button size="small" icon="el-icon-full-screen" :aria-label="isMaximized ? '还原预览窗口' : '最大化预览窗口'" @click="toggleMaximize">
          <span class="actionLabel">{{ isMaximized ? '还原' : '最大化' }}</span>
        </el-button>
        <el-button v-if="attachmentId" size="small" type="primary" icon="el-icon-download" @click="download">下载</el-button>
        <el-button v-else-if="externalUrl" size="small" type="primary" icon="el-icon-top-right" @click="openExternal">外部打开</el-button>
        <el-button class="attachmentCloseButton" size="small" icon="el-icon-close" aria-label="关闭附件预览" @click="visible = false"></el-button>
      </div>
    </header>
    <main v-if="visible" class="attachmentViewerMain">
      <div v-if="loading" class="attachmentViewerState" role="status"><i class="el-icon-loading"></i><strong>正在加载文件…</strong></div>
      <div v-else-if="error" class="attachmentViewerState" role="alert">
        <i class="el-icon-warning-outline"></i><strong>{{ error }}</strong><el-button size="small" @click="retry">重新加载</el-button>
      </div>
      <component v-else-if="source && previewComponent" :is="previewComponent" :key="requestId" :source="source" :kind="kind" @download="download" />
      <div v-else-if="externalUrl" class="attachmentExternal">
        <iframe :src="externalUrl" :title="title" sandbox="allow-same-origin allow-popups allow-forms allow-downloads" referrerpolicy="no-referrer"></iframe>
      </div>
      <div v-else class="attachmentViewerState">
        <i class="el-icon-document"></i><strong>暂不支持在线预览此文件类型</strong><p>{{ typeLabel }} · {{ fileSize }}</p>
        <el-button v-if="attachmentId" type="primary" size="small" icon="el-icon-download" @click="download">下载原文件</el-button>
      </div>
    </main>
  </el-dialog>
</template>

<script>
import { roomFromLocation } from '@/utils/roomLocation'
import { getNodeAttachment, nodeAttachmentContentUrl } from '@/utils/nodeAttachmentApi'
import { attachmentPreviewKind, isHtmlAttachment, attachmentBusyMessage } from '@/utils/nodeAttachmentPreview'
import { formatPreviewBytes } from '@/utils/attachmentProgressiveText'
import '@/style/attachment-preview.less'

export default {
  name: 'NodeAttachmentPreview',
  components: {
    AttachmentDocumentPreview: () => import('./attachment-preview/AttachmentDocumentPreview.vue').then(module => module.default || module),
    AttachmentOfficePreview: () => import('./attachment-preview/AttachmentOfficePreview.vue').then(module => module.default || module),
    AttachmentPdfPreview: () => import('./attachment-preview/AttachmentPdfPreview.vue').then(module => module.default || module),
    AttachmentPresentationPreview: () => import('./attachment-preview/AttachmentPresentationPreview.vue').then(module => module.default || module),
    AttachmentArchivePreview: () => import('./attachment-preview/AttachmentArchivePreview.vue').then(module => module.default || module),
    AttachmentImagePreview: () => import('./attachment-preview/AttachmentImagePreview.vue').then(module => module.default || module)
  },
  data: () => ({
    visible: false, loading: false, title: '附件预览', attachmentId: '', attachment: null,
    kind: 'unsupported', source: null, externalUrl: '', error: '', requestId: 0,
    isMaximized: false, selectedData: null
  }),
  computed: {
    fileSize() { return formatPreviewBytes(this.attachment && this.attachment.byteSize) },
    typeLabel() {
      const ext = this.title.includes('.') ? this.title.split('.').pop().toUpperCase() : ''
      return ext || '文件'
    },
    fileIcon() {
      return this.kind === 'image' ? 'el-icon-picture-outline' :
        this.kind === 'office' && /\.(xls|xlsx|xlsm|ods)$/i.test(this.title) ? 'el-icon-s-grid' : 'el-icon-document'
    },
    previewComponent() {
      if (this.kind === 'image') return 'AttachmentImagePreview'
      if (this.kind === 'pdf') return 'AttachmentPdfPreview'
      if (this.kind === 'office') return 'AttachmentOfficePreview'
      if (this.kind === 'presentation') return 'AttachmentPresentationPreview'
      if (this.kind === 'archive') return 'AttachmentArchivePreview'
      if (['markdown', 'text', 'json'].includes(this.kind)) return 'AttachmentDocumentPreview'
      return null
    }
  },
  watch: {
    $route(to, from) {
      if (roomFromLocation(to) !== roomFromLocation(from)) { this.visible = false; this.resetPreview() }
    }
  },
  created() { this.$bus.$on('node_attachmentClick', this.onAttachmentClick) },
  beforeDestroy() { this.$bus.$off('node_attachmentClick', this.onAttachmentClick); this.resetPreview() },
  methods: {
    onAttachmentClick(node) {
      const data = node && node.getData ? node.getData() || {} : {}
      if (!data.attachmentId && !data.attachmentUrl) { this.$message.info(attachmentBusyMessage(data)); return }
      if (isHtmlAttachment(data.attachmentName, data.attachmentMimeType, data.attachmentUrl)) {
        if (data.attachmentId) this.openHtmlInNewPage(data)
        else this.openUrlInNewPage(data.attachmentUrl)
        return
      }
      if (data.attachmentId) this.openStoredAttachment(data)
      else this.openExternalAttachment(data)
    },
    openUrlInNewPage(url) { if (url) window.open(url, '_blank', 'noopener') },
    openHtmlInNewPage(data) {
      const room = roomFromLocation(this.$route)
      if (!room) { this.$message.warning('请先进入协作房间后再打开网页附件'); return }
      this.openUrlInNewPage(nodeAttachmentContentUrl(room, data.attachmentId || data.id))
    },
    resetPreview() {
      this.requestId++
      this.source = null
      this.loading = false
      this.error = ''
      this.attachment = null
      this.attachmentId = ''
      this.externalUrl = ''
    },
    async openStoredAttachment(data) {
      this.resetPreview()
      this.selectedData = { ...data }
      this.title = data.attachmentName || '附件预览'
      this.attachmentId = data.attachmentId
      this.kind = attachmentPreviewKind(this.title, data.attachmentMimeType)
      this.visible = true
      this.loading = true
      const token = this.requestId
      const roomKey = roomFromLocation(this.$route)
      try {
        if (!roomKey) throw new Error('请先进入协作房间后再预览附件')
        const result = await getNodeAttachment(roomKey, data.attachmentId)
        if (token !== this.requestId || !this.visible) return
        const attachment = result && result.attachment
        if (!attachment || !attachment.id) throw new Error('附件不存在或已移除')
        this.attachment = attachment
        this.attachmentId = attachment.id
        this.title = attachment.fileName || this.title
        this.kind = attachmentPreviewKind(this.title, attachment.mimeType || data.attachmentMimeType)
        if (this.kind === 'html') {
          this.openHtmlInNewPage({ attachmentId: attachment.id })
          this.visible = false
          return
        }
        this.source = Object.freeze({ ...attachment, roomKey, url: nodeAttachmentContentUrl(roomKey, attachment.id) })
      } catch (error) {
        if (token === this.requestId) this.error = error.message || '附件加载失败'
      } finally { if (token === this.requestId) this.loading = false }
    },
    openExternalAttachment(data) {
      this.resetPreview()
      this.title = data.attachmentName || '附件预览'
      this.kind = 'external'
      this.externalUrl = String(data.attachmentUrl || '')
      this.visible = true
    },
    retry() { if (this.selectedData) this.openStoredAttachment(this.selectedData) },
    toggleMaximize() { this.isMaximized = !this.isMaximized },
    download() {
      const room = (this.source && this.source.roomKey) || roomFromLocation(this.$route)
      if (!room || !this.attachmentId) return
      const link = document.createElement('a')
      link.href = nodeAttachmentContentUrl(room, this.attachmentId, { download: true })
      link.download = this.title || 'attachment'
      link.target = '_blank'
      link.rel = 'noopener'
      document.body.appendChild(link)
      link.click()
      link.remove()
    },
    openExternal() { this.openUrlInNewPage(this.externalUrl) },
    onClosed() { this.resetPreview() }
  }
}
</script>
