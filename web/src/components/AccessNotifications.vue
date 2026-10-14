<template>
  <div>
    <AccessNotificationTrigger
      v-if="floating"
      collapsed
      class="floatingNotification"
    />
    <el-drawer
      :visible.sync="state.visible"
      direction="rtl"
      size="480px"
      append-to-body
      :with-header="false"
      custom-class="accessNotificationDrawer"
      @opened="onOpened"
    >
      <section class="messageCenter" aria-label="消息中心">
        <header class="messageHeader">
          <div class="messageHeading">
            <span class="messageIcon"><i class="el-icon-bell"/></span>
            <div>
              <h2>消息中心</h2>
              <span :class="['connectionState', { live: state.connected }]"
                ><i />{{
                  state.connected ? '实时同步中' : '自动同步 · 断线后重试'
                }}</span
              >
            </div>
          </div>
          <button
            type="button"
            class="closeMessage"
            aria-label="关闭消息中心"
            @click="state.visible = false"
          >
            <i class="el-icon-close" />
          </button>
        </header>
        <el-tabs
          v-model="state.activeTab"
          class="messageTabs"
          @tab-click="onTab"
        >
          <el-tab-pane
            :label="`访问申请${state.total ? ' ' + state.total : ''}`"
            name="requests"
          />
          <el-tab-pane
            :label="`审批结果${state.unread ? ' ' + state.unread : ''}`"
            name="results"
          />
          <el-tab-pane
            :label="
              `更新公告${
                state.announcementUnread ? ' ' + state.announcementUnread : ''
              }`
            "
            name="announcements"
          />
        </el-tabs>
        <div v-if="state.error" class="messageError" role="alert">
          <i class="el-icon-warning-outline" /><span>{{ state.error }}</span
          ><el-button type="text" @click="refresh">重试</el-button>
        </div>
        <div
          v-if="state.activeTab === 'requests'"
          v-loading="state.loading"
          class="messageContent"
        >
          <div class="sectionIntro">
            <div>
              <h3>待处理申请</h3>
              <p>由文件所有者决定访问范围</p>
            </div>
            <button
              type="button"
              class="refreshMessage"
              aria-label="刷新申请"
              @click="refresh"
            >
              <i class="el-icon-refresh" />
            </button>
          </div>
          <article
            v-for="item in state.items"
            :key="item.id"
            class="accessRequestCard"
            :data-request-id="item.id"
          >
            <div class="requestIdentity">
              <span class="requestAvatar">{{
                (item.requester_name || item.requester_id).slice(0, 1)
              }}</span>
              <div>
                <strong>{{ item.requester_name || item.requester_id }}</strong
                ><small>{{ formatTime(item.created_at) }}</small>
              </div>
              <span :class="['requestedRole', item.requested_role]"
                >申请{{ roleText(item.requested_role) }}</span
              >
            </div>
            <button type="button" class="requestFile" @click="openFile(item)">
              <i class="el-icon-document" /><span>{{
                item.title || '未命名脑图'
              }}</span
              ><i class="el-icon-top-right" />
            </button>
            <p
              v-if="item.request_reason"
              class="requestReason"
              v-text="item.request_reason"
            ></p>
            <label class="grantLabel" :for="`grant-${item.id}`"
              >同意后授予</label
            >
            <el-select
              :id="`grant-${item.id}`"
              :value="grantRole(item)"
              size="small"
              :disabled="!!busyId"
              :aria-label="
                `授予${item.requester_name || item.requester_id}的权限`
              "
              @change="$set(roles, item.id, $event)"
            >
              <el-option label="可查看 · 仅阅读内容" value="viewer" /><el-option
                label="可编辑 · 查看与修改"
                value="editor"
              /><el-option label="可管理 · 编辑与管理成员" value="manager" />
            </el-select>
            <el-input
              v-if="rejectingId === item.id"
              v-model="decisionReason"
              type="textarea"
              :rows="2"
              maxlength="500"
              show-word-limit
              placeholder="拒绝原因（选填）"
              class="decisionReason"
            />
            <div class="requestActions">
              <template v-if="rejectingId === item.id"
                ><el-button
                  size="small"
                  :disabled="!!busyId"
                  @click="rejectingId = ''"
                  >取消</el-button
                ><el-button
                  size="small"
                  type="danger"
                  plain
                  :loading="busyId === item.id"
                  :disabled="!!busyId && busyId !== item.id"
                  @click="decide(item, 'reject')"
                  >确认拒绝</el-button
                ></template
              ><template v-else
                ><el-button
                  size="small"
                  :disabled="!!busyId"
                  @click="beginReject(item)"
                  >拒绝</el-button
                ><el-button
                  size="small"
                  type="primary"
                  :loading="busyId === item.id"
                  :disabled="!!busyId && busyId !== item.id"
                  @click="decide(item, 'approve')"
                  >同意并授权</el-button
                ></template
              >
            </div>
          </article>
          <div
            v-if="!state.items.length && !state.loading && !state.error"
            class="emptyMessages"
          >
            <i class="el-icon-circle-check" />
            <h3>申请已处理完毕</h3>
            <p>新的访问申请会在这里实时提醒</p>
          </div>
        </div>
        <div
          v-else-if="state.activeTab === 'results'"
          v-loading="state.loading"
          class="messageContent"
        >
          <div class="sectionIntro">
            <div>
              <h3>我的申请结果</h3>
              <p>保留审批记录，随时查看</p>
            </div>
          </div>
          <article
            v-for="item in state.results"
            :key="item.id"
            class="resultCard"
          >
            <span :class="['resultIcon', item.status]"
              ><i
                :class="
                  item.status === 'approved' ? 'el-icon-check' : 'el-icon-close'
                "
            /></span>
            <div>
              <strong>{{ item.title || '未命名脑图' }}</strong>
              <p>
                {{
                  item.status === 'approved'
                    ? `已通过 · ${roleText(
                        item.granted_role || item.requested_role
                      )}`
                    : '申请未通过'
                }}
              </p>
              <p
                v-if="item.decision_reason"
                class="resultReason"
                v-text="item.decision_reason"
              ></p>
              <small>{{ formatTime(item.decided_at) }}</small>
            </div>
            <el-button
              v-if="item.status === 'approved'"
              size="mini"
              @click="openFile(item)"
              >打开文件</el-button
            >
          </article>
          <div
            v-if="!state.results.length && !state.loading && !state.error"
            class="emptyMessages"
          >
            <i class="el-icon-chat-dot-round" />
            <h3>暂无审批结果</h3>
            <p>所有者处理后会在这里通知你</p>
          </div>
        </div>
        <div v-else class="messageContent">
          <article
            v-for="announcement in announcements"
            :key="announcement.id"
            class="announcementRow"
          >
            <div>
              <strong>{{ announcement.title }}</strong
              ><time>{{ announcement.date }}</time>
            </div>
            <ul>
              <li v-for="(line, index) in announcement.content" :key="index">
                {{ line }}
              </li>
            </ul>
          </article>
        </div>
        <footer
          v-if="state.activeTab !== 'announcements'"
          class="messageFooter"
        >
          <span
            >{{
              state.activeTab === 'requests' ? state.total : state.resultTotal
            }}
            条{{
              state.activeTab === 'requests' ? '待处理申请' : '审批记录'
            }}</span
          ><el-pagination
            v-if="
              (state.activeTab === 'requests'
                ? state.total
                : state.resultTotal) > 20
            "
            small
            layout="prev,pager,next"
            :current-page="
              state.activeTab === 'requests' ? state.page : state.resultPage
            "
            :page-size="20"
            :total="
              state.activeTab === 'requests' ? state.total : state.resultTotal
            "
            @current-change="changePage"
          />
        </footer>
      </section>
    </el-drawer>
  </div>
</template>
<script>
import AccessNotificationTrigger from './AccessNotificationTrigger.vue'
import announcements from '@/config/announcements'
import service from '@/services/accessRequestService'
import {
  state,
  roleText,
  startNotifications,
  stopNotifications,
  refreshNotifications
} from '@/services/accessNotificationState'
export default {
  name: 'AccessNotifications',
  components: { AccessNotificationTrigger },
  props: {
    userId: { type: String, required: true },
    floating: { type: Boolean, default: true }
  },
  data: () => ({
    state,
    announcements,
    roles: {},
    busyId: '',
    rejectingId: '',
    decisionReason: '',
    seenBusy: false
  }),
  watch: {
    userId(id) {
      startNotifications(id)
    },
    'state.syncVersion'() {
      if (this.state.visible && this.state.activeTab === 'results')
        this.markResultsSeen()
    }
  },
  created() {
    startNotifications(this.userId)
  },
  beforeDestroy() {
    stopNotifications(this.userId)
  },
  methods: {
    roleText,
    formatTime(value) {
      const date = new Date(value)
      return Number.isNaN(date.getTime())
        ? ''
        : date.toLocaleString('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
          })
    },
    grantRole(item) {
      return this.roles[item.id] || item.requested_role
    },
    refresh() {
      return refreshNotifications()
    },
    changePage(page) {
      if (this.state.activeTab === 'requests') this.state.page = page
      else this.state.resultPage = page
      this.refresh()
    },
    onOpened() {
      this.onTab()
    },
    onTab() {
      if (this.state.activeTab === 'results') this.markResultsSeen()
      if (this.state.activeTab === 'announcements') {
        try {
          window.localStorage.setItem(
            `mindmap:announcements:seen:${encodeURIComponent(this.userId)}`,
            JSON.stringify(this.announcements.map(item => item.id))
          )
        } catch (_) {
          /* Keep the center usable when storage is unavailable. */
        }
        this.state.announcementUnread = 0
        window.dispatchEvent(new Event('mindmap:announcements-seen'))
      }
    },
    async markResultsSeen() {
      if (this.seenBusy) return
      const ids = this.state.results
        .filter(item => !item.requester_seen_at)
        .map(item => item.id)
      if (!ids.length) return
      this.seenBusy = true
      const userId = this.userId
      try {
        await service.seen(ids)
        if (userId !== this.userId || this._isDestroyed) return
        this.state.results.forEach(item => {
          if (ids.includes(item.id))
            item.requester_seen_at = new Date().toISOString()
        })
        await this.refresh()
      } catch (_) {
        /* Retry on the next inbox refresh. */
      } finally {
        this.seenBusy = false
      }
    },
    beginReject(item) {
      this.rejectingId = item.id
      this.decisionReason = ''
    },
    async decide(item, decision) {
      if (this.busyId) return
      this.busyId = item.id
      const role = this.grantRole(item)
      try {
        await service.decide(
          item.id,
          decision,
          decision === 'approve' ? role : undefined,
          decision === 'reject' ? this.decisionReason : ''
        )
        this.rejectingId = ''
        this.$delete(this.roles, item.id)
        await this.refresh()
        this.$message.success(
          decision === 'approve' ? `已授权${roleText(role)}` : '已拒绝申请'
        )
      } catch (error) {
        this.$message.error(error.message || '处理申请失败')
        if ([404, 409].includes(error.statusCode)) await this.refresh()
      } finally {
        this.busyId = ''
      }
    },
    openFile(item) {
      this.state.visible = false
      if (this.$router)
        this.$router
          .push({ path: '/', query: { room: item.room_key } })
          .catch(() => {})
      else this.$emit('open-file', item.room_key)
    }
  }
}
</script>
<style lang="less" scoped>
.messageCenter {
  height: 100%;
  display: flex;
  flex-direction: column;
  color: #1e3028;
  background: #fff;
}
.messageHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 24px 24px 16px;
  flex: none;
}
.messageHeading {
  display: flex;
  align-items: center;
  gap: 12px;
}
.messageIcon {
  width: 42px;
  height: 42px;
  border-radius: 12px;
  display: grid;
  place-items: center;
  background: #eaf5ef;
  color: #087854;
  font-size: 21px;
}
h2 {
  font-size: 20px;
  margin: 0 0 5px;
}
.connectionState {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: #7c8982;
}
.connectionState i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #a8b0ac;
}
.connectionState.live i {
  background: #25986d;
}
.closeMessage,
.refreshMessage {
  border: 0;
  background: transparent;
  color: #708078;
  border-radius: 7px;
  cursor: pointer;
  width: 32px;
  height: 32px;
  font-size: 17px;
}
.closeMessage:hover,
.refreshMessage:hover {
  background: #f0f5f2;
  color: #087854;
}
.messageTabs {
  padding: 0 24px;
  flex: none;
}
.messageTabs /deep/ .el-tabs__header {
  margin: 0;
}
.messageTabs /deep/ .el-tabs__item.is-active {
  color: #087854;
}
.messageTabs /deep/ .el-tabs__active-bar {
  background: #087854;
}
.messageContent {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 20px 24px;
  background: #f7f9f8;
}
.sectionIntro {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
h3 {
  font-size: 14px;
  margin: 0;
}
.sectionIntro p {
  font-size: 12px;
  color: #819087;
  margin: 5px 0 0;
}
.accessRequestCard {
  padding: 18px;
  border: 1px solid #e1e8e4;
  border-radius: 12px;
  background: #fff;
  margin-bottom: 12px;
}
.requestIdentity {
  display: flex;
  align-items: center;
  gap: 10px;
}
.requestAvatar {
  width: 34px;
  height: 34px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: #eaf0ed;
  color: #317259;
  font-weight: 600;
}
.requestIdentity strong {
  font-size: 14px;
  display: block;
}
.requestIdentity small {
  font-size: 11px;
  color: #89958e;
  display: block;
  margin-top: 4px;
}
.requestedRole {
  margin-left: auto;
  border-radius: 15px;
  background: #f2f4f5;
  color: #697580;
  font-size: 11px;
  padding: 4px 8px;
  white-space: nowrap;
}
.requestedRole.editor {
  background: #edf4ff;
  color: #386ba7;
}
.requestFile {
  display: flex;
  gap: 8px;
  align-items: center;
  width: 100%;
  text-align: left;
  padding: 12px 10px;
  margin: 14px 0;
  border: 0;
  border-radius: 7px;
  background: #f6f8f7;
  color: #3f5148;
  cursor: pointer;
}
.requestFile span {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.requestReason {
  font-size: 13px;
  color: #64756b;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin: 0 0 14px;
}
.grantLabel {
  display: block;
  font-size: 12px;
  color: #617268;
  margin-bottom: 7px;
}
.accessRequestCard /deep/ .el-select {
  width: 100%;
}
.requestActions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}
.requestActions /deep/ .el-button + .el-button {
  margin-left: 0;
}
.requestActions /deep/ .el-button--primary {
  background: #087854;
  border-color: #087854;
}
.decisionReason {
  margin-top: 12px;
}
.messageFooter {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 24px;
  border-top: 1px solid #e7ece9;
  font-size: 12px;
  color: #7a8981;
  flex: none;
}
.emptyMessages {
  text-align: center;
  padding: 80px 0;
  color: #87958c;
}
.emptyMessages > i {
  font-size: 38px;
  color: #a6bdb0;
}
.emptyMessages h3 {
  margin-top: 16px;
  color: #52665a;
}
.emptyMessages p {
  font-size: 12px;
}
.messageError {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 24px;
  background: #fff5ed;
  color: #9a6641;
  font-size: 12px;
}
.messageError span {
  flex: 1;
}
.resultCard {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  padding: 18px 0;
  border-bottom: 1px solid #e2e9e5;
}
.resultCard > div {
  flex: 1;
  min-width: 0;
}
.resultCard strong {
  font-size: 14px;
}
.resultCard p {
  font-size: 12px;
  color: #5d7466;
  line-height: 1.5;
  margin: 6px 0;
  overflow-wrap: anywhere;
}
.resultCard small {
  font-size: 11px;
  color: #86958c;
}
.resultIcon {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: #e9f5ee;
  color: #087854;
  flex: none;
}
.resultIcon.rejected {
  background: #f8efed;
  color: #aa6a5b;
}
.announcementRow {
  padding: 16px 0;
  border-bottom: 1px solid #e2e9e5;
  font-size: 13px;
}
.announcementRow > div {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
.announcementRow time {
  font-size: 11px;
  color: #7c8d82;
  white-space: nowrap;
}
.announcementRow ul {
  padding-left: 18px;
  line-height: 1.8;
  color: #64766a;
}
.floatingNotification {
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 1800;
}
.floatingNotification /deep/ .notificationButton {
  width: 44px;
  height: 44px;
  background: #fff;
  border: 1px solid #dce6e0;
  box-shadow: 0 4px 16px #244e3612;
  border-radius: 50%;
}
.floatingNotification /deep/ .notificationButton i {
  font-size: 20px;
}
button:focus-visible {
  outline: 2px solid #087854;
  outline-offset: 2px;
}
@media (max-width: 520px) {
  .messageHeader {
    padding: 20px 16px 14px;
  }
  .messageTabs {
    padding: 0 16px;
  }
  .messageContent {
    padding: 16px;
  }
  .messageFooter {
    padding: 14px 16px;
  }
  .floatingNotification {
    right: 16px;
    bottom: 20px;
  }
  .accessRequestCard {
    padding: 15px;
  }
}
</style>
<style lang="less">
.accessNotificationDrawer {
  max-width: 100vw;
}
.accessNotificationDrawer .el-drawer__body {
  overflow: hidden;
}
</style>
