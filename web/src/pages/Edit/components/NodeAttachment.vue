<template>
  <input
    ref="fileInput"
    class="node-attachment-input"
    type="file"
    accept=".txt,.md,.markdown,.csv,.log,.json,.html,.htm,.pdf,.doc,.docx,.xls,.xlsx,.xlsm,.ods,.pptx,.png,.jpg,.jpeg,.webp,.gif,text/plain,text/markdown,text/csv,text/html,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel.sheet.macroenabled.12,application/vnd.oasis.opendocument.spreadsheet,application/vnd.openxmlformats-officedocument.presentationml.presentation,image/png,image/jpeg,image/webp,image/gif"
    @change="onFilePicked"
  />
</template>

<script>
import { roomFromLocation } from '@/utils/roomLocation'
import {
  getNodeAttachment,
  uploadNodeAttachment,
  waitForAttachmentReady,
  maxAttachmentBytes,
  formatAttachmentMaxMb
} from '@/utils/nodeAttachmentApi'

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
      pendingNodes: [],
      inflight: {}
    }
  },
  created() {
    this.$bus.$on('selectAttachment', this.onSelectAttachment)
  },
  mounted() {
    this.hydrateExistingAttachments()
  },
  beforeDestroy() {
    this.$bus.$off('selectAttachment', this.onSelectAttachment)
    Object.keys(this.inflight).forEach(uid => this.abortInflight(uid))
  },
  methods: {
    abortInflight(uid) {
      const job = this.inflight[uid]
      if (job && job.controller) job.controller.abort()
      this.$delete(this.inflight, uid)
    },
    resolveNode(item) {
      const renderer = this.mindMap && this.mindMap.renderer
      const uid = (item && item.uid) || (item && item.getData && item.getData('uid'))
      return (
        (uid &&
          renderer &&
          typeof renderer.findNodeByUid === 'function' &&
          renderer.findNodeByUid(uid)) ||
        (item && item.node) ||
        item ||
        null
      )
    },
    applyAttachment(item, url, name, meta, options = {}) {
      const node = this.resolveNode(item)
      if (!node || !this.mindMap) return
      const persist = options.persist !== false
      if (persist) {
        this.mindMap.execCommand('SET_NODE_ATTACHMENT', node, url, name, meta)
        return
      }
      const renderer = this.mindMap.renderer
      const patch = {
        attachmentUrl: url,
        attachmentName: name,
        ...(meta || {})
      }
      if (renderer && typeof renderer.setNodeData === 'function') {
        renderer.setNodeData(node, patch)
      } else if (node.nodeData && node.nodeData.data) {
        Object.assign(node.nodeData.data, patch)
      }
      if (
        options.progressOnly &&
        typeof node.updateAttachmentIconState === 'function' &&
        node._attachmentData &&
        node._attachmentData.view
      ) {
        node.updateAttachmentIconState()
        return
      }
      if (typeof node.reRender === 'function') {
        node.reRender(['attachment'])
        return
      }
      if (renderer && typeof renderer.reRenderNodeCheckChange === 'function') {
        renderer.reRenderNodeCheckChange(node)
      }
    },
    snapshotOf(node) {
      const data = (node && node.getData && node.getData()) || {}
      return {
        attachmentUrl: data.attachmentUrl || '',
        attachmentName: data.attachmentName || '',
        attachmentId: data.attachmentId || '',
        attachmentMimeType: data.attachmentMimeType || '',
        attachmentStatus: data.attachmentStatus || '',
        attachmentError: data.attachmentError || '',
        attachmentExtractedText: data.attachmentExtractedText || '',
        attachmentProgress: data.attachmentProgress
      }
    },
    restoreSnapshot(item, snapshot) {
      if (!snapshot) {
        this.applyAttachment(item, '', '', {
          attachmentId: '',
          attachmentMimeType: '',
          attachmentStatus: '',
          attachmentError: '',
          attachmentExtractedText: '',
          attachmentProgress: 0
        })
        return
      }
      this.applyAttachment(
        item,
        snapshot.attachmentUrl || '',
        snapshot.attachmentName || '',
        {
          attachmentId: snapshot.attachmentId || '',
          attachmentMimeType: snapshot.attachmentMimeType || '',
          attachmentStatus: snapshot.attachmentStatus || '',
          attachmentError: snapshot.attachmentError || '',
          attachmentExtractedText: snapshot.attachmentExtractedText || '',
          attachmentProgress: snapshot.attachmentProgress || 0
        }
      )
    },
    metaFromAttachment(attachment, file, extras = {}) {
      const saved = attachment || {}
      return {
        attachmentId: saved.id || extras.attachmentId || '',
        attachmentMimeType: saved.mimeType || (file && file.type) || extras.mimeType || '',
        attachmentStatus: saved.status || extras.status || 'failed',
        attachmentError: saved.errorMessage || extras.error || '',
        attachmentExtractedText: String(saved.extractedText || extras.extractedText || '').slice(
          0,
          2400
        ),
        attachmentProgress:
          saved.status === 'ready' || saved.status === 'failed'
            ? 100
            : extras.progress != null
            ? extras.progress
            : 100
      }
    },
    async hydrateExistingAttachments() {
      const roomKey = roomFromLocation(this.$route)
      const root = this.mindMap && this.mindMap.renderer && this.mindMap.renderer.root
      if (!roomKey || !root) return
      const nodes = []
      const visit = node => {
        const data = node && node.getData && node.getData()
        if (data && data.attachmentId) nodes.push(node)
        ;(node.children || []).forEach(visit)
      }
      visit(root)
      for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index]
        const data = node.getData() || {}
        const status = String(data.attachmentStatus || '').toLowerCase()
        if (status === 'uploading' && !data.attachmentId) {
          this.restoreSnapshot(node, {
            attachmentUrl: '',
            attachmentName: '',
            attachmentId: '',
            attachmentMimeType: '',
            attachmentStatus: '',
            attachmentError: '',
            attachmentExtractedText: '',
            attachmentProgress: 0
          })
          continue
        }
        try {
          const result = await getNodeAttachment(roomKey, data.attachmentId)
          const attachment = result && result.attachment
          if (!attachment) continue
          const nextStatus = attachment.status || data.attachmentStatus
          this.applyAttachment(
            node,
            data.attachmentUrl || '',
            data.attachmentName || attachment.fileName || '',
            {
              attachmentId: data.attachmentId,
              attachmentStatus: nextStatus,
              attachmentError: attachment.errorMessage || data.attachmentError,
              attachmentExtractedText: String(
                attachment.extractedText || data.attachmentExtractedText || ''
              ).slice(0, 2400),
              attachmentMimeType: attachment.mimeType || data.attachmentMimeType,
              attachmentProgress:
                nextStatus === 'ready' || nextStatus === 'failed' ? 100 : 100
            },
            {
              persist:
                nextStatus !== data.attachmentStatus ||
                (!data.attachmentMimeType && !!attachment.mimeType)
            }
          )
          if (attachment.status === 'processing' || attachment.status === 'pending') {
            this.watchAttachment(node, roomKey, attachment.id || data.attachmentId)
          }
        } catch (err) {
          // 单个历史附件不可读取时不影响其余节点。
        }
      }
    },
    watchAttachment(item, roomKey, attachmentId, options = {}) {
      const node = this.resolveNode(item)
      const uid = (node && node.getData && node.getData('uid')) || (item && item.uid)
      if (!uid || !attachmentId) return
      this.abortInflight(uid)
      const controller =
        typeof AbortController !== 'undefined' ? new AbortController() : { abort() {}, signal: { aborted: false } }
      this.$set(this.inflight, uid, { controller, attachmentId })
      waitForAttachmentReady(roomKey, attachmentId, {
        signal: controller.signal,
        onUpdate: attachment => {
          if (this.inflight[uid] && this.inflight[uid].attachmentId !== attachmentId) return
          this.applyAttachment(
            { uid, node },
            '',
            (attachment && attachment.fileName) || '',
            this.metaFromAttachment(attachment, null, { progress: 100 }),
            { persist: false, progressOnly: true }
          )
        }
      })
        .then(attachment => {
          if (this.inflight[uid] && this.inflight[uid].attachmentId !== attachmentId) return
          if (!attachment) return
          this.applyAttachment(
            { uid, node },
            '',
            attachment.fileName || '',
            this.metaFromAttachment(attachment, null, { progress: 100 })
          )
          if (attachment.status === 'failed') {
            if (options.notify) {
              this.$message.warning(attachment.errorMessage || '处理失败')
            }
          }
        })
        .catch(err => {
          if (err && err.name === 'AbortError') return
        })
        .finally(() => {
          if (this.inflight[uid] && this.inflight[uid].attachmentId === attachmentId) {
            this.$delete(this.inflight, uid)
          }
        })
    },
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
      // Keep the selected identities. Collaboration renders may replace node
      // instances while the file picker/upload is open.
      this.pendingNodes = list.map(node => ({ uid: node.uid, node }))
      this.$refs.fileInput && this.$refs.fileInput.click()
    },
    async onFilePicked(event) {
      const file =
        event && event.target && event.target.files && event.target.files[0]
      if (event && event.target) event.target.value = ''
      const pendingNodes = this.pendingNodes.slice()
      this.pendingNodes = []
      if (!file || !pendingNodes.length) return
      if (file.size > maxAttachmentBytes()) {
        this.$message.error(
          `单个附件最大支持 ${formatAttachmentMaxMb()} MB`
        )
        return
      }
      const roomKey = roomFromLocation(this.$route)
      const mindMap =
        this.mindMap ||
        (pendingNodes[0] && pendingNodes[0].node && pendingNodes[0].node.mindMap) ||
        null
      if (!mindMap || !roomKey) {
        this.$message.error('无法上传：缺少导图或房间')
        return
      }
      const snapshots = pendingNodes.map(item => ({
        ...item,
        snapshot: this.snapshotOf(this.resolveNode(item))
      }))
      snapshots.forEach(item => {
        this.applyAttachment(
          item,
          '',
          file.name,
          {
            attachmentId: '',
            attachmentMimeType: file.type || '',
            attachmentStatus: 'uploading',
            attachmentError: '',
            attachmentExtractedText: '',
            attachmentProgress: 0
          },
          { persist: false }
        )
      })
      try {
        let lastPercent = -1
        const res = await uploadNodeAttachment(roomKey, {
          file,
          fileName: file.name,
          mimeType: file.type || 'application/octet-stream',
          nodeUid: pendingNodes[0] && pendingNodes[0].uid,
          sourceKind: 'attachment',
          onUploadProgress: evt => {
            const percent = Number(evt && evt.percent) || 0
            if (percent === lastPercent) return
            lastPercent = percent
            snapshots.forEach(item => {
              this.applyAttachment(
                item,
                '',
                file.name,
                {
                  attachmentId: '',
                  attachmentMimeType: file.type || '',
                  attachmentStatus: 'uploading',
                  attachmentError: '',
                  attachmentExtractedText: '',
                  attachmentProgress: percent
                },
                { persist: false, progressOnly: true }
              )
            })
          }
        })
        const attachment = (res && res.attachment) || {}
        snapshots.forEach(item => {
          this.applyAttachment(
            item,
            '',
            attachment.fileName || file.name,
            this.metaFromAttachment(attachment, file)
          )
        })
        if (attachment.status === 'ready') {
          this.$message.success('已添加')
        } else if (attachment.status === 'processing' || attachment.status === 'pending') {
          this.$message.success('已上传，正在处理')
          snapshots.forEach(item => {
            this.watchAttachment(item, roomKey, attachment.id, { notify: true })
          })
        } else {
          this.$message.warning(
            attachment.errorMessage || '处理失败'
          )
        }
      } catch (err) {
        console.error('[attachment] upload failed', err)
        snapshots.forEach(item => this.restoreSnapshot(item, item.snapshot))
        this.$message.error((err && err.message) || '附件上传失败')
      }
    }
  }
}
</script>

<style scoped>
.node-attachment-input {
  display: none;
}
</style>
