<template>
  <div>
    <el-dialog
      :visible.sync="state.visible"
      title="消息中心"
      append-to-body
      :show-close="false"
      :close-on-click-modal="false"
      custom-class="accessNotificationDialog"
      @opened="onOpened"
      @closed="onClosed"
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
          <el-tab-pane label="我已审批" name="history" />
          <el-tab-pane
            :label="`我的申请${state.unread ? ' ' + state.unread : ''}`"
            name="results"
          />
          <el-tab-pane
            :label="`@我的${state.mentionUnread ? ' ' + state.mentionUnread : ''}`"
            name="mentions"
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
          ref="messageContent"
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
          <div class="requestGrid">
            <article
              v-for="item in state.items"
              :key="item.id"
              class="accessRequestCard"
              :data-request-id="item.id"
            >
              <div class="requestIdentity">
                <UserAvatar
                  :person="{
                    name: item.requester_name || item.requester_id,
                    avatar: item.requester_avatar
                  }"
                  :size="34"
                />
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
                popper-class="accessNotificationPopper"
                :disabled="!!busyId"
                :aria-label="
                  `授予${item.requester_name || item.requester_id}的权限`
                "
                @change="$set(roles, item.id, $event)"
              >
                <el-option
                  label="可查看 · 仅阅读内容"
                  value="viewer"
                /><el-option
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
          </div>
          <div
            v-if="!state.items.length && !state.loading && !state.error"
            class="emptyMessages"
          >
            <i class="el-icon-circle-check" />
            <h3>申请已处理完毕</h3>
            <p>新的访问申请会在这里实时提醒</p>
          </div>
        </div>
        <template v-else-if="state.activeTab === 'history'">
          <div class="historyTools">
            <el-radio-group
              v-model="state.historyStatus"
              size="small"
              aria-label="审批状态筛选"
              @change="filterHistory"
            >
              <el-radio-button label=""
                >全部 {{ state.historyCounts.all }}</el-radio-button
              >
              <el-radio-button label="approved"
                >已同意 {{ state.historyCounts.approved }}</el-radio-button
              >
              <el-radio-button label="rejected"
                >已拒绝 {{ state.historyCounts.rejected }}</el-radio-button
              >
            </el-radio-group>
            <el-input
              v-model="state.historySearch"
              size="small"
              clearable
              prefix-icon="el-icon-search"
              placeholder="搜索申请人或文件"
              aria-label="搜索审批历史"
              @input="searchHistory"
            />
          </div>
          <div
            class="messageContent historyContent"
            ref="messageContent"
            v-loading="state.historyLoading"
          >
            <div class="sectionIntro">
              <div>
                <h3>我处理的申请</h3>
                <p>按审批时间排列，保留当时的授权决定</p>
              </div>
              <button
                type="button"
                class="refreshMessage"
                aria-label="刷新审批历史"
                @click="refresh"
              >
                <i class="el-icon-refresh" />
              </button>
            </div>
            <article
              v-for="item in state.history"
              :key="item.id"
              class="historyCard"
              :data-history-id="item.id"
            >
              <div class="requestIdentity">
                <UserAvatar
                  :person="{
                    name: item.requester_name || item.requester_id,
                    avatar: item.requester_avatar
                  }"
                  :size="34"
                />
                <div class="historyIdentity">
                  <strong>{{ item.requester_name || item.requester_id }}</strong
                  ><small>{{ formatTime(item.decided_at) }}</small>
                </div>
                <el-tag
                  size="small"
                  :type="item.status === 'approved' ? 'success' : 'info'"
                  effect="light"
                  >{{
                    item.status === 'approved' ? '已同意' : '已拒绝'
                  }}</el-tag
                >
              </div>
              <button
                type="button"
                class="requestFile"
                :disabled="!!item.deleted_at"
                @click="openFile(item)"
              >
                <i class="el-icon-document" /><span>{{
                  item.title || '未命名脑图'
                }}</span
                ><small v-if="item.deleted_at">已删除</small
                ><i v-else class="el-icon-top-right" />
              </button>
              <div class="historyRoles">
                <span>申请{{ roleText(item.requested_role) }}</span
                ><template v-if="item.status === 'approved'"
                  ><i class="el-icon-right" /><span
                    :class="[
                      'grantedRole',
                      item.granted_role || item.requested_role
                    ]"
                    >已授予{{
                      roleText(item.granted_role || item.requested_role)
                    }}</span
                  ></template
                >
              </div>
              <p v-if="item.request_reason" class="historyReason">
                <span>申请说明</span><span v-text="item.request_reason" />
              </p>
              <p v-if="item.decision_reason" class="historyReason">
                <span>审批说明</span><span v-text="item.decision_reason" />
              </p>
            </article>
            <div
              v-if="
                !state.history.length &&
                  !state.historyLoading &&
                  !state.historyError
              "
              class="emptyMessages"
            >
              <i class="el-icon-finished" />
              <h3>
                {{
                  state.historySearch || state.historyStatus
                    ? '没有匹配的审批记录'
                    : '暂无历史审批'
                }}
              </h3>
              <p>
                {{
                  state.historySearch || state.historyStatus
                    ? '调整筛选条件或搜索关键词'
                    : '处理后的申请会保留在这里'
                }}
              </p>
            </div>
          </div>
        </template>
        <div
          v-else-if="state.activeTab === 'results'"
          v-loading="state.loading"
          class="messageContent"
          ref="messageContent"
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
        <div
          v-else-if="state.activeTab === 'mentions'"
          ref="messageContent"
          v-loading="state.mentionLoading && !state.mentions.length"
          class="messageContent mentionContent"
        >
          <div class="sectionIntro">
            <div>
              <h3>提到我的</h3>
              <p>同事在节点评论中 @你 时会出现在这里</p>
            </div>
            <div class="mentionTools">
              <button
                type="button"
                class="markAllRead"
                data-testid="mentions-mark-all"
                :disabled="!state.mentionUnread || markingAll"
                @click="markAllMentions"
              >
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 7 17l-5-5"/><path d="m22 10-7.5 7.5L13 16"/></svg
                ><span>全部标为已读</span>
              </button>
              <button
                type="button"
                class="refreshMessage"
                aria-label="刷新提及"
                @click="reloadMentions"
              >
                <i class="el-icon-refresh" />
              </button>
            </div>
          </div>
          <div
            v-if="state.mentionError && !state.mentions.length"
            class="emptyMessages mentionErrorState"
            role="alert"
          >
            <i class="el-icon-warning-outline" />
            <h3>提及加载失败</h3>
            <p>{{ state.mentionError }}</p>
            <el-button size="small" @click="reloadMentions">重试</el-button>
          </div>
          <ul v-else-if="state.mentions.length" class="mentionList">
            <li
              v-for="item in state.mentions"
              :key="item.room_key + ':' + item.id"
              class="mentionItem"
              :class="{ unread: item.unread }"
              role="button"
              tabindex="0"
              :data-mention-id="item.id"
              :aria-label="`${item.author_name} 在 ${item.room_name} 中提到了你`"
              @click="openMention(item)"
              @keydown.enter.prevent="openMention(item)"
            >
              <span
                class="mentionAvatar"
                :style="{ background: mentionColor(item) }"
                aria-hidden="true"
              >
                <img
                  v-if="item.author_avatar && !brokenAvatars[item.author_avatar]"
                  :src="item.author_avatar"
                  alt=""
                  @error="$set(brokenAvatars, item.author_avatar, true)"
                />
                <template v-else>{{ mentionInitial(item.author_name) }}</template>
              </span>
              <div class="mentionBody">
                <div class="mentionTitle">
                  <span
                    ><b>{{ item.author_name }}</b> 在
                    <b>{{ item.room_name }}</b> 中提到了你</span
                  >
                  <i v-if="item.unread" class="mentionDot" title="未读" />
                </div>
                <div class="mentionTime">
                  <span>{{ absoluteTime(item.created_at) }}</span>
                  <span>{{ relativeTime(item.created_at) }}</span>
                </div>
                <div class="mentionQuote"
                  ><span
                    v-for="(seg, index) in segments(item)"
                    :key="index"
                    :class="{ mentionAt: seg.mention }"
                    >{{ seg.text }}</span
                  ></div
                >
                <div class="mentionRef">
                  <i class="el-icon-share" /><span>节点：{{ item.node_text }}</span>
                </div>
              </div>
            </li>
          </ul>
          <div v-else-if="!state.mentionLoading" class="emptyMessages">
            <i class="el-icon-bell" />
            <h3>暂时没有人 @你</h3>
            <p>同事在评论中 @你 后，会在这里提醒</p>
          </div>
          <div v-if="state.mentionHasMore" class="mentionMore">
            <el-button
              type="text"
              :loading="state.mentionLoading"
              @click="loadMoreMentions"
              >加载更多</el-button
            >
          </div>
          <p
            v-if="state.mentionError && state.mentions.length"
            class="mentionInlineError"
          >
            {{ state.mentionError }}
          </p>
        </div>
        <div v-else ref="messageContent" class="messageContent">
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
          v-if="
            state.activeTab !== 'announcements' &&
              state.activeTab !== 'mentions'
          "
          class="messageFooter"
        >
          <span
            >{{ currentTotal }} 条{{
              state.activeTab === 'requests' ? '待处理申请' : '审批记录'
            }}</span
          >
          <el-pagination
            v-if="currentTotal > 20"
            small
            layout="prev,pager,next"
            :pager-count="5"
            :current-page="currentPage"
            :page-size="20"
            :total="currentTotal"
            @current-change="changePage"
          />
        </footer>
      </section>
    </el-dialog>
  </div>
</template>
<script>
import UserAvatar from './UserAvatar.vue'
import announcements from '@/config/announcements'
import service from '@/services/accessRequestService'
import {
  state,
  roleText,
  startNotifications,
  stopNotifications,
  refreshNotifications,
  refreshApprovalHistory,
  refreshMentions,
  markMentionRead,
  markAllMentionsRead
} from '@/services/accessNotificationState'
import {
  formatMentionAbsolute,
  formatMentionRelative,
  mentionInitial,
  mentionAvatarColor,
  mentionRoute,
  mentionSegments
} from '@/utils/mentionFormat'
export default {
  name: 'AccessNotifications',
  components: { UserAvatar },
  props: {
    userId: { type: String, required: true }
  },
  data: () => ({
    state,
    announcements,
    roles: {},
    busyId: '',
    rejectingId: '',
    decisionReason: '',
    seenBusy: false,
    searchTimer: null,
    markingAll: false,
    mentionNow: Date.now(),
    brokenAvatars: {}
  }),
  computed: {
    currentTotal() {
      return this.state.activeTab === 'history'
        ? this.state.historyTotal
        : this.state.activeTab === 'requests'
        ? this.state.total
        : this.state.resultTotal
    },
    currentPage() {
      return this.state.activeTab === 'history'
        ? this.state.historyPage
        : this.state.activeTab === 'requests'
        ? this.state.page
        : this.state.resultPage
    },
    currentError() {
      return this.state.activeTab === 'history'
        ? this.state.historyError
        : this.state.activeTab === 'announcements'
        ? ''
        : this.state.error
    }
  },
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
    window.clearTimeout(this.searchTimer)
    stopNotifications(this.userId)
  },
  methods: {
    roleText,
    formatTime(value) {
      const date = new Date(value)
      return Number.isNaN(date.getTime())
        ? ''
        : date.toLocaleString('zh-CN', {
            year: 'numeric',
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
      if (this.state.activeTab === 'mentions') return this.reloadMentions()
      return this.state.activeTab === 'history'
        ? refreshApprovalHistory()
        : refreshNotifications()
    },
    mentionInitial,
    mentionColor(item) {
      return mentionAvatarColor(item)
    },
    absoluteTime(value) {
      return formatMentionAbsolute(value, this.mentionNow)
    },
    relativeTime(value) {
      return formatMentionRelative(value, this.mentionNow)
    },
    segments(item) {
      return mentionSegments(item.content, item.mentions)
    },
    reloadMentions() {
      this.mentionNow = Date.now()
      return refreshMentions(true)
    },
    loadMoreMentions() {
      this.mentionNow = Date.now()
      return refreshMentions(false)
    },
    async markAllMentions() {
      if (this.markingAll) return
      this.markingAll = true
      try {
        await markAllMentionsRead()
        this.$message.success('已全部标为已读')
      } catch (error) {
        this.$message.error(error.message || '操作失败，请重试')
      } finally {
        this.markingAll = false
      }
    },
    // 标记已读 → 关闭消息中心 → 打开脑图并定位到节点、展开评论卡片
    openMention(item) {
      markMentionRead(item)
      this.state.visible = false
      const target = mentionRoute(item)
      const request = () =>
        window.dispatchEvent(
          new CustomEvent('mindmap:focus-comment', {
            detail: {
              room: target.query.room,
              node: target.query.focus,
              comment: target.query.comment
            }
          })
        )
      if (!this.$router) {
        this.$emit('open-file', item.room_key)
        return
      }
      const current = (this.$route && this.$route.query) || {}
      if (
        this.$route &&
        this.$route.path === '/' &&
        String(current.room || '') === target.query.room &&
        String(current.focus || '') === target.query.focus &&
        String(current.comment || '') === target.query.comment
      ) {
        // 地址没变（已在该脑图且刚看过同一条），直接让编辑页重新定位
        request()
        return
      }
      this.$router.push(target).catch(err => {
        if (err && err.name === 'NavigationDuplicated') request()
      })
    },
    filterHistory() {
      window.clearTimeout(this.searchTimer)
      this.state.historyPage = 1
      return refreshApprovalHistory().then(() => this.resetScroll('history'))
    },
    searchHistory() {
      window.clearTimeout(this.searchTimer)
      this.searchTimer = window.setTimeout(() => this.filterHistory(), 300)
    },
    onClosed() {
      window.clearTimeout(this.searchTimer)
      if (!this.busyId) {
        this.rejectingId = ''
        this.decisionReason = ''
      }
    },
    changePage(page) {
      if (this.state.activeTab === 'requests') this.state.page = page
      else if (this.state.activeTab === 'history') this.state.historyPage = page
      else this.state.resultPage = page
      const tab = this.state.activeTab
      this.refresh().then(() => this.resetScroll(tab))
    },
    resetScroll(tab) {
      this.$nextTick(() => {
        if (this.state.activeTab === tab && this.$refs.messageContent)
          this.$refs.messageContent.scrollTop = 0
      })
    },
    onOpened() {
      this.onTab()
    },
    onTab() {
      if (this.state.activeTab === 'history') refreshApprovalHistory()
      if (this.state.activeTab === 'results') this.markResultsSeen()
      if (this.state.activeTab === 'mentions') this.reloadMentions()
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
.messageTabs /deep/ .el-tabs__item {
  font-size: 13px;
  padding: 0 12px;
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
.requestGrid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  align-items: start;
}
.historyTools {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 24px;
  flex: none;
  border-bottom: 1px solid #e7ece9;
}
.historyTools /deep/ .el-input {
  width: 235px;
}
.historyTools
  /deep/
  .el-radio-button__orig-radio:checked
  + .el-radio-button__inner {
  background: #edf7f2;
  border-color: #8ac7ae;
  color: #087854;
  box-shadow: -1px 0 0 #8ac7ae;
}
.historyCard {
  padding: 18px;
  border: 1px solid #e1e8e4;
  border-radius: 12px;
  background: #fff;
  margin-bottom: 12px;
}
.historyIdentity {
  flex: 1;
  min-width: 0;
}
.historyIdentity strong {
  overflow-wrap: anywhere;
}
.historyRoles {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: #819087;
}
.grantedRole {
  border-radius: 5px;
  padding: 3px 7px;
  background: #f1f3f4;
  color: #64727d;
}
.grantedRole.manager {
  color: #087854;
  background: #eaf6ef;
}
.grantedRole.editor {
  color: #386ba7;
  background: #edf4ff;
}
.historyReason {
  display: flex;
  gap: 14px;
  font-size: 12px;
  line-height: 1.6;
  margin: 10px 0 0;
  color: #68796f;
}
.historyReason > span:first-child {
  flex: none;
  color: #91a097;
}
.historyReason > span:last-child {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  min-width: 0;
}
.requestFile:disabled {
  cursor: default;
  color: #91a097;
}
.accessRequestCard {
  padding: 18px;
  border: 1px solid #e1e8e4;
  border-radius: 12px;
  background: #fff;
  margin-bottom: 0;
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
.requestIdentity > div {
  min-width: 0;
}
.requestIdentity strong {
  overflow-wrap: anywhere;
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
button:focus-visible {
  outline: 2px solid #087854;
  outline-offset: 2px;
}
.mentionTools {
  display: flex;
  align-items: center;
  gap: 4px;
}
.markAllRead {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding: 0 10px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: #087854;
  font-size: 12px;
  cursor: pointer;
}
.markAllRead:hover:not(:disabled) {
  background: #eaf5ef;
}
.markAllRead:disabled {
  color: #a3b0a9;
  cursor: default;
}
.mentionList {
  list-style: none;
  margin: 0;
  padding: 0 18px;
  background: #fff;
  border: 1px solid #e1e8e4;
  border-radius: 12px;
}
.mentionItem {
  display: flex;
  gap: 14px;
  padding: 16px 0;
  cursor: pointer;
  border-radius: 8px;
  outline: none;
}
.mentionItem + .mentionItem {
  border-top: 1px dashed #dbe3df;
}
.mentionItem:hover .mentionTitle b:last-of-type,
.mentionItem:focus-visible .mentionTitle b:last-of-type {
  color: #087854;
}
.mentionItem:focus-visible {
  box-shadow: 0 0 0 2px #087854;
}
.mentionAvatar {
  flex: none;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  overflow: hidden;
  color: #fff;
  font-size: 17px;
  font-weight: 600;
}
.mentionAvatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.mentionBody {
  flex: 1;
  min-width: 0;
}
.mentionTitle {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  font-size: 14px;
  line-height: 20px;
  color: #42544b;
}
.mentionTitle b {
  color: #1e3028;
  font-weight: 600;
}
.mentionDot {
  flex: none;
  width: 8px;
  height: 8px;
  margin-top: 6px;
  border-radius: 50%;
  background: #25986d;
  box-shadow: 0 0 0 3px rgba(37, 152, 109, 0.15);
}
.mentionTime {
  display: flex;
  justify-content: space-between;
  margin-top: 3px;
  font-size: 12px;
  color: #8a978f;
}
.mentionQuote {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  background: #f3f6f4;
  color: #33453c;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.mentionAt {
  color: #087854;
  font-weight: 600;
}
.mentionRef {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 8px;
  font-size: 12px;
  color: #8a978f;
  min-width: 0;
}
.mentionRef span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mentionMore {
  text-align: center;
  padding-top: 8px;
}
.mentionMore /deep/ .el-button--text {
  color: #087854;
}
.mentionInlineError {
  text-align: center;
  font-size: 12px;
  color: #c0703d;
}
.mentionErrorState /deep/ .el-button {
  margin-top: 8px;
}
@media (max-width: 700px) {
  .requestGrid {
    grid-template-columns: minmax(0, 1fr);
  }
  .historyTools {
    flex-direction: column;
    align-items: stretch;
    gap: 12px;
    padding: 14px 16px;
  }
  .historyTools /deep/ .el-input {
    width: 100%;
  }
  .historyTools /deep/ .el-radio-button__inner {
    padding: 9px 12px;
  }
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
  .accessRequestCard {
    padding: 15px;
  }
}
</style>
<style lang="less">
.accessNotificationDialog.el-dialog {
  width: 92vw;
  max-width: 840px;
  height: 86vh;
  max-height: 860px;
  margin: 7vh auto !important;
  border-radius: 16px;
  overflow: hidden;
  box-shadow: 0 24px 80px rgba(16, 37, 26, 0.2);
}
.accessNotificationDialog .el-dialog__header {
  display: none;
}
.accessNotificationDialog .el-dialog__body {
  padding: 0;
  height: 100%;
}
@media (max-width: 520px) {
  .accessNotificationDialog.el-dialog {
    width: 96vw;
    height: 92vh;
    margin: 4vh auto !important;
    border-radius: 12px;
  }
}
/* 暗色模式：编辑页 body.isDark 时生效（ProductShell 页不加 isDark，保持浅色） */
body.isDark .accessNotificationDialog.el-dialog {
  background: #1f2329;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.55);
  .messageCenter { color: #e6e8eb; background: #1f2329; }
  .messageIcon { background: rgba(37, 152, 109, 0.16); color: #4cc596; }
  .connectionState { color: #9aa0a6; }
  .connectionState i { background: #5f656b; }
  .connectionState.live i { background: #3fbf8a; }
  .closeMessage, .refreshMessage { color: #9aa0a6; }
  .closeMessage:hover, .refreshMessage:hover { background: #2c3036; color: #4cc596; }
  .el-tabs__item { color: #9aa0a6; }
  .el-tabs__item:hover, .el-tabs__item.is-active { color: #4cc596; }
  .el-tabs__active-bar { background: #3fbf8a; }
  .el-tabs__nav-wrap::after { background-color: #3a3d42; }
  .messageContent { background: #25282d; }
  .sectionIntro p, .historyRoles, .requestIdentity small, .messageFooter,
  .resultCard small, .announcementRow time, .emptyMessages { color: #9aa0a6; }
  .historyTools, .messageFooter { border-color: #3a3d42; }
  .historyCard, .accessRequestCard { background: #1f2329; border-color: #3a3d42; }
  .grantedRole, .requestedRole { background: #2c3036; color: #b4bac0; }
  .grantedRole.manager { background: rgba(37, 152, 109, 0.18); color: #4cc596; }
  .grantedRole.editor, .requestedRole.editor { background: rgba(80, 140, 220, 0.18); color: #8db8ef; }
  .historyReason, .requestReason, .resultCard p, .announcementRow ul { color: #b4bac0; }
  .historyReason > span:first-child, .grantLabel { color: #9aa0a6; }
  .requestAvatar { background: #2f3a35; color: #6fd1a8; }
  .requestFile { background: #2a2e34; color: #d5d9dd; }
  .requestFile:disabled { color: #7d848b; }
  .requestActions .el-button--primary { background: #1f8f66; border-color: #1f8f66; color: #fff; }
  .emptyMessages > i { color: #4f7a66; }
  .emptyMessages h3 { color: #d5d9dd; }
  .messageError { background: rgba(230, 140, 70, 0.14); color: #e6a77a; }
  .resultCard, .announcementRow { border-color: #3a3d42; }
  .markAllRead { color: #4cc596; }
  .markAllRead:hover:not(:disabled) { background: #2c3036; }
  .markAllRead:disabled { color: #5f656b; }
  .mentionList { background: #1f2329; border-color: #3a3d42; }
  .mentionItem + .mentionItem { border-top-color: #3a3d42; }
  .mentionTitle { color: #b4bac0; }
  .mentionTitle b { color: #e6e8eb; }
  .mentionItem:hover .mentionTitle b:last-of-type { color: #4cc596; }
  .mentionDot { background: #3fbf8a; box-shadow: 0 0 0 3px rgba(63, 191, 138, 0.18); }
  .mentionTime, .mentionRef { color: #8b9198; }
  .mentionQuote { background: #2a2e34; color: #d5d9dd; }
  .mentionAt { color: #4cc596; }
  .mentionMore .el-button--text { color: #4cc596; }
  .resultIcon { background: rgba(37, 152, 109, 0.18); color: #4cc596; }
  .resultIcon.rejected { background: rgba(220, 110, 90, 0.16); color: #e39582; }
  button:focus-visible { outline-color: #3fbf8a; }
  /* Element UI 控件 */
  .el-input__inner, .el-textarea__inner {
    background: #2a2e34; border-color: #3a3d42; color: #e6e8eb;
    &::placeholder { color: #7d848b; }
    &:hover { border-color: #4a4e54; }
    &:focus { border-color: #3fbf8a; }
  }
  .el-input.is-disabled .el-input__inner { background: #25282d; color: #7d848b; }
  .el-select .el-input__icon, .el-input__prefix, .el-input__suffix { color: #9aa0a6; }
  .el-radio-button__inner { background: #2a2e34; border-color: #3a3d42; color: #b4bac0; }
  .el-radio-button:first-child .el-radio-button__inner { border-left-color: #3a3d42; }
  .el-radio-button__orig-radio:checked + .el-radio-button__inner {
    background: rgba(37, 152, 109, 0.2); border-color: #2f8f6a; color: #4cc596; box-shadow: -1px 0 0 #2f8f6a;
  }
  .el-button--default { background: #2a2e34; border-color: #3a3d42; color: #d5d9dd; }
  .el-button--default:hover { border-color: #3fbf8a; color: #4cc596; }
  .el-button--text { color: #4cc596; }
  .el-pagination { color: #9aa0a6; }
  .el-pagination button, .el-pagination .el-pager li, .el-pagination button:disabled { background: transparent; color: #9aa0a6; }
  .el-pagination .el-pager li.active, .el-pagination .el-pager li:hover { color: #4cc596; }
}
body.isDark .v-modal { background: #000; }
/* 下拉框挂在 body 上，单独覆盖 */
body.isDark .accessNotificationPopper.el-select-dropdown {
  background: #25282d; border-color: #3a3d42;
  .el-select-dropdown__item { color: #d5d9dd; }
  .el-select-dropdown__item.hover, .el-select-dropdown__item:hover { background: #2f343a; }
  .el-select-dropdown__item.selected { color: #4cc596; }
  .popper__arrow { border-bottom-color: #3a3d42 !important; }
  .popper__arrow::after { border-bottom-color: #25282d !important; }
  &[x-placement^='top'] .popper__arrow { border-top-color: #3a3d42 !important; }
  &[x-placement^='top'] .popper__arrow::after { border-top-color: #25282d !important; }
}
body.isDark .accessNotificationDialog .el-loading-mask {
  background-color: rgba(24, 27, 33, 0.72);
}
body.isDark .accessNotificationDialog .el-loading-spinner .path {
  stroke: #34c759;
}
.accessNotificationDialog .el-loading-spinner .path {
  stroke: #0f8a3a;
}
</style>
