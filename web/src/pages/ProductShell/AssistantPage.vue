<template>
  <div class="assistantPage">
    <aside class="chatSidebar">
      <button class="newChatBtn" type="button" @click="newChat">
        <i class="el-icon-plus" aria-hidden="true"></i>
        新对话
      </button>
      <div class="chatList customScrollbar">
        <button
          v-for="c in conversations"
          :key="c.id"
          type="button"
          class="chatItem"
          :class="{ active: c.id === activeId }"
          @click="selectChat(c.id)"
        >
          <span class="chatTitle">{{ c.title || '新对话' }}</span>
          <span class="chatMeta">{{ formatTime(c.updatedAt) }}</span>
        </button>
        <p v-if="!conversations.length" class="emptySide">还没有对话</p>
      </div>
      <div class="sideFooter">
        <button type="button" class="linkBtn" @click="showSettings = true">
          连接设置
        </button>
        <a
          class="linkBtn"
          :href="controlUrl"
          target="_blank"
          rel="noopener"
        >
          OpenClaw 原版
        </a>
      </div>
    </aside>

    <section class="chatMain">
      <header class="mainHead">
        <div class="headLeft">
          <strong>助理</strong>
          <span class="statusDot" :class="health.ok ? 'ok' : 'bad'"></span>
          <span class="statusText">{{ healthLabel }}</span>
        </div>
        <div class="headRight">
          <el-select
            v-model="model"
            size="mini"
            filterable
            allow-create
            default-first-option
            placeholder="模型"
            class="modelSelect"
            @change="persistModel"
          >
            <el-option
              v-for="m in models"
              :key="m.id"
              :label="m.name || m.id"
              :value="m.id"
            ></el-option>
          </el-select>
        </div>
      </header>

      <div
        v-if="!activeMessages.length"
        class="hero"
      >
        <h1>有什么可以帮忙的？</h1>
        <p>已接入本机 OpenClaw Gateway，对话会走你的本地助手。</p>
        <div class="suggestRow">
          <button
            v-for="s in suggestions"
            :key="s"
            type="button"
            class="suggest"
            @click="useSuggestion(s)"
          >
            {{ s }}
          </button>
        </div>
      </div>

      <div
        v-else
        ref="msgBox"
        class="msgBox customScrollbar"
      >
        <div
          v-for="(msg, idx) in activeMessages"
          :key="idx"
          class="msgRow"
          :class="msg.role"
        >
          <div class="bubble">
            <div
              v-if="msg.role === 'assistant'"
              class="md"
              v-html="renderMd(msg.content)"
            ></div>
            <div v-else class="plain">{{ msg.content }}</div>
            <span
              v-if="
                sending &&
                  msg.role === 'assistant' &&
                  idx === activeMessages.length - 1
              "
              class="streamCaret"
              aria-hidden="true"
            ></span>
          </div>
        </div>
        <div
          v-if="sending && toolStatusLine"
          class="toolProgress"
        >
          <span class="toolDot" aria-hidden="true"></span>
          <span>{{ toolStatusLine }}</span>
        </div>
        <div
          v-if="sending && !streamingPreview"
          class="msgRow assistant"
        >
          <div class="bubble thinking">生成中…</div>
        </div>
      </div>

      <div class="composerWrap">
        <div v-if="errorText" class="errorBanner">
          {{ errorText }}
          <button type="button" class="linkBtn" @click="showSettings = true">
            去设置
          </button>
        </div>
        <div class="composerShell">
          <div v-if="slashOpen" class="slashMenu" role="listbox">
            <div class="slashHead">
              <span>调用 SOP</span>
              <select
                v-if="spaces.length > 1"
                class="slashSpace"
                :value="sopRoomKey"
                @change="onSlashSpaceChange($event.target.value)"
              >
                <option
                  v-for="s in spaces"
                  :key="s.room_key"
                  :value="s.room_key"
                >
                  {{ s.label }}
                </option>
              </select>
            </div>
            <p v-if="sopLoading" class="slashEmpty">正在加载 SOP…</p>
            <p v-else-if="!sopRoomKey" class="slashEmpty">暂无空间，请先在文件页创建导图</p>
            <p v-else-if="!filteredSops.length" class="slashEmpty">
              {{ slashQuery ? '没有匹配的 SOP' : '该空间暂无「D：」台账 SOP' }}
            </p>
            <button
              v-for="(sop, idx) in filteredSops"
              :key="sop.uid || sop.title + idx"
              type="button"
              class="slashItem"
              :class="{ active: idx === slashIndex }"
              role="option"
              @mousedown.prevent="pickSop(sop)"
              @mouseenter="slashIndex = idx"
            >
              <strong>{{ sopLabel(sop) }}</strong>
              <span v-if="sopPath(sop)" class="slashPath">{{ sopPath(sop) }}</span>
            </button>
          </div>
          <div class="composer">
            <textarea
              v-model="draft"
              rows="1"
              placeholder="发给 OpenClaw… 输入 / 搜索并调用 SOP"
              @keydown="onKeydown"
              @input="onDraftInput"
              ref="input"
            ></textarea>
            <button
              type="button"
              class="sendBtn"
              :disabled="!canSend"
              @click="send"
            >
              <i v-if="!sending" class="el-icon-s-promotion" aria-hidden="true"></i>
              <i v-else class="el-icon-loading" aria-hidden="true"></i>
            </button>
            <button
              v-if="sending"
              type="button"
              class="stopBtn"
              @click="stop"
            >
              停止
            </button>
          </div>
        </div>
        <p class="hint">
          / 调用 SOP · Enter 发送 · Shift+Enter 换行
        </p>
      </div>
    </section>

    <el-dialog
      title="OpenClaw 连接"
      :visible.sync="showSettings"
      width="480px"
      append-to-body
    >
      <el-form label-position="top" size="small">
        <el-form-item label="Gateway 地址（经代理或直连）">
          <el-input v-model="form.baseUrl" placeholder="/openclaw-api"></el-input>
        </el-form-item>
        <el-form-item label="Bearer Token（gateway.auth.token）">
          <el-input
            v-model="form.token"
            type="password"
            show-password
            placeholder="本机 OpenClaw 网关令牌"
          ></el-input>
        </el-form-item>
        <el-form-item label="默认模型">
          <el-input v-model="form.model" placeholder="openclaw/default"></el-input>
        </el-form-item>
      </el-form>
      <p class="setupTip">
        正常情况双击 Start-Docker.bat 会自动写入 Token，无需手工配置。
        仅当自动注入失败时，再填写本机 OpenClaw 的 gateway.auth.token。
      </p>
      <span slot="footer">
        <el-button size="small" @click="showSettings = false">取消</el-button>
        <el-button type="primary" size="small" :loading="saving" @click="saveSettings">
          保存并检测
        </el-button>
      </span>
    </el-dialog>
  </div>
</template>

<script>
import MarkdownIt from 'markdown-it'
import {
  getOpenclawConfig,
  saveOpenclawConfig,
  checkOpenclawHealth,
  listOpenclawModels,
  streamOpenclawChat
} from '@/utils/openclawChat'
import { streamOpenclawGatewayWs } from '@/utils/openclawGatewayWs'
import { listFiles } from '@/utils/fileApi'
import { listRoomDRegistrySops } from '@/utils/sopRegistryPrompt'
import { loadSopRunContext } from '@/utils/sopRun'

const STORE_KEY = 'openclaw.conversations.v1'
const SOP_ROOM_KEY = 'assistant.sopRoom'
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true
})

function uid() {
  return (
    Date.now().toString(36) +
    Math.random()
      .toString(36)
      .slice(2, 8)
  )
}

const TOOL_PROGRESS_LINE =
  /^(?:\[\d+(?:\/\d+)?\]\s*)?([a-zA-Z][\w./:-]{0,64})\s+(start|result|update|end|error|ok|done)\s*$/i

function isToolProgressNoise(text) {
  const s = String(text || '').trim()
  if (!s) return false
  const lines = s
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
  if (!lines.length) return false
  return lines.every(l => TOOL_PROGRESS_LINE.test(l))
}

function parseToolProgressNoise(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(TOOL_PROGRESS_LINE)
    if (m) return { name: m[1], phase: m[2].toLowerCase(), detail: '' }
  }
  return null
}

function stripToolProgressNoise(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter(l => {
      const t = l.trim()
      return t && !TOOL_PROGRESS_LINE.test(t)
    })
    .join('\n')
    .trim()
}

function looksLikePartialToolLine(text) {
  const t = String(text || '').trim()
  if (!t) return false
  if (/[\u4e00-\u9fff]/.test(t)) return false
  return /^[a-zA-Z][\w./:-]{0,64}(?:\s+[a-zA-Z]*)?$/.test(t)
}

function loadStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}')
    return {
      conversations: Array.isArray(raw.conversations) ? raw.conversations : [],
      activeId: raw.activeId || ''
    }
  } catch (e) {
    return { conversations: [], activeId: '' }
  }
}

function saveStore(state) {
  try {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        conversations: state.conversations,
        activeId: state.activeId
      })
    )
  } catch (e) {
    /* ignore */
  }
}

/** 检测输入末尾是否处于 / 命令态，返回 { start, query } */
function detectSlash(text) {
  const value = String(text || '')
  const m = value.match(/(^|\s)\/([^\n]*)$/)
  if (!m) return null
  const query = String(m[2] || '')
  // 已选中 SOP：`/D：标题 `（标题后已有空格）时不再弹出，避免「没有匹配」挡输入
  if (/^D\s*[：:]/i.test(query) && /\s/.test(query)) {
    return null
  }
  const start = value.length - m[0].length + (m[1] ? m[1].length : 0)
  return { start, query }
}

function sopDisplayName(sop) {
  const title = String((sop && sop.title) || '').trim()
  const id = String((sop && sop.id) || 'D').trim() || 'D'
  return title ? `${id}：${title}` : id
}

export default {
  name: 'AssistantPage',
  data() {
    const cfg = getOpenclawConfig()
    const store = loadStore()
    return {
      conversations: store.conversations,
      activeId: store.activeId,
      draft: '',
      sending: false,
      errorText: '',
      health: { ok: false },
      models: [{ id: 'openclaw/default', name: 'openclaw/default' }],
      model: cfg.model || 'openclaw/default',
      controlUrl: cfg.controlUrl,
      showSettings: false,
      saving: false,
      form: {
        baseUrl: cfg.baseUrl,
        token: cfg.token,
        model: cfg.model
      },
      abort: null,
      suggestions: [
        '帮我总结今天要做的事',
        '检查一下本机 OpenClaw 状态',
        '用中文解释一下当前项目结构'
      ],
      spaces: [],
      sopRoomKey: '',
      sopList: [],
      sopLoading: false,
      slashOpen: false,
      slashQuery: '',
      slashStart: -1,
      slashIndex: 0,
      pendingSop: null,
      toolEvents: [],
      toolStatusLine: ''
    }
  },
  computed: {
    healthLabel() {
      if (this.health.ok) return 'OpenClaw 在线'
      return this.health.message || '未连接'
    },
    activeChat() {
      return this.conversations.find(c => c.id === this.activeId) || null
    },
    activeMessages() {
      return (this.activeChat && this.activeChat.messages) || []
    },
    canSend() {
      return !this.sending && String(this.draft || '').trim()
    },
    streamingPreview() {
      const msgs = this.activeMessages
      if (!msgs.length) return false
      const last = msgs[msgs.length - 1]
      return !!(last && last.role === 'assistant' && String(last.content || ''))
    },
    filteredSops() {
      const q = String(this.slashQuery || '')
        .trim()
        .toLowerCase()
      const list = Array.isArray(this.sopList) ? this.sopList : []
      if (!q) return list.slice(0, 40)
      return list
        .filter(sop => {
          const blob = [
            sopDisplayName(sop),
            sop.title,
            sop.id,
            this.sopPath(sop)
          ]
            .join(' ')
            .toLowerCase()
          return blob.includes(q)
        })
        .slice(0, 40)
    }
  },
  mounted() {
    const cfg = getOpenclawConfig()
    // Start-Docker 注入的配置自动同步，无需弹窗手工填写
    if (cfg.fromRuntime && cfg.token) {
      saveOpenclawConfig({
        token: cfg.token,
        baseUrl: cfg.baseUrl,
        model: cfg.model
      })
      this.form.token = cfg.token
      this.form.baseUrl = cfg.baseUrl
      this.form.model = cfg.model
      this.model = cfg.model
    }
    this.refreshHealth()
    this.refreshModels()
    this.bootstrapSops()
    if (!this.activeId && this.conversations.length) {
      this.activeId = this.conversations[0].id
    }
    this.persist()
  },
  beforeDestroy() {
    this.stop()
  },
  methods: {
    persist() {
      saveStore({
        conversations: this.conversations,
        activeId: this.activeId
      })
    },
    formatTime(ts) {
      if (!ts) return ''
      try {
        return new Date(ts).toLocaleString('zh-CN', {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        })
      } catch (e) {
        return ''
      }
    },
    renderMd(text) {
      return md.render(String(text || ''))
    },
    async refreshHealth() {
      this.health = await checkOpenclawHealth()
    },
    async refreshModels() {
      try {
        const list = await listOpenclawModels()
        if (list && list.length) {
          this.models = list.map(m => ({
            id: m.id,
            name: m.name || m.id
          }))
          if (!this.models.some(m => m.id === this.model)) {
            this.model = this.models[0].id
          }
        }
      } catch (err) {
        // 404 = chatCompletions 未开；健康检查仍可能成功
        if (err && err.status === 404) {
          this.errorText =
            'OpenClaw 在线，但未启用 /v1/chat/completions。请开启后重启 Gateway，或使用「OpenClaw 原版」。'
        }
      }
    },
    persistModel() {
      saveOpenclawConfig({ model: this.model })
    },
    newChat() {
      const id = uid()
      this.conversations.unshift({
        id,
        title: '新对话',
        updatedAt: Date.now(),
        messages: []
      })
      this.activeId = id
      this.errorText = ''
      this.persist()
      this.$nextTick(() => {
        if (this.$refs.input) this.$refs.input.focus()
      })
    },
    selectChat(id) {
      this.activeId = id
      this.persist()
      this.scrollBottom()
    },
    ensureChat() {
      if (this.activeChat) return this.activeChat
      this.newChat()
      return this.activeChat
    },
    useSuggestion(text) {
      this.draft = text
      this.send()
    },
    sopLabel(sop) {
      return sopDisplayName(sop)
    },
    sopPath(sop) {
      return String(
        (sop && sop.source && (sop.source.path || sop.source.ref)) || ''
      ).trim()
    },
    async bootstrapSops() {
      try {
        const data = await listFiles({ limit: 200, offset: 0 })
        const list = (data && data.list) || []
        this.spaces = list
          .map(item => {
            const room_key = item.room_key || item.roomKey || ''
            const title = item.title || item.name || ''
            return {
              room_key,
              title,
              label: title && title !== room_key ? `${title}` : room_key
            }
          })
          .filter(s => s.room_key)
        let saved = ''
        try {
          saved = localStorage.getItem(SOP_ROOM_KEY) || ''
        } catch (e) {
          saved = ''
        }
        const fromQuery =
          (this.$route && this.$route.query && this.$route.query.room) || ''
        const pick =
          [fromQuery, saved]
            .map(s => String(s || '').trim())
            .find(k => this.spaces.some(s => s.room_key === k)) ||
          (this.spaces[0] && this.spaces[0].room_key) ||
          ''
        if (pick) await this.loadSopsForRoom(pick)
      } catch (err) {
        console.warn('[assistant] load spaces failed', err)
      }
    },
    async loadSopsForRoom(roomKey) {
      const key = String(roomKey || '').trim()
      this.sopRoomKey = key
      if (!key) {
        this.sopList = []
        return
      }
      try {
        localStorage.setItem(SOP_ROOM_KEY, key)
      } catch (e) {
        /* ignore */
      }
      this.sopLoading = true
      try {
        const result = await listRoomDRegistrySops(key)
        this.sopList = Array.isArray(result.sops) ? result.sops : []
      } catch (err) {
        console.warn('[assistant] load sops failed', err)
        this.sopList = []
      } finally {
        this.sopLoading = false
        this.slashIndex = 0
      }
    },
    onSlashSpaceChange(roomKey) {
      this.loadSopsForRoom(roomKey)
    },
    onDraftInput() {
      this.autoGrow()
      this.updateSlashState()
    },
    updateSlashState() {
      const hit = detectSlash(this.draft)
      if (!hit) {
        this.slashOpen = false
        this.slashQuery = ''
        this.slashStart = -1
        return
      }
      this.slashOpen = true
      this.slashQuery = hit.query
      this.slashStart = hit.start
      this.slashIndex = 0
      if (!this.sopList.length && this.sopRoomKey && !this.sopLoading) {
        this.loadSopsForRoom(this.sopRoomKey)
      } else if (!this.sopRoomKey && !this.sopLoading) {
        this.bootstrapSops()
      }
    },
    pickSop(sop) {
      if (!sop) return
      const label = sopDisplayName(sop)
      const before =
        this.slashStart >= 0
          ? String(this.draft || '').slice(0, this.slashStart)
          : String(this.draft || '')
      // 末尾空格：既方便继续写需求，也让 detectSlash 立刻关闭菜单
      const insert = `/${label} `
      this.draft = before + insert
      this.pendingSop = {
        ...sop,
        roomKey: this.sopRoomKey
      }
      this.slashOpen = false
      this.slashQuery = ''
      this.slashStart = -1
      this.$nextTick(() => {
        this.autoGrow()
        this.updateSlashState()
        if (this.$refs.input) this.$refs.input.focus()
      })
    },
    onKeydown(e) {
      if (this.slashOpen) {
        if (e.key === 'ArrowDown' || e.keyCode === 40) {
          e.preventDefault()
          if (!this.filteredSops.length) return
          this.slashIndex = (this.slashIndex + 1) % this.filteredSops.length
          return
        }
        if (e.key === 'ArrowUp' || e.keyCode === 38) {
          e.preventDefault()
          if (!this.filteredSops.length) return
          this.slashIndex =
            (this.slashIndex - 1 + this.filteredSops.length) %
            this.filteredSops.length
          return
        }
        if (e.key === 'Escape' || e.keyCode === 27) {
          e.preventDefault()
          this.slashOpen = false
          return
        }
        if (
          (e.key === 'Enter' || e.keyCode === 13) &&
          !e.shiftKey &&
          this.filteredSops.length
        ) {
          e.preventDefault()
          this.pickSop(this.filteredSops[this.slashIndex])
          return
        }
        if (e.key === 'Tab' || e.keyCode === 9) {
          if (this.filteredSops.length) {
            e.preventDefault()
            this.pickSop(this.filteredSops[this.slashIndex])
          }
          return
        }
      }
      if (e.keyCode === 13 && !e.shiftKey) {
        e.preventDefault()
        this.send()
      }
    },
    autoGrow() {
      const el = this.$refs.input
      if (!el) return
      el.style.height = 'auto'
      el.style.height = Math.min(el.scrollHeight, 160) + 'px'
    },
    resolveSopFromDraft(text) {
      const raw = String(text || '')
      if (this.pendingSop) return this.pendingSop
      const m = raw.match(/(^|\s)\/(D)\s*[：:]\s*/i)
      if (!m) return null
      const after = raw.slice(m.index + m[0].length)
      // 用已加载列表做最长标题前缀匹配，避免把「读取一下…」也吞进标题
      let best = null
      let bestLen = 0
      ;(this.sopList || []).forEach(s => {
        const title = String((s && s.title) || '').trim()
        if (!title) return
        if (after === title || after.startsWith(title + ' ') || after.startsWith(title + '\n')) {
          if (title.length > bestLen) {
            best = s
            bestLen = title.length
          }
        }
      })
      if (best) {
        return { ...best, roomKey: this.sopRoomKey }
      }
      // 未命中列表：只取冒号后到第一个空白前，或整段到行尾（无空格时）
      const loose = after.match(/^([^\s\n]+)(?:\s+|$)/)
      const title = String((loose && loose[1]) || after)
        .trim()
        .slice(0, 80)
      if (!title) return null
      return {
        id: 'D',
        title,
        roomKey: this.sopRoomKey
      }
    },
    splitUserNote(userText, sop) {
      const raw = String(userText || '')
      const label = sopDisplayName(sop)
      // 去掉已插入的 /D：标题
      let rest = raw
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      rest = rest.replace(new RegExp('(^|\\s)/' + escaped + '\\s*', 'i'), '$1')
      const title = String((sop && sop.title) || '').trim()
      if (title) {
        const t = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        rest = rest.replace(new RegExp('(^|\\s)/D\\s*[：:]\\s*' + t + '\\s*', 'i'), '$1')
      }
      rest = rest.replace(/(^|\s)\/D\s*[：:]\s*/i, '$1').trim()
      return rest
    },
    formatToolStatus(info) {
      const raw = String((info && info.name) || 'tool')
      const phase = String((info && info.phase) || '').toLowerCase()
      // 忽略中间 update，避免刷屏
      if (phase === 'update') return ''
      const map = {
        read: '读取文件',
        exec: '执行命令',
        process: '查看进程',
        write: '写入文件',
        memory_search: '搜索记忆',
        sessions_search: '搜索会话',
        wecom_mcp: '企业微信',
        web_search: '联网搜索'
      }
      let label = map[raw]
      if (!label) {
        if (/todo/i.test(raw)) label = '待办'
        else if (/^mcp/i.test(raw)) label = 'MCP 工具'
        else label = raw.replace(/^mcp[-_]+/i, '').slice(0, 28)
      }
      if (phase === 'start') return `正在${label}…`
      if (phase === 'result' || phase === 'end' || phase === 'done') {
        return `${label}完成`
      }
      return label
    },
    async buildSopPrompt(userText, sop) {
      const roomKey = (sop && sop.roomKey) || this.sopRoomKey
      let ctx = null
      try {
        ctx = await loadSopRunContext(roomKey, sop)
      } catch (err) {
        console.warn('[assistant] sop context failed', err)
      }
      const label = sopDisplayName(sop)
      const rest = this.splitUserNote(userText, sop)
      const wantRead =
        !rest ||
        /读取|看一下|什么内容|讲讲|解释|总结|大纲|是什么|了解/.test(rest)
      const wantRun = /执行|运行|派发|发待办|发给|创建待办|开始跑|按SOP做/.test(
        rest
      )
      const modeHint = wantRun
        ? '用户明确要求执行/派发。可调用工具完成，但先简要确认对应的是哪条 SOP。'
        : wantRead
          ? [
              '用户主要想了解这条 SOP 的内容。',
              '请【只】基于下方「SOP 子树 / 大纲上下文」解读；那就是良策注入的全部定义。',
              '禁止为了找 SOP 正文去搜本机文件、记忆库、会话历史；那些地方通常没有。',
              '若大纲只有标题/很少节点，就如实说「台账里目前只有这些」，不要假装去别处翻定义。',
              '除非用户明确要求，否则不要发企微待办或改外部系统。'
            ].join('')
          : '优先结合下方 SOP 大纲回答；只有用户明确要求执行时才调用外部工具。禁止为找 SOP 定义去搜本机文件。'
      const answerHint = wantRead
        ? '回答要求：用中文直接概括这条 SOP 是做什么的；若有子步骤则列出；不要先跑一堆搜索工具再回答。'
        : '回答要求：先用中文说明要做什么；需要工具时用一两句中文说明进度即可（不要输出工具内部 phase 名）。'
      return [
        `用户在良策助理页通过 / 选中了台账 SOP「${label}」。`,
        modeHint,
        roomKey ? `房间：${roomKey}` : '',
        sop && sop.uid ? `节点 uid：${sop.uid}` : '',
        ctx && ctx.source ? `大纲来源：${ctx.source}` : '',
        rest ? `\n用户补充说明：\n${rest}` : '\n用户补充说明：（无，默认解读 SOP 内容）',
        '',
        '## SOP 子树 / 大纲上下文（权威来源，勿另找）',
        (ctx && ctx.outline) || '（未拉到大纲。请如实说明，不要编造步骤，也不要去本机搜索。）',
        '',
        answerHint
      ]
        .filter(Boolean)
        .join('\n')
    },
    scrollBottom() {
      this.$nextTick(() => {
        const box = this.$refs.msgBox
        if (box) box.scrollTop = box.scrollHeight
      })
    },
    stop() {
      if (this.abort) {
        this.abort.abort()
        this.abort = null
      }
      this.sending = false
      this.toolStatusLine = ''
    },
    async saveSettings() {
      this.saving = true
      try {
        saveOpenclawConfig(this.form)
        this.model = this.form.model || this.model
        this.errorText = ''
        await this.refreshHealth()
        await this.refreshModels()
        if (this.health.ok) {
          this.$message.success('已连接 OpenClaw')
          this.showSettings = false
        } else {
          this.$message.warning(this.health.message || '连接失败')
        }
      } finally {
        this.saving = false
      }
    },
    async send() {
      const text = String(this.draft || '').trim()
      if (!text || this.sending) return
      this.slashOpen = false
      const sop = this.resolveSopFromDraft(text)
      const chat = this.ensureChat()
      chat.messages.push({ role: 'user', content: text })
      if (!chat.title || chat.title === '新对话') {
        chat.title = text.slice(0, 28)
      }
      chat.updatedAt = Date.now()
      this.draft = ''
      this.pendingSop = null
      this.autoGrow()
      this.persist()
      this.scrollBottom()

      const assistant = { role: 'assistant', content: '' }
      chat.messages.push(assistant)
      this.sending = true
      this.toolEvents = []
      this.toolStatusLine = ''
      this.errorText = ''
      this.abort = typeof AbortController !== 'undefined' ? new AbortController() : null

      try {
        let apiMessages = chat.messages
          .slice(0, -1)
          .map(m => ({ role: m.role, content: m.content }))
        let promptText = text
        if (sop) {
          promptText = await this.buildSopPrompt(text, sop)
          apiMessages = apiMessages.slice(0, -1).concat([
            { role: 'user', content: promptText }
          ])
        }
        let lineBuf = ''
        const onDelta = delta => {
          const raw = String(delta || '')
          if (!raw) return
          lineBuf += raw
          const parts = lineBuf.split(/\r?\n/)
          lineBuf = parts.pop() || ''
          let added = ''
          for (const part of parts) {
            const line = part
            const probe = line.trim()
            if (probe && isToolProgressNoise(probe)) {
              const info = parseToolProgressNoise(probe)
              if (info && !assistant.content && !added) {
                const status = this.formatToolStatus(info)
                if (status) this.toolStatusLine = status
              }
              continue
            }
            added += line + '\n'
          }
          // 未完成的一行：像工具日志则先憋住；中文/正常句子立刻输出
          if (lineBuf) {
            if (isToolProgressNoise(lineBuf)) {
              const info = parseToolProgressNoise(lineBuf)
              if (info && !assistant.content && !added) {
                const status = this.formatToolStatus(info)
                if (status) this.toolStatusLine = status
              }
            } else if (!looksLikePartialToolLine(lineBuf)) {
              added += lineBuf
              lineBuf = ''
            }
          }
          if (!added) {
            this.scrollBottom()
            return
          }
          const next = String(assistant.content || '') + added
          this.$set(assistant, 'content', next)
          if (next) this.toolStatusLine = ''
          chat.updatedAt = Date.now()
          this.scrollBottom()
        }
        try {
          // 方案 3：Gateway WS（经 bridge）— 可带工具进度
          await streamOpenclawGatewayWs({
            conversationId: chat.id,
            message: promptText,
            signal: this.abort && this.abort.signal,
            onDelta,
            onTool: info => {
              const line = this.formatToolStatus(info)
              if (!line) return
              this.toolEvents.push({
                name: info.name || 'tool',
                phase: info.phase || '',
                detail: info.detail || ''
              })
              // 尚无正文时才显示一行紧凑进度；有正文则以气泡流式为准
              if (!assistant.content) this.toolStatusLine = line
              this.scrollBottom()
            }
          })
        } catch (wsErr) {
          if (wsErr && wsErr.name === 'AbortError') throw wsErr
          // Bridge 不可用时回退 HTTP SSE
          await streamOpenclawChat({
            conversationId: chat.id,
            model: this.model,
            messages: apiMessages,
            signal: this.abort && this.abort.signal,
            onDelta
          })
        }
        if (!assistant.content && lineBuf && !isToolProgressNoise(lineBuf)) {
          this.$set(assistant, 'content', lineBuf)
          lineBuf = ''
        }
        if (!assistant.content) {
          assistant.content = '（无内容返回）'
        } else {
          const cleaned = stripToolProgressNoise(assistant.content)
          if (cleaned !== assistant.content) {
            this.$set(assistant, 'content', cleaned || '（无内容返回）')
          }
        }
        this.persist()
      } catch (err) {
        if (err && err.name === 'AbortError') {
          if (!assistant.content) assistant.content = '（已停止）'
        } else {
          const msg = (err && err.message) || '发送失败'
          this.errorText = msg
          if (!assistant.content) {
            chat.messages.pop()
          }
          if (err && err.status === 404) {
            this.errorText =
              '未启用 OpenClaw Chat Completions（/v1/chat/completions）。请开启后重启，或打开「OpenClaw 原版」。'
          } else if (err && err.status === 401) {
            this.errorText =
              '鉴权失败。请重新运行 Start-Docker.bat 自动注入 Token，或点「连接设置」手动填写。'
            if (!getOpenclawConfig().token) this.showSettings = true
          } else if (
            err &&
            (err.status === 502 || err.status === 503 || err.status === 504)
          ) {
            this.errorText =
              '连不上 OpenClaw（HTTP ' +
              err.status +
              '）。请先在本机启动 Gateway（默认端口 4623），再刷新本页。'
          }
        }
      } finally {
        this.sending = false
        this.toolEvents = []
        this.toolStatusLine = ''
        this.abort = null
        chat.updatedAt = Date.now()
        this.persist()
        this.scrollBottom()
      }
    }
  }
}
</script>

<style lang="less" scoped>
.assistantPage {
  --ink: #1a1a1a;
  --muted: #6b6b6b;
  --line: #e8e8e8;
  --side: #f7f7f8;
  --accent: #10a37f;
  display: flex;
  height: calc(100vh - 0px);
  min-height: 560px;
  background: #fff;
  color: var(--ink);
  font-family: 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
}

.chatSidebar {
  width: 260px;
  flex-shrink: 0;
  background: var(--side);
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  padding: 12px;
}

.newChatBtn {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  border: 1px solid var(--line);
  background: #fff;
  border-radius: 10px;
  padding: 10px 12px;
  cursor: pointer;
  font-size: 14px;
  color: var(--ink);
  &:hover {
    background: #f0f0f0;
  }
}

.chatList {
  flex: 1;
  overflow: auto;
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.chatItem {
  text-align: left;
  border: 0;
  background: transparent;
  border-radius: 10px;
  padding: 10px 12px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 4px;
  &.active,
  &:hover {
    background: #ececf1;
  }
  .chatTitle {
    font-size: 13px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .chatMeta {
    font-size: 11px;
    color: var(--muted);
  }
}

.emptySide {
  color: var(--muted);
  font-size: 13px;
  padding: 16px 8px;
}

.sideFooter {
  display: flex;
  gap: 12px;
  padding-top: 8px;
  border-top: 1px solid var(--line);
}

.linkBtn {
  border: 0;
  background: none;
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
  text-decoration: none;
  padding: 0;
  &:hover {
    color: var(--ink);
  }
}

.chatMain {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}

.mainHead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  border-bottom: 1px solid var(--line);
  .headLeft {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 15px;
  }
  .statusDot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #ccc;
    &.ok {
      background: var(--accent);
    }
    &.bad {
      background: #e11d48;
    }
  }
  .statusText {
    font-size: 12px;
    color: var(--muted);
    font-weight: 400;
  }
}

.modelSelect {
  width: 200px;
}

.hero {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24px;
  text-align: center;
  h1 {
    margin: 0 0 10px;
    font-size: 32px;
    font-weight: 600;
    letter-spacing: -0.02em;
  }
  p {
    margin: 0 0 28px;
    color: var(--muted);
    font-size: 14px;
  }
}

.suggestRow {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  justify-content: center;
  max-width: 720px;
}

.suggest {
  border: 1px solid var(--line);
  background: #fff;
  border-radius: 14px;
  padding: 12px 14px;
  font-size: 13px;
  color: var(--ink);
  cursor: pointer;
  &:hover {
    background: var(--side);
  }
}

.msgBox {
  flex: 1;
  overflow: auto;
  padding: 24px 16px 12px;
}

.msgRow {
  max-width: 760px;
  margin: 0 auto 18px;
  &.user .bubble {
    background: #f4f4f4;
    margin-left: auto;
  }
  &.assistant .bubble {
    background: transparent;
    padding-left: 0;
    padding-right: 0;
  }
}

.bubble {
  display: inline-block;
  max-width: 100%;
  padding: 12px 14px;
  border-radius: 18px;
  font-size: 15px;
  line-height: 1.65;
  word-break: break-word;
  &.thinking {
    color: var(--muted);
  }
}

.toolProgress {
  max-width: 800px;
  margin: 0 auto 10px;
  padding: 6px 12px;
  border-radius: 999px;
  background: #f6f7f8;
  border: 1px solid var(--line);
  font-size: 12px;
  color: var(--muted);
  display: inline-flex;
  align-items: center;
  gap: 8px;
  width: fit-content;
  max-width: calc(100% - 24px);
}
.toolDot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #6b7280;
  flex-shrink: 0;
  animation: toolPulse 1s ease-in-out infinite;
}
@keyframes toolPulse {
  0%,
  100% {
    opacity: 0.35;
  }
  50% {
    opacity: 1;
  }
}

.streamCaret {
  display: inline-block;
  width: 7px;
  height: 1em;
  margin-left: 2px;
  vertical-align: text-bottom;
  background: var(--ink);
  animation: streamBlink 1s step-end infinite;
}

@keyframes streamBlink {
  50% {
    opacity: 0;
  }
}

.plain {
  white-space: pre-wrap;
}

.md {
  /deep/ p {
    margin: 0 0 0.75em;
  }
  /deep/ p:last-child {
    margin-bottom: 0;
  }
  /deep/ pre {
    background: #f6f6f6;
    padding: 12px;
    border-radius: 10px;
    overflow: auto;
  }
  /deep/ code {
    font-family: Consolas, 'Courier New', monospace;
    font-size: 13px;
  }
}

.composerWrap {
  padding: 8px 16px 18px;
  max-width: 800px;
  width: 100%;
  margin: 0 auto;
  box-sizing: border-box;
}

.composerShell {
  position: relative;
}

.slashMenu {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(100% + 8px);
  max-height: 280px;
  overflow: auto;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 14px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.12);
  z-index: 20;
  padding: 6px;
}

.slashHead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px 8px;
  font-size: 12px;
  color: var(--muted);
  border-bottom: 1px solid var(--line);
  margin-bottom: 4px;
}

.slashSpace {
  max-width: 55%;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 2px 6px;
  font-size: 12px;
  background: #fff;
  color: var(--ink);
}

.slashEmpty {
  margin: 0;
  padding: 16px 12px;
  font-size: 13px;
  color: var(--muted);
  text-align: center;
}

.slashItem {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  width: 100%;
  border: 0;
  background: transparent;
  border-radius: 10px;
  padding: 10px 12px;
  cursor: pointer;
  text-align: left;
  color: var(--ink);
  strong {
    font-size: 14px;
    font-weight: 600;
  }
  &.active,
  &:hover {
    background: #f3f4f6;
  }
}

.slashPath {
  font-size: 12px;
  color: var(--muted);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.errorBanner {
  background: #fff1f2;
  color: #9f1239;
  border-radius: 10px;
  padding: 10px 12px;
  font-size: 13px;
  margin-bottom: 8px;
  display: flex;
  gap: 10px;
  align-items: center;
  justify-content: space-between;
}

.composer {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  border: 1px solid var(--line);
  border-radius: 24px;
  padding: 10px 12px 10px 16px;
  background: #fff;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.04);
  textarea {
    flex: 1;
    border: 0;
    outline: none;
    resize: none;
    font-size: 15px;
    line-height: 1.5;
    max-height: 160px;
    font-family: inherit;
    background: transparent;
  }
}

.sendBtn,
.stopBtn {
  border: 0;
  border-radius: 999px;
  width: 36px;
  height: 36px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.sendBtn {
  background: var(--ink);
  color: #fff;
  &:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }
}
.stopBtn {
  width: auto;
  padding: 0 12px;
  background: #fff1f2;
  color: #9f1239;
  font-size: 12px;
}

.hint {
  margin: 8px 0 0;
  text-align: center;
  font-size: 12px;
  color: var(--muted);
}

.setupTip {
  font-size: 12px;
  color: var(--muted);
  line-height: 1.5;
  code {
    font-size: 11px;
    background: #f4f4f4;
    padding: 1px 4px;
    border-radius: 4px;
  }
}

@media (max-width: 800px) {
  .chatSidebar {
    width: 72px;
    .chatTitle,
    .chatMeta,
    .sideFooter,
    .newChatBtn span {
      display: none;
    }
    .newChatBtn {
      justify-content: center;
    }
  }
  .hero h1 {
    font-size: 24px;
  }
}
</style>
