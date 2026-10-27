<template>
  <el-badge
    :value="count"
    :max="99"
    :is-dot="avatar"
    :hidden="!count || (!collapsed && !avatar)"
    class="notificationBadge"
    :class="{
      'notificationBadge--collapsed': collapsed,
      'notificationBadge--avatar': avatar
    }"
  >
    <el-tooltip
      :content="`${label}${count ? ` · ${count} 条待处理/未读` : ''}`"
      :disabled="!collapsed && !avatar"
      placement="top"
      popper-class="wcpdActionTooltip"
      :open-delay="250"
      :visible-arrow="false"
      :offset="10"
    >
    <button
      type="button"
      class="notificationButton"
      :aria-label="`${label}${count ? `，${count} 条待处理或未读消息` : ''}`"
      :class="{ hasMessages: count > 0 }"
      aria-haspopup="dialog"
      :aria-expanded="state.visible ? 'true' : 'false'"
      @click="open"
    >
      <UserAvatar v-if="avatar" :person="person" :size="28" />
      <template v-else
        ><i :class="icon" aria-hidden="true" /><span v-if="!collapsed" class="notificationLabel"
          >{{ label }}</span
        ><span v-if="!collapsed && count" class="notificationCount" aria-hidden="true">{{ count > 99 ? '99+' : count }}</span></template
      >
    </button>
    </el-tooltip>
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
  flex-shrink: 0;
  margin: 4px 0 8px;
}
.notificationButton {
  box-sizing: border-box;
  width: 100%;
  min-height: 40px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 12px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--ui-text-secondary, #66756e);
  cursor: pointer;
  font-size: 14px;
  font-family: inherit;
  text-align: left;
  transition: background-color 0.18s ease, color 0.18s ease;
}
.notificationButton i {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  font-size: 18px;
  flex-shrink: 0;
}
.notificationLabel {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 20px;
}
.notificationCount {
  flex-shrink: 0;
  margin-left: 0;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  box-sizing: border-box;
  border-radius: 6px;
  background: #fce9e9;
  color: #b83e45;
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 20px;
  text-align: center;
}
.notificationButton:hover {
  background: var(--ui-surface-muted, #e8f4ef);
  color: var(--ui-primary, #087854);
}
.notificationButton:focus-visible {
  outline: 2px solid var(--ui-focus, #087854);
  outline-offset: -2px;
}
.notificationBadge--collapsed .notificationButton {
  justify-content: center;
  padding: 0;
}
.notificationBadge--collapsed:not(.notificationBadge--avatar) /deep/ .el-badge__content.is-fixed {
  top: 8px;
  right: calc(50% - 10px);
  transform: translate(50%, -50%);
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  box-sizing: border-box;
  border: 1px solid var(--ui-surface, #fff);
  font-size: 10px;
  line-height: 14px;
}
.notificationBadge--avatar {
  margin: 0;
  width: 34px;
}
.notificationBadge--avatar .notificationButton {
  padding: 1px;
  width: 34px;
  min-height: 34px;
  border-radius: 50%;
  justify-content: center;
  border: 2px solid transparent;
  transition: border-color 0.18s, box-shadow 0.18s;
}
.notificationBadge--avatar .notificationButton.hasMessages {
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
}
@media (prefers-reduced-motion: reduce) {
  .notificationButton { transition: none; }
}
</style>
<style lang="less">
.el-tooltip__popper.wcpdActionTooltip {
  padding: 7px 10px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  background: #29352f;
  color: #f5f8f6;
  box-shadow: 0 4px 14px rgba(17, 30, 23, 0.14);
  font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif;
  font-size: 12px;
  font-weight: 400;
  line-height: 18px;
}
body.isDark .notificationBadge .notificationButton {
  color: #b4bac0;
}
body.isDark .notificationBadge .notificationButton:hover {
  background: #2c3036;
  color: #4cc596;
}
body.isDark .notificationCount,
.productShell--dark .notificationCount {
  background: #492d33;
  color: #ffb4b8;
}
body.isDark .notificationBadge--avatar .el-badge__content.is-dot {
  border-color: #1f2329;
}
</style>
