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
            :disabled="connected"
            @keydown.native.stop
          >
            <el-button
              slot="append"
              :disabled="connected"
              @click="createRoom"
              >{{ $t('cooperate.newRoom') }}</el-button
            >
          </el-input>
        </el-form-item>
        <el-form-item :label="$t('cooperate.serverUrl')" required>
          <el-input
            v-model.trim="serverUrl"
            :placeholder="$t('cooperate.serverUrlPlaceholder')"
            :disabled="connected"
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
    </div>
    <div slot="footer" class="dialog-footer">
      <el-button @click="copyInvite" :disabled="!roomName">{{
        $t('cooperate.copyInvite')
      }}</el-button>
      <el-button v-if="connected" @click="leave">{{
        $t('cooperate.leave')
      }}</el-button>
      <el-button type="primary" :loading="connecting" @click="join" v-else>{{
        $t('cooperate.join')
      }}</el-button>
    </div>
  </el-dialog>
</template>

<script>
import { WebsocketProvider } from 'y-websocket'
import { mapMutations, mapState } from 'vuex'
import { getRuntimeConfig } from '@/utils/runtimeConfig'
import {
  listFiles,
  renameFile as renameFileApi,
  deleteFile as deleteFileApi,
  getSaveStatus
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
      saveStatus: 'idle',
      saveError: '',
      lastConnectErrorAt: 0,
      reconnectNoticeTimer: null,
      joinedOnce: false,
      fileList: [],
      filesLoading: false
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
    this.userId = localStorage.getItem(USER_ID_KEY) || createId()
    localStorage.setItem(USER_ID_KEY, this.userId)
    this.userName =
      this.$route.query.userName ||
      localStorage.getItem(USER_NAME_KEY) ||
      defaultGuestName(this.userId)
    localStorage.setItem(USER_NAME_KEY, this.userName)
    this.roomName =
      this.$route.query.room || 'room-' + Math.random().toString(36).slice(2, 8)
    this.userColor =
      USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)]
    this.$bus.$on('showCooperate', this.open)
  },
  mounted() {
    this.tryAutoJoin()
  },
  beforeDestroy() {
    this.$bus.$off('showCooperate', this.open)
    this.stopSaveStatusPolling()
    this.clearReconnectNotice()
    this.unbindProvider()
  },
  methods: {
    ...mapMutations(['setCooperateStatus']),

    open() {
      this.dialogVisible = true
      this.loadFiles()
    },

    createRoom() {
      this.roomName = 'room-' + Math.random().toString(36).slice(2, 8)
    },

    tryAutoJoin() {
      if (!this.mindMap || this.connected || this.connecting) return
      if (!this.$route.query.room) return
      if (this._autoJoinScheduled) return
      this._autoJoinScheduled = true
      // 等首屏本地渲染完成后再连协同，避免刷新时远端全量 apply 和首屏渲染抢主线程
      const run = () => {
        this._autoJoinScheduled = false
        if (!this.mindMap || this.connected || this.connecting) return
        if (!this.$route.query.room) return
        this.join({ silent: true })
      }
      const onReady = () => {
        this.mindMap.off('node_tree_render_end', onReady)
        setTimeout(run, 50)
      }
      this.mindMap.on('node_tree_render_end', onReady)
      setTimeout(() => {
        this.mindMap && this.mindMap.off('node_tree_render_end', onReady)
        run()
      }, 1500)
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

    join(options = {}) {
      const silent = !!options.silent
      if (!this.validate() || this.connected) return
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
        if (this.joinedOnce || this.provider) {
          if (!silent) this.dialogVisible = true
          if (!this.joinedOnce) this.notifyConnectFailure()
          return
        }
        this.connecting = false
        if (!silent) this.dialogVisible = true
        this.notifyConnectFailure()
      }, 15000)
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
      this.unbindProvider()
      if (this.mindMap && this.mindMap.cooperate) {
        this.mindMap.cooperate.disconnectProvider()
      }
      this.connecting = false
      this.connected = false
      this.joinedOnce = false
      this.peerList = []
      this.stopSaveStatusPolling()
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
        this.provider = null
      }
    },

    updatePeers() {
      if (!this.provider) {
        this.peerList = []
        return
      }
      const states = Array.from(this.provider.awareness.getStates().values())
      const peers = []
      const seen = new Set()
      states.forEach(state => {
        const legacyKey = Object.keys(state).find(key => {
          return state[key] && state[key].userInfo
        })
        const presence = state.user || (legacyKey && state[legacyKey])
        const info = (presence && presence.userInfo) || null
        if (!info || !info.id || seen.has(info.id)) return
        seen.add(info.id)
        peers.push({
          id: info.id,
          name: info.name,
          color: info.color || '#409EFF',
          shortName: (info.name || '?').slice(0, 1),
          isMe: info.id === this.userId
        })
      })
      if (!peers.find(item => item.id === this.userId) && this.userName) {
        peers.unshift({
          id: this.userId,
          name: this.userName,
          color: this.userColor,
          shortName: this.userName.slice(0, 1),
          isMe: true
        })
      }
      this.peerList = peers
    },

    startSaveStatusPolling() {
      this.stopSaveStatusPolling()
      this.loadSaveStatus()
      this.saveStatusTimer = setInterval(this.loadSaveStatus, 1500)
    },

    stopSaveStatusPolling() {
      if (this.saveStatusTimer) {
        clearInterval(this.saveStatusTimer)
        this.saveStatusTimer = null
      }
      this.saveStatus = 'idle'
      this.saveError = ''
    },

    async loadSaveStatus() {
      if (!this.connected || !this.roomName) return
      try {
        const data = await getSaveStatus(this.roomName)
        if (data.status === 'error') {
          this.saveStatus = 'saveError'
          this.saveError = data.error || this.$t('cooperate.saveError')
        } else if (data.status === 'saving') {
          this.saveStatus = 'saving'
          this.saveError = ''
        } else if (data.status === 'deleted') {
          this.leave({ silent: true })
        } else {
          this.saveStatus = 'saved'
          this.saveError = ''
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

    async openFile(item) {
      if (!item || !item.room_key) return
      if (this.connected && this.roomName === item.room_key) {
        this.$message.success(this.$t('cooperate.openSuccess'))
        return
      }
      if (this.connected) this.leave({ silent: true })
      this.roomName = item.room_key
      this.$nextTick(() => {
        this.join()
      })
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
        await deleteFileApi(item.room_key)
        if (this.connected && this.roomName === item.room_key) {
          this.leave({ silent: true })
        }
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
