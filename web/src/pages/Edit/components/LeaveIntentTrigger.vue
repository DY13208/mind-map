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
          ? '配置审批流程'
          : requestId
          ? '核对申请与审批'
          : '匹配审批流程'
      }}</span
      ><i class="el-icon-arrow-right" />
    </button>
    <el-dialog
      :visible.sync="choosing"
      append-to-body
      title="选择本次审批流程"
      custom-class="workflowPickerDialog"
      width="min(560px, 94vw)"
      :close-on-click-modal="false"
    >
      <p class="workflowChoiceHint">
        请选择本次使用的流程并核对来源。此操作只创建草稿，不提交审批。
      </p>
      <button
        v-for="choice in choices"
        :key="choice.source.roomKey + choice.source.nodeUid"
        class="workflowChoice"
        type="button"
        :disabled="busy"
        @click="begin(choice.source)"
      >
        <strong>{{ choice.title }}</strong
        ><span>{{ choice.roomTitle }} · {{ choice.flowId || '请假制度' }}</span
        ><i class="el-icon-arrow-right" />
      </button>
      <el-button
        v-if="catalogCursor"
        size="small"
        :loading="busy"
        @click="loadMoreChoices"
        >加载更多流程</el-button
      >
    </el-dialog>
  </div>
</template>
<script>
import service, { openLeaveRequest } from '@/services/leaveService'
import { roomFromLocation } from '@/utils/roomLocation'
import {
  extractFields,
  isWorkflowIntent
} from '../../../../../simple-mind-map/src/utils/leaveNodeFields'
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
function fieldsOf(node, template) {
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
  return extractFields(
    rows,
    node.getData('uid'),
    template && template.kind === 'generic' ? template.fields : undefined
  )
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
    checkedLabel: '',
    choices: [],
    catalogCursor: null,
    choosing: false,
    policySource: null
  }),
  mounted() {
    this.requestByNode = new Map()
    this.signatures = new Map()
    this.requestTemplates = new Map()
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
        isWorkflowIntent(text) &&
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
      this.policySource = null
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
      for (let depth = 0, p = n; p && depth < 20; p = p.parent, depth++) {
        if (
          ((p.nodeData && p.nodeData.children) || []).some(c =>
            /^流程标识\s*[:：]\s*.+/.test(
              String(c.data.text || '').replace(/<[^>]+>/g, '')
            )
          )
        ) {
          this.isPolicy = true
          this.node = p
          this.policySource = {
            roomKey: roomFromLocation(this.$route),
            nodeUid: p.getData('uid')
          }
          break
        }
      }
      if (this.isPolicy && !this.policySource)
        this.policySource = {
          roomKey: this.policyRoom,
          nodeUid: this.policyUids[0]
        }
      if (!this.node && d && isWorkflowIntent(d.text)) this.node = n
    },
    async loadMoreChoices() {
      if (this.busy || !this.catalogCursor) return
      this.busy = true
      try {
        const page = await service.catalog(this.catalogCursor)
        const known = new Set(
          this.choices.map(c => c.source.roomKey + ':' + c.source.nodeUid)
        )
        this.choices.push(
          ...page.list.filter(
            c => !known.has(c.source.roomKey + ':' + c.source.nodeUid)
          )
        )
        this.catalogCursor = page.nextCursor
      } catch (e) {
        this.error = e.message
      } finally {
        this.busy = false
      }
    },
    async begin(source) {
      if (this.busy || !this.node || this.readonly) return
      const node = this.node,
        uid = node.getData('uid'),
        room = roomFromLocation(this.$route)
      this.busy = true
      this.error = ''
      try {
        if (!source) {
          const result = await service.resolve(node.getData('text'))
          if (this._isDestroyed || room !== roomFromLocation(this.$route))
            return
          if (!result.candidates.length) {
            const page = await service.catalog()
            if (!page.list.length && !page.hasMore)
              throw new Error(result.reason || '未找到可访问的审批模板')
            this.choices = page.list
            this.catalogCursor = page.nextCursor
            this.choosing = true
            return
          }
          if (result.candidates.length > 1) {
            this.choices = result.candidates
            this.catalogCursor = null
            this.choosing = true
            return
          }
          source = result.candidates[0].source
        }
        this.choosing = false
        let row
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            row = await service.prepare(room, uid, source)
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
        this.requestTemplates.set(row.id, row.template)
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
      this.busy = true
      this.error = ''
      try {
        const cached = this.requestTemplates.get(id)
        if (
          cached &&
          this.signatures.get(id) === JSON.stringify(fieldsOf(node, cached))
        )
          return
        const row = await service.get(id)
        this.requestTemplates.set(id, row.template)
        const fields = fieldsOf(node, row.template),
          signature = JSON.stringify(fields)
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
    async open() {
      clearTimeout(this.checkTimer)
      if (this.isPolicy)
        return window.dispatchEvent(
          new CustomEvent('mindmap:leave-policy', {
            detail: { source: this.policySource }
          })
        )
      if (!this.requestId) return this.begin()
      const id = this.requestId,
        node = this.node,
        room = roomFromLocation(this.$route)
      this.busy = true
      try {
        let tpl = this.requestTemplates.get(id)
        if (!tpl) {
          const row = await service.get(id)
          tpl = row.template
          this.requestTemplates.set(id, tpl)
        }
        if (
          this._isDestroyed ||
          this.requestId !== id ||
          roomFromLocation(this.$route) !== room
        )
          return
        const live =
          (this.mindMap.renderer &&
            this.mindMap.renderer.findNodeByUid(node.getData('uid'))) ||
          node
        openLeaveRequest({
          requestId: id,
          roomKey: room,
          nodeUid: node.getData('uid'),
          expectedFields: fieldsOf(live, tpl)
        })
      } catch (e) {
        this.error = e.message
      } finally {
        this.busy = false
      }
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

<style lang="less">
.workflowPickerDialog {
  border-radius: 14px;
  .el-dialog__body {
    max-height: 62vh;
    overflow: auto;
    padding-top: 12px;
  }
  .el-dialog__header {
    padding: 22px 22px 14px;
  }
}
.workflowChoiceHint {
  font-size: 13px;
  color: #748094;
  line-height: 1.7;
  margin-top: 0;
}
.workflowChoice {
  width: 100%;
  display: grid;
  grid-template-columns: 1fr auto;
  text-align: left;
  gap: 8px;
  padding: 16px;
  border: 1px solid #e4eaf1;
  border-radius: 12px;
  margin-top: 12px;
  background: white;
  color: #293d53;
  cursor: pointer;
  strong {
    font-size: 15px;
  }
  span {
    grid-column: 1;
    color: #7b8a9c;
    font-size: 12px;
  }
  i {
    grid-column: 2;
    grid-row: 1 / 3;
    align-self: center;
  }
  &:hover {
    border-color: #82a9d7;
    background: #f8fbff;
  }
}
</style>
