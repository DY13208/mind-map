<template>
  <el-popover v-if="items.length" placement="bottom-end" width="380" trigger="click">
    <div class="accessInbox">
      <div class="inboxHead"><strong>访问申请</strong><span>{{ items.length }} 条待处理</span></div>
      <div v-for="item in items" :key="item.id" class="requestRow">
        <div class="requestCopy">
          <strong>{{ item.requester_name || item.requester_id }}</strong>
          <span>申请{{ roleText(item.requested_role) }}「{{ item.title }}」</span>
        </div>
        <div class="requestActions">
          <el-button size="mini" @click="decide(item, 'reject')">拒绝</el-button>
          <el-button size="mini" type="primary" @click="decide(item, 'approve')">同意</el-button>
        </div>
      </div>
    </div>
    <el-badge slot="reference" :value="items.length" class="notificationBadge">
      <button class="notificationButton" type="button" title="访问申请" aria-label="访问申请">
        <i class="el-icon-bell" />
      </button>
    </el-badge>
  </el-popover>
</template>

<script>
import accessRequestService from '@/services/accessRequestService'

export default {
  name: 'AccessNotifications',
  data: () => ({ items: [], timer: null, busy: false }),
  created() {
    this.load()
    this.timer = window.setInterval(this.load, 30000)
  },
  beforeDestroy() { if (this.timer) window.clearInterval(this.timer) },
  methods: {
    roleText(role) { return role === 'editor' ? '可编辑' : '只读访问' },
    async load() {
      try {
        const data = await accessRequestService.inbox()
        this.items = data.list || []
      } catch (error) {
        this.items = []
      }
    },
    async decide(item, decision) {
      if (this.busy) return
      this.busy = true
      try {
        await accessRequestService.decide(item.id, decision)
        this.items = this.items.filter(row => row.id !== item.id)
        this.$message.success(decision === 'approve' ? '已同意访问申请' : '已拒绝访问申请')
      } catch (error) {
        this.$message.error(error.message || '处理申请失败')
      } finally {
        this.busy = false
      }
    }
  }
}
</script>

<style lang="less" scoped>
.notificationBadge { position: fixed; top: 18px; right: 22px; z-index: 1200; }
.notificationButton {
  width: 38px; height: 38px; display: grid; place-items: center; border: 1px solid #dfe8e3;
  border-radius: 10px; background: #fff; color: #52665f; cursor: pointer; font-size: 17px;
  box-shadow: 0 4px 14px rgba(23, 38, 31, 0.08);
  &:hover { border-color: #a9c9bb; color: #087854; }
  &:focus-visible { outline: 2px solid #087854; outline-offset: 2px; }
}
.accessInbox {
  .inboxHead { display: flex; justify-content: space-between; align-items: center; padding-bottom: 10px; border-bottom: 1px solid #edf1ef; }
  .inboxHead span { color: #7b8982; font-size: 12px; }
  .requestRow { padding: 13px 0; border-bottom: 1px solid #edf1ef; }
  .requestRow:last-child { border-bottom: 0; padding-bottom: 0; }
  .requestCopy { display: flex; flex-direction: column; gap: 4px; }
  .requestCopy span { color: #66756e; font-size: 13px; }
  .requestActions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
  /deep/ .el-button--primary { background: #087854; border-color: #087854; }
}
</style>
