<template>
  <el-dialog
    class="cooperateDialog"
    :custom-class="'cooperateDialogShell' + (isDark ? ' isDark' : '')"
    :title="$t('cooperate.title')"
    :visible.sync="dialogVisible"
    width="720px"
    append-to-body
  >
    <div class="cooperateBox" :class="{ isDark: isDark }">
      <div class="statusBar">
        <span class="statusDot" :class="status"></span>
        <span class="statusLabel">{{ statusText }}</span>
        <span
          v-if="connected"
          class="saveState"
          :class="saveStatus"
          :title="saveError"
          >{{ saveStatusText }}</span
        >
        <span v-if="peerList.length" class="peerCount"
          >{{ $t('cooperate.peers') }} {{ peerList.length }}</span
        >
      </div>
      <div class="peerList" v-if="peerList.length">
        <div class="peer" v-for="peer in peerList" :key="peer.id">
          <span class="avatar" :style="{ background: peer.color }">{{
            peer.shortName
          }}</span>
          <span class="name">{{ peer.name }}</span>
          <span class="you" v-if="peer.isMe">{{ $t('cooperate.you') }}</span>
        </div>
      </div>

      <section class="filePanel">
        <div class="fileHead">
          <div class="fileHeadTitle">
            <span>{{ $t('cooperate.files') }}</span>
            <span class="fileCount">{{
              $t('cooperate.fileCount', { count: fileTotal })
            }}</span>
          </div>
          <el-button type="text" :disabled="filesLoading" @click="loadFiles">{{
            $t('cooperate.refresh')
          }}</el-button>
        </div>
        <el-input
          v-model.trim="fileQuery"
          class="fileSearch"
          size="small"
          clearable
          prefix-icon="el-icon-search"
          :placeholder="$t('cooperate.searchFiles')"
          @keydown.native.stop
        ></el-input>
        <div class="fileList">
          <div v-if="filesLoading" class="fileSkeleton">
            <div class="fileSkeletonRow" v-for="n in 4" :key="'sk-' + n"></div>
          </div>
          <div
            class="empty"
            v-else-if="!fileList.length"
          >
            {{
              fileQuery
                ? $t('cooperate.emptySearch', { q: fileQuery })
                : $t('cooperate.noFiles')
            }}
          </div>
          <template v-else>
            <div
              class="fileItem"
              v-for="item in fileList"
              :key="item.room_key"
              :class="{ current: connected && roomName === item.room_key }"
              @dblclick="openFile(item)"
            >
            <div class="fileMeta">
              <div class="fileTitle">
                {{ item.title }}
                <span
                  v-if="connected && roomName === item.room_key"
                  class="currentTag"
                  >{{ $t('cooperate.currentRoom') }}</span
                >
              </div>
              <div class="fileTime">{{ formatTime(item.updated_at) }}</div>
            </div>
            <div class="fileActions" @click.stop>
              <el-button type="text" @click="openFile(item)">{{
                $t('cooperate.openFile')
              }}</el-button>
              <el-button type="text" @click="renameSavedFile(item)">{{
                $t('cooperate.renameFile')
              }}</el-button>
              <el-button
                type="text"
                class="danger"
                @click="removeSavedFile(item)"
                >{{ $t('cooperate.deleteFile') }}</el-button
              >
            </div>
            </div>
          </template>
        </div>
        <div class="filePager" v-if="fileTotal > filePageSize">
          <el-pagination
            small
            layout="total, prev, pager, next"
            :page-size="filePageSize"
            :current-page="filePage"
            :total="fileTotal"
            @current-change="onFilePageChange"
          ></el-pagination>
        </div>
      </section>

      <el-form class="joinForm" label-width="88px" size="small" @submit.native.prevent>
        <el-form-item :label="$t('cooperate.userName')" required>
          <el-input
            v-model.trim="userName"
            :placeholder="$t('cooperate.userNamePlaceholder')"
            maxlength="20"
            @keydown.native.stop
          ></el-input>
        </el-form-item>
        <el-form-item :label="$t('cooperate.roomName')" required>
          <el-input
            v-model.trim="roomName"
            :placeholder="$t('cooperate.roomNamePlaceholder')"
            maxlength="40"
            :disabled="connected || connecting"
            @keydown.native.stop
          >
            <el-button
              slot="append"
              :disabled="connected || connecting"
              @click="createRoom"
              >{{ $t('cooperate.newRoom') }}</el-button
            >
          </el-input>
        </el-form-item>
      </el-form>

      <button
        class="advancedToggle"
        type="button"
        @click="showAdvanced = !showAdvanced"
      >
        {{ $t('cooperate.advanced') }}
        <i :class="showAdvanced ? 'el-icon-arrow-up' : 'el-icon-arrow-down'"></i>
      </button>
      <div class="advancedBox" v-show="showAdvanced">
        <p class="hint">{{ $t('cooperate.tip') }}</p>
        <p class="hint">{{ $t('cooperate.startServerTip') }}</p>
        <el-form label-width="88px" size="small" @submit.native.prevent>
          <el-form-item :label="$t('cooperate.serverUrl')" required>
            <el-input
              v-model.trim="serverUrl"
              :placeholder="$t('cooperate.serverUrlPlaceholder')"
              :disabled="connected || connecting"
              @keydown.native.stop
            ></el-input>
          </el-form-item>
        </el-form>
      </div>

      <section class="historyPanel" v-if="connected">
        <div class="fileHead">
          <span>{{ $t('cooperate.history') }}</span>
          <el-button type="text" @click="loadHistory">{{
            $t('cooperate.refresh')
          }}</el-button>
        </div>
        <div class="empty" v-if="!historyList.length && !historyLoading">
          {{ $t('cooperate.noHistory') }}
        </div>
        <div
          class="historyItem"
          v-for="item in filteredHistory"
          :key="item.operationId"
        >
          <span class="historyMeta">
            v{{ item.version }} · {{ item.type }} · {{ item.actorId }}
          </span>
          <el-button
            v-if="canUndoHistoryItem(item)"
            type="text"
            @click="undoHistoryItem(item)"
            >{{ $t('toolbar.undo') }}</el-button
          >
        </div>
        <div class="filePager" v-if="historyList.length > historyPageSize">
          <el-pagination
            small
            layout="prev, pager, next"
            :page-size="historyPageSize"
            :current-page.sync="historyPage"
            :total="historyList.length"
          ></el-pagination>
        </div>
      </section>
    </div>
    <div slot="footer" class="dialog-footer">
      <el-button @click="copyInvite" :disabled="!roomName">{{
        $t('cooperate.copyInvite')
      }}</el-button>
      <el-button v-if="connected" @click="leave">{{
        $t('cooperate.leave')
      }}</el-button>
      <el-button
        type="primary"
        :loading="connecting"
        @click="joinFromDialog"
        v-else
        >{{ $t('cooperate.join') }}</el-button
      >
    </div>
  </el-dialog>
</template>

<script>
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { mapMutations, mapState } from 'vuex'
import { getRuntimeConfig } from '@/utils/runtimeConfig'
import { getCurrentUser } from '@/utils/auth'
import { roomFromLocation } from '@/utils/roomLocation'
import {
  listFiles,
  createFile as createFileApi,
  renameFile as renameFileApi,
  deleteFile as deleteFileApi,
  getSaveStatus,
  beatPresence,
  leavePresence,
  getFilePreview,
  getFileSubtree,
  getFileExport,
  locateFileNode,
  getFileNodes,
  getMapVersion,
  getMapOperations,
  getMapAudit,
  undoMapOperation,
  redoMapOperation,
  addFileNode,
  patchFileNode,
  deleteFileNode,
  replaceFileTree
} from '@/utils/fileApi'
import { countNodes, stubImportedTree } from '@/utils/importTree'

const USER_NAME_KEY = 'COOPERATE_USER_NAME'
const USER_ID_KEY = 'COOPERATE_USER_ID'
const USER_COLORS = [
  '#409EFF',
  '#67C23A',
  '#E6A23C',
  '#F56C6C',
  '#909399',
  '#9B59B6',
  '#1ABC9C',
  '#E67E22'
]

const createId = () => {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID()
  return 'u-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

const defaultGuestName = userId => {
  const suffix = String(userId)
    .replace(/-/g, '')
    .slice(-4)
    .toLowerCase()
  return '访客' + suffix
}

const defaultServerUrl = () => {
  return getRuntimeConfig().collabUrl
}

export default {
  props: {
    mindMap: {
      type: Object,
      default: null
    }
  },
  data() {
    return {
      dialogVisible: false,
      userName: '',
      roomName: '',
      serverUrl: defaultServerUrl(),
      connecting: false,
      connected: false,
      userId: '',
      userColor: USER_COLORS[0],
      peerList: [],
      provider: null,
      connectTimer: null,
      saveStatusTimer: null,
      saveStatusInFlight: false,
      presenceTimer: null,
      presenceQuickTimer: null,
      presenceSyncInFlight: false,
      presenceSyncQueued: false,
      saveStatus: 'idle',
      saveError: '',
      lastConnectErrorAt: 0,
      reconnectNoticeTimer: null,
      joinedOnce: false,
      fileList: [],
      filesLoading: false,
      fileQuery: '',
      filePage: 1,
      filePageSize: 8,
      fileTotal: 0,
      showAdvanced: false,
      httpCollab: false,
      historyList: [],
      historyLoading: false,
      historyPage: 1,
      historyPageSize: 8
    }
  },
  computed: {
    ...mapState({
      isDark: state => state.localConfig.isDark
    }),
    status() {
      if (this.connecting) return 'connecting'
      if (this.connected) return 'connected'
      return 'disconnected'
    },
    statusText() {
      if (this.httpCollab && this.connected) {
        return this.$t('cooperate.largeMapMode')
      }
      return this.$t(`cooperate.${this.status}`)
    },
    saveStatusText() {
      const status = ['saving', 'saved', 'saveError'].includes(this.saveStatus)
        ? this.saveStatus
        : 'saving'
      return this.$t(`cooperate.${status}`)
    },
    filteredHistory() {
      const start = (this.historyPage - 1) * this.historyPageSize
      return this.historyList.slice(start, start + this.historyPageSize)
    }
  },
  watch: {
    mindMap(val) {
      if (val) this.tryAutoJoin()
    },
    fileQuery() {
      this.filePage = 1
      this.scheduleFileSearch()
    }
  },
  created() {
    const authenticatedUser = getCurrentUser()
    this.userId = authenticatedUser
      ? `wecom:${authenticatedUser.id}`
      : localStorage.getItem(USER_ID_KEY) || createId()
    localStorage.setItem(USER_ID_KEY, this.userId)
    this.userName = authenticatedUser
      ? authenticatedUser.name
      : this.$route.query.userName ||
        localStorage.getItem(USER_NAME_KEY) ||
        defaultGuestName(this.userId)
    localStorage.setItem(USER_NAME_KEY, this.userName)
    this.roomName = roomFromLocation(this.$route) || ''
    this.userColor =
      USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)]
    this.$bus.$on('showCooperate', this.open)
    this._seenHttpChanges = new Map()
    this._unsubCollabStore = null
  },
  mounted() {
    this.tryAutoJoin()
  },
  beforeDestroy() {
    this.$bus.$off('showCooperate', this.open)
    this.stopSaveStatusPolling()
    this.clearReconnectNotice()
    this.unbindCollabStore()
    this.unbindProvider()
    if (this._fileSearchTimer) {
      clearTimeout(this._fileSearchTimer)
      this._fileSearchTimer = null
    }
  },
  methods: {
    ...mapMutations(['setCooperateStatus']),

    mapCollabStoreStatus(status) {
      if (status === 'live' || status === 'recovering') return 'connected'
      if (status === 'connecting') return 'connecting'
      return 'disconnected'
    },

    bindCollabStore() {
      this.unbindCollabStore()
      const cooperate = this.mindMap && this.mindMap.cooperate
      if (!cooperate || typeof cooperate.subscribeCollaboration !== 'function') {
        return
      }
      this._unsubCollabStore = cooperate.subscribeCollaboration(snap => {
        this.setCooperateStatus(this.mapCollabStoreStatus(snap.status))
      })
      const snap = cooperate.getCollaborationSnapshot()
      if (snap) this.setCooperateStatus(this.mapCollabStoreStatus(snap.status))
    },

    unbindCollabStore() {
      if (typeof this._unsubCollabStore === 'function') {
        this._unsubCollabStore()
      }
      this._unsubCollabStore = null
    },

    open() {
      this.dialogVisible = true
      this.filePage = 1
      this.loadFiles()
      // Do not auto-join / auto-create here. Opening the dialog used to call
      // openSavedRoom with a random roomName, which created "未命名" rooms.
    },

    createRoom() {
      this.createBlankRoom()
    },

    async createBlankRoom() {
      try {
        const { value } = await this.$prompt(
          this.$t('cooperate.roomTitlePlaceholder'),
          this.$t('cooperate.newRoom'),
          {
            inputValue: this.$t('cooperate.unnamed'),
            inputValidator: val => !!String(val || '').trim()
          }
        )
        const title =
          String(value || '')
            .trim()
            .slice(0, 80) || this.$t('cooperate.unnamed')
        if (this.connected) this.leave({ silent: true })
        const created = await createFileApi({ title })
        this.roomName = created.room_key
        this.syncRoomQuery()
        await this.openSavedRoom({ silent: false, createIfMissing: true })
        this.loadFiles()
      } catch (err) {
        if (err === 'cancel' || err === 'close') return
        this.$message.error(err.message || this.$t('cooperate.createFailed'))
      }
    },

    tryAutoJoin() {
      if (!this.mindMap || this.connected || this.connecting) return
      const room = roomFromLocation(this.$route)
      if (!room) return
      if (this._autoJoinScheduled) return
      this._autoJoinScheduled = true
      this.roomName = room
      this.openSavedRoom({ silent: true })
    },

    validate() {
      if (!this.userName) {
        this.$message.warning(this.$t('cooperate.userNameRequired'))
        return false
      }
      if (!this.roomName) {
        this.$message.warning(this.$t('cooperate.roomRequired'))
        return false
      }
      if (!/^[a-zA-Z0-9._-]{1,80}$/.test(this.roomName)) {
        this.$message.warning(this.$t('cooperate.roomInvalid'))
        return false
      }
      if (!this.serverUrl) {
        this.$message.warning(this.$t('cooperate.serverRequired'))
        return false
      }
      if (!this.mindMap || !this.mindMap.cooperate) {
        this.$message.error(this.$t('cooperate.pluginMissing'))
        return false
      }
      return true
    },

    joinFromDialog() {
      this.openSavedRoom({ silent: false, force: true })
    },

    deferJoin() {
      if (this.httpCollab) return
      const run = () => {
        this.join({ silent: true })
      }
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(run, { timeout: 2500 })
        return
      }
      setTimeout(run, 400)
    },

    join(options = {}) {
      const silent = !!options.silent
      if (!this.validate() || this.connected || this.connecting) return
      if (
        this.httpCollab ||
        (this.mindMap.cooperate && this.mindMap.cooperate.httpCollabMode)
      ) {
        this.markHttpConnected()
        return
      }
      if (this.joinedOnce && this.provider) return
      if (this.connecting) return
      this.connecting = true
      this.setCooperateStatus('connecting')
      localStorage.setItem(USER_NAME_KEY, this.userName)
      this.syncRoomQuery()
      const cooperate = this.mindMap.cooperate
      cooperate.setUserInfo({
        id: this.userId,
        name: this.userName,
        color: this.userColor
      })
      this.unbindProvider()
      const provider = new WebsocketProvider(
        this.serverUrl.replace(/\/$/, ''),
        this.roomName,
        cooperate.getDoc(),
        { connect: false, maxBackoffTime: 10000 }
      )
      this.provider = provider
      cooperate.setProvider(provider)
      provider.on('status', ({ status }) => {
        if (status === 'connected') {
          this.connected = true
          this.connecting = false
          this.joinedOnce = true
          this.clearReconnectNotice()
          this.setCooperateStatus('connected')
          if (this.connectTimer) {
            clearTimeout(this.connectTimer)
            this.connectTimer = null
          }
          this.loadFiles()
          setTimeout(() => this.loadFiles(), 2500)
          this.startSaveStatusPolling()
          return
        }
        this.connected = false
        if (status === 'connecting' || this.joinedOnce) {
          this.connecting = true
          this.setCooperateStatus('connecting')
          this.scheduleReconnectNotice()
          return
        }
        this.connecting = false
        this.stopSaveStatusPolling()
        this.setCooperateStatus('disconnected')
      })
      provider.on('connection-error', () => {
        if (this.joinedOnce) {
          this.connected = false
          this.connecting = true
          this.setCooperateStatus('connecting')
          this.scheduleReconnectNotice()
          return
        }
        if (this.connectTimer) {
          clearTimeout(this.connectTimer)
          this.connectTimer = null
        }
        this.connecting = false
        this.connected = false
        this.stopSaveStatusPolling()
        this.setCooperateStatus('disconnected')
        if (!silent) {
          this.dialogVisible = true
          this.notifyConnectFailure()
        }
      })
      provider.on('connection-close', event => {
        if (!event || event.code !== 1008) return
        this.leave({ silent: true })
        if (!silent) this.$message.warning(this.$t('cooperate.roomUnavailable'))
      })
      provider.awareness.on('change', this.updatePeers)
      this.updatePeers()
      if (this.connectTimer) clearTimeout(this.connectTimer)
      this.connectTimer = setTimeout(() => {
        if (this.connected) return
        this.connecting = false
        this.setCooperateStatus('disconnected')
        if (!silent) {
          this.dialogVisible = true
          if (!this.joinedOnce) this.notifyConnectFailure()
        }
      }, 60000)
      provider.connect()
    },

    notifyConnectFailure() {
      const now = Date.now()
      if (now - this.lastConnectErrorAt < 60000) return
      this.lastConnectErrorAt = now
      this.$message.error(this.$t('cooperate.connectFailed'))
    },

    scheduleReconnectNotice() {
      if (this.reconnectNoticeTimer || !this.joinedOnce) return
      this.reconnectNoticeTimer = setTimeout(() => {
        this.reconnectNoticeTimer = null
        if (this.connected || !this.joinedOnce) return
        this.notifyConnectFailure()
      }, 12000)
    },

    clearReconnectNotice() {
      if (this.reconnectNoticeTimer) {
        clearTimeout(this.reconnectNoticeTimer)
        this.reconnectNoticeTimer = null
      }
    },

    leave(options = {}) {
      const silent = !!options.silent
      if (this.connectTimer) {
        clearTimeout(this.connectTimer)
        this.connectTimer = null
      }
      this.clearReconnectNotice()
      this.unbindCollabStore()
      this.unbindProvider()
      if (this.mindMap && this.mindMap.cooperate) {
        this.mindMap.cooperate.clearHttpCollab()
        this.mindMap.cooperate.disconnectProvider()
      }
      this.connecting = false
      this.connected = false
      this.joinedOnce = false
      this.httpCollab = false
      this.peerList = []
      this.stopSaveStatusPolling()
      if (this.mindMap && this.mindMap.cooperate) {
        if (typeof this.mindMap.cooperate.setPresenceSyncHandler === 'function') {
          this.mindMap.cooperate.setPresenceSyncHandler(null)
        }
        if (typeof this.mindMap.cooperate.applyPresenceUsers === 'function') {
          this.mindMap.cooperate.applyPresenceUsers([])
        }
      }
      if (this.roomName && this.userId) {
        const clientId =
          (this.provider &&
            this.provider.awareness &&
            this.provider.awareness.clientID) ||
          this.userId
        leavePresence(this.roomName, this.userId, clientId).catch(() => {})
      }
      this.setCooperateStatus('disconnected')
      if (!silent) this.$message.success(this.$t('cooperate.leaveSuccess'))
    },

    unbindProvider() {
      if (this.provider) {
        try {
          this.provider.awareness.off('change', this.updatePeers)
        } catch (e) {
          // ignore
        }
        if (this._presenceProvider && typeof this.provider.destroy === 'function') {
          try {
            this.provider.destroy()
          } catch (e) {
            // ignore
          }
        }
        this.provider = null
      }
      this._presenceProvider = false
      this._presenceWs = false
      this._seenHttpChanges = new Map()
      if (this.presenceDoc) {
        try {
          this.presenceDoc.destroy()
        } catch (e) {
          // ignore
        }
        this.presenceDoc = null
      }
    },

    updatePeers() {
      if (!this.provider) {
        this.peerList = []
        return
      }
      const states = Array.from(this.provider.awareness.getStates().values())
      const peers = []
      const presenceUsers = []
      const seen = new Set()
      states.forEach(state => {
        const legacyKey = Object.keys(state).find(key => {
          return state[key] && state[key].userInfo
        })
        const presence = state.user || (legacyKey && state[legacyKey])
        const info = (presence && presence.userInfo) || null
        this.handleHttpChange(state.documentChange)
        if (!info || !info.id || seen.has(info.id)) return
        seen.add(info.id)
        const selectedUids = presence.selectedUids || presence.nodeIdList || []
        const editingUid = presence.editingUid || null
        peers.push({
          id: info.id,
          name: info.name,
          color: info.color || '#409EFF',
          shortName: (info.name || '?').slice(0, 1),
          isMe: info.id === this.userId,
          selectedUids,
          editingUid,
          cursor: presence.cursor || null
        })
        presenceUsers.push({
          id: info.id,
          name: info.name,
          color: info.color || '#409EFF',
          avatar: info.avatar,
          selectedUids,
          editingUid,
          cursor: presence.cursor || null
        })
      })
      if (!peers.find(item => item.id === this.userId) && this.userName) {
        peers.unshift({
          id: this.userId,
          name: this.userName,
          color: this.userColor,
          shortName: this.userName.slice(0, 1),
          isMe: true,
          selectedUids: [],
          editingUid: null,
          cursor: null
        })
      }
      this.peerList = peers
      const cooperate = this.mindMap && this.mindMap.cooperate
      if (cooperate && typeof cooperate.applyPresenceUsers === 'function') {
        cooperate.applyPresenceUsers(presenceUsers)
      }
    },

    handleHttpChange(change) {
      if (!change || change.roomKey !== this.roomName) return
      const myClientId =
        this.provider && this.provider.awareness
          ? String(this.provider.awareness.clientID)
          : ''
      // Compare as strings: outbox uses "outbox-publisher", browsers use numeric ids.
      if (myClientId && String(change.clientId) === myClientId) return
      const key = String(change.clientId || change.userId || '')
      const nonce = String(change.nonce || change.updatedAt || '')
      if (!key || !nonce || this._seenHttpChanges.get(key) === nonce) return
      this._seenHttpChanges.set(key, nonce)
      const cooperate = this.mindMap && this.mindMap.cooperate
      if (!cooperate || !this.httpCollab) return
      const version = Number(change.version)
      if (Number.isFinite(version) && version > 0) {
        if (version <= (Number(cooperate.lastAppliedVersion) || 0)) return
        cooperate.scheduleRemoteRecover(version)
        return
      }
      cooperate
        .refreshVisibleFromHttp(change.updatedAt, { force: true })
        .catch(() => {})
    },

    publishHttpChange(result = {}) {
      const version = Number(result.version) || 0
      const updatedAt = result.updated_at || result.updatedAt || ''
      this._lastHttpChange = {
        roomKey: this.roomName,
        userId: this.userId,
        version,
        updatedAt,
        nonce: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      }
      if (!this.provider || !this._presenceProvider || !this.provider.awareness) {
        return
      }
      this.provider.awareness.setLocalStateField('documentChange', {
        ...this._lastHttpChange,
        clientId: this.provider.awareness.clientID
      })
    },

    notifyHttpMutation(request) {
      return Promise.resolve(request).then(result => {
        const cooperate = this.mindMap && this.mindMap.cooperate
        if (cooperate && result && result.version != null) {
          cooperate.acknowledgeLocalVersion(result.version, {
            operationId: result.operationId || result.operation_id,
            duplicate: !!(result && result.duplicate)
          })
        }
        this.publishHttpChange(result || {})
        return result
      })
    },

    startSaveStatusPolling() {
      this.stopSaveStatusPolling()
      this.loadSaveStatus()
      // This endpoint only reports persistence state. It must not drive document
      // synchronization: operation events, reconnect and explicit version-gap
      // recovery already provide the reliable synchronization path.
      // Keep it infrequent and single-flight so a slow database cannot create an
      // ever-growing queue of status requests.
      this.saveStatusTimer = setInterval(this.loadSaveStatus, 5000)
      this.syncHttpPresence()
      this.presenceTimer = setInterval(this.syncHttpPresence, 10000)
    },

    stopSaveStatusPolling() {
      if (this.saveStatusTimer) {
        clearInterval(this.saveStatusTimer)
        this.saveStatusTimer = null
      }
      if (this.presenceTimer) {
        clearInterval(this.presenceTimer)
        this.presenceTimer = null
      }
      if (this.presenceQuickTimer) {
        clearTimeout(this.presenceQuickTimer)
        this.presenceQuickTimer = null
      }
      this.presenceSyncInFlight = false
      this.presenceSyncQueued = false
      this.saveStatus = 'idle'
      this.saveError = ''
    },

    applyPresenceList(list) {
      const peers = (list || []).map(info => ({
        id: info.id,
        name: info.name,
        color: info.color || '#409EFF',
        shortName: (info.name || '?').slice(0, 1),
        isMe: info.id === this.userId,
        selectedUids: info.selectedUids || [],
        editingUid: info.editingUid || null,
        cursor: info.cursor || null
      }))
      if (!peers.find(item => item.id === this.userId) && this.userName) {
        peers.unshift({
          id: this.userId,
          name: this.userName,
          color: this.userColor,
          shortName: this.userName.slice(0, 1),
          isMe: true,
          selectedUids: [],
          editingUid: null,
          cursor: null
        })
      }
      this.peerList = peers
      const cooperate = this.mindMap && this.mindMap.cooperate
      if (cooperate && typeof cooperate.applyPresenceUsers === 'function') {
        cooperate.applyPresenceUsers(list || [])
      }
    },

    schedulePresenceSync() {
      if (this.presenceQuickTimer) clearTimeout(this.presenceQuickTimer)
      this.presenceQuickTimer = setTimeout(() => {
        this.presenceQuickTimer = null
        this.syncHttpPresence()
      }, 250)
    },

    async syncHttpPresence() {
      if (!this.httpCollab || !this.connected || !this.roomName) return
      if (this.presenceSyncInFlight) {
        this.presenceSyncQueued = true
        return
      }
      this.presenceSyncInFlight = true
      try {
        const clientId =
          (this.provider &&
            this.provider.awareness &&
            this.provider.awareness.clientID) ||
          this.userId
        const cooperate = this.mindMap && this.mindMap.cooperate
        const local =
          cooperate && typeof cooperate.getLocalPresence === 'function'
            ? cooperate.getLocalPresence()
            : {}
        const data = await beatPresence(this.roomName, {
          id: this.userId,
          clientId,
          name: this.userName,
          color: this.userColor,
          selectedUids: local.selectedUids || [],
          editingUid: local.editingUid || null,
          cursor: local.cursor || null
        })
        this.applyPresenceList(data.list)
      } catch (e) {
        // keep last peer list
      } finally {
        this.presenceSyncInFlight = false
        if (this.presenceSyncQueued) {
          this.presenceSyncQueued = false
          this.syncHttpPresence()
        }
      }
    },

    async loadSaveStatus() {
      if (!this.connected || !this.roomName) return
      if (this.saveStatusInFlight) return
      const roomKey = this.roomName
      this.saveStatusInFlight = true
      try {
        const data = await getSaveStatus(roomKey)
        // Ignore a delayed response for a room that was closed or switched.
        if (!this.connected || this.roomName !== roomKey) return
        if (data.status === 'deleted') {
          this.leave({ silent: true })
          return
        }
        if (data.status === 'error') {
          this.saveStatus = 'saveError'
          this.saveError = data.error || this.$t('cooperate.saveError')
        } else if (data.status === 'saving') {
          this.saveStatus = 'saving'
          this.saveError = ''
        } else {
          this.saveStatus = 'saved'
          this.saveError = ''
        }
      } catch (err) {
        if (this.connected && this.roomName === roomKey) {
          this.saveStatus = 'saveError'
          this.saveError = err.message || this.$t('cooperate.saveError')
        }
      } finally {
        this.saveStatusInFlight = false
      }
    },

    syncRoomQuery() {
      const query = { ...this.$route.query, room: this.roomName }
      this.$router.replace({ query }).catch(() => {})
    },

    copyInvite() {
      if (!this.roomName) return
      const invite = `${getRuntimeConfig().appUrl}/#/?room=${encodeURIComponent(
        this.roomName
      )}`
      const done = () => {
        this.$message.success(this.$t('cooperate.copied'))
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard
          .writeText(invite)
          .then(done)
          .catch(() => this.fallbackCopy(invite, done))
        return
      }
      this.fallbackCopy(invite, done)
    },

    fallbackCopy(text, done) {
      const input = document.createElement('textarea')
      input.value = text
      document.body.appendChild(input)
      input.select()
      try {
        document.execCommand('copy')
        done()
      } catch (e) {
        this.$message.error(this.$t('cooperate.copyFailed'))
      }
      document.body.removeChild(input)
    },

    formatTime(value) {
      if (!value) return ''
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return ''
      const pad = n => String(n).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
        date.getDate()
      )} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    },

    canUndoHistoryItem(item) {
      if (!item || !item.operationId) return false
      if (item.type === 'operation.undo' || item.type === 'operation.redo') {
        return false
      }
      return item.actorId === this.userId || item.actorId === 'anonymous'
    },

    async loadHistory() {
      if (!this.connected || !this.roomName) return
      this.historyLoading = true
      try {
        const data = await getMapAudit(this.roomName, { limit: 30 })
        this.historyList = (data.items || []).slice().reverse()
        this.historyPage = 1
      } catch (err) {
        this.historyList = []
      } finally {
        this.historyLoading = false
      }
    },

    async undoHistoryItem(item) {
      if (!item || !item.operationId || !this.roomName) return
      try {
        await this.notifyHttpMutation(
          undoMapOperation(this.roomName, item.operationId)
        )
        const cooperate = this.mindMap && this.mindMap.cooperate
        if (cooperate && cooperate.refreshVisibleFromHttp) {
          await cooperate.refreshVisibleFromHttp('', { force: true })
        }
        await this.loadHistory()
      } catch (err) {
        this.$message.error(
          (err && err.message) || this.$t('cooperate.undoFailed')
        )
      }
    },

    scheduleFileSearch() {
      if (this._fileSearchTimer) clearTimeout(this._fileSearchTimer)
      this._fileSearchTimer = setTimeout(() => {
        this._fileSearchTimer = null
        this.loadFiles()
      }, 280)
    },

    async loadFiles() {
      const attempt = (this._filesAttempt = (this._filesAttempt || 0) + 1)
      this.filesLoading = true
      const query = String(this.fileQuery || '').trim()
      const offset = (this.filePage - 1) * this.filePageSize
      try {
        const data = await listFiles({
          q: query,
          limit: this.filePageSize,
          offset
        })
        if (attempt !== this._filesAttempt) return
        this.fileList = data.list || []
        this.fileTotal = Number(
          data.total != null ? data.total : this.fileList.length
        )
      } catch (err) {
        if (attempt !== this._filesAttempt) return
        this.fileList = []
        this.fileTotal = 0
      } finally {
        if (attempt === this._filesAttempt) this.filesLoading = false
      }
    },

    onFilePageChange(page) {
      this.filePage = page
      this.loadFiles()
    },

    markHttpConnected() {
      this.connecting = false
      this.connected = true
      this.joinedOnce = true
      this.httpCollab = true
      this.clearReconnectNotice()
      this.setCooperateStatus('connected')
      if (this.mindMap && this.mindMap.cooperate) {
        this.mindMap.cooperate.setUserInfo({
          id: this.userId,
          name: this.userName,
          color: this.userColor
        })
        if (typeof this.mindMap.cooperate.setPresenceSyncHandler === 'function') {
          this.mindMap.cooperate.setPresenceSyncHandler(() => {
            this.schedulePresenceSync()
            this.publishLocalAwarenessPresence()
          })
        }
      }
      this.peerList = [
        {
          id: this.userId,
          name: this.userName,
          color: this.userColor,
          shortName: (this.userName || '?').slice(0, 1),
          isMe: true
        }
      ]
      this.connectPresenceSocket()
      this.startSaveStatusPolling()
      // Keep room-entry critical path light: defer secondary HTTP.
      setTimeout(() => {
        this.loadFiles()
        this.syncHttpPresence()
        this.loadHistory()
      }, 0)
    },

    publishLocalAwarenessPresence() {
      if (!this.provider || !this.provider.awareness) return
      const cooperate = this.mindMap && this.mindMap.cooperate
      const local =
        cooperate && typeof cooperate.getLocalPresence === 'function'
          ? cooperate.getLocalPresence()
          : {}
      this.provider.awareness.setLocalStateField('user', {
        userInfo: {
          id: this.userId,
          name: this.userName,
          color: this.userColor
        },
        nodeIdList: local.selectedUids || [],
        selectedUids: local.selectedUids || [],
        editingUid: local.editingUid || null,
        cursor: local.cursor || null
      })
    },

    connectPresenceSocket() {
      if (!this.serverUrl || !this.roomName) return
      this.unbindProvider()
      const doc = new Y.Doc()
      const provider = new WebsocketProvider(
        this.serverUrl.replace(/\/$/, ''),
        `${this.roomName}__presence`,
        doc,
        { connect: true, maxBackoffTime: 10000 }
      )
      this.presenceDoc = doc
      this.provider = provider
      this._presenceProvider = true
      this._presenceWs = false
      this.publishLocalAwarenessPresence()
      if (this._lastHttpChange) {
        provider.awareness.setLocalStateField('documentChange', {
          ...this._lastHttpChange,
          clientId: provider.awareness.clientID,
          nonce: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        })
      }
      provider.awareness.on('change', this.updatePeers)
      provider.on('status', ({ status }) => {
        this._presenceWs = status === 'connected'
        if (status === 'connected') {
          this.publishLocalAwarenessPresence()
          if (this._lastHttpChange) {
            provider.awareness.setLocalStateField('documentChange', {
              ...this._lastHttpChange,
              clientId: provider.awareness.clientID,
              nonce: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
            })
          }
          this.updatePeers()
        }
      })
      this.updatePeers()
    },

    enableHttpCollab(preview) {
      const cooperate = this.mindMap && this.mindMap.cooperate
      const roomKey = this.roomName
      if (!cooperate || !roomKey) return
      cooperate.setHttpCollab({
        roomKey,
        nodeCount: preview.node_count,
        version: preview.version || 0,
        updatedAt: preview.updated_at,
        fetchSubtree: (uid, options) => getFileSubtree(roomKey, uid, options),
        fetchDeepSubtree: (uid, options) =>
          getFileSubtree(roomKey, uid, {
            deep: true,
            maxNodes: 400,
            ...(options || {})
          }),
        fetchExportTree: () => getFileExport(roomKey),
        fetchNodes: uids => getFileNodes(roomKey, uids),
        fetchLocate: uid => locateFileNode(roomKey, uid),
        fetchOperations: after => getMapOperations(roomKey, after),
        fetchVersion: () => getMapVersion(roomKey),
        undoOperation: operationId =>
          this.notifyHttpMutation(undoMapOperation(roomKey, operationId)),
        redoOperation: operationId =>
          this.notifyHttpMutation(redoMapOperation(roomKey, operationId)),
        patchNode: (uid, body) =>
          this.notifyHttpMutation(patchFileNode(roomKey, uid, body)),
        addNode: body =>
          this.notifyHttpMutation(addFileNode(roomKey, body)),
        deleteNode: (uid, options) =>
          this.notifyHttpMutation(deleteFileNode(roomKey, uid, options)),
        replaceTree: tree =>
          Promise.resolve(replaceFileTree(roomKey, tree)).then(result => {
            this.publishHttpChange(result || {})
            return result
          })
      })
      this.bindCollabStore()
    },

    isNotFound(err) {
      return /not found|404/i.test(String((err && err.message) || err || ''))
    },

    async ensureRoomFile(roomKey, title) {
      try {
        return await createFileApi({
          room_key: roomKey,
          title: title || this.$t('cooperate.unnamed')
        })
      } catch (err) {
        if (/已存在|409|exist/i.test(String((err && err.message) || ''))) {
          return null
        }
        throw err
      }
    },

    async applyPreview(preview, silent) {
      const cooperate = this.mindMap.cooperate
      this.enableHttpCollab(preview)
      cooperate.setPreviewApplied(true)
      // Apply canvas data, but do not block room entry on first paint.
      // Previously waited up to 4s for node_tree_render_end, which felt like a hang.
      const renderWait = new Promise(resolve => {
        let settled = false
        const done = () => {
          if (settled) return
          settled = true
          this.mindMap.off('node_tree_render_end', done)
          resolve()
        }
        this.mindMap.on('node_tree_render_end', done)
        let tree = preview.tree
        if (tree && countNodes(tree) > 280) {
          stubImportedTree(tree, {
            keepDepth: 1,
            maxNodes: 280,
            maxChildren: 40
          })
        }
        this.$bus.$emit('setData', tree, {
          quiet: true,
          fromSaved: true
        })
        if (typeof cooperate.markTreeUids === 'function') {
          cooperate.markTreeUids(preview.tree)
        }
        if (typeof cooperate.seedPreviewHydration === 'function') {
          cooperate.seedPreviewHydration(preview.tree)
        }
        setTimeout(done, 600)
      })
      this.markHttpConnected()
      await renderWait
      const renderRoot =
        this.mindMap.renderer && this.mindMap.renderer.renderTree
      if (renderRoot && typeof cooperate.markTreeUids === 'function') {
        cooperate.markTreeUids(renderRoot)
      }
      if (renderRoot && typeof cooperate.seedPreviewHydration === 'function') {
        cooperate.seedPreviewHydration(renderRoot)
      }
      await this.$nextTick()
      cooperate.setPreviewApplied(false)
      if (typeof cooperate.scheduleHttpStructureSync === 'function') {
        cooperate.scheduleHttpStructureSync(120)
      }
      if (!silent) {
        this.$message.success(this.$t('cooperate.openSuccess'))
      }
      return true
    },

    async openSavedRoom(options = {}) {
      const silent = !!options.silent
      const force = !!options.force
      const createIfMissing = !!options.createIfMissing
      if (this.connected) {
        if (!silent) this.$message.success(this.$t('cooperate.openSuccess'))
        return
      }
      if (this.connecting && !force) return
      const roomKey = this.roomName
      const cooperate = this.mindMap && this.mindMap.cooperate
      if (!roomKey || !cooperate) {
        if (!silent) this.join()
        else this.join({ silent: true })
        return
      }
      const attemptId = (this._openAttemptId = (this._openAttemptId || 0) + 1)
      this.connecting = true
      this.setCooperateStatus('connecting')
      cooperate.setExpectRemoteDoc(true)
      let previewLoaded = false
      try {
        let preview = null
        try {
          preview = await getFilePreview(roomKey, 2)
        } catch (err) {
          if (!this.isNotFound(err)) throw err
          // Only create when the user explicitly asked for a new room.
          // Auto-creating on join / dialog open produced "未命名" rooms and
          // also revived rooms right after delete.
          if (!createIfMissing) {
            if (!silent) {
              this.$message.warning(this.$t('cooperate.openFailed'))
            }
            return
          }
          await this.ensureRoomFile(roomKey)
          preview = await getFilePreview(roomKey, 2)
        }
        if (preview && preview.tree) {
          previewLoaded = true
          const connected = await this.applyPreview(preview, silent)
          if (connected) return
        }
      } catch (err) {
        cooperate.setPreviewApplied(false)
        if (!silent) {
          this.$message.warning(
            err.message || this.$t('cooperate.openFailed')
          )
        }
      } finally {
        if (this._openAttemptId === attemptId && !this.connected) {
          this.connecting = false
          this.setCooperateStatus('disconnected')
        }
      }
      if (this.connected) return
      if (getRuntimeConfig().gateway || previewLoaded) {
        if (!silent) {
          this.$message.error(this.$t('cooperate.connectFailed'))
        }
        return
      }
      await this.$nextTick()
      this.deferJoin()
    },

    async openFile(item) {
      if (!item || !item.room_key) return
      if (this.connected && this.roomName === item.room_key) {
        this.$message.success(this.$t('cooperate.openSuccess'))
        return
      }
      if (this.connected) this.leave({ silent: true })
      this.roomName = item.room_key
      this.syncRoomQuery()
      await this.openSavedRoom({ silent: false })
    },

    async renameSavedFile(item) {
      try {
        const { value } = await this.$prompt(
          this.$t('cooperate.renameFile'),
          this.$t('cooperate.files'),
          {
            inputValue: item.title,
            inputValidator: val => !!String(val || '').trim()
          }
        )
        await renameFileApi(item.room_key, value)
        this.$message.success(this.$t('cooperate.renamed'))
        this.loadFiles()
      } catch (err) {
        if (err === 'cancel' || err === 'close') return
        this.$message.error(err.message || this.$t('cooperate.connectFailed'))
      }
    },

    async removeSavedFile(item) {
      try {
        await this.$confirm(
          this.$t('cooperate.deleteConfirm', { title: item.title }),
          this.$t('cooperate.deleteFile'),
          { type: 'warning' }
        )
        const deletedKey = item.room_key
        await deleteFileApi(deletedKey)
        if (this.roomName === deletedKey) {
          if (this.connected || this.connecting) {
            this.leave({ silent: true })
          }
          this.roomName = ''
          const query = { ...this.$route.query }
          delete query.room
          this.$router.replace({ query }).catch(() => {})
        }
        this.fileList = this.fileList.filter(
          file => file && file.room_key !== deletedKey
        )
        if (this.fileTotal > 0) this.fileTotal -= 1
        this.$message.success(this.$t('cooperate.fileDeleted'))
        this.loadFiles()
      } catch (err) {
        if (err === 'cancel' || err === 'close') return
        this.$message.error(err.message || this.$t('cooperate.connectFailed'))
      }
    }
  }
}
</script>

<style lang="less" scoped>
.cooperateBox {
  color: #1f2328;

  .statusBar {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 36px;
    padding: 0 12px;
    margin-bottom: 10px;
    border: 1px solid #e6e8eb;
    border-radius: 8px;
    background: #f7f8fa;
    font-size: 13px;
    color: #4b5563;
  }

  .statusDot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #c0c4cc;
    flex-shrink: 0;

    &.connecting {
      background: #d97706;
    }

    &.connected {
      background: #16a34a;
    }
  }

  .statusLabel {
    font-weight: 600;
    color: #1f2328;
  }

  .peerCount {
    margin-left: auto;
  }

  .saveState {
    color: #6b7280;

    &.saved {
      color: #16a34a;
    }

    &.saveError {
      color: #dc2626;
    }
  }

  .peerList {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 12px;
  }

  .peer {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px 4px 4px;
    background: #f3f4f6;
    border-radius: 999px;
    font-size: 12px;

    .avatar {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
    }

    .you {
      color: #2563eb;
    }
  }

  .filePanel,
  .historyPanel {
    margin-top: 4px;
    padding: 12px;
    border: 1px solid #e6e8eb;
    border-radius: 10px;
    background: #fff;
  }

  .historyPanel {
    margin-top: 12px;
  }

  .fileHead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 13px;
    font-weight: 600;
    color: #1f2328;
    margin-bottom: 8px;
  }

  .fileHeadTitle {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .fileCount {
    font-size: 12px;
    font-weight: 400;
    color: #6b7280;
  }

  .fileSearch {
    margin-bottom: 8px;
  }

  .fileList {
    min-height: 168px;
    max-height: 280px;
    overflow: auto;
  }

  .empty {
    font-size: 13px;
    color: #6b7280;
    padding: 28px 8px;
    text-align: center;
    line-height: 1.6;
  }

  .fileSkeletonRow {
    height: 48px;
    margin-bottom: 8px;
    border-radius: 8px;
    background: linear-gradient(90deg, #f3f4f6 25%, #e5e7eb 37%, #f3f4f6 63%);
    background-size: 400% 100%;
    animation: filePulse 1.2s ease-in-out infinite;
  }

  .fileItem {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    width: 100%;
    margin: 0 0 4px;
    padding: 10px 10px;
    border: 1px solid transparent;
    border-radius: 8px;
    cursor: pointer;

    &:hover {
      background: #f7f8fa;
    }

    &.current {
      background: #eff6ff;
      border-color: #bfdbfe;
    }
  }

  .fileTitle {
    font-size: 13px;
    font-weight: 600;
    color: #1f2328;
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .currentTag {
    flex-shrink: 0;
    font-size: 11px;
    font-weight: 600;
    color: #1d4ed8;
    background: #dbeafe;
    border-radius: 999px;
    padding: 1px 7px;
  }

  .fileTime {
    font-size: 12px;
    color: #6b7280;
    margin-top: 2px;
  }

  .fileActions {
    display: flex;
    align-items: center;
    flex-shrink: 0;

    .danger {
      color: #dc2626;
    }
  }

  .filePager {
    display: flex;
    justify-content: flex-end;
    margin-top: 8px;
  }

  .joinForm {
    margin-top: 14px;
  }

  .advancedToggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin: 4px 0 8px;
    padding: 0;
    border: 0;
    background: none;
    color: #4b5563;
    font-size: 12px;
    cursor: pointer;

    &:hover {
      color: #1f2328;
    }
  }

  .advancedBox {
    padding: 10px 12px;
    border: 1px solid #e6e8eb;
    border-radius: 8px;
    background: #f7f8fa;
  }

  .hint {
    margin: 0 0 8px;
    color: #4b5563;
    line-height: 1.6;
    font-size: 12px;
  }

  .historyItem {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 4px;
    border-bottom: 1px solid #f3f4f6;
    font-size: 12px;
    color: #4b5563;
  }

  &.isDark {
    color: hsla(0, 0%, 100%, 0.9);

    .statusBar,
    .advancedBox {
      background: #2b3035;
      border-color: hsla(0, 0%, 100%, 0.08);
      color: hsla(0, 0%, 100%, 0.7);
    }

    .statusLabel,
    .fileHead,
    .fileTitle,
    .advancedToggle:hover {
      color: hsla(0, 0%, 100%, 0.92);
    }

    .filePanel,
    .historyPanel {
      background: #262b30;
      border-color: hsla(0, 0%, 100%, 0.08);
    }

    .fileItem:hover {
      background: #32383e;
    }

    .fileItem.current {
      background: rgba(64, 158, 255, 0.16);
      border-color: rgba(64, 158, 255, 0.35);
    }

    .currentTag {
      background: rgba(64, 158, 255, 0.22);
      color: #93c5fd;
    }

    .peer {
      background: #32383e;
    }

    .fileTime,
    .fileCount,
    .empty,
    .hint,
    .historyItem,
    .advancedToggle {
      color: hsla(0, 0%, 100%, 0.55);
    }

    .historyItem {
      border-bottom-color: hsla(0, 0%, 100%, 0.06);
    }

    .fileSkeletonRow {
      background: linear-gradient(
        90deg,
        #32383e 25%,
        #3a4148 37%,
        #32383e 63%
      );
      background-size: 400% 100%;
    }
  }
}

@keyframes filePulse {
  0% {
    background-position: 100% 0;
  }
  100% {
    background-position: 0 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .fileSkeletonRow {
    animation: none;
  }
}
</style>

<style lang="less">
.cooperateDialogShell {
  .el-dialog__body {
    padding: 12px 20px 8px;
  }

  .el-dialog__header {
    padding: 16px 20px 10px;
  }

  .el-dialog__title {
    font-size: 16px;
    font-weight: 650;
  }

  &.isDark {
    background: #1f2428;
    border: 1px solid hsla(0, 0%, 100%, 0.08);

    .el-dialog__header,
    .el-dialog__body,
    .el-dialog__footer {
      background: #1f2428;
    }

    .el-dialog__title,
    .el-dialog__close {
      color: hsla(0, 0%, 100%, 0.9);
    }

    .el-pagination button,
    .el-pagination .el-pager li {
      background: transparent;
      color: hsla(0, 0%, 100%, 0.75);
    }
  }
}
</style>
