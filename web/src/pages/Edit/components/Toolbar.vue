<template>
  <div class="toolbarContainer" :class="{ isDark: isDark }">
    <div class="toolbar" ref="toolbarRef">
      <!-- 节点操作 -->
      <div
        class="toolbarBlockWrapper"
        :class="{ collapsed: nodeToolbarCollapsed }"
        v-if="!isReadonly"
      >
        <button
          type="button"
          class="collapseToggleBtn"
          :class="{ collapsed: nodeToolbarCollapsed }"
          :title="
            nodeToolbarCollapsed
              ? $t('toolbar.expandToolbar')
              : $t('toolbar.collapseToolbar')
          "
          :aria-label="
            nodeToolbarCollapsed
              ? $t('toolbar.expandToolbar')
              : $t('toolbar.collapseToolbar')
          "
          :aria-expanded="String(!nodeToolbarCollapsed)"
          @click.stop="toggleNodeToolbar"
        >
          <span class="iconfont iconjiantouyou"></span>
        </button>
        <div class="toolbarBlock">
          <ToolbarNodeBtnList :list="horizontalList"></ToolbarNodeBtnList>
          <!-- 更多 -->
          <el-popover
            v-model="popoverShow"
            placement="bottom-end"
            width="120"
            trigger="hover"
            v-if="showMoreBtn"
            :style="{ marginLeft: horizontalList.length > 0 ? '20px' : 0 }"
          >
            <ToolbarNodeBtnList
              dir="v"
              :list="verticalList"
              @click.native="popoverShow = false"
            ></ToolbarNodeBtnList>
            <div slot="reference" class="toolbarBtn">
              <span class="icon iconfont icongongshi"></span>
              <span class="text">{{ $t('toolbar.more') }}</span>
            </div>
          </el-popover>
        </div>
      </div>
      <!-- 导出 -->
      <div
        class="toolbarBlockWrapper"
        :class="{ collapsed: fileToolbarCollapsed }"
      >
        <button
          type="button"
          class="collapseToggleBtn"
          :class="{ collapsed: fileToolbarCollapsed }"
          :title="
            fileToolbarCollapsed
              ? $t('toolbar.expandToolbar')
              : $t('toolbar.collapseToolbar')
          "
          :aria-label="
            fileToolbarCollapsed
              ? $t('toolbar.expandToolbar')
              : $t('toolbar.collapseToolbar')
          "
          :aria-expanded="String(!fileToolbarCollapsed)"
          @click.stop="toggleFileToolbar"
        >
          <span class="iconfont iconjiantouyou"></span>
        </button>
        <div class="toolbarBlock">
          <div class="toolbarBtn" @click="openDirectory" v-if="!isMobile">
            <span class="icon iconfont icondakai"></span>
            <span class="text">{{ $t('toolbar.directory') }}</span>
          </div>
          <el-tooltip
            effect="dark"
            :content="$t('toolbar.newFileTip')"
            placement="bottom"
            v-if="!isMobile"
          >
            <div class="toolbarBtn" @click="createNewLocalFile">
              <span class="icon iconfont iconxinjian"></span>
              <span class="text">{{ $t('toolbar.newFile') }}</span>
            </div>
          </el-tooltip>
          <el-tooltip
            effect="dark"
            :content="$t('toolbar.openFileTip')"
            placement="bottom"
            v-if="!isMobile"
          >
            <div class="toolbarBtn" @click="openLocalFile">
              <span class="icon iconfont iconwenjian1"></span>
              <span class="text">{{ $t('toolbar.openFile') }}</span>
            </div>
          </el-tooltip>
          <div class="toolbarBtn" @click="saveLocalFile" v-if="!isMobile">
            <span class="icon iconfont iconlingcunwei"></span>
            <span class="text">{{ $t('toolbar.saveAs') }}</span>
          </div>
          <div
            class="toolbarBtn"
            data-testid="import"
            @click="$bus.$emit('showImport')"
            v-if="!isReadonly"
          >
            <span class="icon iconfont icondaoru"></span>
            <span class="text">{{ $t('toolbar.import') }}</span>
          </div>
          <div
            class="collabStatus"
            data-testid="collab-status"
            :class="[displayedSaveChip, { cooperating: collabLive }]"
          >
            <el-popover
              placement="bottom"
              width="240"
              trigger="click"
              popper-class="collabPeerPopper"
            >
              <div class="collabPeerPopover">
                <div class="peerHead">{{ $t('cooperate.peers') }} {{ collabPeers.length }}</div>
                <div
                  class="peerRow"
                  v-for="peer in collabPeers"
                  :key="peer.id"
                >
                  <span
                    class="miniAvatar"
                    :style="peerAvatarStyle(peer)"
                    >{{ peer.shortName || '?' }}</span
                  >
                  <span class="peerName">{{ peer.name }}</span>
                  <span class="you" v-if="peer.isMe">{{ $t('cooperate.you') }}</span>
                </div>
                <div class="empty" v-if="!collabPeers.length">
                  {{ $t('cooperate.noOnlinePeers') }}
                </div>
              </div>
              <div slot="reference" class="collabAvatars" data-testid="collab-peers">
                <span
                  class="miniAvatar"
                  v-for="peer in visibleCollabPeers"
                  :key="peer.id"
                  :style="peerAvatarStyle(peer)"
                  >{{ peer.shortName || '?' }}</span
                >
                <span class="more" v-if="extraPeerCount">+{{ extraPeerCount }}</span>
                <span class="peerCount">{{ collabPeers.length }}</span>
              </div>
            </el-popover>
            <el-popover
              v-if="displayedSaveChip === 'failed'"
              placement="bottom-end"
              width="380"
              trigger="click"
              popper-class="collabDiagPopper"
            >
              <div class="collabDiag">
                <div class="diagHead">{{ $t('cooperate.diagTitle') }}</div>
                <div
                  class="diagRow"
                  v-for="row in collabDiagRows"
                  :key="row.key"
                >
                  <span class="k">{{ row.key }}</span>
                  <span class="v">{{ row.value }}</span>
                </div>
                <el-button
                  v-if="isCollabDiagDev"
                  size="mini"
                  type="primary"
                  plain
                  class="diagCopy"
                  @click="copyCollabDiag"
                >{{
                  diagCopied
                    ? $t('cooperate.diagCopied')
                    : $t('cooperate.diagCopy')
                }}</el-button>
              </div>
              <span
                slot="reference"
                class="saveChip clickable"
                data-testid="collab-sync-failed"
                >{{ collabSaveLabel }}</span
              >
            </el-popover>
            <span v-else class="saveChip" :title="collabError">{{
              collabSaveLabel
            }}</span>
          </div>
          <div
            class="toolbarBtn"
            data-testid="share"
            @click="$bus.$emit('showShareAcl')"
          >
            <span class="icon iconfont iconxietongwendang"></span>
            <span class="text">{{ $t('acl.share') }}</span>
          </div>
          <div
            class="toolbarBtn"
            data-testid="history-versions"
            v-if="$route.query.room"
            @click="$emit('open-history')"
          >
            <span class="icon el-icon-time"></span>
            <span class="text">历史版本</span>
          </div>
          <div
            class="toolbarBtn"
            data-testid="back-to-my-maps"
            title="返回脑图"
            v-if="$route.query.room"
            @click="goToMyMaps"
          >
            <span class="icon el-icon-back"></span>
            <span class="text">脑图</span>
          </div>
          <div
            class="toolbarBtn"
            :class="{ disabled: refreshing }"
            data-testid="refresh"
            @click="refreshPage"
          >
            <span
              class="icon"
              :class="refreshing ? 'el-icon-loading' : 'el-icon-refresh'"
            ></span>
            <span class="text">{{ $t('toolbar.refresh') }}</span>
          </div>
          <div
            class="toolbarBtn"
            data-testid="run-workbuddy-job"
            :class="{ disabled: isReadonly }"
            title="把任务派发到本机或局域网其他电脑的 WorkBuddy"
            @click="openWorkbuddyJobDialog"
            v-if="!isReadonly"
          >
            <span
              class="icon"
              :class="jobDispatching ? 'el-icon-loading' : 'el-icon-video-play'"
            ></span>
            <span class="text">运行</span>
          </div>
          <div
            class="toolbarBtn"
            @click="$bus.$emit('showExport')"
            style="margin-right: 0"
          >
            <span class="icon iconfont iconexport"></span>
            <span class="text">{{ $t('toolbar.export') }}</span>
          </div>
          <!-- 本地文件树 -->
          <div
            class="fileTreeBox"
            v-if="fileTreeVisible"
            :class="{ expand: fileTreeExpand }"
          >
            <div class="fileTreeToolbar">
              <div class="fileTreeName">
                {{ rootDirName ? '/' + rootDirName : '' }}
              </div>
              <div class="fileTreeActionList">
                <div
                  class="btn"
                  :class="[
                    fileTreeExpand ? 'el-icon-arrow-up' : 'el-icon-arrow-down'
                  ]"
                  @click="fileTreeExpand = !fileTreeExpand"
                ></div>
                <div
                  class="btn el-icon-close"
                  @click="fileTreeVisible = false"
                ></div>
              </div>
            </div>
            <div class="fileTreeWrap">
              <el-tree
                :props="fileTreeProps"
                :load="loadFileTreeNode"
                :expand-on-click-node="false"
                node-key="id"
                lazy
              >
                <span class="customTreeNode" slot-scope="{ node, data }">
                  <div class="treeNodeInfo">
                    <span
                      class="treeNodeIcon iconfont"
                      :class="[
                        data.type === 'file' ? 'iconwenjian' : 'icondakai'
                      ]"
                    ></span>
                    <span class="treeNodeName">{{ node.label }}</span>
                  </div>
                  <div class="treeNodeBtnList" v-if="data.type === 'file'">
                    <el-button
                      type="text"
                      size="mini"
                      v-if="data.enableEdit"
                      @click="editLocalFile(data)"
                      >编辑</el-button
                    >
                    <el-button
                      type="text"
                      size="mini"
                      v-else
                      @click="importLocalFile(data)"
                      >导入</el-button
                    >
                  </div>
                </span>
              </el-tree>
            </div>
          </div>
        </div>
      </div>
    </div>
    <el-dialog
      title="运行 · 派发 WorkBuddy 任务"
      :visible.sync="jobDialogVisible"
      width="580px"
      custom-class="workbuddyJobDialog"
      append-to-body
      @closed="onJobDialogClosed"
    >
      <div class="jobForm" :class="{ isDark: isDark }">
        <div class="jobField">
          <label class="jobLabel">执行主机</label>
          <el-select
            v-model="jobHostKey"
            size="small"
            style="width: 100%"
            placeholder="选择执行任务的电脑"
            :loading="jobHostsLoading"
            @change="onJobHostChange"
          >
            <el-option
              v-for="item in jobHosts"
              :key="item.key"
              :label="item.label + (item.online ? '' : '（离线）')"
              :value="item.key"
              :disabled="!item.online"
            ></el-option>
          </el-select>
          <p class="jobHint" v-if="jobHostsLoading">正在读取主机列表…</p>
          <p class="jobHint warn" v-else-if="jobHostsError">
            {{ jobHostsError }}
          </p>
          <p class="jobHint" v-else-if="!jobHosts.length">
            没发现可用主机。本机请先运行 test1.py，其他电脑用
            <code>--lan --hub</code> 登记到通讯页。
          </p>
        </div>
        <div class="jobField">
          <label class="jobLabel">目标任务（产物落在它的工作目录）</label>
          <el-select
            v-model="jobGateway"
            size="small"
            style="width: 100%"
            placeholder="选择该主机上正在运行的 WorkBuddy 任务"
            :loading="jobGatewaysLoading"
          >
          <el-option
            v-for="item in jobGateways"
            :key="item.url"
            :label="jobGatewayLabel(item)"
            :value="item.url"
          ></el-option>
          </el-select>
          <p class="jobHint warn" v-if="jobGatewaysError">
            {{ jobGatewaysError }}
          </p>
        </div>
        <div class="jobField">
          <label class="jobLabel">任务内容</label>
          <el-input
            v-model="jobPrompt"
            type="textarea"
            :rows="6"
            placeholder="描述要在这台电脑上执行的任务"
          ></el-input>
        </div>
        <div class="jobStatus" v-if="jobStatus">
          <span :class="jobStatusType">{{ jobStatus }}</span>
          <el-button v-if="jobPolling" type="text" size="mini" @click="stopJob"
            >停止</el-button
          >
          <el-button
            v-if="jobCurrentId && !jobPolling"
            type="text"
            size="mini"
            :loading="jobFullLoading"
            @click="loadJobFullText"
            >{{ jobFullChars ? '重新取全文' : '取全文' }}</el-button
          >
          <el-button
            v-if="jobResult"
            type="text"
            size="mini"
            @click="copyJobResult"
            >{{ jobCopied ? '已复制' : '复制' }}</el-button
          >
        </div>
          <pre class="jobResult" v-if="jobResult">{{ jobResult }}</pre>
          <p class="jobHint" v-if="jobFullChars">
            完整回答 {{ jobFullChars }} 字{{
              jobFullSource === 'transcript' ? '（取自执行记录）' : ''
            }}，上方框内可滚动查看。
          </p>
          <div class="jobField">
          <div class="jobHistoryHead">
            <label class="jobLabel" style="margin: 0"
              >运行历史（这台主机的后台任务）</label
            >
            <el-button
              type="text"
              size="mini"
              :loading="jobHistoryLoading"
              @click="loadJobHistory"
              >刷新</el-button
            >
          </div>
          <div class="jobHistory" v-if="jobHistory.length">
            <div
              class="jobHistoryRow"
              :class="{ active: item.id === jobCurrentId }"
              v-for="item in jobHistory"
              :key="item.id"
            >
              <span class="hDot" :class="jobStateClass(item)"></span>
              <span class="hName" :title="item.intent || ''">{{
                item.name || '(未命名)'
              }}</span>
              <span class="hMeta"
                >{{ jobStateText(item) }} · {{ jobTimeText(item) }}</span
              >
              <el-button type="text" size="mini" @click="viewJob(item)"
                >看结果</el-button
              >
              <el-button
                v-if="isJobRunning(item)"
                type="text"
                size="mini"
                @click="stopJobById(item.id)"
                >停止</el-button
              >
            </div>
          </div>
          <p class="jobHint" v-else>
            {{ jobHistoryError || '这台主机的这个任务下还没有派发记录。' }}
          </p>
        </div>
      </div>
      <span slot="footer">
        <el-button size="small" @click="refreshJobHosts">刷新主机</el-button>
        <el-button size="small" @click="jobDialogVisible = false"
          >关闭</el-button
        >
        <el-button
          size="small"
          type="primary"
          :loading="jobDispatching"
          :disabled="!jobCanDispatch"
          @click="runWorkbuddyJob"
          >派发</el-button
        >
      </span>
    </el-dialog>
    <NodeImage></NodeImage>
    <NodeHyperlink></NodeHyperlink>
    <NodeIcon></NodeIcon>
    <NodeNote></NodeNote>
    <NodeTag></NodeTag>
    <Export></Export>
    <Import ref="ImportRef"></Import>
  </div>
</template>

<script>
import NodeImage from './NodeImage.vue'
import NodeHyperlink from './NodeHyperlink.vue'
import NodeIcon from './NodeIcon.vue'
import NodeNote from './NodeNote.vue'
import NodeTag from './NodeTag.vue'
import Export from './Export.vue'
import Import from './Import.vue'
import { mapState } from 'vuex'
import { Notification } from 'element-ui'
import exampleData from 'simple-mind-map/example/exampleData'
import { getData } from '../../../api'
import ToolbarNodeBtnList from './ToolbarNodeBtnList.vue'
import { throttle, isMobile } from 'simple-mind-map/src/utils/index'
import { stringifyJsonOffMainThread } from '@/utils/importTree'
import { navigateToMyMaps } from '@/utils/roomLocation'
import { getTextFromHtml } from 'simple-mind-map/src/utils'
import {
  resolveJobHosts,
  listHostGateways,
  listHostJobs,
  stopHostJob,
  fetchJobTranscript,
  describeEmptyGateways,
  dispatchWorkbuddyJob
} from '@/utils/workbuddyJobBridge'

const JOB_POLL_INTERVAL = 2500
const JOB_RUNNING_STATES = ['working', 'busy', 'active', 'running', 'pending']

// 工具栏
let fileHandle = null
const defaultBtnList = [
  'back',
  'forward',
  'painter',
  'siblingNode',
  'childNode',
  'deleteNode',
  'image',
  'icon',
  'link',
  'note',
  'tag',
  'summary',
  'associativeLine',
  'formula',
  'attachment',
  'outerFrame',
  'annotation',
  'flowExpand',
  'ai'
]

export default {
  components: {
    NodeImage,
    NodeHyperlink,
    NodeIcon,
    NodeNote,
    NodeTag,
    Export,
    Import,
    ToolbarNodeBtnList
  },
  data() {
    return {
      isMobile: isMobile(),
      horizontalList: [],
      verticalList: [],
      showMoreBtn: true,
      popoverShow: false,
      fileTreeProps: {
        label: 'name',
        children: 'children',
        isLeaf: 'leaf'
      },
      fileTreeVisible: false,
      rootDirName: '',
      fileTreeExpand: true,
      waitingWriteToLocalFile: false,
      pendingLocalFileContent: null,
      refreshing: false,
      nodeToolbarCollapsed: false,
      fileToolbarCollapsed: false,
      diagCopied: false,
      displayedSaveChip: 'offline',
      saveChipTimer: null,
      jobDispatching: false,
      jobDialogVisible: false,
      jobHosts: [],
      jobHostsLoading: false,
      jobHostsError: '',
      jobHostKey: '',
      jobGateways: [],
      jobGatewaysLoading: false,
      jobGatewaysError: '',
      jobGateway: '',
      jobPrompt: '',
      jobStatus: '',
      jobStatusType: 'jobOk',
      jobResult: '',
      jobCurrentId: '',
      jobPollTimer: null,
      jobFullText: '',
      jobFullChars: 0,
      jobFullSource: '',
      jobFullLoading: false,
      jobCopied: false,
      jobHistory: [],
      jobHistoryLoading: false,
      jobHistoryError: '',
      activeNodes: []
    }
  },
  computed: {
    ...mapState({
      isDark: state => state.localConfig.isDark,
      isHandleLocalFile: state => state.isHandleLocalFile,
      openNodeRichText: state => state.localConfig.openNodeRichText,
      enableAi: state => state.localConfig.enableAi,
      cooperateStatus: state => state.cooperateStatus,
      isReadonly: state => state.isReadonly,
      collabPhase: state => state.collabPhase,
      collabSaveState: state => state.collabSaveState,
      collabPeers: state => state.collabPeers,
      collabPendingCount: state => state.collabPendingCount,
      collabError: state => state.collabError,
      collabDiagnostic: state => state.collabDiagnostic
    }),
    collabLive() {
      return this.collabPhase === 'LIVE' || this.cooperateStatus === 'connected'
    },
    visibleCollabPeers() {
      return (this.collabPeers || []).slice(0, 3)
    },
    extraPeerCount() {
      return Math.max(0, (this.collabPeers || []).length - 3)
    },
    collabSaveChip() {
      const phase = this.collabPhase
      const save = this.collabSaveState
      if (save === 'error') return 'failed'
      if (phase === 'ERROR' && save !== 'saved' && save !== 'saving') {
        return 'failed'
      }
      if (save === 'offline' || phase === 'OFFLINE' || phase === 'DISCONNECTED') {
        return this.collabPendingCount || save === 'offline' ? 'offline' : 'offline'
      }
      if (
        save === 'resync' ||
        save === 'reconnecting' ||
        phase === 'RESYNCING' ||
        phase === 'CONNECTING' ||
        phase === 'JOINING'
      ) {
        return 'syncing'
      }
      if (save === 'saving' || this.collabPendingCount > 0) return 'saving'
      if (save === 'saved' && this.collabLive) return 'saved'
      return 'offline'
    },
    collabSaveLabel() {
      const key = {
        saved: 'chipSaved',
        saving: 'chipSaving',
        offline: 'chipOffline',
        syncing: 'chipSyncing',
        failed: 'chipFailed'
      }[this.displayedSaveChip]
      return this.$t('cooperate.' + (key || 'chipOffline'))
    },
    isCollabDiagDev() {
      if (typeof window === 'undefined') return false
      if (window.__COLLAB_V2_DIAG__ === true) return true
      if (process.env.NODE_ENV !== 'production') return true
      const host = (window.location && window.location.hostname) || ''
      return (
        host === 'localhost' ||
        host === '127.0.0.1' ||
        /^192\.168\./.test(host) ||
        /^10\./.test(host) ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
      )
    },
    collabDiag() {
      const fromWin =
        typeof window !== 'undefined' && window.__COLLAB_V2_STATE__
          ? window.__COLLAB_V2_STATE__
          : null
      return fromWin || this.collabDiagnostic || {}
    },
    collabDiagRows() {
      const d = this.collabDiag || {}
      const err = d.lastError || {}
      return [
        ['errorCode', d.errorCode || err.code || ''],
        ['errorMessage', d.errorMessage || err.message || this.collabError || ''],
        ['stage', d.stage || err.stage || ''],
        ['roomKey', d.roomKey || ''],
        ['userId', d.userId || ''],
        ['clientId', d.clientId || ''],
        ['socketId', d.socketId || ''],
        ['lastServerRevision', d.lastServerRevision],
        ['serverRevision', d.serverRevision],
        ['outboxPending', d.outboxPending],
        ['outboxSending', d.outboxSending],
        ['baseRevision', d.baseRevision != null ? d.baseRevision : (err.details && err.details.baseRevision)],
        ['roomCurrentRevision', d.roomCurrentRevision != null ? d.roomCurrentRevision : (err.details && err.details.roomCurrentRevision)],
        ['clientSeq', d.clientSeq != null ? d.clientSeq : (err.details && err.details.clientSeq)],
        ['outboxIndex', d.outboxIndex != null ? d.outboxIndex : (err.details && err.details.outboxIndex)],
        ['lastOpId', d.lastOpId || err.opId || ''],
        ['currentError', d.currentError && d.currentError.code],
        ['lastErrorRecovered', d.lastErrorRecovered],
        ['timestamp', d.timestamp || err.timestamp || '']
      ].map(([key, value]) => ({
        key,
        value: value == null || value === '' ? '—' : String(value)
      }))
    },

    btnLit() {
      let res = [...defaultBtnList]
      if (!this.openNodeRichText) {
        res = res.filter(item => {
          return item !== 'formula'
        })
      }
      if (!this.enableAi) {
        res = res.filter(item => {
          return item !== 'ai'
        })
      }
      return res
    },

    jobSelectedHost() {
      return this.jobHosts.find(item => item.key === this.jobHostKey) || null
    },

    jobPolling() {
      return this.jobPollTimer != null
    },

    jobCanDispatch() {
      const host = this.jobSelectedHost
      return (
        !this.jobDispatching &&
        !!host &&
        host.online &&
        !!this.jobGateway &&
        !!String(this.jobPrompt || '').trim()
      )
    }
  },
  watch: {
    isHandleLocalFile(val) {
      if (!val) {
        Notification.closeAll()
      }
    },
    btnLit: {
      deep: true,
      handler() {
        this.computeToolbarShow()
      }
    },
    collabSaveChip: {
      immediate: true,
      handler(next) {
        this.syncDisplayedSaveChip(next)
      }
    }
  },
  created() {
    this.$bus.$on('write_local_file', this.onWriteLocalFile)
    this.$bus.$on(
      'set_canvas_toolbars_collapsed',
      this.setCanvasToolbarsCollapsed
    )
    this.$bus.$on('node_active', this.onNodeActive)
  },
  mounted() {
    this.computeToolbarShow()
    this.computeToolbarShowThrottle = throttle(this.computeToolbarShow, 300)
    window.addEventListener('resize', this.computeToolbarShowThrottle)
    this.$bus.$on('lang_change', this.computeToolbarShowThrottle)
    window.addEventListener('beforeunload', this.onUnload)
    this.$bus.$on('node_note_dblclick', this.onNodeNoteDblclick)
  },
  beforeDestroy() {
    if (this.saveChipTimer) {
      clearTimeout(this.saveChipTimer)
      this.saveChipTimer = null
    }
    this.stopJobPoll()
    this.$bus.$off('write_local_file', this.onWriteLocalFile)
    this.$bus.$off(
      'set_canvas_toolbars_collapsed',
      this.setCanvasToolbarsCollapsed
    )
    this.$bus.$off('node_active', this.onNodeActive)
    window.removeEventListener('resize', this.computeToolbarShowThrottle)
    this.$bus.$off('lang_change', this.computeToolbarShowThrottle)
    window.removeEventListener('beforeunload', this.onUnload)
    this.$bus.$off('node_note_dblclick', this.onNodeNoteDblclick)
  },
  methods: {
    setCanvasToolbarsCollapsed(collapsed) {
      this.nodeToolbarCollapsed = collapsed
      this.fileToolbarCollapsed = collapsed
      if (collapsed) {
        this.popoverShow = false
      }
    },

    onNodeActive(_node, activeNodeList) {
      this.activeNodes = Array.isArray(activeNodeList) ? [...activeNodeList] : []
    },

    nodePlainTitle(node) {
      if (!node || typeof node.getData !== 'function') return ''
      return getTextFromHtml(node.getData('text') || '').trim()
    },

    buildDefaultJobPrompt() {
      const selected = this.activeNodes[0]
      const title = this.nodePlainTitle(selected)
      const room = String(
        (this.$route.query && this.$route.query.room) || ''
      ).trim()
      if (title) {
        return [
          `请基于当前脑图选中节点执行任务。`,
          room ? `房间：${room}` : '',
          `节点：${title}`,
          ``,
          `请结合该节点上下文完成分析或落地动作，并给出可执行结论。`
        ]
          .filter(Boolean)
          .join('\n')
      }
      return room
        ? `请分析并执行脑图房间「${room}」相关任务，给出可执行结论。`
        : '请分析当前脑图并给出可执行结论。'
    },

    openWorkbuddyJobDialog() {
      if (this.isReadonly) return
      this.jobStatus = ''
      this.jobStatusType = 'jobOk'
      this.jobResult = ''
      this.jobCurrentId = ''
      this.resetJobFullText()
      this.jobPrompt = this.buildDefaultJobPrompt()
      this.jobDialogVisible = true
      this.refreshJobHosts()
    },

    resetJobFullText() {
      this.jobFullText = ''
      this.jobFullChars = 0
      this.jobFullSource = ''
      this.jobCopied = false
    },

    onJobDialogClosed() {
      this.stopJobPoll()
    },

    async refreshJobHosts() {
      this.jobHostsLoading = true
      this.jobHostsError = ''
      try {
        const res = await resolveJobHosts()
        this.jobHosts = res.hosts || []
        this.jobHostsError = res.error || ''
        const keep = this.jobHosts.some(item => item.key === this.jobHostKey)
        if (!keep) {
          const preferred =
            res.defaultHost ||
            this.jobHosts.find(item => item.online) ||
            this.jobHosts[0]
          this.jobHostKey = preferred ? preferred.key : ''
        }
      } catch (err) {
        this.jobHosts = []
        this.jobHostsError = (err && err.message) || '读取主机列表失败'
      } finally {
        this.jobHostsLoading = false
      }
      await this.loadJobGateways()
    },

    onJobHostChange() {
      this.jobStatus = ''
      this.jobResult = ''
      this.jobCurrentId = ''
      this.resetJobFullText()
      this.loadJobGateways()
    },

    jobGatewayLabel(item) {
      const name = item.title || item.url || 'WorkBuddy'
      const parts = [name]
      if (item.cwd) parts.push(item.cwd)
      if (item.internal) parts.push('内部主机')
      return parts.join(' · ')
    },

    async loadJobGateways() {
      const host = this.jobSelectedHost
      this.jobGateways = []
      this.jobGateway = ''
      this.jobGatewaysError = ''
      if (!host) return
      this.jobGatewaysLoading = true
      try {
        const res = await listHostGateways(host)
        if (!res.ok) {
          this.jobGatewaysError = res.error || '读取失败'
          return
        }
        this.jobGateways = res.gateways || []
        if (this.jobGateways.length) {
          this.jobGateway = this.jobGateways[0].url
        } else {
          this.jobGatewaysError = describeEmptyGateways(res.diag)
        }
      } finally {
        this.jobGatewaysLoading = false
      }
      await this.loadJobHistory()
    },

    /** 那台主机上的后台任务记录（含以前派发的） */
    async loadJobHistory() {
      const host = this.jobSelectedHost
      this.jobHistory = []
      this.jobHistoryError = ''
      if (!host) return
      this.jobHistoryLoading = true
      try {
        const res = await listHostJobs({ host, gateway: this.jobGateway })
        if (!res.ok) {
          this.jobHistoryError = res.error || '拿不到运行记录'
          return
        }
        this.jobHistory = (res.jobs || [])
          .slice()
          .sort(
            (a, b) =>
              (b.updatedAt || b.startedAt || 0) -
              (a.updatedAt || a.startedAt || 0)
          )
          .slice(0, 20)
      } finally {
        this.jobHistoryLoading = false
      }
    },

    isJobRunning(item) {
      const state = item.state || item.status || ''
      return JOB_RUNNING_STATES.indexOf(state) !== -1 || item.alive === true
    },

    jobStateText(item) {
      const state = item.state || item.status || '?'
      const map = {
        done: '已完成',
        completed: '已完成',
        working: '执行中',
        running: '执行中',
        busy: '执行中',
        active: '执行中',
        pending: '排队中',
        failed: '失败',
        stopped: '已停止'
      }
      return map[state] || state
    },

    jobStateClass(item) {
      const state = item.state || item.status || ''
      return 's-' + (state || 'unknown')
    },

    jobTimeText(item) {
      const ts = item.updatedAt || item.startedAt
      if (!ts) return ''
      const d = new Date(ts)
      return `${String(d.getHours()).padStart(2, '0')}:${String(
        d.getMinutes()
      ).padStart(2, '0')}`
    },

    async viewJob(item) {
      if (!item || !item.id) return
      this.jobCurrentId = item.id
      this.jobResult = String(item.detail || '')
        .replace(/^result:\s*/i, '')
        .trim()
      this.resetJobFullText()
      if (this.isJobRunning(item)) {
        this.startJobPoll()
      } else {
        this.loadJobFullText()
      }
    },

    async runWorkbuddyJob() {
      if (this.jobDispatching) return
      const host = this.jobSelectedHost
      if (!host) {
        this.$message.warning('请先选择执行主机')
        return
      }
      const prompt = String(this.jobPrompt || '').trim()
      if (!prompt) {
        this.$message.warning('请填写任务内容')
        return
      }
      if (!this.jobGateway) {
        this.$message.warning('请先选择该主机上的 WorkBuddy 任务')
        return
      }
      this.jobDispatching = true
      this.jobStatus = `正在派发到 ${host.label} …`
      this.jobStatusType = 'jobWait'
      this.jobResult = ''
      try {
        const result = await dispatchWorkbuddyJob({
          host,
          gateway: this.jobGateway,
          prompt,
          name: '脑图运行'
        })
        if (!result.ok) {
          const errText =
            typeof result.error === 'string'
              ? result.error
              : JSON.stringify(result.error || result)
          this.jobStatus = `派发失败：${errText}`
          this.jobStatusType = 'jobErr'
          this.$message.error(`派发失败：${errText}`)
          return
        }
        const jobId =
          (result.job && (result.job.id || result.job.jobId)) || ''
        this.jobCurrentId = jobId
        const cwd =
          result.gatewayCwd ||
          (this.jobGateways.find(item => item.url === this.jobGateway) || {})
            .cwd ||
          '对应工作区'
        this.jobStatus = `已派发到 ${host.label}${
          result.via === 'hub' ? '（经主服务转发）' : ''
        }${jobId ? ` · ${jobId}` : ''}，产物落在：${cwd}`
        this.jobStatusType = 'jobOk'
        this.$message.success(`已派发到 ${host.label}`)
        this.startJobPoll()
        this.loadJobHistory()
      } catch (err) {
        this.jobStatus = `派发失败：${(err && err.message) || '未知错误'}`
        this.jobStatusType = 'jobErr'
      } finally {
        this.jobDispatching = false
      }
    },

    startJobPoll() {
      this.stopJobPoll()
      this.pollJob()
      this.jobPollTimer = setInterval(() => this.pollJob(), JOB_POLL_INTERVAL)
    },

    stopJobPoll() {
      if (this.jobPollTimer) {
        clearInterval(this.jobPollTimer)
        this.jobPollTimer = null
      }
    },

    async pollJob() {
      const host = this.jobSelectedHost
      if (!host || !this.jobCurrentId) return
      const res = await listHostJobs({ host, gateway: this.jobGateway })
      if (!res.ok) return
      const cur = (res.jobs || []).find(item => item.id === this.jobCurrentId)
      if (!cur) return
      const state = cur.state || cur.status || ''
      const detail = String(cur.detail || '').replace(/^result:\s*/i, '')
      const running =
        JOB_RUNNING_STATES.indexOf(state) !== -1 || cur.alive === true
      if (running) {
        this.jobStatus = `执行中（${state || 'working'}）`
        this.jobStatusType = 'jobWait'
        this.jobResult = detail
        return
      }
      this.stopJobPoll()
      if (state === 'failed' || state === 'stopped') {
        this.jobStatus = state === 'failed' ? '执行失败' : '已停止'
        this.jobStatusType = 'jobErr'
      } else {
        this.jobStatus = `已完成（${state || 'done'}）`
        this.jobStatusType = 'jobOk'
      }
      // detail 只有一行摘要，全文另外取
      this.jobResult = detail || '没有文字结果'
      this.loadJobFullText()
      this.loadJobHistory()
    },

    async loadJobFullText() {
      const host = this.jobSelectedHost
      if (!host || !this.jobCurrentId) return
      this.jobFullLoading = true
      try {
        const res = await fetchJobTranscript({
          host,
          jobId: this.jobCurrentId
        })
        if (!res.ok) return
        this.jobFullText = res.text || ''
        this.jobFullChars = res.chars || this.jobFullText.length
        this.jobFullSource = res.source || ''
        if (this.jobFullText) this.jobResult = this.jobFullText
      } finally {
        this.jobFullLoading = false
      }
    },

    copyJobResult() {
      const text = this.jobResult || this.jobFullText
      if (!text) return
      const done = () => {
        this.jobCopied = true
        setTimeout(() => {
          this.jobCopied = false
        }, 1500)
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard
          .writeText(text)
          .then(done)
          .catch(() => {
            this.fallbackCopyDiag(text)
            done()
          })
        return
      }
      this.fallbackCopyDiag(text)
      done()
    },

    async stopJob() {
      return this.stopJobById(this.jobCurrentId)
    },

    async stopJobById(jobId) {
      const host = this.jobSelectedHost
      if (!host || !jobId) return
      const res = await stopHostJob({
        host,
        gateway: this.jobGateway,
        id: jobId
      })
      if (res.ok) {
        if (jobId === this.jobCurrentId) {
          this.jobStatus = '已请求停止'
          this.jobStatusType = 'jobWait'
        }
        this.loadJobHistory()
      } else {
        this.$message.error(res.error || '停止失败')
      }
    },

    syncDisplayedSaveChip(next) {
      const chip = next || 'offline'
      if (this.saveChipTimer) {
        clearTimeout(this.saveChipTimer)
        this.saveChipTimer = null
      }
      if (chip === 'saving' && this.displayedSaveChip !== 'saving') {
        this.saveChipTimer = setTimeout(() => {
          this.saveChipTimer = null
          this.displayedSaveChip = 'saving'
        }, 200)
        return
      }
      this.displayedSaveChip = chip
    },

    peerAvatarStyle(peer) {
      if (peer && peer.avatar) {
        return {
          backgroundImage: 'url(' + peer.avatar + ')',
          backgroundSize: 'cover',
          backgroundPosition: 'center'
        }
      }
      return { background: (peer && peer.color) || '#409EFF' }
    },

    copyCollabDiag() {
      const payload =
        (typeof window !== 'undefined' && window.__COLLAB_V2_STATE__) ||
        this.collabDiag ||
        {}
      const text = JSON.stringify(payload, null, 2)
      const done = () => {
        this.diagCopied = true
        setTimeout(() => {
          this.diagCopied = false
        }, 1500)
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(() => {
          this.fallbackCopyDiag(text)
          done()
        })
        return
      }
      this.fallbackCopyDiag(text)
      done()
    },

    fallbackCopyDiag(text) {
      const el = document.createElement('textarea')
      el.value = text
      el.setAttribute('readonly', 'readonly')
      el.style.position = 'fixed'
      el.style.left = '-9999px'
      document.body.appendChild(el)
      el.select()
      try {
        document.execCommand('copy')
      } catch (err) {
        // ignore
      }
      document.body.removeChild(el)
    },

    toggleNodeToolbar() {
      this.nodeToolbarCollapsed = !this.nodeToolbarCollapsed
      if (this.nodeToolbarCollapsed) {
        this.popoverShow = false
      }
    },

    toggleFileToolbar() {
      this.fileToolbarCollapsed = !this.fileToolbarCollapsed
    },

    // 计算工具按钮如何显示
    computeToolbarShow() {
      if (!this.$refs.toolbarRef) return
      const windowWidth = window.innerWidth - 40
      const all = [...this.btnLit]
      let index = 1
      const loopCheck = () => {
        if (index > all.length) return done()
        this.horizontalList = all.slice(0, index)
        this.$nextTick(() => {
          const width = this.$refs.toolbarRef.getBoundingClientRect().width
          if (width < windowWidth) {
            index++
            loopCheck()
          } else if (index > 0 && width > windowWidth) {
            index--
            this.horizontalList = all.slice(0, index)
            done()
          }
        })
      }
      const done = () => {
        this.verticalList = all.slice(index)
        this.showMoreBtn = this.verticalList.length > 0
      }
      loopCheck()
    },

    // 监听本地文件读写
    onWriteLocalFile(content) {
      this.pendingLocalFileContent = content
      clearTimeout(this.timer)
      if (fileHandle && this.isHandleLocalFile) {
        this.waitingWriteToLocalFile = true
      }
      this.timer = setTimeout(() => {
        this.writeLocalFile(content)
      }, 1000)
    },

    onUnload(e) {
      if (this.waitingWriteToLocalFile) {
        const msg = '存在未保存的数据'
        e.returnValue = msg
        return msg
      }
    },

    // 加载本地文件树
    async loadFileTreeNode(node, resolve) {
      try {
        let dirHandle
        if (node.level === 0) {
          dirHandle = await window.showDirectoryPicker()
          this.rootDirName = dirHandle.name
        } else {
          dirHandle = node.data.handle
        }
        const dirList = []
        const fileList = []
        for await (const [key, value] of dirHandle.entries()) {
          const isFile = value.kind === 'file'
          if (isFile && !/\.(smm|xmind|md|json)$/.test(value.name)) {
            continue
          }
          const enableEdit = isFile && /\.smm$/.test(value.name)
          const data = {
            id: key,
            name: value.name,
            type: value.kind,
            handle: value,
            leaf: isFile,
            enableEdit
          }
          if (isFile) {
            fileList.push(data)
          } else {
            dirList.push(data)
          }
        }
        resolve([...dirList, ...fileList])
      } catch (error) {
        console.log(error)
        this.fileTreeVisible = false
        resolve([])
        if (error.toString().includes('aborted')) {
          return
        }
        this.$message.warning(this.$t('toolbar.notSupportTip'))
      }
    },

    goToMyMaps() {
      navigateToMyMaps(this.$router)
    },

    prepareReload() {
      return new Promise(resolve => {
        let settled = false
        const finish = result => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(result || { ok: true })
        }
        const timer = setTimeout(() => finish({ ok: true, timeout: true }), 5000)
        this.$bus.$emit('prepare_reload', finish)
      })
    },

    async flushLocalFileNow() {
      if (!fileHandle || !this.isHandleLocalFile) return
      clearTimeout(this.timer)
      this.timer = null
      if (this.pendingLocalFileContent) {
        await this.writeLocalFile(this.pendingLocalFileContent)
      }
    },

    async refreshPage() {
      if (this.refreshing) return
      this.refreshing = true
      try {
        if (this.collabSaveChip === 'saving' || this.collabPendingCount > 0) {
          this.$message.info(this.$t('toolbar.refreshFlushingTip'))
        }
        await this.prepareReload()
        await this.flushLocalFileNow()
        if (this.waitingWriteToLocalFile) {
          this.$message.warning(this.$t('toolbar.refreshSavingTip'))
          this.refreshing = false
          return
        }
      } catch (err) {
        console.warn('[toolbar] prepare reload failed', err)
      }
      window.location.reload()
    },

    // 扫描本地文件夹
    openDirectory() {
      this.fileTreeVisible = false
      this.fileTreeExpand = true
      this.rootDirName = ''
      this.$nextTick(() => {
        this.fileTreeVisible = true
      })
    },

    // 编辑指定文件
    editLocalFile(data) {
      if (data.handle) {
        fileHandle = data.handle
        this.readFile()
      }
    },

    // 导入指定文件
    async importLocalFile(data) {
      try {
        const file = await data.handle.getFile()
        this.$refs.ImportRef.onChange({
          raw: file,
          name: file.name
        })
        this.$refs.ImportRef.confirm()
      } catch (error) {
        console.log(error)
      }
    },

    // 打开本地文件
    async openLocalFile() {
      try {
        let [_fileHandle] = await window.showOpenFilePicker({
          types: [
            {
              description: '',
              accept: {
                'application/json': ['.smm']
              }
            }
          ],
          excludeAcceptAllOption: true,
          multiple: false
        })
        if (!_fileHandle) {
          return
        }
        fileHandle = _fileHandle
        if (fileHandle.kind === 'directory') {
          this.$message.warning(this.$t('toolbar.selectFileTip'))
          return
        }
        this.readFile()
      } catch (error) {
        console.log(error)
        if (error.toString().includes('aborted')) {
          return
        }
        this.$message.warning(this.$t('toolbar.notSupportTip'))
      }
    },

    // 读取本地文件
    async readFile() {
      let file = await fileHandle.getFile()
      let fileReader = new FileReader()
      fileReader.onload = async () => {
        this.$store.commit('setIsHandleLocalFile', true)
        this.setData(fileReader.result)
        Notification.closeAll()
        Notification({
          title: this.$t('toolbar.tip'),
          message: `${this.$t('toolbar.editingLocalFileTipFront')}${
            file.name
          }${this.$t('toolbar.editingLocalFileTipEnd')}`,
          duration: 0,
          showClose: true
        })
      }
      fileReader.readAsText(file)
    },

    // 渲染读取的数据
    setData(str) {
      try {
        let data = JSON.parse(str)
        if (typeof data !== 'object') {
          throw new Error(this.$t('toolbar.fileContentError'))
        }
        if (data.root) {
          this.isFullDataFile = true
        } else {
          this.isFullDataFile = false
          data = {
            ...exampleData,
            root: data
          }
        }
        this.$bus.$emit('setData', data)
      } catch (error) {
        console.log(error)
        this.$message.error(this.$t('toolbar.fileOpenFailed'))
      }
    },

    // 写入本地文件
    async writeLocalFile(content) {
      if (!fileHandle || !this.isHandleLocalFile) {
        this.waitingWriteToLocalFile = false
        return
      }
      if (!this.isFullDataFile) {
        content = content.root
      }
      const string = await stringifyJsonOffMainThread(content)
      const writable = await fileHandle.createWritable()
      await writable.write(string)
      await writable.close()
      this.waitingWriteToLocalFile = false
    },

    // 创建本地文件
    async createNewLocalFile() {
      await this.createLocalFile(exampleData)
    },

    // 另存为
    async saveLocalFile() {
      let data = getData()
      await this.createLocalFile(data)
    },

    // 创建本地文件
    async createLocalFile(content) {
      try {
        let _fileHandle = await window.showSaveFilePicker({
          types: [
            {
              description: '',
              accept: { 'application/json': ['.smm'] }
            }
          ],
          suggestedName: this.$t('toolbar.defaultFileName')
        })
        if (!_fileHandle) {
          return
        }
        const loading = this.$loading({
          lock: true,
          text: this.$t('toolbar.creatingTip'),
          spinner: 'el-icon-loading',
          background: 'rgba(0, 0, 0, 0.7)'
        })
        fileHandle = _fileHandle
        this.$store.commit('setIsHandleLocalFile', true)
        this.isFullDataFile = true
        await this.writeLocalFile(content)
        await this.readFile()
        loading.close()
      } catch (error) {
        console.log(error)
        if (error.toString().includes('aborted')) {
          return
        }
        this.$message.warning(this.$t('toolbar.notSupportTip'))
      }
    },

    onNodeNoteDblclick(node, e) {
      e.stopPropagation()
      this.$bus.$emit('showNodeNote', node)
    }
  }
}
</script>

<style lang="less" scoped>
.toolbarContainer {
  &.isDark {
    .toolbar {
      color: hsla(0, 0%, 100%, 0.9);
      .collabStatus {
        background: rgba(255, 255, 255, 0.06);
        border-color: rgba(255, 255, 255, 0.1);
        .more,
        .peerCount {
          color: hsla(0, 0%, 100%, 0.7);
        }
        .miniAvatar {
          border-color: #262a2e;
        }
      }
      .toolbarBlock {
        background-color: #262a2e;

        .fileTreeBox {
          background-color: #262a2e;

          /deep/ .el-tree {
            background-color: #262a2e;

            &.el-tree--highlight-current {
              .el-tree-node.is-current > .el-tree-node__content {
                background-color: hsla(0, 0%, 100%, 0.05) !important;
              }
            }

            .el-tree-node:focus > .el-tree-node__content {
              background-color: hsla(0, 0%, 100%, 0.05) !important;
            }

            .el-tree-node__content:hover,
            .el-upload-list__item:hover {
              background-color: hsla(0, 0%, 100%, 0.02) !important;
            }
          }

          .fileTreeWrap {
            .customTreeNode {
              .treeNodeInfo {
                color: #fff;
              }

              .treeNodeBtnList {
                .el-button {
                  padding: 7px 5px;
                }
              }
            }
          }
        }
      }

      .toolbarBtn {
        .icon {
          background: transparent;
          border-color: transparent;
        }

        &.cooperating {
          color: #67c23a;

          .icon {
            background: rgba(103, 194, 58, 0.15);
          }
        }

        &:hover {
          &:not(.disabled) {
            .icon {
              background: hsla(0, 0%, 100%, 0.05);
            }
          }
        }

        &.disabled {
          color: #54595f;
        }
      }
    }
  }
  .toolbar {
    position: fixed;
    left: 50%;
    transform: translateX(-50%);
    top: 20px;
    width: max-content;
    display: flex;
    font-size: 12px;
    font-family:
      PingFangSC-Regular,
      PingFang SC;
    font-weight: 400;
    color: rgba(26, 26, 26, 0.8);
    z-index: 2;
    .toolbarBlockWrapper {
      position: relative;
      margin-right: 20px;
      transition: transform 0.3s;

      &:last-of-type {
        margin-right: 0;
      }

      &.collapsed {
        transform: translateY(calc(-100% - 20px));
      }

      .collapseToggleBtn {
        position: absolute;
        left: 50%;
        top: calc(100% - 22px);
        width: 60px;
        height: 28px;
        padding: 0;
        border: 0;
        border-radius: 0 0 10px 10px;
        background-color: #409eff;
        color: #fff;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transform: translateX(-50%);
        transition: top 0.1s linear;
        z-index: 0;

        &:hover,
        &:focus-visible {
          top: calc(100% - 10px);
        }

        &:focus-visible {
          outline: 2px solid #409eff;
          outline-offset: 2px;
        }

        span {
          width: auto;
          height: auto;
          line-height: 1;
          font-size: 10px;
          transform: rotateZ(-90deg);
          transition: transform 0.1s;
        }

        &.collapsed span {
          transform: rotateZ(90deg);
        }
      }
    }

    .toolbarBlock {
      display: flex;
      background-color: #fff;
      padding: 10px 20px;
      border-radius: 6px;
      box-shadow: 0 2px 16px 0 rgba(0, 0, 0, 0.06);
      border: 1px solid rgba(0, 0, 0, 0.06);
      flex-shrink: 0;
      position: relative;
      z-index: 1;

      .fileTreeBox {
        position: absolute;
        left: 0;
        top: 68px;
        width: 100%;
        height: 30px;
        background-color: #fff;
        padding: 12px 5px;
        padding-top: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        border-radius: 5px;
        min-width: 200px;
        box-shadow: 0 2px 16px 0 rgba(0, 0, 0, 0.06);

        &.expand {
          height: 300px;

          .fileTreeWrap {
            visibility: visible;
          }
        }

        .fileTreeToolbar {
          width: 100%;
          height: 30px;
          flex-shrink: 0;
          display: flex;
          align-items: center;
          justify-content: space-between;
          border-bottom: 1px solid #e9e9e9;
          margin-bottom: 12px;
          padding-left: 12px;

          .fileTreeName {
          }

          .fileTreeActionList {
            .btn {
              font-size: 18px;
              margin-left: 12px;
              cursor: pointer;
            }
          }
        }

        .fileTreeWrap {
          width: 100%;
          height: 100%;
          overflow: auto;
          visibility: hidden;

          .customTreeNode {
            flex: 1;
            display: flex;
            align-items: center;
            justify-content: space-between;
            font-size: 13px;
            padding-right: 5px;

            .treeNodeInfo {
              display: flex;
              align-items: center;

              .treeNodeIcon {
                margin-right: 5px;
                opacity: 0.7;
              }

              .treeNodeName {
                max-width: 200px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
              }
            }

            .treeNodeBtnList {
              display: flex;
              align-items: center;
            }
          }
        }
      }
    }

    .toolbarBtn {
      display: flex;
      justify-content: center;
      flex-direction: column;
      cursor: pointer;
      margin-right: 20px;

      &:last-of-type {
        margin-right: 0;
      }

      &:hover {
        &:not(.disabled) {
          .icon {
            background: #f5f5f5;
          }
        }
      }

      &.active {
        .icon {
          background: #f5f5f5;
        }
      }

      &.cooperating {
        color: #67c23a;

        .icon {
          background: #f0f9eb;
        }
      }

      &.disabled {
        color: #bcbcbc;
        cursor: not-allowed;
        pointer-events: none;
      }

      .icon {
        display: flex;
        height: 26px;
        background: #fff;
        border-radius: 4px;
        border: 1px solid #e9e9e9;
        justify-content: center;
        flex-direction: column;
        text-align: center;
        padding: 0 5px;
      }

      .text {
        margin-top: 3px;
      }
    }

    .collabStatus {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-right: 16px;
      padding: 4px 8px 4px 6px;
      border-radius: 999px;
      background: rgba(15, 23, 42, 0.04);
      border: 1px solid rgba(15, 23, 42, 0.08);
      cursor: default;

      &.cooperating {
        border-color: rgba(16, 185, 129, 0.35);
      }

      .collabAvatars {
        display: flex;
        align-items: center;
        cursor: pointer;
      }

      .miniAvatar {
        width: 22px;
        height: 22px;
        margin-left: -6px;
        border-radius: 50%;
        color: #fff;
        font-size: 11px;
        line-height: 22px;
        text-align: center;
        border: 2px solid #fff;
        box-sizing: border-box;

        &:first-child {
          margin-left: 0;
        }
      }

      .more,
      .peerCount {
        margin-left: 4px;
        font-size: 11px;
        color: rgba(26, 26, 26, 0.65);
      }

      .saveChip {
        font-size: 11px;
        letter-spacing: 0.02em;
        white-space: nowrap;
      }

      &.saved .saveChip {
        color: #059669;
      }
      &.saving .saveChip {
        color: #d97706;
      }
      &.offline .saveChip {
        color: #64748b;
      }
      &.syncing .saveChip {
        color: #2563eb;
      }
      &.failed .saveChip {
        color: #dc2626;
      }
      .saveChip.clickable {
        cursor: pointer;
        text-decoration: underline;
        text-underline-offset: 2px;
      }
    }
  }
}

.collabPeerPopover {
  .peerHead {
    font-size: 12px;
    color: #64748b;
    margin-bottom: 8px;
  }
  .peerRow {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 0;
  }
  .miniAvatar {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    color: #fff;
    font-size: 11px;
    line-height: 22px;
    text-align: center;
    flex-shrink: 0;
  }
  .peerName {
    font-size: 13px;
  }
  .you {
    font-size: 11px;
    color: #94a3b8;
  }
  .empty {
    font-size: 12px;
    color: #94a3b8;
  }
}

@media (prefers-reduced-motion: reduce) {
  .toolbarContainer .toolbar .toolbarBlockWrapper,
  .toolbarContainer .toolbar .collapseToggleBtn,
  .toolbarContainer .toolbar .collapseToggleBtn span {
    transition: none;
  }
}
</style>

<style lang="less">
.collabDiagPopper {
  .collabDiag {
    font-size: 12px;
    color: #1f2937;
  }
  .diagHead {
    font-size: 13px;
    font-weight: 600;
    margin-bottom: 8px;
  }
  .diagRow {
    display: flex;
    gap: 8px;
    padding: 2px 0;
    line-height: 1.45;
    word-break: break-all;
  }
  .k {
    flex: 0 0 140px;
    color: #64748b;
    font-family: Consolas, 'SF Mono', monospace;
  }
  .v {
    flex: 1;
    font-family: Consolas, 'SF Mono', monospace;
  }
  .diagCopy {
    margin-top: 10px;
  }
}

.workbuddyJobDialog {
  .jobField {
    margin-bottom: 14px;
  }
  .jobLabel {
    display: block;
    margin-bottom: 6px;
    font-size: 13px;
    color: #606266;
  }
  .jobHint {
    margin: 6px 0 0;
    font-size: 12px;
    line-height: 1.5;
    color: #909399;
    &.warn {
      color: #e6a23c;
    }
  }
  .jobStatus {
    margin-top: 4px;
    font-size: 13px;
    line-height: 1.6;
    word-break: break-all;
  }
  .jobOk {
    color: #67c23a;
  }
  .jobWait {
    color: #e6a23c;
  }
  .jobErr {
    color: #f56c6c;
  }
  .jobResult {
    max-height: 320px;
    margin: 8px 0 0;
    padding: 10px;
    overflow: auto;
    font-size: 12px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
    background: #f5f7fa;
    border-radius: 4px;
  }
  code {
    padding: 1px 4px;
    font-size: 12px;
    background: #f5f7fa;
    border-radius: 3px;
  }

  .jobHistoryHead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
  }
  .jobHistory {
    max-height: 168px;
    overflow: auto;
    border: 1px solid #ebeef5;
    border-radius: 4px;
  }
  .jobHistoryRow {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    font-size: 12px;
    border-top: 1px solid #ebeef5;
    &.active {
      background: #f5f7fa;
    }
    &:first-child {
      border-top: 0;
    }
  }
  .jobHistoryRow .hDot {
    flex: 0 0 auto;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #c0c4cc;
    &.s-done,
    &.s-completed {
      background: #67c23a;
    }
    &.s-working,
    &.s-running,
    &.s-busy,
    &.s-active,
    &.s-pending {
      background: #e6a23c;
    }
    &.s-failed {
      background: #f56c6c;
    }
  }
  .jobHistoryRow .hName {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #303133;
  }
  .jobHistoryRow .hMeta {
    flex: 0 0 auto;
    color: #909399;
  }

  .jobForm.isDark {
    .jobLabel {
      color: hsla(0, 0%, 100%, 0.9);
    }
    .jobHint {
      color: hsla(0, 0%, 100%, 0.45);
      &.warn {
        color: #e0a94f;
      }
    }
    .jobResult,
    code {
      color: hsla(0, 0%, 100%, 0.85);
      background: #1e2226;
    }
    .jobHistory {
      border-color: #3a3a37;
    }
    .jobHistoryRow {
      border-top-color: #3a3a37;
      &.active {
        background: rgba(255, 255, 255, 0.06);
      }
    }
    .jobHistoryRow .hName {
      color: hsla(0, 0%, 100%, 0.85);
    }
    .jobHistoryRow .hMeta {
      color: hsla(0, 0%, 100%, 0.45);
    }
    .jobOk {
      color: #7bc99a;
    }
    .jobWait {
      color: #e0a94f;
    }
    .jobErr {
      color: #e08a8a;
    }
  }
}

.el-dialog__wrapper .workbuddyJobDialog .el-dialog__body {
  padding-top: 12px;
}

.el-dialog__wrapper .workbuddyJobDialog {
  .el-textarea__inner {
    font-family: inherit;
  }
}
</style>
