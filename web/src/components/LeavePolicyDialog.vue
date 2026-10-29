<template>
  <el-dialog
    :visible.sync="visible"
    :title="agentMode ? '发布这个审批流' : '审批流程配置'"
    custom-class="leavePolicyDialog"
    append-to-body
    :close-on-click-modal="false"
    @closed="sequence++"
  >
    <section v-loading="loading">
      <el-alert v-if="error" :title="error" type="error" :closable="false" />
      <template v-if="policy">
        <div class="policyHeading">
          <div>
            <small>{{ policy.title }}</small>
            <h2>{{ agentMode ? '发布为审批节点，由 Agent 通过 MCP 执行' : '脑图定义规则，发布后执行' }}</h2>
          </div>
          <el-tag :type="policy.publication.valid ? 'success' : 'warning'">{{
            policy.publication.valid ? '当前版本已发布' : configurationPending ? '待配置' : '待发布'
          }}</el-tag>
        </div>
        <el-alert v-if="policy.notificationOnly" title="仅抄送，无需审批：材料完整并确认提交后完成登记，通知已配置的抄送人，不生成审核待办。" type="info" :closable="false" show-icon />
        <el-alert v-if="(policy.configurationErrors || []).length" :title="policy.configurationErrors.join('；')" type="warning" :closable="false" show-icon />
        <p class="policyHint">
          <template v-if="agentMode">发布后节点显示“审批”标记，可复制给 AI 在 Agent 中运行。材料可在脑图提交要求下填写，也可在 Agent 对话中提供，本次对话材料不写回脑图。修改审批规则后须重新发布。</template>
          写明姓名会匹配本企业唯一成员，同名时须登记具体账号。部门负责人和HRBP由人事组织架构按申请员工动态解析。
          也可统一登记在「当前流程 →
          审批配置」子节点。角色下新增「账号：成员ID」；按部门分配时新增「部门：部门ID
          → 账号：成员ID」。未配置或匹配不唯一会阻止提交。
        </p>
        <el-table :data="bindings" size="small"
          ><el-table-column
            prop="role"
            label="角色"
            min-width="130"
          /><el-table-column label="已登记账号" min-width="180"
            ><template slot-scope="scope"
              ><span v-if="scope.row.accounts.length">{{
                scope.row.accounts.join('、')
              }}</span
              ><el-tag v-else-if="scope.row.dynamicReady" size="mini" type="success">提交时按申请员工解析</el-tag
              ><span v-else-if="scope.row.resolutionError">{{ scope.row.resolutionError }}</span
              ><el-tag v-else size="mini" type="warning"
                >待配置</el-tag
              ></template
            ></el-table-column
          ></el-table
        >
        <div class="policyLookup">
          <strong>查询成员ID</strong
          ><el-select
            filterable
            remote
            :remote-method="lookup"
            :loading="searching"
            v-model="member"
            placeholder="输入姓名或账号"
            ><el-option
              v-for="m in members"
              :key="m.user_id"
              :value="m.user_id"
              :label="m.name + ' · ' + m.user_id"/></el-select
          ><code v-if="member">账号：{{ member }}</code>
        </div>
        <p class="policyHint">
          字段、顺序和审核要点来自当前脑图；特殊业务事实与证明真实性仍须人工核验。修改规则或人员后应重新发布；在途申请须退回重提。
        </p>
        <footer>
          <el-button @click="locate">定位制度节点</el-button
          ><el-button :disabled="loading || busy" @click="load"
            >重新读取</el-button
          ><el-button
            type="primary"
            :loading="busy"
            :disabled="!policy.canPublish || configurationPending"
            @click="publish"
            >{{ agentMode ? '发布这个审批流' : '发布当前流程' }}</el-button
          >
        </footer>
        <p v-if="!policy.canPublish && policy.publishHint" class="policyHint publishHint">
          <i class="el-icon-warning-outline" /> {{ policy.publishHint }}
        </p>
      </template>
    </section>
  </el-dialog>
</template>
<script>
import service from '@/services/leaveService'
export default {
  data: () => ({
    visible: false,
    agentMode: false,
    policy: null,
    error: '',
    loading: false,
    busy: false,
    searching: false,
    members: [],
    member: '',
    source: null,
    sequence: 0,
    searchSequence: 0
  }),
  computed: {
    configurationPending() {
      return !this.policy || (this.policy.configurationErrors || []).length > 0 || this.bindings.some(s=>!s.accounts.length&&!s.dynamicReady)
    },
    bindings() {
      return [
        ...this.policy.steps.map(s => ({ role: s.role, accounts: s.accounts, resolutionError: s.resolutionError, dynamicReady: ['hrbp','head'].includes(s.dynamicRole) && s.resolverConfigured })),
        ...this.policy.ccBindings.map(s => ({
          role: '抄送 · ' + s.role,
          accounts: s.accounts,
          dynamicReady: ['hrbp','head'].includes(s.dynamicRole) && s.resolverConfigured,
          resolutionError: s.resolutionError
        }))
      ]
    }
  },
  mounted() {
    window.addEventListener('mindmap:leave-policy', this.open)
  },
  beforeDestroy() {
    window.removeEventListener('mindmap:leave-policy', this.open)
    this.sequence++
    this.searchSequence++
  },
  methods: {
    open(event) {
      this.agentMode = !!(event && event.detail && event.detail.agentMode)
      this.source = (event && event.detail && event.detail.source) || null
      this.visible = true
      this.policy = null
      this.load()
    },
    async load() {
      const seq = ++this.sequence
      this.loading = true
      this.error = ''
      try {
        const data = await service.template(this.source)
        if (seq === this.sequence) {
          this.policy = data
          if(data.publication.agent_mode)this.agentMode=true
        }
      } catch (e) {
        if (seq === this.sequence) this.error = e.message
      } finally {
        if (seq === this.sequence) this.loading = false
      }
    },
    async lookup(q) {
      const seq = ++this.searchSequence
      this.searching = true
      try {
        const data = await service.members(q)
        if (seq === this.searchSequence) this.members = data.list
      } catch (e) {
        if (seq === this.searchSequence) this.error = e.message
      } finally {
        if (seq === this.searchSequence) this.searching = false
      }
    },
    async publish() {
      this.busy = true
      this.error = ''
      try {
        await service.publish(this.policy.fingerprint, this.policy.source, this.agentMode ? {agentMode:true,expectedContentFingerprint:this.policy.contentFingerprint} : {})
        await this.load()
        window.dispatchEvent(new CustomEvent('mindmap:approval-published'))
        this.$message.success('流程已发布，后续提交使用此版本')
      } catch (e) {
        this.error = e.message
      } finally {
        this.busy = false
      }
    },
    locate() {
      this.visible = false
      this.$router
        .push({
          path: '/',
          query: {
            room: this.policy.source.roomKey,
            focus: this.policy.rootUid
          }
        })
        .catch(() => {})
    }
  }
}
</script>
<style lang="less">
.leavePolicyDialog {
  width: 92vw;
  max-width: 820px;
  margin-top: 7vh !important;
  border-radius: 14px;
  .el-dialog__body {
    max-height: 72vh;
    overflow: auto;
    padding-top: 0;
  }
  .policyHeading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 12px 0;
    h2 {
      font-size: 20px;
      color: #25354b;
    }
    small {
      color: #8794a4;
    }
  }
  .policyHint {
    font-size: 13px;
    line-height: 1.9;
    color: #7c8898;
  }
  .publishHint {
    font-size: 13px;
    line-height: 1.9;
    color: #b54444;
  }
  .policyLookup {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 14px;
    margin: 24px 0;
    font-size: 13px;
    code {
      padding: 8px;
      background: #f3f6fa;
      border-radius: 6px;
    }
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 24px;
  }
}
@media (max-width: 600px) {
  .leavePolicyDialog .policyHeading {
    display: block;
  }
  .leavePolicyDialog footer {
    flex-wrap: wrap;
  }
}
</style>
