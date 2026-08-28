<template>
  <el-dialog
    class="cooperateDialog"
    :title="$t('cooperate.title')"
    :visible.sync="dialogVisible"
    width="520px"
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
      joinedOnce: false
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
    this.unbindProvider()
  },
  methods: {
    ...mapMutations(['setCooperateStatus']),

    open() {
      this.dialogVisible = true
    },

    createRoom() {
      this.roomName = 'room-' + Math.random().toString(36).slice(2, 8)
    },

    tryAutoJoin() {
      if (!this.mindMap || this.connected || this.connecting) return
      if (!this.$route.query.room) return
      this.join({ silent: true })
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
      if (!this.validate() || this.connecting || this.connected) return
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
        { connect: false }
      )
      this.provider = provider
      cooperate.setProvider(provider)
      provider.on('status', ({ status }) => {
        this.connected = status === 'connected'
        this.connecting = false
        this.setCooperateStatus(this.connected ? 'connected' : 'disconnected')
        if (status === 'connected') {
          if (this.connectTimer) {
            clearTimeout(this.connectTimer)
            this.connectTimer = null
          }
          if (!this.joinedOnce) {
            this.joinedOnce = true
            this.$message.success(
              this.$t('cooperate.autoJoinSuccess', { name: this.userName })
            )
          }
        }
      })
      provider.on('connection-error', () => {
        if (this.connectTimer) {
          clearTimeout(this.connectTimer)
          this.connectTimer = null
        }
        this.connecting = false
        this.connected = false
        this.setCooperateStatus('disconnected')
        if (!silent) this.dialogVisible = true
        this.$message.error(this.$t('cooperate.connectFailed'))
      })
      provider.awareness.on('change', this.updatePeers)
      this.updatePeers()
      if (this.connectTimer) clearTimeout(this.connectTimer)
      this.connectTimer = setTimeout(() => {
        if (!this.connected) {
          this.connecting = false
          if (!silent) this.dialogVisible = true
          this.$message.error(this.$t('cooperate.connectFailed'))
        }
      }, 8000)
      provider.connect()
    },

    leave() {
      if (this.connectTimer) {
        clearTimeout(this.connectTimer)
        this.connectTimer = null
      }
      this.unbindProvider()
      if (this.mindMap && this.mindMap.cooperate) {
        this.mindMap.cooperate.disconnectProvider()
      }
      this.connecting = false
      this.connected = false
      this.joinedOnce = false
      this.peerList = []
      this.setCooperateStatus('disconnected')
      this.$message.success(this.$t('cooperate.leaveSuccess'))
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
        const key = Object.keys(state)[0]
        const info = (state[key] && state[key].userInfo) || null
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
}
</style>
