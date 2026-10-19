<template
  ><button
    v-if="node && (!readonly || requestId || isPolicy)"
    type="button"
    class="leaveIntentTrigger"
    @click="open"
  >
    <i class="el-icon-date" /><span>{{
      isPolicy ? '配置请假流程' : requestId ? '查看请假申请' : '发起请假申请'
    }}</span
    ><i class="el-icon-arrow-right" /></button
></template>
<script>
import service, { openLeaveRequest } from '@/services/leaveService'
import { roomFromLocation } from '@/utils/roomLocation'
export default {
  props: { mindMap: Object },
  data: () => ({
    node: null,
    readonly: false,
    requestId: '',
    isPolicy: false,
    policyUids: []
  }),
  mounted() {
    this.$bus.$on('node_active', this.select)
    this.mindMap.on('hide_text_edit', this.onTextEnd)
    this.mindMap.on('data_change', this.update)
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
    this.$bus.$off('node_active', this.select)
    this.mindMap.off('hide_text_edit', this.onTextEnd)
    this.mindMap.off('data_change', this.update)
  },
  methods: {
    onTextEnd(element, list, editedNode) {
      if (!editedNode) return
      this.candidate = editedNode
      this.update()
      const d = editedNode.getData(),
        text = String(d.text || '')
          .replace(/<[^>]*>/g, '')
          .trim()
      const directIntent = /^(?:我要|我想|我需要|我准备|申请|我要申请|我想申请|需要申请|准备申请).{0,6}(?:请假|年假|病假|事假|调休|婚假|产假|陪产假|丧假|长假)/.test(
        text
      )
      if (
        !directIntent ||
        /取消|撤回|不请|不想|不要|无需/.test(text) ||
        this.readonly ||
        this.isPolicy ||
        this.requestId ||
        !this.node
      )
        return
      const signature = d.uid + ':' + text
      if (!this.prompted) this.prompted = new Set()
      if (this.prompted.has(signature)) return
      if (this.prompted.size >= 100) this.prompted.clear()
      this.prompted.add(signature)
      this.$nextTick(() => {
        if (
          !this._isDestroyed &&
          this.candidate === editedNode &&
          !this.$store.state.isReadonly
        )
          this.open()
      })
    },
    select(...args) {
      const list = args[1] || []
      this.candidate = list[0] || null
      this.update()
    },
    update() {
      const n = this.candidate,
        d = n && n.getData()
      this.readonly = !!this.$store.state.isReadonly
      this.requestId = ''
      if (d && d.hyperlink) {
        try {
          const url = new URL(d.hyperlink, window.location.origin)
          const id = url.searchParams.get('leaveRequest') || ''
          if (
            url.origin === window.location.origin &&
            /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)
          )
            this.requestId = id
        } catch (_) {
          /* Ordinary links do not identify approval requests. */
        }
      }
      this.isPolicy =
        roomFromLocation(this.$route) === this.policyRoom &&
        !!d &&
        this.policyUids.includes(d.uid)
      this.node =
        d &&
        (this.isPolicy ||
          this.requestId ||
          /(?:我要|申请|想|需要|准备).{0,12}(?:请假|年假|病假|事假|调休|婚假|产假|陪产假|丧假|长假)/.test(
            String(d.text || '').replace(/<[^>]*>/g, '')
          ))
          ? n
          : null
    },
    open() {
      if (this.isPolicy)
        return window.dispatchEvent(new CustomEvent('mindmap:leave-policy'))
      openLeaveRequest({
        requestId: this.requestId || undefined,
        roomKey: roomFromLocation(this.$route),
        nodeUid: this.node.getData('uid')
      })
    }
  }
}
</script>
<style lang="less" scoped>
.leaveIntentTrigger {
  position: absolute;
  right: 88px;
  bottom: 60px;
  z-index: 8;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border: 1px solid #dbe6f3;
  border-radius: 12px;
  background: #fff;
  box-shadow: 0 5px 24px #20355614;
  color: #385b88;
  cursor: pointer;
  font-size: 13px;
}
.leaveIntentTrigger:hover {
  border-color: #9ab8e0;
  background: #f7faff;
}
@media (max-width: 600px) {
  .leaveIntentTrigger {
    right: 18px;
    bottom: 70px;
  }
}
</style>
