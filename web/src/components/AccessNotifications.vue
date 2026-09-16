<template>
  <el-popover v-model="visible" placement="bottom-end" width="380" trigger="click" @show="markAnnouncementsSeen">
    <div class="accessInbox">
      <el-tabs v-model="activeTab">
        <el-tab-pane label="更新公告" name="announcements">
          <article v-for="announcement in announcements" :key="announcement.id" class="announcementRow">
            <div class="announcementHead"><strong>{{ announcement.title }}</strong><time>{{ announcement.date }}</time></div>
            <ul><li v-for="(line, index) in announcement.content" :key="index">{{ line }}</li></ul>
          </article>
          <div v-if="!announcements.length" class="emptyInbox">暂无更新公告</div>
        </el-tab-pane>
        <el-tab-pane :label="`访问申请${items.length ? '（' + items.length + '）' : ''}`" name="requests">
      <div class="inboxHead"><strong>访问申请</strong><span>{{ items.length }} 条待处理</span></div>
      <div v-if="!items.length" class="emptyInbox">暂无待处理的访问申请</div>
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
        </el-tab-pane>
      </el-tabs>
    </div>
    <el-badge slot="reference" :value="items.length + unreadCount" :hidden="!items.length && !unreadCount" class="notificationBadge">
      <button class="notificationButton" type="button" title="消息中心" aria-label="消息中心">
        <i class="el-icon-bell" />
      </button>
    </el-badge>
  </el-popover>
</template>

<script>
import accessRequestService from '@/services/accessRequestService'
import announcements from '@/config/announcements'
import { getCurrentUser } from '@/utils/auth'

export default {
  name: 'AccessNotifications',
  data: () => ({ items: [], timer: null, busy: false, visible: false, activeTab: 'announcements', announcements, seenIds: [], storageKey: '' }),
  computed: {
    unreadCount() { return this.announcements.filter(item => !this.seenIds.includes(item.id)).length }
  },
  watch: {
    activeTab() { if (this.visible) this.markAnnouncementsSeen() }
  },
  created() {
    this.load()
    this.timer = window.setInterval(this.load, 30000)
  },
  mounted() {
    const user = getCurrentUser()
    if (!user || !user.id) return
    this.storageKey = `mindmap:announcements:seen:${encodeURIComponent(user.id)}`
    try {
      const stored = JSON.parse(window.localStorage.getItem(this.storageKey) || '[]')
      this.seenIds = Array.isArray(stored) ? stored : []
    } catch (error) { this.seenIds = [] }
    if (this.unreadCount) {
      this.markAnnouncementsSeen()
      this.visible = true
    }
  },
  beforeDestroy() { if (this.timer) window.clearInterval(this.timer) },
  methods: {
    markAnnouncementsSeen() {
      if (this.activeTab !== 'announcements' || !this.storageKey) return
      this.seenIds = this.announcements.map(item => item.id)
      try { window.localStorage.setItem(this.storageKey, JSON.stringify(this.seenIds)) } catch (error) { /* 当前会话仍保持已提示状态 */ }
    },
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
  max-height: 60vh; overflow-y: auto;
  .announcementRow { padding: 12px 0; border-bottom: 1px solid #edf1ef; }
  .announcementHead { display: flex; justify-content: space-between; gap: 12px; }
  time { color: #66756e; font-size: 12px; flex-shrink: 0; }
  ul { padding-left: 18px; margin-bottom: 0; color: #52665f; font-size: 13px; line-height: 1.8; }
  .emptyInbox { padding: 24px 0; text-align: center; color: #66756e; }
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
