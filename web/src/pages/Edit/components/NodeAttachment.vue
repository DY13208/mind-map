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
  getRoomRevision,
  deleteNodeAttachment,
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
      inflight: {},
      operationEpochs: {},
      operationSequence: 0,
      navigationEpoch: 0,
      destroyed: false
    }
  },
  watch: {
    $route() {
      this.navigationEpoch += 1
      this.pendingNodes = []
      Object.keys(this.inflight).forEach(uid => this.abortInflight(uid))
    }
  },
  created() {
    this.$bus.$on('selectAttachment', this.onSelectAttachment)
    this.$bus.$on('manageNodeAttachment', this.onManageAttachment)
  },
  mounted() {
    this.hydrateExistingAttachments()
  },
  beforeDestroy() {
    this.destroyed = true
    this.navigationEpoch += 1
    this.pendingNodes = []
    this.$bus.$off('selectAttachment', this.onSelectAttachment)
    this.$bus.$off('manageNodeAttachment', this.onManageAttachment)
    Object.keys(this.inflight).forEach(uid => this.abortInflight(uid))
  },
  methods: {
    abortInflight(uid, expectedAttachmentId = '') {
      const job = this.inflight[uid]
      if (
        expectedAttachmentId &&
        job &&
        String(job.attachmentId || '') !== String(expectedAttachmentId)
      ) {
        return false
      }
      this.$delete(this.inflight, uid)
      if (job && job.controller) job.controller.abort()
      return !!job
    },
    nodeUid(item) {
      if (!item) return ''
      return String(
        (item.getData && item.getData('uid')) ||
          item.uid ||
          (item.node && item.node.uid) ||
          ''
      )
    },
    liveNode(uid) {
      const renderer = this.mindMap && this.mindMap.renderer
      return uid && renderer && typeof renderer.findNodeByUid === 'function'
        ? renderer.findNodeByUid(uid)
        : null
    },
    captureTarget(item, roomKey, expected = {}) {
      const uid = this.nodeUid(item)
      const node = this.liveNode(uid) || this.resolveNode(item)
      if (!uid || !node) return null
      const data = (node.getData && node.getData()) || {}
      return {
        uid,
        node,
        roomKey,
        navigationEpoch:
          expected.navigationEpoch != null
            ? expected.navigationEpoch
            : this.navigationEpoch,
        expectedAttachmentId:
          expected.expectedAttachmentId != null
            ? String(expected.expectedAttachmentId)
            : String(data.attachmentId || ''),
        expectedAttachmentUrl:
          expected.expectedAttachmentUrl != null
            ? String(expected.expectedAttachmentUrl)
            : String(data.attachmentUrl || ''),
        expectedAttachmentName:
          expected.expectedAttachmentName != null
            ? String(expected.expectedAttachmentName)
            : String(data.attachmentName || ''),
        replacementIntentToken: expected.replacementIntentToken || 0
      }
    },
    roomIsCurrent(roomKey, navigationEpoch) {
      return (
        !this.destroyed &&
        navigationEpoch === this.navigationEpoch &&
        roomFromLocation(this.$route) === roomKey
      )
    },
    targetIsCurrent(target) {
      if (
        !target ||
        !this.roomIsCurrent(target.roomKey, target.navigationEpoch)
      ) {
        return false
      }
      const node = this.liveNode(target.uid)
      if (!node) return false
      const data = (node.getData && node.getData()) || {}
      const attachmentId = String(data.attachmentId || '')
      if (attachmentId !== target.expectedAttachmentId) return false
      if (attachmentId) return true
      return (
        String(data.attachmentUrl || '') === target.expectedAttachmentUrl &&
        String(data.attachmentName || '') === target.expectedAttachmentName
      )
    },
    beginOperation(target) {
      const token = ++this.operationSequence
      this.$set(this.operationEpochs, target.uid, token)
      return token
    },
    operationIsCurrent(target, token) {
      return (
        this.targetIsCurrent(target) &&
        this.operationEpochs[target.uid] === token
      )
    },
    operationTokenIsCurrent(uid, token) {
      return (
        !this.destroyed &&
        this.operationEpochs[uid] === token
      )
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
    applyLocalAttachment(node, patch) {
      if (!node || !patch) return
      const renderer = this.mindMap && this.mindMap.renderer
      if (renderer && typeof renderer.setNodeData === 'function') {
        renderer.setNodeData(node, patch)
      } else if (node.nodeData && node.nodeData.data) {
        Object.assign(node.nodeData.data, patch)
      }
      if (typeof node.reRender === 'function') {
        node.reRender(['attachment'])
      } else if (
        renderer &&
        typeof renderer.reRenderNodeCheckChange === 'function'
      ) {
        renderer.reRenderNodeCheckChange(node)
      }
    },
    applyDetachedResponse(target, result) {
      if (!this.roomIsCurrent(target.roomKey, target.navigationEpoch)) return false
      const node = this.liveNode(target.uid)
      if (!node) return false
      const current = (node.getData && node.getData()) || {}
      const currentId = String(current.attachmentId || '')
      if (currentId && currentId !== target.expectedAttachmentId) return false
      if (
        !currentId &&
        (String(current.attachmentUrl || '') !== target.expectedAttachmentUrl ||
          String(current.attachmentName || '') !== target.expectedAttachmentName) &&
        (current.attachmentUrl || current.attachmentName)
      ) return false
      const serverNode = result && result.node
      const serverData =
        (serverNode && serverNode.data) || (result && result.data) || null
      const serverId = String((serverData && serverData.attachmentId) || '')
      if (serverId && serverId !== target.expectedAttachmentId) return false
      const fields = [
        'attachmentUrl',
        'attachmentName',
        'attachmentId',
        'attachmentMimeType',
        'attachmentStatus',
        'attachmentError',
        'attachmentExtractedText',
        'attachmentProgress'
      ]
      const patch = {}
      fields.forEach(key => {
        patch[key] = serverData && Object.prototype.hasOwnProperty.call(serverData, key)
          ? serverData[key]
          : key === 'attachmentProgress'
          ? 0
          : ''
      })
      this.applyLocalAttachment(node, patch)
      return true
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
      const navigationEpoch = this.navigationEpoch
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
        const initialNode = nodes[index]
        const initialData = initialNode.getData() || {}
        const target = this.captureTarget(initialNode, roomKey, {
          expectedAttachmentId: initialData.attachmentId,
          navigationEpoch
        })
        if (
          !target ||
          !initialData.attachmentId ||
          !this.targetIsCurrent(target)
        ) continue
        try {
          const result = await getNodeAttachment(
            roomKey,
            target.expectedAttachmentId
          )
          if (!this.targetIsCurrent(target)) continue
          const node = this.liveNode(target.uid)
          const data = (node && node.getData && node.getData()) || {}
          const attachment = result && result.attachment
          if (!attachment) continue
          const nextStatus = attachment.status || data.attachmentStatus
          this.applyAttachment(
            { uid: target.uid, node },
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
            this.watchAttachment(
              { uid: target.uid, node },
              roomKey,
              attachment.id || target.expectedAttachmentId
            )
          }
        } catch (err) {
          // 单个历史附件不可读取时不影响其余节点。
        }
      }
    },
    watchAttachment(item, roomKey, attachmentId, options = {}) {
      const uid = this.nodeUid(item)
      const liveNode = this.liveNode(uid)
      const data = (liveNode && liveNode.getData && liveNode.getData()) || {}
      const target = this.captureTarget(liveNode || item, roomKey, {
        expectedAttachmentId: attachmentId,
        expectedAttachmentUrl: data.attachmentUrl,
        expectedAttachmentName: data.attachmentName
      })
      if (!uid || !attachmentId || !target || !this.targetIsCurrent(target)) return
      this.abortInflight(uid)
      const controller =
        typeof AbortController !== 'undefined' ? new AbortController() : { abort() {}, signal: { aborted: false } }
      const task = { controller, attachmentId, roomKey, target }
      this.$set(this.inflight, uid, task)
      waitForAttachmentReady(roomKey, attachmentId, {
        signal: controller.signal,
        onUpdate: attachment => {
          if (
            this.inflight[uid] !== task ||
            !this.targetIsCurrent(target)
          ) return
          const node = this.liveNode(uid)
          const current = (node && node.getData && node.getData()) || {}
          this.applyAttachment(
            { uid, node },
            current.attachmentUrl || '',
            (attachment && attachment.fileName) || current.attachmentName || '',
            this.metaFromAttachment(attachment, null, { progress: 100 }),
            { persist: false, progressOnly: true }
          )
        }
      })
        .then(attachment => {
          if (
            this.inflight[uid] !== task ||
            !this.targetIsCurrent(target) ||
            !attachment
          ) return
          const node = this.liveNode(uid)
          const current = (node && node.getData && node.getData()) || {}
          this.applyAttachment(
            { uid, node },
            current.attachmentUrl || '',
            attachment.fileName || current.attachmentName || '',
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
          if (this.inflight[uid] === task) {
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
      // Snapshot the intended target and attachment before the native picker.
      // Collaboration may replace node instances while the picker is open.
      this.pendingNodes = list
        .map(node => this.captureTarget(node, roomKey))
        .filter(Boolean)
      this.$refs.fileInput && this.$refs.fileInput.click()
    },
    async onManageAttachment(item) {
      const action = item && item.action ? item.action : 'replace'
      const itemNode = (item && item.node) || item
      const roomKey = roomFromLocation(this.$route)
      const target = this.captureTarget(itemNode, roomKey, item || {})
      if (!roomKey || !target || !this.targetIsCurrent(target)) {
        this.$message.warning('节点附件已发生变化，请重新打开附件菜单')
        return
      }
      const node = this.liveNode(target.uid)
      const data = (node && node.getData && node.getData()) || {}
      const hasAttachment = !!(
        target.expectedAttachmentId ||
        target.expectedAttachmentUrl ||
        target.expectedAttachmentName ||
        data.attachmentStatus
      )
      if (!hasAttachment || !['delete', 'replace'].includes(action)) return
      const fileName = target.expectedAttachmentName || '未命名附件'
      try {
        await this.$confirm(
          action === 'delete'
            ? `确定从当前节点删除附件“${fileName}”吗？这只会解除当前节点的引用，服务端保留文件，也不影响其他节点。`
            : `将为当前节点选择新文件。附件“${fileName}”会继续保留，直到新文件上传成功后才切换；取消或上传失败时原附件不变。`,
          action === 'delete' ? '删除节点附件' : '替换节点附件',
          {
            confirmButtonText: action === 'delete' ? '删除附件' : '选择文件',
            cancelButtonText: '取消',
            type: action === 'delete' ? 'warning' : 'info'
          }
        )
      } catch (err) {
        return
      }
      if (!this.targetIsCurrent(target)) {
        this.$message.warning('节点附件已发生变化，请重新操作')
        return
      }
      if (action === 'replace') {
        target.replacementIntentToken = this.beginOperation(target)
        this.pendingNodes = [target]
        this.$refs.fileInput && this.$refs.fileInput.click()
        return
      }

      this.beginOperation(target)
      try {
        if (target.expectedAttachmentId) {
          const baseVersion = await getRoomRevision(roomKey)
          if (!this.targetIsCurrent(target)) {
            this.$message.warning('节点附件已发生变化，请重新操作')
            return
          }
          const result = await deleteNodeAttachment(
            roomKey,
            target.expectedAttachmentId,
            target.uid,
            { confirmSopChange: true, baseVersion }
          )
          const updatedLocally = this.applyDetachedResponse(target, result)
          this.abortInflight(target.uid, target.expectedAttachmentId)
          if (result && result.already_detached) {
            this.$message.info('当前节点已解除该附件引用，文件仍保留在房间中')
          } else if (!updatedLocally) {
            this.$message.info('旧附件引用已解除；节点已有更新内容，已保留当前内容')
          } else {
            this.$message.success('已从当前节点删除附件，文件仍保留在房间中')
          }
        } else {
          // Legacy URL-only attachments have no server attachment record to
          // DELETE; clear only the current node's pointer using the normal
          // collaboration command. No remote URL or file is removed.
          if (!this.targetIsCurrent(target)) return
          this.abortInflight(target.uid)
          this.applyAttachment(node, '', '', {
            attachmentId: '',
            attachmentMimeType: '',
            attachmentStatus: '',
            attachmentError: '',
            attachmentExtractedText: '',
            attachmentProgress: 0
          })
          this.$message.success('已解除当前节点的附件引用')
        }
      } catch (err) {
        if (err && (err.code === 'ATTACHMENT_MISMATCH' || err.statusCode === 409)) {
          this.$message.warning('节点附件已被其他操作更新，请刷新后重试')
          return
        }
        this.$message.error((err && err.message) || '删除附件失败')
      }
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
      const validTargets = pendingNodes.filter(
        target =>
          target.roomKey === roomKey &&
          this.targetIsCurrent(target) &&
          (!target.replacementIntentToken ||
            this.operationTokenIsCurrent(
              target.uid,
              target.replacementIntentToken
            ))
      )
      if (!this.mindMap || !roomKey) {
        this.$message.error('无法上传：缺少导图或房间')
        return
      }
      if (!validTargets.length) {
        this.$message.warning('目标节点或附件已发生变化，请重新选择节点')
        return
      }
      const operations = validTargets.map(target => ({
        target,
        token: this.beginOperation(target)
      }))
      let uploadNotice = null
      if (typeof this.$message === 'function') {
        uploadNotice = this.$message({
          message: '附件上传中；原附件会保留到新文件上传成功后再切换',
          type: 'info',
          duration: 0,
          showClose: true
        })
      } else if (this.$message && this.$message.info) {
        this.$message.info('附件上传中；原附件会保留到新文件上传成功后再切换')
      }
      try {
        const res = await uploadNodeAttachment(roomKey, {
          file,
          fileName: file.name,
          mimeType: file.type || 'application/octet-stream',
          nodeUid: validTargets[0].uid,
          sourceKind: 'attachment'
        })
        const attachment = (res && (res.attachment || (res.data && res.data.attachment))) || {}
        if (!attachment.id) {
          this.$message.error('上传已完成，但服务端未返回附件 ID；原附件保持不变')
          return
        }
        let applied = 0
        const attachedTargets = []
        operations.forEach(({ target, token }) => {
          if (!this.operationIsCurrent(target, token)) return
          const node = this.liveNode(target.uid)
          if (!node) return
          this.abortInflight(target.uid)
          this.applyAttachment(
            { uid: target.uid, node },
            '',
            attachment.fileName || file.name,
            this.metaFromAttachment(attachment, file)
          )
          applied += 1
          attachedTargets.push({ uid: target.uid, token })
        })
        if (!applied) {
          this.$message.warning('上传已完成，但目标节点已变化；附件未替换到节点')
          return
        }
        if (attachment.status === 'ready') {
          this.$message.success('已添加')
        } else if (attachment.status === 'processing' || attachment.status === 'pending') {
          this.$message.success('已上传，正在处理')
          attachedTargets.forEach(({ uid, token }) => {
            if (!this.operationTokenIsCurrent(uid, token)) return
            const node = this.liveNode(uid)
            if (
              !node ||
              String((node.getData && node.getData('attachmentId')) || '') !==
                String(attachment.id || '')
            ) return
            this.watchAttachment(
              { uid, node },
              roomKey,
              attachment.id,
              { notify: true }
            )
          })
        } else {
          this.$message.warning(
            attachment.errorMessage || '处理失败'
          )
        }
      } catch (err) {
        console.error('[attachment] upload failed', err)
        this.$message.error((err && err.message) || '附件上传失败')
      } finally {
        if (uploadNotice && typeof uploadNotice.close === 'function') {
          uploadNotice.close()
        }
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
