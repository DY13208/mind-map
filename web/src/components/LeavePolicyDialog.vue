<template>
  <el-dialog
    :visible.sync="visible"
    title="请假流程配置"
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
            <small>公司模型 / SOP / 请假</small>
            <h2>脑图定义规则，发布后执行</h2>
          </div>
          <el-tag :type="policy.publication.valid ? 'success' : 'warning'">{{
            policy.publication.valid ? '当前版本已发布' : '待配置 / 待发布'
          }}</el-tag>
        </div>
        <p class="policyHint">
          审核人和抄送人统一登记在「请假 →
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
          时长按已登记工作时段计算。节假日及补班日、余额、司龄、特殊情形和证明真实性仍须核验。修改规则或人员后应重新发布；在途申请须退回重提。
        </p>
        <footer>
          <el-button @click="locate">定位制度节点</el-button
          ><el-button :disabled="loading || busy" @click="load"
            >重新读取</el-button
          ><el-button
            v-if="policy.canPublish"
            type="primary"
            :loading="busy"
            @click="publish"
            >发布当前流程</el-button
          >
        </footer>
      </template>
    </section>
  </el-dialog>
</template>
<script>
import service from '@/services/leaveService'
export default {
  data: () => ({
    visible: false,
    policy: null,
    error: '',
    loading: false,
    busy: false,
    searching: false,
    members: [],
    member: '',
    sequence: 0,
    searchSequence: 0
  }),
  computed: {
    bindings() {
      return [
        ...this.policy.steps.map(s => ({ role: s.role, accounts: s.accounts })),
        ...this.policy.ccBindings.map(s => ({
          role: '抄送 · ' + s.role,
          accounts: s.accounts
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
    open() {
      this.visible = true
      this.policy = null
      this.load()
    },
    async load() {
      const seq = ++this.sequence
      this.loading = true
      this.error = ''
      try {
        const data = await service.template()
        if (seq === this.sequence) this.policy = data
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
        await service.publish(this.policy.fingerprint)
        await this.load()
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
