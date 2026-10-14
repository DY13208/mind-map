<template>
  <div
    v-show="visible"
    class="nodeCommentCard"
    :class="{ isDark: isDark }"
    :style="cardStyle"
    data-testid="node-comment-card"
    @mousedown.stop
    @click.stop="closeMenus"
    @wheel.stop
  >
    <span class="ncArrow" :class="arrowSide" :style="{ top: arrowTop + 'px' }"></span>
    <div class="ncHeader">
      <div class="ncTitle">节点评论（{{ comments.length }}）<span v-if="resolved && comments.length" class="ncResolvedTag">已解决</span></div>
      <div class="ncActions">
        <button type="button" class="ncIconBtn" title="上一条评论" aria-label="上一条评论" :disabled="!canNavigate" @click="navigate(-1)">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>
        </button>
        <button type="button" class="ncIconBtn" title="下一条评论" aria-label="下一条评论" :disabled="!canNavigate" @click="navigate(1)">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
        </button>
        <button
          v-if="!readonly && comments.length"
          type="button"
          class="ncIconBtn"
          :class="{ active: resolved }"
          :title="resolved ? '重新打开' : '解决并归档'"
          :aria-label="resolved ? '重新打开' : '解决并归档'"
          data-testid="comment-resolve"
          @click="toggleResolved"
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9"/><path d="m9.5 14 2 2 3.5-3.5"/></svg>
        </button>
        <button type="button" class="ncIconBtn" :class="{ active: showAll }" title="全部评论" aria-label="全部评论" data-testid="comment-list-toggle" @click="showAll = !showAll">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/></svg>
        </button>
        <span class="ncSep"></span>
        <button type="button" class="ncIconBtn" title="关闭" aria-label="关闭" data-testid="comment-close" @click="close">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>
        </button>
      </div>
    </div>

    <div v-if="showAll" class="ncAll">
      <div v-if="!threadNodes.length" class="ncEmpty">暂无评论</div>
      <div
        v-for="item in threadSummaries"
        :key="item.uid"
        class="ncAllItem"
        :class="{ current: item.node === node, resolved: item.resolved }"
        @click="openThread(item.node)"
      >
        <span class="ncAllText">{{ item.text || '（无标题节点）' }}</span>
        <span class="ncAllCount">{{ item.count }}</span>
      </div>
    </div>

    <template v-else>
      <div v-if="comments.length" ref="list" class="ncList">
        <div v-for="item in comments" :key="item.id" class="ncItem">
          <span class="ncAvatar" :style="avatarStyle(item)">
            <img v-if="avatarSrc(item)" :src="avatarSrc(item)" alt="" />
            <template v-else>{{ initial(item.userName) }}</template>
          </span>
          <div class="ncBody">
            <div class="ncMeta">
              <span class="ncName">{{ item.userName || '匿名用户' }}</span>
              <span class="ncTime">{{ timeText(item.time) }}</span>
              <span class="ncMoreWrap">
                <button type="button" class="ncLink ncDots" aria-label="更多" @click.stop="toggleMenu(item.id)">···</button>
                <div v-if="menuId === item.id" class="ncMenu">
                  <div class="ncMenuItem" @click="copyComment(item)">复制</div>
                  <div v-if="canDelete(item)" class="ncMenuItem danger" data-testid="comment-delete" @click="removeComment(item.id)">删除</div>
                </div>
              </span>
            </div>
            <div class="ncContent"><span
              v-for="(seg, i) in contentSegments(item)"
              :key="i"
              :class="{ ncMention: seg.mention }"
            >{{ seg.text }}</span></div>
            <div v-if="!readonly" class="ncItemActions">
              <button type="button" class="ncLink" data-testid="comment-reply" @click="replyTo(item)">回复</button>
            </div>
          </div>
        </div>
      </div>
      <div v-else-if="readonly" class="ncEmpty">暂无评论</div>

      <div v-if="!readonly" class="ncComposer">
        <div v-if="mentionOpen && mentionCandidates.length" class="ncSuggest" data-testid="comment-mention-list">
          <div
            v-for="(m, i) in mentionCandidates"
            :key="m.userId || m.name"
            class="ncSuggestItem"
            :class="{ active: i === mentionIndex }"
            @mousedown.prevent="pickMention(m)"
          >
            <span class="ncAvatar small" :style="avatarStyle(m)">
              <img v-if="avatarSrc(m)" :src="avatarSrc(m)" alt="" />
              <template v-else>{{ initial(m.name) }}</template>
            </span>
            <span>{{ m.name }}</span>
          </div>
        </div>
        <div v-if="emojiOpen" class="ncEmojiPanel" data-testid="comment-emoji-panel">
          <span v-for="e in emojis" :key="e" class="ncEmoji" @mousedown.prevent="insertText(e)">{{ e }}</span>
        </div>
        <div class="ncComposerRow">
          <span class="ncAvatar" :style="avatarStyle(currentUser)">
            <img v-if="avatarSrc(currentUser)" :src="avatarSrc(currentUser)" alt="" />
            <template v-else>{{ initial(currentUser.userName) }}</template>
          </span>
          <div class="ncInputPill">
            <input
              ref="input"
              v-model="draft"
              class="ncInput"
              type="text"
              maxlength="2000"
              placeholder="写下你的评论..."
              data-testid="comment-input"
              @input="onInput"
              @keydown="onInputKeydown"
            />
            <button type="button" class="ncPillBtn" title="@成员" aria-label="@成员" data-testid="comment-mention" @click.stop="startMention">
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="3.6"/><path d="M15.6 12v1.4a2.6 2.6 0 0 0 5.2 0V12a8.8 8.8 0 1 0-3.5 7"/></svg>
            </button>
            <button type="button" class="ncPillBtn" title="表情" aria-label="表情" @click.stop="emojiOpen = !emojiOpen">
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0"/><path d="M9 9.5h.01M15 9.5h.01" stroke-width="2.6"/></svg>
            </button>
          </div>
          <button type="button" class="ncSend" :class="{ ready: !!draft.trim() }" title="发送" aria-label="发送" data-testid="comment-send" @click="submit">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M3.4 11.2 19.6 4c.8-.4 1.6.4 1.2 1.2l-7.2 16.2c-.4.8-1.5.7-1.7-.1l-1.7-6.3-6.3-1.7c-.8-.2-.9-1.3-.1-1.7Z"/></svg>
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<script>
import { formatCommentTime } from '@/utils/commentTime'
import { currentCommentUser } from '@/utils/commentUser'
import { markCommentsRead, collectMentions, splitMentions } from '@/utils/commentRead'
import { roomFromLocation } from '@/utils/roomLocation'
import shareService from '@/services/shareService'
import { mergeComments, liveComments } from 'simple-mind-map/src/utils/nodeComment'

const CARD_WIDTH = 320
const CARD_GAP = 12
const ARROW_OFFSET = 26
const CARD_HEIGHT_ESTIMATE = 360
const CLOSE_EVENTS = ['node_dragging', 'mode_change', 'node_contextmenu']
const REPOSITION_EVENTS = ['scale', 'translate']
const AVATAR_COLORS = ['#5b8ff9', '#5ad8a6', '#f6bd16', '#e8684a', '#6dc8ec', '#9270ca', '#ff9d4d', '#269a99']
const EMOJIS = ['👍', '👏', '🎉', '😀', '😂', '🤔', '😅', '🙏', '💪', '✅', '❌', '❤️', '🔥', '👀', '📌', '⚠️']
const memberCache = {}

function isImage(value) {
  const url = String(value || '').trim()
  return /^(https?:)?\/\//.test(url) || url.startsWith('data:image/')
}

// 只展示存活评论；墓碑和脏数据由 liveComments 过滤
function normalizeComments(list) {
  return liveComments(list)
}

// 节点评论卡片：查看 / 发表 / 回复 / @成员 / 删除自己的评论 / 解决归档 / 上下切换
export default {
  name: 'NodeCommentCard',
  data() {
    return {
      visible: false,
      node: null,
      comments: [],
      rawComments: [],
      resolved: false,
      readonly: false,
      isDark: false,
      showAll: false,
      draft: '',
      left: 0,
      top: 0,
      arrowTop: 20,
      arrowSide: 'left',
      now: Date.now(),
      threadNodes: [],
      menuId: '',
      emojiOpen: false,
      emojis: EMOJIS,
      members: [],
      mentionOpen: false,
      mentionQuery: '',
      mentionIndex: 0,
      pickedMentions: [],
      replyTargetId: ''
    }
  },
  computed: {
    cardStyle() {
      return { left: this.left + 'px', top: this.top + 'px', width: CARD_WIDTH + 'px' }
    },
    currentUser() {
      return currentCommentUser()
    },
    roomKey() {
      try {
        return roomFromLocation(this.$route) || ''
      } catch (e) {
        return ''
      }
    },
    canNavigate() {
      return this.threadNodes.some(n => n !== this.node)
    },
    threadSummaries() {
      return this.threadNodes.map(node => {
        const data = node.getData() || {}
        return {
          node,
          uid: data.uid,
          text: String(data.text || '').replace(/<[^>]+>/g, '').trim(),
          count: normalizeComments(data.comments).length,
          resolved: !!data.commentResolved
        }
      })
    },
    // 候选成员：房间成员 + 评论里出现过的人，排除自己
    mentionPool() {
      const map = new Map()
      const add = (userId, name, avatar) => {
        const key = String(userId || name || '')
        if (!key || !name || map.has(key)) return
        map.set(key, { userId: String(userId || ''), name: String(name), avatar: String(avatar || '') })
      }
      this.members.forEach(m => add(m.userId || m.id, m.name, m.avatar))
      this.comments.forEach(c => add(c.userId, c.userName, c.avatar))
      const me = this.currentUser.userId
      return Array.from(map.values()).filter(m => !me || m.userId !== me)
    },
    mentionCandidates() {
      const q = this.mentionQuery.toLowerCase()
      return this.mentionPool.filter(m => !q || m.name.toLowerCase().includes(q)).slice(0, 8)
    }
  },
  created() {
    this.$bus.$on('node_commentClick', this.onMarkerClick)
    this.$bus.$on('showNodeComment', this.open)
    this.$bus.$on('node_tree_render_end', this.syncFromNode)
    CLOSE_EVENTS.forEach(event => this.$bus.$on(event, this.close))
    REPOSITION_EVENTS.forEach(event => this.$bus.$on(event, this.reposition))
  },
  mounted() {
    if (typeof document !== 'undefined' && document.body && this.$el && this.$el.parentNode !== document.body) {
      document.body.appendChild(this.$el)
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('mousedown', this.onDocumentMousedown, true)
      document.addEventListener('keydown', this.onKeydown)
    }
    if (typeof window !== 'undefined') window.addEventListener('resize', this.reposition)
  },
  beforeDestroy() {
    this.$bus.$off('node_commentClick', this.onMarkerClick)
    this.$bus.$off('showNodeComment', this.open)
    this.$bus.$off('node_tree_render_end', this.syncFromNode)
    CLOSE_EVENTS.forEach(event => this.$bus.$off(event, this.close))
    REPOSITION_EVENTS.forEach(event => this.$bus.$off(event, this.reposition))
    if (typeof document !== 'undefined') {
      document.removeEventListener('mousedown', this.onDocumentMousedown, true)
      document.removeEventListener('keydown', this.onKeydown)
    }
    if (typeof window !== 'undefined') window.removeEventListener('resize', this.reposition)
    if (this.$el && this.$el.parentNode) this.$el.parentNode.removeChild(this.$el)
  },
  methods: {
    onMarkerClick(node) {
      this.open(node)
    },
    open(node) {
      if (!node || typeof node.getData !== 'function') return
      const mindMap = node.mindMap
      this.node = node
      this.readonly = !!(mindMap && mindMap.opt && mindMap.opt.readonly)
      this.isDark =
        typeof document !== 'undefined' && !!document.body && document.body.classList.contains('isDark')
      this.showAll = false
      this.draft = ''
      this.pickedMentions = []
      this.closeMenus()
      this.now = Date.now()
      this.loadFromNode()
      this.collectThreads()
      this.visible = true
      this.reposition()
      this.markRead()
      this.loadMembers()
      this.focusInput()
    },
    close() {
      if (!this.visible && !this.node) return
      this.visible = false
      this.node = null
      this.draft = ''
      this.showAll = false
      this.closeMenus()
    },
    closeMenus() {
      this.menuId = ''
      this.emojiOpen = false
      this.mentionOpen = false
    },
    loadFromNode() {
      const data = (this.node && this.node.getData()) || {}
      this.rawComments = Array.isArray(data.comments) ? data.comments : []
      this.comments = normalizeComments(this.rawComments)
      this.resolved = !!data.commentResolved
    },
    // 打开即视为已读：记录到本地并刷新节点上的未读红点
    markRead() {
      const node = this.node
      if (!node) return
      const uid = node.getData('uid')
      const latest = this.comments.reduce((max, c) => Math.max(max, Number(c.time) || 0), 0)
      const hadUnread = this.hasUnreadDot(node)
      markCommentsRead(this.roomKey, uid, this.currentUser.userId, Math.max(latest, Date.now()))
      if (hadUnread && typeof node.reRender === 'function') {
        try {
          node.reRender(['comment'])
        } catch (e) {
          // ignore
        }
      }
    },
    hasUnreadDot(node) {
      const fn = node && node.mindMap && node.mindMap.opt && node.mindMap.opt.isNodeCommentUnread
      try {
        return typeof fn === 'function' ? !!fn(node) : false
      } catch (e) {
        return false
      }
    },
    async loadMembers() {
      const roomKey = this.roomKey
      if (!roomKey || this.readonly) return
      if (memberCache[roomKey]) {
        this.members = memberCache[roomKey]
        return
      }
      try {
        const list = await shareService.getMembers(roomKey)
        memberCache[roomKey] = Array.isArray(list) ? list : []
        this.members = memberCache[roomKey]
      } catch (e) {
        this.members = []
      }
    },
    collectThreads() {
      const mindMap = this.node && this.node.mindMap
      const root = mindMap && mindMap.renderer && mindMap.renderer.root
      const list = []
      const walk = node => {
        if (!node) return
        const data = typeof node.getData === 'function' ? node.getData() : null
        if (data && normalizeComments(data.comments).length) list.push(node)
        ;(node.children || []).forEach(walk)
      }
      walk(root)
      this.threadNodes = list
    },
    nodeRect(node) {
      const el = node && node.group && node.group.node
      if (el && typeof el.getBoundingClientRect === 'function') return el.getBoundingClientRect()
      return null
    },
    // 锚点：节点右上角评论标签；没有标签（如从右键菜单添加第一条）时用节点右上角
    anchorRect(node) {
      const tab = node && node._commentTab && node._commentTab.node
      if (tab && typeof tab.getBoundingClientRect === 'function') {
        const t = tab.getBoundingClientRect()
        if (t && (t.width || t.height)) return t
      }
      const r = this.nodeRect(node)
      if (!r) return null
      return { left: r.right - 20, right: r.right, top: r.top, bottom: Math.min(r.bottom, r.top + 20) }
    },
    // 卡片在评论标签右侧，箭头指向标签；右侧空间不足时放到左侧
    reposition() {
      if (!this.visible || !this.node) return
      const a = this.anchorRect(this.node) || { left: 0, top: 0, right: 0, bottom: 0 }
      const vw = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : Infinity
      const vh = typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : Infinity
      const anchorY = (a.top + a.bottom) / 2
      let side = 'left'
      let left = a.right + CARD_GAP
      if (Number.isFinite(vw) && left + CARD_WIDTH > vw - 8 && a.left - CARD_GAP - CARD_WIDTH >= 8) {
        side = 'right'
        left = a.left - CARD_GAP - CARD_WIDTH
      }
      let top = anchorY - ARROW_OFFSET
      if (Number.isFinite(vh)) top = Math.min(top, vh - CARD_HEIGHT_ESTIMATE - 8)
      top = Math.max(8, top)
      this.left = Math.max(8, left)
      this.top = top
      this.arrowSide = side
      this.arrowTop = Math.max(12, Math.min(CARD_HEIGHT_ESTIMATE - 24, anchorY - top - 6))
    },
    focusInput() {
      if (this.readonly) return
      this.$nextTick && this.$nextTick(() => {
        const input = this.$refs && this.$refs.input
        if (input && typeof input.focus === 'function') input.focus()
      })
    },
    onDocumentMousedown(e) {
      if (!this.visible) return
      const target = e && e.target
      if (this.$el && target && typeof this.$el.contains === 'function' && this.$el.contains(target)) return
      if (target && typeof target.closest === 'function' && target.closest('.smm-comment-marker, .nodeCommentEntry, .nodeQuickToolbar')) return
      this.close()
    },
    onKeydown(e) {
      if (this.visible && e && (e.key === 'Escape' || e.keyCode === 27)) this.close()
    },
    syncFromNode() {
      if (!this.visible || !this.node) return
      const node = this.node
      const renderer = node.mindMap && node.mindMap.renderer
      const uid = node.getData('uid')
      if (renderer && typeof renderer.findNodeByUid === 'function' && uid) {
        const live = renderer.findNodeByUid(uid)
        if (!live) return this.close()
        this.node = live
      }
      this.loadFromNode()
      this.collectThreads()
      this.reposition()
    },
    // 提交完整评论数组（含删除墓碑）；服务端与其他客户端按 id 并集合并，不会互相覆盖
    commit(rawComments, resolved) {
      const node = this.node
      if (!node || this.readonly) return
      this.rawComments = rawComments
      this.comments = normalizeComments(rawComments)
      this.resolved = resolved
      node.mindMap.execCommand('SET_NODE_COMMENT', node, rawComments, resolved)
    },
    submit() {
      const content = String(this.draft || '').trim()
      if (!content || this.readonly || !this.node) return
      const user = this.currentUser
      const time = Date.now()
      const comment = {
        id: `c_${time.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        userId: user.userId,
        userName: user.userName,
        avatar: user.avatar,
        content,
        time
      }
      const mentions = collectMentions(content, this.pickedMentions)
      if (mentions.length) comment.mentions = mentions
      if (this.replyTargetId && this.comments.some(c => c.id === this.replyTargetId)) comment.replyTo = this.replyTargetId
      this.replyTargetId = ''
      this.draft = ''
      this.pickedMentions = []
      this.closeMenus()
      this.now = time
      this.commit(mergeComments(this.rawComments, [comment]), false)
      markCommentsRead(this.roomKey, this.node.getData('uid'), user.userId, time)
      this.collectThreads()
      this.$nextTick && this.$nextTick(() => {
        const list = this.$refs && this.$refs.list
        if (list) list.scrollTop = list.scrollHeight
      })
    },
    insertText(text) {
      const input = this.$refs && this.$refs.input
      const value = this.draft
      let start = value.length
      let end = value.length
      if (input && typeof input.selectionStart === 'number' && typeof document !== 'undefined' && document.activeElement === input) {
        start = input.selectionStart
        end = input.selectionEnd
      }
      this.draft = value.slice(0, start) + text + value.slice(end)
      this.emojiOpen = false
      this.$nextTick && this.$nextTick(() => {
        if (input && typeof input.focus === 'function') {
          input.focus()
          const pos = start + text.length
          if (typeof input.setSelectionRange === 'function') input.setSelectionRange(pos, pos)
        }
      })
    },
    replyTo(item) {
      if (this.readonly || !item) return
      const name = item.userName || ''
      if (name) {
        this.draft = `@${name} `
        this.pickedMentions = [{ userId: item.userId, name }]
      }
      this.replyTargetId = item.id || ''
      this.menuId = ''
      this.focusInput()
    },
    startMention() {
      if (this.readonly) return
      const sep = this.draft && !/\s$/.test(this.draft) ? ' ' : ''
      this.draft = this.draft + sep + '@'
      this.mentionQuery = ''
      this.mentionIndex = 0
      this.mentionOpen = true
      this.focusInput()
    },
    // 光标前出现 @xxx 时弹出成员建议
    onInput() {
      const match = /(^|\s)@([^\s@]*)$/.exec(this.draft)
      if (match) {
        this.mentionOpen = true
        this.mentionQuery = match[2]
        this.mentionIndex = 0
      } else {
        this.mentionOpen = false
      }
    },
    pickMention(member) {
      if (!member) return
      this.draft = this.draft.replace(/@([^\s@]*)$/, `@${member.name} `)
      this.pickedMentions = this.pickedMentions.concat({ userId: member.userId, name: member.name })
      this.mentionOpen = false
      this.focusInput()
    },
    onInputKeydown(e) {
      if (!e) return
      const list = this.mentionCandidates
      if (this.mentionOpen && list.length) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          const step = e.key === 'ArrowDown' ? 1 : -1
          this.mentionIndex = (this.mentionIndex + step + list.length) % list.length
          return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault()
          this.pickMention(list[this.mentionIndex] || list[0])
          return
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        if (this.mentionOpen || this.emojiOpen) this.closeMenus()
        else this.close()
        if (typeof e.stopPropagation === 'function') e.stopPropagation()
        return
      }
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault()
        this.submit()
      }
    },
    toggleMenu(id) {
      this.menuId = this.menuId === id ? '' : id
      this.emojiOpen = false
    },
    async copyComment(item) {
      this.menuId = ''
      if (!item) return
      try {
        await navigator.clipboard.writeText(item.content)
        if (this.$message) this.$message.success('已复制')
      } catch (e) {
        if (this.$message) this.$message.warning('复制失败')
      }
    },
    canDelete(item) {
      if (this.readonly || !item) return false
      const me = this.currentUser
      return !!(me.userId && item.userId === me.userId)
    },
    removeComment(id) {
      this.menuId = ''
      const item = this.comments.find(c => c.id === id)
      if (!this.canDelete(item)) return
      const tombstone = { id, deleted: true, deletedAt: Date.now(), deletedBy: this.currentUser.userId }
      const next = mergeComments(this.rawComments, [tombstone])
      this.commit(next, normalizeComments(next).length ? this.resolved : false)
      this.collectThreads()
    },
    toggleResolved() {
      if (this.readonly || !this.comments.length) return
      this.commit(this.rawComments.slice(), !this.resolved)
    },
    navigate(step) {
      this.collectThreads()
      const list = this.threadNodes
      if (!list.length) return
      let index = list.indexOf(this.node)
      index = index < 0 ? 0 : (index + step + list.length) % list.length
      this.openThread(list[index])
    },
    openThread(node) {
      if (!node) return
      const mindMap = node.mindMap
      if (mindMap && mindMap.renderer && typeof mindMap.renderer.moveNodeToCenter === 'function') {
        mindMap.renderer.moveNodeToCenter(node, false)
      }
      this.open(node)
    },
    contentSegments(item) {
      return splitMentions(item && item.content, item && item.mentions)
    },
    timeText(time) {
      return formatCommentTime(time, this.now)
    },
    initial(name) {
      const text = String(name || '').trim()
      return text ? text.slice(0, 1) : '我'
    },
    avatarSrc(item) {
      return item && isImage(item.avatar) ? String(item.avatar).trim() : ''
    },
    avatarStyle(item) {
      if (this.avatarSrc(item)) return {}
      const key = String((item && (item.userId || item.userName || item.name)) || '')
      let hash = 0
      for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0
      return { background: AVATAR_COLORS[hash % AVATAR_COLORS.length] }
    }
  }
}
</script>

<style lang="less" scoped>
.nodeCommentCard {
  position: fixed;
  z-index: 2100;
  box-sizing: border-box;
  background: #fff;
  border: 1px solid #eaecf0;
  border-radius: 12px;
  box-shadow: 0 10px 30px rgba(16, 24, 40, 0.14);
  color: #1f2329;
  font-size: 13px;

  .ncArrow {
    position: absolute;
    width: 12px;
    height: 12px;
    background: inherit;
    border-left: 1px solid #eaecf0;
    border-bottom: 1px solid #eaecf0;
    transform: rotate(45deg);

    &.left {
      left: -7px;
    }

    &.right {
      right: -7px;
      transform: rotate(225deg);
    }
  }

  .ncHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 46px;
    padding: 0 10px 0 16px;
  }

  .ncTitle {
    font-size: 14px;
    font-weight: 600;
  }

  .ncResolvedTag {
    margin-left: 6px;
    padding: 1px 6px;
    border-radius: 4px;
    background: #f2f3f5;
    color: #8f959e;
    font-size: 11px;
    font-weight: 400;
  }

  .ncActions {
    display: flex;
    align-items: center;
    gap: 1px;
  }

  .ncSep {
    width: 1px;
    height: 14px;
    margin: 0 4px;
    background: #e4e7ec;
  }

  .ncIconBtn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: #8f959e;
    cursor: pointer;

    &:hover:not(:disabled) {
      background: rgba(31, 35, 41, 0.08);
      color: #1f2329;
    }

    &:disabled {
      opacity: 0.35;
      cursor: default;
    }

    &.active {
      color: #3370ff;
      background: rgba(51, 112, 255, 0.1);
    }
  }

  .ncList {
    max-height: 300px;
    overflow-y: auto;
    padding: 0 0 4px;
  }

  .ncItem {
    display: flex;
    gap: 10px;
    padding: 12px 16px;

    & + .ncItem {
      border-top: 1px solid #f0f1f3;
    }
  }

  .ncAvatar {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: #5b8ff9;
    color: #fff;
    font-size: 12px;
    overflow: hidden;

    &.small {
      width: 22px;
      height: 22px;
      font-size: 11px;
    }

    img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
  }

  .ncBody {
    flex: 1;
    min-width: 0;
  }

  .ncMeta {
    display: flex;
    align-items: center;
    gap: 6px;
    line-height: 20px;
  }

  .ncName {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ncTime {
    color: #8f959e;
    font-size: 12px;
    white-space: nowrap;
  }

  .ncContent {
    margin-top: 2px;
    line-height: 20px;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .ncMention {
    color: #3370ff;
  }

  .ncItemActions {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-top: 4px;
  }

  .ncLink {
    padding: 0;
    border: none;
    background: transparent;
    color: #3370ff;
    font-size: 12px;
    line-height: 18px;
    cursor: pointer;

    &:hover {
      opacity: 0.8;
    }

    &.ncDots {
      color: #8f959e;
      letter-spacing: 1px;
    }
  }

  .ncMoreWrap {
    position: relative;
    margin-left: auto;
  }

  .ncMenu,
  .ncSuggest,
  .ncEmojiPanel {
    position: absolute;
    z-index: 2;
    background: #fff;
    border: 1px solid #eaecf0;
    border-radius: 8px;
    box-shadow: 0 6px 18px rgba(16, 24, 40, 0.14);
  }

  .ncMenu {
    top: 20px;
    right: -4px;
    min-width: 88px;
    padding: 4px;
  }

  .ncMenuItem {
    padding: 5px 10px;
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;

    &:hover {
      background: rgba(31, 35, 41, 0.06);
    }

    &.danger {
      color: #f54a45;
    }
  }

  .ncEmpty {
    padding: 14px 16px;
    color: #8f959e;
    text-align: center;
    font-size: 12px;
  }

  .ncComposer {
    position: relative;
    padding: 10px 12px 12px;
    border-top: 1px solid #f0f1f3;
  }

  .ncComposerRow {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .ncSend {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    padding: 0;
    border: none;
    border-radius: 8px;
    background: #3370ff;
    color: #fff;
    cursor: pointer;
    opacity: 0.55;

    &.ready {
      opacity: 1;
    }

    &:hover {
      background: #285fe0;
    }
  }

  .ncSuggest {
    bottom: 54px;
    left: 12px;
    right: 12px;
    max-height: 200px;
    overflow-y: auto;
    padding: 4px;
  }

  .ncSuggestItem {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 8px;
    border-radius: 6px;
    cursor: pointer;

    &:hover,
    &.active {
      background: rgba(51, 112, 255, 0.08);
    }
  }

  .ncEmojiPanel {
    bottom: 54px;
    right: 12px;
    display: grid;
    grid-template-columns: repeat(8, 28px);
    gap: 2px;
    padding: 6px;
  }

  .ncEmoji {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 28px;
    border-radius: 6px;
    font-size: 17px;
    cursor: pointer;

    &:hover {
      background: rgba(31, 35, 41, 0.08);
    }
  }

  .ncInputPill {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 0;
    height: 34px;
    padding: 0 4px 0 10px;
    border: 1px solid #e4e7ec;
    border-radius: 8px;
    background: #fff;

    &:focus-within {
      border-color: #3370ff;
      background: #fff;
    }
  }

  .ncInput {
    flex: 1;
    min-width: 0;
    height: 100%;
    padding: 0;
    border: none;
    outline: none;
    background: transparent;
    color: inherit;
    font-size: 13px;
  }

  .ncPillBtn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    padding: 0;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: #8f959e;
    cursor: pointer;

    &:hover {
      background: rgba(31, 35, 41, 0.08);
      color: #3370ff;
    }
  }

  .ncAll {
    max-height: 300px;
    overflow-y: auto;
    padding: 0 8px 8px;
  }

  .ncAllItem {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 8px;
    border-radius: 6px;
    cursor: pointer;

    &:hover,
    &.current {
      background: rgba(31, 35, 41, 0.06);
    }

    &.resolved {
      color: #8f959e;
    }
  }

  .ncAllText {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ncAllCount {
    min-width: 18px;
    padding: 0 6px;
    border-radius: 9px;
    background: rgba(51, 112, 255, 0.1);
    color: #3370ff;
    font-size: 12px;
    text-align: center;
  }

  &.isDark {
    background: #2b2f33;
    border-color: #3a3f45;
    color: rgba(255, 255, 255, 0.88);
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);

    .ncArrow {
      border-color: #3a3f45;
    }

    .ncSep {
      background: #3a3f45;
    }

    .ncIconBtn {
      color: rgba(255, 255, 255, 0.55);

      &:hover:not(:disabled) {
        background: rgba(255, 255, 255, 0.08);
        color: #fff;
      }

      &.active {
        color: #69b1ff;
        background: rgba(64, 150, 255, 0.18);
      }
    }

    .ncTime,
    .ncEmpty,
    .ncLink.ncDots {
      color: rgba(255, 255, 255, 0.45);
    }

    .ncResolvedTag {
      background: rgba(255, 255, 255, 0.08);
      color: rgba(255, 255, 255, 0.55);
    }

    .ncLink,
    .ncMention {
      color: #69b1ff;
    }

    .ncMenu,
    .ncSuggest,
    .ncEmojiPanel {
      background: #2b2f33;
      border-color: #3a3f45;
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
    }

    .ncMenuItem:hover,
    .ncEmoji:hover,
    .ncPillBtn:hover {
      background: rgba(255, 255, 255, 0.08);
    }

    .ncSuggestItem:hover,
    .ncSuggestItem.active {
      background: rgba(64, 150, 255, 0.18);
    }

    .ncItem + .ncItem,
    .ncComposer {
      border-color: #3a3f45;
    }

    .ncSend {
      background: #4096ff;

      &:hover {
        background: #69b1ff;
      }
    }

    .ncInputPill {
      background: #1f2226;
      border-color: #3a3f45;

      &:focus-within {
        border-color: #4096ff;
        background: #1f2226;
      }
    }

    .ncPillBtn {
      color: rgba(255, 255, 255, 0.55);

      &:hover {
        color: #69b1ff;
      }
    }

    .ncAllItem:hover,
    .ncAllItem.current {
      background: rgba(255, 255, 255, 0.06);
    }

    .ncAllCount {
      background: rgba(64, 150, 255, 0.18);
      color: #69b1ff;
    }
  }
}
</style>
