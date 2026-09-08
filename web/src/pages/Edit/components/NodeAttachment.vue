<template>
  <input
    ref="fileInput"
    class="node-attachment-input"
    type="file"
    accept=".txt,.md,.markdown,.csv,.log,.json,.pdf,.docx,.xlsx,.png,.jpg,.jpeg,.webp,.gif,text/plain,text/markdown,text/csv,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,image/*"
    @change="onFilePicked"
  />
</template>

<script>
import { roomFromLocation } from '@/utils/roomLocation'
import { uploadNodeAttachment } from '@/utils/nodeAttachmentApi'

const MAX_LOCAL_BYTES = 5 * 1024 * 1024

export default {
  name: 'NodeAttachment',
  props: {
    mindMap: {
      type: Object,
      default: null
    }
  },
  data() {
    return {
      pendingNodes: []
    }
  },
  created() {
    this.$bus.$on('selectAttachment', this.onSelectAttachment)
  },
  beforeDestroy() {
    this.$bus.$off('selectAttachment', this.onSelectAttachment)
  },
  methods: {
    onSelectAttachment(nodes) {
      const list = Array.isArray(nodes) ? nodes.filter(Boolean) : []
      if (!list.length) {
        this.$message.warning('请先选中节点')
        return
      }
      const roomKey = roomFromLocation(this.$route)
      if (!roomKey) {
        this.$message.warning('请先进入协作房间后再上传附件')
        return
      }
      this.pendingNodes = list
      this.$refs.fileInput && this.$refs.fileInput.click()
    },
    async onFilePicked(event) {
      const file =
        event && event.target && event.target.files && event.target.files[0]
      if (event && event.target) event.target.value = ''
      const nodes = this.pendingNodes.slice()
      this.pendingNodes = []
      if (!file || !nodes.length) return
      if (file.size > MAX_LOCAL_BYTES) {
        this.$message.error(`文件过大（最多 ${MAX_LOCAL_BYTES} 字节）`)
        return
      }
      const roomKey = roomFromLocation(this.$route)
      const mindMap =
        this.mindMap ||
        (nodes[0] && nodes[0].mindMap) ||
        null
      if (!mindMap || !roomKey) {
        this.$message.error('无法上传：缺少导图或房间')
        return
      }
      const loading = this.$loading({
        text: '正在上传并解析附件…',
        background: 'rgba(0,0,0,0.25)'
      })
      try {
        const contentBase64 = await this.readAsDataUrl(file)
        const res = await uploadNodeAttachment(roomKey, {
          fileName: file.name,
          mimeType: file.type || 'application/octet-stream',
          contentBase64,
          nodeUid: nodes[0] && nodes[0].uid,
          sourceKind: 'attachment'
        })
        const attachment = (res && res.attachment) || {}
        const excerpt = String(attachment.extractedText || '').slice(0, 2400)
        nodes.forEach(node => {
          mindMap.execCommand(
            'SET_NODE_ATTACHMENT',
            node,
            '',
            attachment.fileName || file.name,
            {
              attachmentId: attachment.id || '',
              attachmentStatus: attachment.status || 'failed',
              attachmentError: attachment.errorMessage || '',
              attachmentExtractedText: excerpt
            }
          )
        })
        if (attachment.status === 'ready') {
          this.$message.success('附件已解析，可被流程补齐使用')
        } else {
          this.$message.warning(
            attachment.errorMessage || '附件已保存，但内容解析失败'
          )
        }
      } catch (err) {
        console.error('[attachment] upload failed', err)
        this.$message.error((err && err.message) || '附件上传失败')
      } finally {
        loading.close()
      }
    },
    readAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result || ''))
        reader.onerror = () => reject(new Error('读取本地文件失败'))
        reader.readAsDataURL(file)
      })
    }
  }
}
</script>

<style scoped>
.node-attachment-input {
  display: none;
}
</style>
