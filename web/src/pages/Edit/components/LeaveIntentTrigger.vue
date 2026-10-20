<template>
  <div
    v-if="node && (!readonly || requestId || isPolicy)"
    class="leaveIntentTrigger"
    aria-live="polite"
  >
    <span v-if="busy" class="leaveNodeStatus"
      ><i class="el-icon-loading" /> 正在检查节点资料</span
    >
    <span v-else-if="error" class="leaveNodeError">{{ error }}</span>
    <span v-else-if="requestId" class="leaveNodeStatus">{{
      checkedLabel || '直接在申请资料子节点填写'
    }}</span>
    <button type="button" :disabled="busy" @click="open">
      <i class="el-icon-date" /><span>{{
        isPolicy
          ? '配置请假流程'
          : requestId
          ? '核对申请与审批'
          : '生成请假资料子节点'
      }}</span
      ><i class="el-icon-arrow-right" />
    </button>
  </div>
</template>
<script>
import service, { openLeaveRequest } from '@/services/leaveService'
import { roomFromLocation } from '@/utils/roomLocation'
import { extractFields } from '../../../../../simple-mind-map/src/utils/leaveNodeFields'
function requestLink(data) {
  try {
    const url = new URL(data.hyperlink, window.location.origin)
    const id = url.searchParams.get('leaveRequest') || ''
    return url.origin === window.location.origin &&
      /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)
      ? id
      : ''
  } catch (_) {
    return ''
  }
}
function fieldsOf(node) {
  const rows = []
  const walk = (item, parent, position = '') => {
    if (rows.length >= 500)
      throw new Error('申请资料超过500节点，请精简后再检查')
    const data = item.data || {},
      uid = data.uid
    rows.push({ uid, parent_uid: parent, position, data })
    ;(item.children || []).forEach((c, i) =>
      walk(c, uid, String(i).padStart(6, '0'))
    )
  }
  walk(
    node.getPureData
      ? node.getPureData()
      : node.nodeData || { data: node.getData() },
    null
  )
  return extractFields(rows, node.getData('uid'))
}
export default {
  props: { mindMap: Object },
  data: () => ({
    node: null,
    readonly: false,
    requestId: '',
    isPolicy: false,
    policyUids: [],
    busy: false,
    error: '',
    checkedLabel: ''
  }),
  mounted() {
    this.requestByNode = new Map()
    this.signatures = new Map()
    this.$bus.$on('node_active', this.select)
    this.mindMap.on('hide_text_edit', this.onTextEnd)
    this.mindMap.on('data_change', this.onDataChange)
    window.addEventListener('mindmap:leave-focus', this.focusNodes)
    service
      .template()
      .then(tpl => {
        if (this._isDestroyed) return
        this.policyRoom = tpl.source.roomKey
        this.policyUids = [
          tpl.rootUid,
          ...tpl.steps.map(s => s.bindingUid),
          ...tpl.ccBindings.map(s => s.bindingUid)
        ].filter(Boolean)
        this.update()
      })
      .catch(() => {})
  },
  beforeDestroy() {
    clearTimeout(this.checkTimer)
    this.$bus.$off('node_active', this.select)
    this.mindMap.off('hide_text_edit', this.onTextEnd)
    this.mindMap.off('data_change', this.onDataChange)
    window.removeEventListener('mindmap:leave-focus', this.focusNodes)
  },
  methods: {
    focusNodes(event) {
      const d = event.detail || {}
      if (d.roomKey === roomFromLocation(this.$route))
        this.mindMap.execCommand('GO_TARGET_NODE', d.nodeUid)
    },
    onTextEnd(element, list, editedNode) {
      if (!editedNode) return
      this.candidate = editedNode
      this.update()
      if (this.requestId) return this.scheduleCheck()
      const text = String(editedNode.getData('text') || '')
        .replace(/<[^>]*>/g, '')
        .trim()
      if (
        /^(?:我要|我想|我需要|我准备|申请|我要申请|我想申请|需要申请|准备申请).{0,6}(?:请假|年假|病假|事假|调休|婚假|产假|陪产假|丧假|长假)/.test(
          text
        ) &&
        !/取消|撤回|不请|不想|不要|无需/.test(text) &&
        !this.readonly &&
        !this.isPolicy &&
        this.node &&
        !this.busy
      )
        this.begin()
    },
    select(...args) {
      this.candidate = (args[1] || [])[0] || null
      this.update()
    },
    onDataChange() {
      this.update()
      this.scheduleCheck()
    },
    update() {
      let n = this.candidate
      if (n && this.mindMap.renderer && this.mindMap.renderer.findNodeByUid)
        n = this.mindMap.renderer.findNodeByUid(n.getData('uid')) || n
      const d = n && n.getData()
      this.readonly = !!this.$store.state.isReadonly
      this.requestId = ''
      this.isPolicy =
        roomFromLocation(this.$route) === this.policyRoom &&
        !!d &&
        this.policyUids.includes(d.uid)
      this.node = this.isPolicy ? n : null
      for (
        let depth = 0, p = n;
        p && depth < 20 && !this.isPolicy;
        p = p.parent, depth++
      ) {
        const direct = requestLink(p.getData())
        const childLink = ((p.nodeData && p.nodeData.children) || [])
          .map(c => requestLink(c.data || {}))
          .find(Boolean)
        const id =
          direct ||
          childLink ||
          (this.requestByNode && this.requestByNode.get(p.getData('uid')))
        if (id) {
          this.node = direct && p.parent ? p.parent : p
          this.requestId = id
          break
        }
      }
      if (
        !this.node &&
        d &&
        /(?:我要|申请|想|需要|准备).{0,12}(?:请假|年假|病假|事假|调休|婚假|产假|陪产假|丧假|长假)/.test(
          String(d.text || '').replace(/<[^>]*>/g, '')
        )
      )
        this.node = n
    },
    async begin() {
      if (this.busy || !this.node || this.readonly) return
      const node = this.node,
        uid = node.getData('uid'),
        room = roomFromLocation(this.$route)
      this.busy = true
      this.error = ''
      try {
        let row
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            row = await service.prepare(room, uid)
            break
          } catch (e) {
            if (e.code !== 'NODE_SCOPE_INVALID' || attempt === 3) throw e
            await new Promise(resolve =>
              setTimeout(resolve, [400, 900, 1800][attempt])
            )
          }
        }
        if (this._isDestroyed || room !== roomFromLocation(this.$route)) return
        this.requestByNode.set(uid, row.id)
        this.checkedLabel = '已生成资料子节点，直接双击“待填写”编辑'
        this.update()
        window.dispatchEvent(new CustomEvent('mindmap:leave-changed'))
      } catch (e) {
        if (!this._isDestroyed) this.error = e.message
      } finally {
        if (!this._isDestroyed) {
          this.busy = false
          this.scheduleCheck()
        }
      }
    },
    scheduleCheck() {
      clearTimeout(this.checkTimer)
      if (!this.requestId || this.readonly || this.isPolicy) return
      if (this.busy) {
        this.checkAgain = true
        return
      }
      this.checkTimer = setTimeout(() => this.checkNodes(), 1000)
    },
    async checkNodes() {
      if (!this.node || !this.requestId || this.busy || this.readonly) return
      const id = this.requestId,
        node = this.node
      let fields
      try {
        fields = fieldsOf(node)
      } catch (e) {
        this.error = e.message
        return
      }
      const signature = JSON.stringify(fields)
      if (this.signatures.get(id) === signature) return
      this.busy = true
      this.error = ''
      try {
        const row = await service.get(id)
        if (!['draft', 'returned'].includes(row.status)) {
          this.signatures.set(id, signature)
          return
        }
        const fresh = await service.act(id, 'import', {
          expectedRevision: row.revision,
          expectedFields: fields
        })
        this.signatures.set(id, signature)
        if (id === this.requestId && !this._isDestroyed)
          this.checkedLabel = (fresh.report.blockers || []).length
            ? '缺项已标在填写检查节点中'
            : '资料已读取，可核对并提交'
      } catch (e) {
        if (id === this.requestId && !this._isDestroyed) this.error = e.message
      } finally {
        if (!this._isDestroyed) {
          this.busy = false
          if (this.checkAgain) {
            this.checkAgain = false
            this.scheduleCheck()
          }
        }
      }
    },
    open() {
      clearTimeout(this.checkTimer)
      if (this.isPolicy)
        return window.dispatchEvent(new CustomEvent('mindmap:leave-policy'))
      if (!this.requestId) return this.begin()
      let expectedFields
      try {
        expectedFields = fieldsOf(this.node)
      } catch (e) {
        this.error = e.message
        return
      }
      openLeaveRequest({
        requestId: this.requestId,
        roomKey: roomFromLocation(this.$route),
        nodeUid: this.node.getData('uid'),
        expectedFields
      })
    }
  }
}
</script>
<style lang="less" scoped>
.leaveIntentTrigger {
  position: absolute;
  right: 24px;
  bottom: 24px;
  z-index: 8;
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: calc(100% - 48px);
  padding: 10px 14px;
  border: 1px solid #dbe6f3;
  border-radius: 12px;
  background: #fff;
  box-shadow: 0 5px 24px #20355614;
  color: #385b88;
  font-size: 13px;
  button {
    display: flex;
    align-items: center;
    gap: 8px;
    border: 0;
    background: transparent;
    color: #3267a5;
    cursor: pointer;
    white-space: nowrap;
    padding: 6px;
  }
  button:disabled {
    opacity: 0.6;
    cursor: wait;
  }
  .leaveNodeStatus,
  .leaveNodeError {
    max-width: 360px;
    line-height: 1.5;
  }
  .leaveNodeError {
    color: #b54444;
  }
}
@media (max-width: 600px) {
  .leaveIntentTrigger {
    right: 12px;
    bottom: 12px;
    max-width: calc(100% - 24px);
    flex-wrap: wrap;
    gap: 4px;
  }
  .leaveNodeStatus,
  .leaveNodeError {
    font-size: 12px;
  }
}
</style>
