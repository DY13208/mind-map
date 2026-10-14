<template>
  <el-badge
    :value="count"
    :max="99"
    :hidden="!count"
    class="notificationBadge"
    :class="{ 'notificationBadge--collapsed': collapsed }"
  >
    <button
      type="button"
      class="notificationButton"
      :title="`消息中心${count ? ` · ${count} 条待处理/未读` : ''}`"
      aria-label="消息中心"
      @click="open"
    >
      <i class="el-icon-bell" /><span v-if="!collapsed">消息中心</span>
    </button>
  </el-badge>
</template>
<script>
import { state, openNotifications } from '@/services/accessNotificationState'
import announcements from '@/config/announcements'
import { getCurrentUser } from '@/utils/auth'
export default {
  name: 'AccessNotificationTrigger',
  props: { collapsed: Boolean },
  data: () => ({ state }),
  computed: {
    count() {
      return (
        this.state.total + this.state.unread + this.state.announcementUnread
      )
    }
  },
  mounted() {
    this.readAnnouncements()
    window.addEventListener(
      'mindmap:announcements-seen',
      this.readAnnouncements
    )
  },
  beforeDestroy() {
    window.removeEventListener(
      'mindmap:announcements-seen',
      this.readAnnouncements
    )
  },
  methods: {
    readAnnouncements() {
      try {
        const user = getCurrentUser() || {}
        const seen = JSON.parse(
          window.localStorage.getItem(
            `mindmap:announcements:seen:${encodeURIComponent(user.id || '')}`
          ) || '[]'
        )
        this.state.announcementUnread = announcements.filter(
          item => !seen.includes(item.id)
        ).length
      } catch (_) {
        this.state.announcementUnread = 0
      }
    },
    open() {
      openNotifications(
        this.state.total
          ? 'requests'
          : this.state.unread
          ? 'results'
          : this.state.announcementUnread
          ? 'announcements'
          : 'requests'
      )
    }
  }
}
</script>
<style lang="less" scoped>
.notificationBadge {
  display: block;
  margin: 8px 0;
}
.notificationButton {
  width: 100%;
  min-height: 40px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 12px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #52665f;
  cursor: pointer;
  font-size: 14px;
  text-align: left;
}
.notificationButton i {
  font-size: 18px;
  flex-shrink: 0;
}
.notificationButton:hover {
  background: #e8f4ef;
  color: #087854;
}
.notificationButton:focus-visible {
  outline: 2px solid #087854;
  outline-offset: 2px;
}
.notificationBadge--collapsed .notificationButton {
  justify-content: center;
  padding: 0;
}
</style>
