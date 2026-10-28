<template>
  <el-badge
    :value="count"
    :max="99"
    :is-dot="avatar"
    :hidden="!count"
    class="notificationBadge"
    :class="{
      'notificationBadge--collapsed': collapsed,
      'notificationBadge--avatar': avatar
    }"
  >
    <button
      type="button"
      class="notificationButton"
      :title="`消息中心${count ? ` · ${count} 条待处理/未读` : ''}`"
      aria-label="消息中心"
      :class="{ hasMessages: count > 0 }"
      aria-haspopup="dialog"
      :aria-expanded="state.visible ? 'true' : 'false'"
      @click="open"
    >
      <span v-if="avatar" class="notificationAvatarFrame">
        <UserAvatar :person="person" :size="28" />
      </span>
      <template v-else
        ><i :class="icon" /><span v-if="!collapsed"
          >{{ label }}</span
        ></template
      >
    </button>
  </el-badge>
</template>
<script>
import { state, openNotifications } from '@/services/accessNotificationState'
import announcements from '@/config/announcements'
import UserAvatar from './UserAvatar.vue'
import { getCurrentUser } from '@/utils/auth'
export default {
  name: 'AccessNotificationTrigger',
  components: { UserAvatar },
  props: {
    collapsed: Boolean,
    label: { type: String, default: '消息中心' },
    icon: { type: String, default: 'el-icon-bell' },
    avatar: Boolean,
    person: { type: Object, default: () => ({}) }
  },
  data: () => ({ state }),
  computed: {
    count() {
      return (
        this.state.total +
        this.state.unread +
        this.state.leaveUnread +
        this.state.mentionUnread +
        this.state.announcementUnread
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
        this.state.leaveUnread
          ? 'business'
          : this.state.total
          ? 'requests'
          : this.state.mentionUnread
          ? 'mentions'
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
.notificationBadge--avatar {
  margin: 0;
  width: 34px;
}
.notificationBadge--avatar .notificationButton {
  padding: 0;
  width: 34px;
  min-height: 34px;
  border-radius: 50%;
  justify-content: center;
}
.notificationAvatarFrame {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 34px;
  height: 34px;
  padding: 1px;
  border: 2px solid transparent;
  border-radius: 50%;
  transition: border-color 0.18s, box-shadow 0.18s;
}
.notificationButton.hasMessages .notificationAvatarFrame {
  border-color: #e64b57;
  box-shadow: 0 0 0 3px rgba(230, 75, 87, 0.2);
}
.notificationBadge--avatar /deep/ .el-badge__content.is-dot {
  top: 2px;
  right: 3px;
  width: 10px;
  height: 10px;
  background-color: #e64b57;
  border: 2px solid #fff;
  transform: translate(50%, -50%);
  pointer-events: none;
}
</style>
<style lang="less">
body.isDark .notificationBadge .notificationButton {
  color: #b4bac0;
}
body.isDark .notificationBadge .notificationButton:hover {
  background: #2c3036;
  color: #4cc596;
}
body.isDark .notificationBadge--avatar .el-badge__content.is-dot {
  border-color: #1f2329;
}
</style>
