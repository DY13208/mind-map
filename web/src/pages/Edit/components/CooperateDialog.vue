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
        <span v-if="roomRole" class="roleTag" :class="roomRole">{{
          memberRoleText(roomRole)
        }}</span>
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

      <section class="memberPanel" v-if="connected && roomName">
        <div class="fileHead">
          <div class="fileHeadTitle">
            <span>{{ $t('acl.share') }}</span>
          </div>
        </div>
        <div v-if="membersLoading" class="empty">{{ $t('other.loading') }}</div>
        <div v-else class="memberList">
          <div class="memberItem" v-for="item in memberList" :key="item.user_id">
            <span
              class="avatar"
              :style="memberAvatarStyle(item)"
            >{{ memberInitial(item) }}</span>
            <span class="name">{{ item.name || item.user_id }}</span>
            <span class="roleTag" v-if="!roomCanManage" :class="item.role">{{
              memberRoleText(item.role)
            }}</span>
            <template v-if="roomCanManage">
              <el-select
                :value="item.role"
                size="mini"
                class="roleSelect"
                :disabled="memberBusy"
                @change="val => changeMemberRole(item, val)"
              >
                <el-option :label="$t('acl.owner')" value="owner"></el-option>
                <el-option :label="$t('acl.editor')" value="editor"></el-option>
                <el-option :label="$t('acl.viewer')" value="viewer"></el-option>
              </el-select>
              <el-button
                type="text"
                class="danger"
                :disabled="memberBusy"
                @click="dropMember(item)"
                >{{ $t('acl.remove') }}</el-button
              >
            </template>
          </div>
        </div>
        <div v-if="roomCanManage" class="memberAdd">
          <el-input
            v-model.trim="memberQuery"
            size="small"
            :placeholder="$t('acl.searchUsers')"
            @input="searchMemberUsers"
            @keydown.native.stop
          ></el-input>
          <div class="userHits" v-if="userHits.length">
            <div
              class="memberItem"
              v-for="user in userHits"
              :key="user.user_id"
            >
              <span class="name">{{ user.name || user.user_id }}</span>
              <el-button
                type="text"
                @click="addMember(user, 'viewer')"
                >{{ $t('acl.addViewer') }}</el-button
              >
              <el-button type="text" @click="addMember(user, 'editor')">{{
                $t('acl.addEditor')
              }}</el-button>
            </div>
          </div>
        </div>
      </section>

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
                <span class="roleTag" :class="item.role || 'editor'">{{
                  fileRoleText(item.role)
                }}</span>
              </div>
              <div class="fileTime">{{ formatTime(item.updated_at) }}</div>
            </div>
            <div class="fileActions" @click.stop>
              <el-button type="text" @click="openFile(item)">{{
                $t('cooperate.openFile')
              }}</el-button>
              <el-button
                type="text"
                v-if="item.canManage"
                @click="renameSavedFile(item)"
                >{{ $t('cooperate.renameFile') }}</el-button
              >
              <el-button
                type="text"
                class="danger"
                v-if="item.canManage"
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
  replaceFileTree,
  getFileMembers,
  addFileMember,
  updateFileMember,
  removeFileMember,
  searchUsers
} from '@/utils/fileApi'
import { countNodes, stubImportedTree } from '@/utils/importTree'
import {
  captureMapView,
  inspectMapRef,
  loadMapView,
  normalizeMapRef,
  restoreMapView,
  saveMapView
} from '@/utils/mapRefNav'
import { applyRoomAccess, fileRoleLabelKey, memberRoleLabelKey } from '@/utils/roomAcl'
import { createCollaborationAdapter } from 'simple-mind-map/bin/collabV2/adapter'
import { io } from 'socket.io-client'

const USER_NAME_KEY = 'COOPERATE_USER_NAME'
const USER_ID_KEY = 'COOPERATE_USER_ID'
const V2_CLIENT_KEY = 'mind-map-collab-v2-client'

function tabClientId() {
  try {
    let id = sessionStorage.getItem(V2_CLIENT_KEY)
    if (!id || !String(id).trim()) {
      id =
        (typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, ch => {
              const n = (Math.random() * 16) | 0
              const v = ch === 'x' ? n : (n & 0x3) | 0x8
              return v.toString(16)
            }))
      sessionStorage.setItem(V2_CLIENT_KEY, id)
    }
    return String(id).trim()
  } catch (err) {
    return (
      (typeof crypto !== 'undefined' && crypto.randomUUID && crypto.randomUUID()) ||
      'client-' + Date.now() + '-' + Math.random().toString(36).slice(2)
    )
  }
}
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
      saveStatusBackoffUntil: 0,
      saveStatusFailCount: 0,
      presenceTimer: null,
      presenceQuickTimer: null,
      presenceSyncInFlight: false,
      presenceSyncQueued: false,
      presenceBackoffUntil: 0,
      presenceFailCount: 0,
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
      historyPageSize: 8,
      memberList: [],
      membersLoading: false,
      memberQuery: '',
      userHits: [],
      memberBusy: false,
      collabV2Adapter: null
    }
  },
  computed: {
    ...mapState({
      isDark: state => state.localConfig.isDark,
      roomRole: state => state.roomRole,
      roomCanEdit: state => state.roomCanEdit,
      roomCanManage: state => state.roomCanManage
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
      const status = [
        'saving',
        'saved',
        'saveError',
        'offline',
        'reconnecting'
      ].includes(this.saveStatus)
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
    mindMap(val, prev) {
      if (prev) {
        prev.off('room_acl_denied', this.onAclDenied)
        prev.off('undo_conflict', this.onUndoConflict)
      }
      if (val) {
        val.on('room_acl_denied', this.onAclDenied)
        val.on('undo_conflict', this.onUndoConflict)
        this.tryAutoJoin()
      }
    },
    fileQuery() {
      this.filePage = 1
      this.scheduleFileSearch()
    },
    '$route.query.room'() {
      this.onRoomRouteChange()
    },
    '$route.query.focus'() {
      if (!this.connected) return
      if (this.roomName !== roomFromLocation(this.$route)) return
      this.tryFocusFromQuery()
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
    this.$bus.$on('map_ref_click', this.onMapRefClick)
    this.$bus.$on('showShareAcl', this.openShare)
    this._seenHttpChanges = new Map()
    this._unsubCollabStore = null
  },
  mounted() {
    this.tryAutoJoin()
  },
  beforeDestroy() {
    this.$bus.$off('showCooperate', this.open)
    this.$bus.$off('map_ref_click', this.onMapRefClick)
    this.$bus.$off('showShareAcl', this.openShare)
    if (this.mindMap) {
      this.mindMap.off('room_acl_denied', this.onAclDenied)
      this.mindMap.off('undo_conflict', this.onUndoConflict)
    }
    this.persistCurrentMapView()
    this.stopSaveStatusPolling()
    this.clearReconnectNotice()
    this.unbindCollabStore()
    this.unbindProvider()
    if (this._unsubCollabV2) {
      this._unsubCollabV2()
      this._unsubCollabV2 = null
    }
    if (this.collabV2Adapter && this.collabV2Adapter.disconnect) {
      this.collabV2Adapter.disconnect()
    }
    if (this._fileSearchTimer) {
      clearTimeout(this._fileSearchTimer)
      this._fileSearchTimer = null
    }
    if (this._memberSearchTimer) {
      clearTimeout(this._memberSearchTimer)
      this._memberSearchTimer = null
    }
  },
  methods: {
    ...mapMutations(['setCooperateStatus']),

    applyAccess(access) {
      applyRoomAccess(this.$store, this.mindMap, access || {})
    },

    useCollabV2() {
      return getRuntimeConfig().collabV2 !== false
    },

    mapV2Peers(peers) {
      const mine = this.collabV2Adapter && this.collabV2Adapter.getClientId()
      const list = (peers || []).map(peer => ({
        id: peer.clientId || peer.userId,
        name: peer.name || peer.userId || 'user',
        color: peer.color || '#409EFF',
        shortName: String(peer.name || peer.userId || '?').slice(0, 1),
        isMe: peer.clientId === mine,
        avatar: peer.avatar || '',
        editingUid: peer.editingUid || null
      }))
      if (!list.some(item => item.isMe)) {
        list.unshift({
          id: this.userId,
          name: this.userName,
          color: this.userColor,
          shortName: (this.userName || '?').slice(0, 1),
          isMe: true
        })
      }
      return list
    },

    exposeCollabV2Debug() {
      if (typeof window === 'undefined' || !this.collabV2Adapter) return
      const adapter = this.collabV2Adapter
      const debug = adapter.getDebugState
        ? adapter.getDebugState()
        : adapter.getStatus()
      window.__COLLAB_V2_STATE__ = debug
      window.__COLLAB_V2_STATUS__ = () =>
        (adapter.getDebugState && adapter.getDebugState()) || adapter.getStatus()
      try {
        const trace =
          window.__COLLAB_V2_TRACE__ === true ||
          (window.localStorage &&
            window.localStorage.getItem('COLLAB_V2_TRACE') === '1')
        if (trace && console && console.table) {
          console.table({
            userId: debug.userId,
            clientId: debug.clientId,
            socketId: debug.socketId,
            roomKey: debug.roomKey,
            status: debug.status,
            lastServerRevision: debug.lastServerRevision,
            serverRevision: debug.serverRevision,
            pending: debug.outboxPending
          })
        }
      } catch (err) {
        // ignore
      }
    },

    ensureCollabV2() {
      if (this.collabV2Adapter) return this.collabV2Adapter
      const cooperate = this.mindMap && this.mindMap.cooperate
      const clientId = tabClientId()
      if (typeof window !== 'undefined') {
        window.__COLLAB_V2_STATE__ = {
          status: 'booting',
          clientId,
          userId: String(this.userId || '').replace(/^wecom:/, ''),
          roomKey: this.roomName || ''
        }
      }
      const adapter = createCollaborationAdapter({
        clientId,
        name: this.userName,
        color: this.userColor,
        createSocket: () => {
          const cfg = getRuntimeConfig()
          const raw = String(cfg.collabApi || this.serverUrl || '')
            .replace(/^ws/i, 'http')
            .replace(/\/$/, '')
            .replace(/\/collab$/i, '')
          return io(raw, {
            path: '/collab-v2',
            auth: {
              clientId,
              userId: String(this.userId || '').replace(/^wecom:/, '')
            },
            withCredentials: true,
            transports: ['websocket', 'polling']
          })
        },
        httpSync: async ({ afterRevision }) => {
          const api = getRuntimeConfig().collabApi || ''
          const roomKey = encodeURIComponent(this.roomName || '')
          const res = await fetch(
            `${api}/api/collab-v2/ops?roomKey=${roomKey}&afterRevision=${Number(afterRevision) || 0}`,
            { credentials: 'include', headers: { Accept: 'application/json' } }
          )
          return res.json().catch(() => ({ ok: false }))
        },
        onRemoteOperation: op => {
          if (cooperate && typeof cooperate.applyV2RemoteOperation === 'function') {
            return cooperate.applyV2RemoteOperation(op)
          }
        },
        onReloadRequired: () => {
          if (cooperate && typeof cooperate.recoverHttpCollab === 'function') {
            return cooperate.recoverHttpCollab(
              this.collabV2Adapter &&
                this.collabV2Adapter.getStatus().lastServerRevision
            )
          }
        },
        onRejected: (op, err) => {
          if (err && (err.statusCode === 403 || err.code === 'FORBIDDEN')) {
            this.onAclDenied()
          }
          const skipHttp =
            err &&
            (err.code === 'VERSION_AHEAD' ||
              err.code === 'STALE_BASE' ||
              err.code === 'VERSION_CONFLICT' ||
              err.code === 'ACK_TIMEOUT' ||
              err.code === 'UID_REUSED' ||
              err.code === 'TARGET_DELETED' ||
              err.code === 'NODE_DELETED' ||
              err.code === 'PARENT_DELETED' ||
              err.code === 'MOVE_CONFLICT' ||
              err.code === 'DROPPED_DELETED')
          if (
            !skipHttp &&
            cooperate &&
            typeof cooperate.recoverHttpCollab === 'function'
          ) {
            cooperate.recoverHttpCollab(
              this.collabV2Adapter.getStatus().lastServerRevision
            )
          }
        },
        onLockDenied: owner => {
          this.$message.warning(
            (owner && owner.name ? owner.name : '同事') + ' 正在编辑该节点'
          )
        }
      })
      this.collabV2Adapter = adapter
      if (cooperate && typeof cooperate.setCollabV2Adapter === 'function') {
        cooperate.setCollabV2Adapter(adapter)
      }
      this.exposeCollabV2Debug()
      this._unsubCollabV2 = adapter.subscribe(snap => {
        this.exposeCollabV2Debug()
        if (snap.peers) this.peerList = this.mapV2Peers(snap.peers)
        if (
          snap.phase === 'LIVE' &&
          cooperate &&
          typeof cooperate.establishV2HistoryBaseline === 'function'
        ) {
          cooperate.establishV2HistoryBaseline()
        }
        if (snap.saveState === 'saved') this.saveStatus = 'saved'
        else if (snap.status === 'reconnecting' || snap.saveState === 'resync') {
          this.saveStatus = 'reconnecting'
          this.saveError = ''
        } else if (snap.saveState === 'offline') {
          this.saveStatus = 'offline'
          this.saveError = ''
        } else if (snap.saveState === 'error') {
          this.saveStatus = 'saveError'
          const reason = [snap.lastErrorCode, snap.lastErrorMessage || snap.error]
            .filter(Boolean)
            .join(': ')
          this.saveError = reason || this.$t('cooperate.saveError')
        } else if (snap.saveState === 'saving') this.saveStatus = 'saving'
        this.$store.commit('setCollabPresence', {
          phase: snap.phase || '',
          status: snap.status || '',
          saveState: snap.saveState || 'idle',
          error: snap.lastErrorMessage || snap.error || '',
          diagnostic: this.collabV2Adapter.getDebugState
            ? this.collabV2Adapter.getDebugState()
            : snap,
          peers: this.peerList,
          pendingCount: snap.pendingCount || 0
        })
        if (snap.role || snap.canEdit != null) {
          this.applyAccess({
            role: snap.role,
            canEdit: snap.canEdit,
            canManage: snap.role === 'owner',
            canView: snap.canView
          })
        }
      })
      return adapter
    },

    async connectCollabV2() {
      const adapter = this.ensureCollabV2()
      const previewVersion = Math.max(
        Number(
          (this.mindMap.cooperate && this.mindMap.cooperate.lastAppliedVersion) || 0
        ),
        Number((this._httpCollabPreview && this._httpCollabPreview.version) || 0)
      )
      adapter.setLastServerRevision(previewVersion)
      const joinResult = await adapter.connect({
        roomKey: this.roomName,
        userId: this.userId.replace(/^wecom:/, ''),
        clientId: adapter.getClientId && adapter.getClientId(),
        lastServerRevision: previewVersion
      })
      const cooperate = this.mindMap && this.mindMap.cooperate
      const joinMeta = (joinResult && joinResult.metadata) || {}
      if (
        joinResult &&
        cooperate &&
        typeof cooperate.hydrateRoomMetadata === 'function' &&
        (joinMeta.theme ||
          joinMeta.layout ||
          joinResult.theme ||
          joinResult.layout)
      ) {
        cooperate.hydrateRoomMetadata(joinResult)
      }
      this.peerList = this.mapV2Peers(adapter.getStatus().peers)
      const snap = adapter.getStatus()
      this.$store.commit('setCollabPresence', {
        phase: snap.phase || '',
        status: snap.status || '',
        saveState: snap.saveState || 'idle',
        error: snap.lastErrorMessage || snap.error || '',
        diagnostic: adapter.getDebugState ? adapter.getDebugState() : snap,
        peers: this.peerList,
        pendingCount: snap.pendingCount || 0
      })
      this.exposeCollabV2Debug()
    },

    fallbackToV1Collab() {
      if (this.useCollabV2()) {
        console.warn('[collab-v2] V1 fallback disabled while COLLAB_V2 is on')
        return
      }
      const cooperate = this.mindMap && this.mindMap.cooperate
      if (this._unsubCollabV2) {
        this._unsubCollabV2()
        this._unsubCollabV2 = null
      }
      if (this.collabV2Adapter && this.collabV2Adapter.disconnect) {
        this.collabV2Adapter.disconnect()
      }
      this.collabV2Adapter = null
      if (cooperate && typeof cooperate.setCollabV2Adapter === 'function') {
        cooperate.setCollabV2Adapter(null)
      }
      if (this._httpCollabPreview) this.enableHttpCollab(this._httpCollabPreview)
      this.connectPresenceSocket()
    },

    fileRoleText(role) {
      return this.$t(fileRoleLabelKey(role))
    },

    memberRoleText(role) {
      return this.$t(memberRoleLabelKey(role))
    },

    memberInitial(item) {
      const name = String((item && (item.name || item.user_id)) || '?').trim()
      return name.slice(0, 1)
    },

    memberAvatarStyle(item) {
      if (item && item.avatar) {
        return {
          backgroundImage: `url(${item.avatar})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center'
        }
      }
      return {}
    },

    onAclDenied() {
      this.applyAccess({ role: 'viewer', canEdit: false, canManage: false })
      this.$message.warning(this.$t('acl.demoted'))
    },

    onUndoConflict(err) {
      const code = err && err.code
      if (code === 'REDO_CONFLICT') {
        this.$message.warning(this.$t('cooperate.redoConflict'))
        return
      }
      this.$message.warning(this.$t('cooperate.undoConflict'))
    },

    openShare() {
      this.dialogVisible = true
      this.loadMembers()
    },

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
      if (this.connected) this.loadMembers()
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
        if (this.connected) {
          this.persistCurrentMapView()
          this.leave({ silent: true })
        }
        const created = await createFileApi({ title })
        this.roomName = created.room_key
        this.syncRoomQuery({ clearFocus: true })
        await this.openSavedRoom({ silent: false, createIfMissing: true })
        this.loadFiles()
      } catch (err) {
        if (err === 'cancel' || err === 'close') return
        this.$message.error(err.message || this.$t('cooperate.createFailed'))
      }
    },

    persistCurrentMapView() {
      if (!this.roomName || !this.mindMap) return
      saveMapView(this.roomName, captureMapView(this.mindMap))
    },

    async onRoomRouteChange() {
      const room = roomFromLocation(this.$route)
      if (!room) return
      if (this.roomName === room) {
        if (this.connected) this.tryFocusFromQuery()
        return
      }
      if (this.connected || this.connecting) {
        this.persistCurrentMapView()
        this.leave({ silent: true })
      }
      this.roomName = room
      await this.openSavedRoom({ silent: true })
    },

    async tryFocusFromQuery() {
      const focus = this.$route.query.focus
      if (!focus || !this.mindMap || !this.mindMap.cooperate) return false
      const found = await this.mindMap.cooperate.revealUid(focus)
      if (!found) {
        this.$message.warning(this.$t('mapRef.missingNode'))
        return false
      }
      return true
    },

    async restoreOpenedMapView() {
      const snap = loadMapView(this.roomName)
      if (!snap || !this.mindMap) return
      restoreMapView(this.mindMap, snap)
      const uid = snap.selectedUids && snap.selectedUids[0]
      if (uid && this.mindMap.cooperate) {
        try {
          await this.mindMap.cooperate.revealUid(uid)
        } catch (err) {
          // ignore missing historical selection
        }
      }
    },

    async afterMapOpened() {
      const gen = (this._mapOpenGen = (this._mapOpenGen || 0) + 1)
      await this.$nextTick()
      if (gen !== this._mapOpenGen) return
      if (this.$route.query.focus) {
        await this.tryFocusFromQuery()
        return
      }
      await this.restoreOpenedMapView()
    },

    async onMapRefClick(_node, ref) {
      const current = roomFromLocation(this.$route)
      this.persistCurrentMapView()
      let info
      try {
        info = await inspectMapRef(ref)
      } catch (err) {
        const msg = String((err && err.message) || '')
        if (err && (err.code === 'FORBIDDEN' || err.statusCode === 403 || /403|permission/i.test(msg))) {
          this.$message.warning(this.$t('mapRef.noPermission'))
          return
        }
        if (
          err &&
          (err.statusCode === 404 ||
            err.code === 'NOT_FOUND' ||
            err.code === 'ROOM_DELETED' ||
            /not found|404/i.test(msg))
        ) {
          this.$message.warning(this.$t('mapRef.missingMap'))
          return
        }
        this.$message.warning(this.$t('mapRef.openFailed'))
        return
      }
      if (!info || !info.exists) {
        this.$message.warning(this.$t('mapRef.missingMap'))
        return
      }
      const normalized = normalizeMapRef(ref)
      if (!normalized) return
      if (normalized.nodeId && info.nodeExists === false) {
        this.$message.warning(this.$t('mapRef.missingNode'))
      }
      const query = { ...this.$route.query, room: normalized.mapId }
      if (normalized.nodeId && info.nodeExists !== false) {
        query.focus = normalized.nodeId
      } else {
        delete query.focus
      }
      if (normalized.mapId === current) {
        if (
          normalized.nodeId &&
          info.nodeExists !== false &&
          this.mindMap &&
          this.mindMap.cooperate
        ) {
          await this.mindMap.cooperate.revealUid(normalized.nodeId)
        }
        return
      }
      this.$router.push({ query }).catch(() => {})
    },

    tryAutoJoin() {
      const room = roomFromLocation(this.$route)
      if (typeof window !== 'undefined') {
        window.__COLLAB_V2_JOIN__ = {
          room,
          hasMindMap: !!this.mindMap,
          connected: this.connected,
          connecting: this.connecting,
          useV2: this.useCollabV2 && this.useCollabV2(),
          autoJoinScheduled: !!this._autoJoinScheduled
        }
      }
      if (!this.mindMap || this.connected || this.connecting) return
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
      if (this.useCollabV2()) {
        if (this.mindMap && this.mindMap.cooperate && this.roomName) {
          this.openSavedRoom({ silent, createIfMissing: !silent })
        }
        return
      }
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
      this.clearSaveStatusTimers()
      // V1 leftover. Collaboration V2 derives save UI from socket / outbox / ACK.
      if (this.useCollabV2()) return
      this.loadSaveStatus()
      this.saveStatusTimer = setInterval(this.loadSaveStatus, 15000)
      this.syncHttpPresence()
      this.presenceTimer = setInterval(this.syncHttpPresence, 10000)
    },

    clearSaveStatusTimers() {
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
    },

    stopSaveStatusPolling() {
      this.clearSaveStatusTimers()
      this.presenceSyncInFlight = false
      this.presenceSyncQueued = false
      this.presenceBackoffUntil = 0
      this.presenceFailCount = 0
      this.saveStatusBackoffUntil = 0
      this.saveStatusFailCount = 0
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
      const cooperate = this.mindMap && this.mindMap.cooperate
      if (cooperate && (cooperate.httpReplacing || cooperate.httpReplaceInFlight || cooperate.httpSettlingAfterReplace || cooperate.httpHydrating || (typeof cooperate.isHttpSettling === 'function' && cooperate.isHttpSettling()))) {
        return
      }
      if (this.presenceBackoffUntil && Date.now() < this.presenceBackoffUntil) {
        return
      }
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
        this.presenceFailCount = 0
        this.applyPresenceList(data.list)
      } catch (e) {
        this.presenceFailCount = (this.presenceFailCount || 0) + 1
        this.presenceBackoffUntil =
          Date.now() + Math.min(30000, 2000 * Math.pow(2, this.presenceFailCount - 1))
        this.presenceSyncQueued = false
      } finally {
        this.presenceSyncInFlight = false
        if (this.presenceSyncQueued) {
          this.presenceSyncQueued = false
          this.syncHttpPresence()
        }
      }
    },

    async loadSaveStatus() {
      if (this.useCollabV2()) return
      if (!this.connected || !this.roomName) return
      const cooperate = this.mindMap && this.mindMap.cooperate
      if (cooperate && (cooperate.httpReplacing || cooperate.httpReplaceInFlight || cooperate.httpSettlingAfterReplace || cooperate.httpHydrating)) {
        this.saveStatus = cooperate.httpHydrating ? this.saveStatus : 'saving'
        return
      }
      if (this.saveStatusInFlight) return
      if (this.saveStatusBackoffUntil && Date.now() < this.saveStatusBackoffUntil) {
        return
      }
      const roomKey = this.roomName
      this.saveStatusInFlight = true
      try {
        const data = await getSaveStatus(roomKey)
        this.saveStatusFailCount = 0
        // Ignore a delayed response for a room that was closed or switched.
        if (!this.connected || this.roomName !== roomKey) return
        if (data.status === 'deleted') {
          this.leave({ silent: true })
          return
        }
        // UI-only. Never hydrate, flush, markTreeUids, rewrite lastPushed, or
        // reload SimpleMindMap from this response.
        if (data.status === 'error') {
          this.saveStatus = 'saveError'
          this.saveError = data.error || this.$t('cooperate.saveError')
        } else if (data.status === 'saving' || data.replacing) {
          this.saveStatus = 'saving'
          this.saveError = ''
        } else {
          this.saveStatus = 'saved'
          this.saveError = ''
        }
      } catch (err) {
        this.saveStatusFailCount = (this.saveStatusFailCount || 0) + 1
        this.saveStatusBackoffUntil =
          Date.now() +
          Math.min(30000, 2000 * Math.pow(2, this.saveStatusFailCount - 1))
        if (this.connected && this.roomName === roomKey) {
          if (cooperate && (cooperate.httpReplacing || cooperate.httpReplaceInFlight)) {
            this.saveStatus = 'saving'
            return
          }
          this.saveStatus = 'saveError'
          this.saveError = err.message || this.$t('cooperate.saveError')
        }
      } finally {
        this.saveStatusInFlight = false
      }
    },

    syncRoomQuery(extra = {}) {
      const query = { ...this.$route.query, room: this.roomName }
      if (extra.focus) query.focus = extra.focus
      else if (extra.clearFocus) delete query.focus
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
      if (!this.roomCanEdit) return false
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
      if (this.useCollabV2()) {
        const status =
          this.collabV2Adapter &&
          this.collabV2Adapter.getStatus &&
          this.collabV2Adapter.getStatus()
        if (!status || status.status !== 'live') {
          this.connectCollabV2().catch(err => {
            console.warn('[collab-v2] connect failed, V1 fallback disabled', err)
          })
        }
      } else {
        this.connectPresenceSocket()
      }
      this.startSaveStatusPolling()
      // Keep room-entry critical path light: defer secondary HTTP.
      setTimeout(() => {
        this.loadFiles()
        if (!(this.useCollabV2() && this.collabV2Adapter)) {
          this.syncHttpPresence()
        }
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
      if (this.useCollabV2()) {
        console.warn('[collab-v2] V1 presence socket disabled')
        return
      }
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
      this._httpCollabPreview = preview
      const cooperate = this.mindMap && this.mindMap.cooperate
      const roomKey = this.roomName
      if (!cooperate || !roomKey) return
      cooperate.setHttpCollab({
        roomKey,
        nodeCount: preview.node_count,
        version: preview.version || 0,
        updatedAt: preview.updated_at,
        treeSource: preview.treeSource || 'room_nodes',
        roomNodesCount: preview.roomNodesCount,
        roomsJsonCount: preview.roomsJsonCount,
        roomNodesHash: preview.roomNodesHash,
        roomsJsonHash: preview.roomsJsonHash,
        roomNodesInitialized: preview.roomNodesInitialized,
        legacyFallback: preview.legacyFallback,
        legacyFallbackReason: preview.legacyFallbackReason,
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
        replaceTree: (tree, extra) =>
          Promise.resolve(
            replaceFileTree(roomKey, tree, { allowFullTree: true, source: 'import', ...(extra || {}) })
          ).then(result => {
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
      if (typeof window !== 'undefined') {
        window.__COLLAB_V2_APPLY__ = {
          useV2: this.useCollabV2(),
          collabV2: getRuntimeConfig().collabV2,
          hasCooperate: !!cooperate,
          room: this.roomName
        }
      }
      this.applyAccess(preview)
      if (this.useCollabV2()) {
        try {
          this.ensureCollabV2()
          if (cooperate && typeof cooperate.setCollabV2Adapter === 'function') {
            cooperate.setCollabV2Adapter(this.collabV2Adapter)
          }
        } catch (err) {
          if (typeof window !== 'undefined') {
            window.__COLLAB_V2_BOOT_ERROR__ = String((err && err.stack) || err)
          }
          console.error('[collab-v2] adapter init failed', err)
        }
      }
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
      await renderWait
      const renderRoot =
        this.mindMap.renderer && this.mindMap.renderer.renderTree
      if (renderRoot && typeof cooperate.seedPreviewHydration === 'function') {
        cooperate.seedPreviewHydration(renderRoot)
      }
      if (typeof cooperate.hydrateRoomMetadata === 'function') {
        cooperate.hydrateRoomMetadata(preview)
      }
      await this.$nextTick()
      cooperate.setPreviewApplied(false)
      if (this.useCollabV2()) {
        try {
          await this.connectCollabV2()
        } catch (err) {
          console.warn('[collab-v2] connect failed, V1 fallback disabled', err)
        }
      }
      this.markHttpConnected()
      if (typeof cooperate.scheduleHttpStructureSync === 'function') {
        cooperate.scheduleHttpStructureSync(120)
      }
      if (!silent) {
        this.$message.success(this.$t('cooperate.openSuccess'))
      }
      this.applyAccess(preview)
      this.loadMembers()
      await this.afterMapOpened()
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
          if (err && (err.statusCode === 403 || err.code === 'FORBIDDEN')) {
            this.$message.warning(this.$t('acl.noAccess'))
            return
          }
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
      if (this.connected) {
        this.persistCurrentMapView()
        this.leave({ silent: true })
      }
      this.roomName = item.room_key
      this.syncRoomQuery({ clearFocus: true })
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
    },

    async loadMembers() {
      if (!this.roomName) {
        this.memberList = []
        return
      }
      this.membersLoading = true
      try {
        const data = await getFileMembers(this.roomName)
        this.memberList = data.list || []
        if (data.role || data.canEdit != null) this.applyAccess(data)
      } catch (err) {
        this.memberList = []
      } finally {
        this.membersLoading = false
      }
    },

    async searchMemberUsers() {
      if (this._memberSearchTimer) clearTimeout(this._memberSearchTimer)
      if (!this.memberQuery) {
        this.userHits = []
        return
      }
      this._memberSearchTimer = setTimeout(async () => {
        this._memberSearchTimer = null
        const q = this.memberQuery
        try {
          const data = await searchUsers(q, 8)
          if (this.memberQuery !== q) return
          this.userHits = data.list || []
        } catch (err) {
          this.userHits = []
        }
      }, 280)
    },

    async addMember(user, role) {
      if (!this.roomCanManage || !user || !user.user_id) return
      this.memberBusy = true
      try {
        await addFileMember(this.roomName, user.user_id, role || 'viewer')
        this.memberQuery = ''
        this.userHits = []
        await this.loadMembers()
        this.$message.success(this.$t('acl.memberAdded'))
      } catch (err) {
        this.$message.error(err.message || this.$t('acl.updateFailed'))
      } finally {
        this.memberBusy = false
      }
    },

    async changeMemberRole(item, role) {
      if (!this.roomCanManage || !item) return
      this.memberBusy = true
      try {
        await updateFileMember(this.roomName, item.user_id, role)
        await this.loadMembers()
      } catch (err) {
        this.$message.error(err.message || this.$t('acl.updateFailed'))
      } finally {
        this.memberBusy = false
      }
    },

    async dropMember(item) {
      if (!this.roomCanManage || !item) return
      this.memberBusy = true
      try {
        await removeFileMember(this.roomName, item.user_id)
        await this.loadMembers()
        this.$message.success(this.$t('acl.memberRemoved'))
      } catch (err) {
        this.$message.error(err.message || this.$t('acl.updateFailed'))
      } finally {
        this.memberBusy = false
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

    &.offline,
    &.reconnecting {
      color: #d97706;
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

  .roleTag {
    flex-shrink: 0;
    font-size: 11px;
    font-weight: 600;
    border-radius: 999px;
    padding: 1px 7px;
    color: #4b5563;
    background: #eef2f6;
  }
  .roleTag.owner {
    color: #1d4ed8;
    background: #dbeafe;
  }
  .roleTag.editor {
    color: #047857;
    background: #d1fae5;
  }
  .roleTag.viewer {
    color: #92400e;
    background: #fef3c7;
  }

  .memberPanel {
    margin-bottom: 12px;
    padding: 12px;
    border: 1px solid #e6e8eb;
    border-radius: 10px;
    background: #fff;
  }
  .memberList,
  .userHits {
    border: 1px solid #e6e8eb;
    border-radius: 8px;
    max-height: 180px;
    overflow: auto;
  }
  .memberItem {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    font-size: 13px;
    .avatar {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      background: #94a3b8;
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      flex-shrink: 0;
    }
    .name {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .roleSelect {
      width: 96px;
    }
  }
  .memberAdd {
    margin-top: 8px;
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
    .historyPanel,
    .memberPanel {
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
