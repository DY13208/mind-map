import Vue from 'vue'
import { Notification } from 'element-ui'
import service from './accessRequestService'
import mentionService from './mentionService'
import { getRuntimeConfig } from '@/utils/runtimeConfig'
export const state = Vue.observable({
  visible: false,
  activeTab: 'requests',
  items: [],
  results: [],
  history: [],
  historyTotal: 0,
  historyCounts: { all: 0, approved: 0, rejected: 0 },
  historyPage: 1,
  historyStatus: '',
  historySearch: '',
  historyLoading: false,
  historyError: '',
  total: 0,
  resultTotal: 0,
  unread: 0,
  announcementUnread: 0,
  loading: false,
  error: '',
  connected: false,
  page: 1,
  resultPage: 1,
  syncVersion: 0,
  // 「@我的」
  mentions: [],
  mentionUnread: 0,
  mentionLoading: false,
  mentionError: '',
  mentionCursor: null,
  mentionHasMore: false,
  mentionLoaded: false
})
let mentionSequence = 0
let userId = '',
  stream = null,
  timer = null,
  generation = 0,
  inFlight = null,
  queued = false,
  historySequence = 0,
  announced = new Set()
const notices = { requests: null, results: null }
function showNotice(kind, options) {
  const previous = notices[kind]
  if (previous && typeof previous.close === 'function') previous.close()
  notices[kind] = Notification(options)
}
export const roleText = role =>
  ({ viewer: '可查看', editor: '可编辑', manager: '可管理', owner: '所有者' }[
    role
  ] || '可查看')
export function openNotifications(tab) {
  if (tab) state.activeTab = tab
  state.visible = true
  refreshNotifications()
  // 「@我的」列表由消息中心打开/切换标签时加载，这里只刷新角标
  refreshMentionUnread()
}
function remember(id) {
  announced.add(id)
  try {
    window.sessionStorage.setItem(
      `mindmap:access:announced:${userId}`,
      JSON.stringify([...announced].slice(-300))
    )
  } catch (_) {
    /* Memory deduplication remains available. */
  }
}
function announce(data, results) {
  const unseen = data.list.filter(
    item => !announced.has(`${item.id}:${item.updated_at}`)
  )
  if (unseen.length) {
    unseen.forEach(item => remember(`${item.id}:${item.updated_at}`))
    showNotice('requests', {
      title: '新的访问申请',
      message: `${unseen[0].requester_name || '企业成员'}申请访问「${unseen[0]
        .title || '脑图'}」${
        data.total > 1 ? `，共 ${data.total} 条待处理` : ''
      }`,
      duration: 6000,
      type: 'info',
      onClick: () => openNotifications('requests')
    })
  }
  const decisions = results.list.filter(
    item =>
      !item.requester_seen_at &&
      !announced.has(`${item.id}:${item.status}:${item.decided_at}`)
  )
  if (decisions.length) {
    decisions.forEach(item =>
      remember(`${item.id}:${item.status}:${item.decided_at}`)
    )
    const first = decisions[0]
    showNotice('results', {
      title: first.status === 'approved' ? '访问申请已通过' : '访问申请已拒绝',
      message: `「${first.title || '脑图'}」${
        first.status === 'approved'
          ? `已授予${roleText(first.granted_role || first.requested_role)}`
          : '的申请未通过'
      }`,
      duration: 6000,
      type: first.status === 'approved' ? 'success' : 'warning',
      onClick: () => openNotifications('results')
    })
  }
}
export async function refreshNotifications() {
  if (!userId) return
  if (inFlight) {
    queued = true
    return inFlight
  }
  const version = generation
  state.loading = true
  const task = (async () => {
    try {
      const [data, results] = await Promise.all([
        service.inbox({ limit: 20, offset: (state.page - 1) * 20 }),
        service.results({ limit: 20, offset: (state.resultPage - 1) * 20 })
      ])
      if (version !== generation) return
      state.items = data.list || []
      state.total = Number(data.total) || 0
      state.results = results.list || []
      state.resultTotal = Number(results.total) || 0
      state.unread = Number(results.unread) || 0
      state.error = ''
      state.syncVersion++
      // A decision by another owner may remove the final item on this page.
      const max = Math.max(1, Math.ceil(state.total / 20)),
        resultMax = Math.max(1, Math.ceil(state.resultTotal / 20))
      if (state.page > max) {
        state.page = max
        queued = true
      }
      if (state.resultPage > resultMax) {
        state.resultPage = resultMax
        queued = true
      }
      announce(data, results)
    } catch (error) {
      if (version === generation) {
        state.error = error.message || '消息加载失败，请重试'
        if (error.statusCode === 401) {
          state.items = []
          state.results = []
          state.resultTotal = 0
          historySequence++
          state.historyLoading = false
          state.history = []
          state.historyTotal = 0
          state.historyCounts = { all: 0, approved: 0, rejected: 0 }
          state.total = 0
          state.unread = 0
          state.connected = false
          if (stream) stream.close()
        }
      }
    } finally {
      if (version === generation) {
        state.loading = false
        inFlight = null
        if (queued) {
          queued = false
          refreshNotifications()
        }
      }
    }
  })()
  inFlight = task
  return task
}
export async function refreshApprovalHistory() {
  if (!userId) return
  const version = generation,
    sequence = ++historySequence
  const filters = {
    limit: 20,
    offset: (state.historyPage - 1) * 20,
    status: state.historyStatus,
    search: state.historySearch.trim()
  }
  state.historyLoading = true
  try {
    const data = await service.history(filters)
    if (
      version !== generation ||
      sequence !== historySequence ||
      filters.status !== state.historyStatus ||
      filters.search !== state.historySearch.trim()
    )
      return
    state.history = data.list || []
    state.historyTotal = Number(data.total) || 0
    state.historyCounts = data.counts || { all: 0, approved: 0, rejected: 0 }
    state.historyError = ''
    const max = Math.max(1, Math.ceil(state.historyTotal / 20))
    if (state.historyPage > max) {
      state.historyPage = max
      return refreshApprovalHistory()
    }
  } catch (error) {
    if (version === generation && sequence === historySequence) {
      state.historyError = error.message || '审批历史加载失败，请重试'
      if (error.statusCode === 401) {
        state.history = []
        state.historyTotal = 0
        state.historyCounts = { all: 0, approved: 0, rejected: 0 }
      }
    }
  } finally {
    if (version === generation && sequence === historySequence)
      state.historyLoading = false
  }
}
export async function refreshMentionUnread() {
  if (!userId) return
  const version = generation
  try {
    const data = await mentionService.unreadCount()
    if (version === generation) state.mentionUnread = Number(data.unread) || 0
  } catch (_) {
    /* 角标刷新失败时保留上次的值 */
  }
}
// reset=true 重新加载第一页；否则按游标加载下一页
export async function refreshMentions(reset = true) {
  if (!userId) return
  if (!reset && (!state.mentionHasMore || state.mentionLoading)) return
  const version = generation,
    sequence = ++mentionSequence
  state.mentionLoading = true
  try {
    const data = await mentionService.list({
      limit: 20,
      before: reset ? '' : state.mentionCursor || ''
    })
    if (version !== generation || sequence !== mentionSequence) return
    const list = data.list || []
    if (reset) state.mentions = list
    else {
      const seen = new Set(state.mentions.map(item => `${item.room_key}:${item.id}`))
      state.mentions = state.mentions.concat(list.filter(item => !seen.has(`${item.room_key}:${item.id}`)))
    }
    state.mentionCursor = data.next_cursor || null
    state.mentionHasMore = !!data.has_more
    state.mentionUnread = Number(data.unread) || 0
    state.mentionError = ''
    state.mentionLoaded = true
  } catch (error) {
    if (version === generation && sequence === mentionSequence)
      state.mentionError = error.message || '提及加载失败，请重试'
  } finally {
    if (version === generation && sequence === mentionSequence)
      state.mentionLoading = false
  }
}
export async function markMentionRead(item) {
  if (!item || !item.unread) return
  item.unread = false
  state.mentionUnread = Math.max(0, state.mentionUnread - 1)
  try {
    const data = await mentionService.markRead([
      { room_key: item.room_key, comment_id: item.comment_id || item.id }
    ])
    if (data && data.unread != null) state.mentionUnread = Number(data.unread) || 0
  } catch (_) {
    /* 下次同步时以服务端为准 */
  }
}
export async function markAllMentionsRead() {
  const data = await mentionService.markAllRead()
  state.mentions.forEach(item => {
    item.unread = false
  })
  state.mentionUnread = Number(data && data.unread) || 0
}
function syncNotifications() {
  refreshNotifications()
  refreshMentionUnread()
  if (state.visible && state.activeTab === 'mentions') refreshMentions(true)
  if (state.visible && state.activeTab === 'history') refreshApprovalHistory()
}
function onVisibility() {
  if (!document.hidden) syncNotifications()
}
export function startNotifications(id) {
  if (userId === String(id)) return
  stopNotifications()
  userId = String(id || '')
  if (!userId) return
  try {
    announced = new Set(
      JSON.parse(
        window.sessionStorage.getItem(`mindmap:access:announced:${userId}`) ||
          '[]'
      )
    )
  } catch (_) {
    announced = new Set()
  }
  refreshNotifications()
  refreshMentionUnread()
  if (typeof EventSource !== 'undefined') {
    stream = new EventSource(
      `${
        getRuntimeConfig().collabApi
      }/api/notifications/access-requests/events`,
      { withCredentials: true }
    )
    const version = generation
    stream.addEventListener('ready', () => {
      if (version === generation) {
        state.connected = true
        syncNotifications()
      }
    })
    stream.addEventListener('invalidate', () => {
      if (version === generation) syncNotifications()
    })
    stream.onerror = () => {
      if (version === generation) state.connected = false
    }
  }
  timer = window.setInterval(() => {
    if (!document.hidden) syncNotifications()
  }, 60000)
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('online', onVisibility)
}
export function stopNotifications(expectedUserId) {
  // A keyed provider may be destroyed after its replacement has started.
  if (expectedUserId && String(expectedUserId) !== userId) return
  Object.keys(notices).forEach(kind => {
    const notice = notices[kind]
    if (notice && typeof notice.close === 'function') notice.close()
    notices[kind] = null
  })
  generation++
  userId = ''
  if (stream) stream.close()
  stream = null
  if (timer) window.clearInterval(timer)
  timer = null
  inFlight = null
  queued = false
  document.removeEventListener('visibilitychange', onVisibility)
  window.removeEventListener('online', onVisibility)
  Object.assign(state, {
    visible: false,
    activeTab: 'requests',
    items: [],
    results: [],
    history: [],
    historyTotal: 0,
    historyCounts: { all: 0, approved: 0, rejected: 0 },
    historyPage: 1,
    historyStatus: '',
    historySearch: '',
    historyLoading: false,
    historyError: '',
    total: 0,
    resultTotal: 0,
    unread: 0,
    announcementUnread: 0,
    loading: false,
    error: '',
    connected: false,
    page: 1,
    resultPage: 1,
    mentions: [],
    mentionUnread: 0,
    mentionLoading: false,
    mentionError: '',
    mentionCursor: null,
    mentionHasMore: false,
    mentionLoaded: false
  })
  mentionSequence++
}
