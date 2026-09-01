<template>
  <el-dialog
    class="cooperateDialog"
    :title="$t('cooperate.title')"
    :visible.sync="dialogVisible"
    width="600px"
    append-to-body
  >
    <div class="cooperateBox">
      <p class="desc">{{ $t('cooperate.tip') }}</p>
      <p class="serverTip">{{ $t('cooperate.startServerTip') }}</p>
      <el-form label-width="100px" @submit.native.prevent>
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
        <el-form-item :label="$t('cooperate.serverUrl')" required>
          <el-input
            v-model.trim="serverUrl"
            :placeholder="$t('cooperate.serverUrlPlaceholder')"
            :disabled="connected || connecting"
            @keydown.native.stop
          ></el-input>
        </el-form-item>
      </el-form>
      <div class="statusRow">
        <span class="statusDot" :class="status"></span>
        <span>{{ statusText }}</span>
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
      <div class="fileBox">
        <div class="fileHead">
          <span>{{ $t('cooperate.files') }}</span>
          <el-button type="text" @click="loadFiles">{{
            $t('cooperate.refresh')
          }}</el-button>
        </div>
        <div class="empty" v-if="!fileList.length && !filesLoading">
          {{ $t('cooperate.noFiles') }}
        </div>
        <div
          class="fileItem"
          v-for="item in fileList"
          :key="item.room_key"
          :class="{ current: connected && roomName === item.room_key }"
        >
          <div class="fileMeta">
            <div class="fileTitle">{{ item.title }}</div>
            <div class="fileTime">{{ formatTime(item.updated_at) }}</div>
          </div>
          <div class="fileActions">
            <el-button type="text" @click="openFile(item)">{{
              $t('cooperate.openFile')
            }}</el-button>
            <el-button type="text" @click="renameSavedFile(item)">{{
              $t('cooperate.renameFile')
            }}</el-button>
            <el-button type="text" class="danger" @click="removeSavedFile(item)">{{
              $t('cooperate.deleteFile')
            }}</el-button>
          </div>
        </div>
      </div>
      <div class="fileBox" v-if="connected">
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
          v-for="item in historyList"
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
      </div>
    </div>
    <div slot="footer" class="dialog-footer">
      <el-button @click="copyInvite" :disabled="!roomName">{{
        $t('cooperate.copyInvite')
      }}</el-button>
      <el-button v-if="connected" @click="leave">{{
        $t('cooperate.leave')
      }}</el-button>
      <el-button type="primary" :loading="connecting" @click="joinFromDialog" v-else>{{
        $t('cooperate.join')
      }}</el-button>
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
      presenceTimer: null,
      presenceQuickTimer: null,
      saveStatus: 'idle',
      saveError: '',
      lastConnectErrorAt: 0,
      reconnectNoticeTimer: null,
      joinedOnce: false,
      fileList: [],
      filesLoading: false,
      httpCollab: false,
      historyList: [],
      historyLoading: false
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
    }
  },
  watch: {
    mindMap(val) {
      if (val) this.tryAutoJoin()
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
      if (
        !change ||
        change.roomKey !== this.roomName ||
        (this.provider &&
          Number(change.clientId) === this.provider.awareness.clientID)
      ) {
        return
      }
      const key = String(change.clientId || change.userId || '')
      const nonce = String(change.nonce || change.updatedAt || '')
      if (!key || !nonce || this._seenHttpChanges.get(key) === nonce) return
      this._seenHttpChanges.set(key, nonce)
      const cooperate = this.mindMap && this.mindMap.cooperate
      if (!cooperate || !this.httpCollab) return
      const version = Number(change.version)
      if (Number.isFinite(version) && version > 0) {
        cooperate.recoverHttpCollab(version).catch(() => {})
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
      this.saveStatusTimer = setInterval(this.loadSaveStatus, 1500)
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
      }
    },

    async loadSaveStatus() {
      if (!this.connected || !this.roomName) return
      if (this.httpCollab) this.syncHttpPresence()
      try {
        const data = await getSaveStatus(this.roomName)
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
        // Version poll is the reliable fallback when presence WS misses events.
        const cooperate = this.mindMap && this.mindMap.cooperate
        if (this.httpCollab && cooperate) {
          if (data.version != null && Number.isFinite(Number(data.version))) {
            const remoteVersion = Number(data.version)
            if (remoteVersion > Number(cooperate.lastAppliedVersion || 0)) {
              cooperate.recoverHttpCollab(remoteVersion).catch(() => {})
            }
          } else if (data.updated_at) {
            cooperate.refreshVisibleFromHttp(data.updated_at, { force: true }).catch(() => {})
          }
        }
      } catch (err) {
        this.saveStatus = 'saveError'
        this.saveError = err.message || this.$t('cooperate.saveError')
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

    async loadFiles() {
      this.filesLoading = true
      try {
        const data = await listFiles()
        this.fileList = data.list || []
      } catch (err) {
        this.fileList = []
      } finally {
        this.filesLoading = false
      }
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
          getFileSubtree(roomKey, uid, { deep: true, ...(options || {}) }),
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
        this.$bus.$emit('setData', preview.tree, {
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
      // Release the preview gate ASAP so early inserts/edits are uploaded.
      // Waiting the full render timeout previously dropped those mutations.
      await this.$nextTick()
      cooperate.setPreviewApplied(false)
      if (typeof cooperate.scheduleHttpStructureSync === 'function') {
        cooperate.scheduleHttpStructureSync(0)
      }
      if (!silent) {
        this.$message.success(this.$t('cooperate.openSuccess'))
      }
      await renderWait
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
.cooperateDialog {
  /deep/ .el-dialog__body {
    padding: 12px 20px 8px;
  }
}

.cooperateBox {
  .desc,
  .serverTip {
    margin: 0 0 12px;
    padding-left: 12px;
    border-left: 5px solid #ccc;
    color: #666;
    line-height: 1.6;
    font-size: 13px;
  }

  .serverTip {
    border-left-color: #409eff;
    word-break: break-all;
  }

  .statusRow {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: #666;
    margin: 4px 0 8px;

    .statusDot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #c0c4cc;

      &.connecting {
        background: #e6a23c;
      }

      &.connected {
        background: #67c23a;
      }
    }

    .peerCount {
      margin-left: auto;
    }

    .saveState {
      margin-left: 8px;
      color: #909399;

      &.saved {
        color: #67c23a;
      }

      &.saveError {
        color: #f56c6c;
      }
    }
  }

  .peerList {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 4px;
  }

  .peer {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px 4px 4px;
    background: #f5f7fa;
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
      color: #409eff;
    }
  }

  .fileBox {
    margin-top: 12px;
    border-top: 1px solid #eee;
    padding-top: 10px;

    .fileHead {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 13px;
      color: #333;
      margin-bottom: 6px;
    }

    .empty {
      font-size: 12px;
      color: #999;
      padding: 8px 0;
    }

    .fileItem {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 8px 0;
      border-bottom: 1px solid #f2f2f2;

      &.current .fileTitle {
        color: #409eff;
      }
    }

    .fileTitle {
      font-size: 13px;
      color: #333;
    }

    .fileTime {
      font-size: 12px;
      color: #999;
      margin-top: 2px;
    }

    .historyItem {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 6px 0;
      border-bottom: 1px solid #f2f2f2;
      font-size: 12px;
      color: #666;
    }

    .fileActions {
      display: flex;
      align-items: center;
      flex-shrink: 0;

      .danger {
        color: #f56c6c;
      }
    }
  }
}
</style>
