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
            <span class="icon">
              <i
                class="refreshIcon"
                :class="refreshing ? 'el-icon-loading' : 'el-icon-refresh'"
              ></i>
            </span>
            <span class="text">{{ $t('toolbar.refresh') }}</span>
          </div>
          <div
            class="toolbarBtn"
            data-testid="run-workbuddy-job"
            :class="{ disabled: isReadonly || jobDispatching }"
            :title="runButtonTitle"
            @click="runWorkbuddyJob()"
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
            data-testid="run-workbuddy-history"
            title="运行历史：左边是节点执行记录（可搜索），右边是内容，底部可继续执行"
            @click="openJobHistory"
            v-if="!isReadonly"
          >
            <span class="icon el-icon-time"></span>
            <span class="text">运行历史</span>
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
      title="运行历史"
      :visible.sync="jobHistoryVisible"
      width="900px"
      custom-class="workbuddyJobDialog jobHistoryDialog"
      append-to-body
      @closed="onJobHistoryClosed"
    >
      <div class="hist" :class="{ isDark: isDark }">
        <aside class="histLeft">
          <el-input
            v-model="jobSearch"
            size="mini"
            clearable
            placeholder="搜索节点 / 任务名 / 内容"
            prefix-icon="el-icon-search"
          ></el-input>
          <div class="histList">
            <div
              class="histItem"
              :class="{ active: item.id === jobActiveId }"
              v-for="item in filteredJobHistory"
              :key="item.id"
              @click="openHistoryItem(item)"
            >
              <span class="hDot" :class="jobStateClass(item)"></span>
              <span class="hName" :title="item.intent || ''">{{
                jobNodeText(item) || item.name || '(未命名)'
              }}</span>
              <span class="hMeta"
                >{{ jobStateText(item) }} · {{ jobTimeText(item) }}</span
              >
              <el-button
                v-if="isJobRunning(item)"
                class="hStop"
                type="text"
                size="mini"
                :loading="jobStopBusyId === item.id"
                @click.stop="stopHistoryItem(item)"
                >停止</el-button
              >
            </div>
            <p class="jobHint" v-if="!filteredJobHistory.length">
              {{
                jobHistoryLoading ? '读取中…' : jobHistoryError || '没有记录'
              }}
            </p>
          </div>
          <div class="histFoot">
            <span class="jobHint">{{ jobTargetLabel }}</span>
            <el-button type="text" size="mini" @click="loadJobHistory"
              >刷新</el-button
            >
          </div>
        </aside>
        <section class="histRight">
          <div class="histHead">
            <span class="histTitle">{{ activeJobTitle }}</span>
            <span class="histHeadBtns">
              <el-button
                v-if="jobActiveId"
                type="text"
                size="mini"
                :loading="jobWriteBusy"
                @click="rewriteActiveJob"
                >写入导图</el-button
              >
              <el-button
                v-if="jobFullText"
                type="text"
                size="mini"
                @click="copyJobResult"
                >{{ jobCopied ? '已复制' : '复制' }}</el-button
              >
            </span>
          </div>
          <div class="histWrite" v-if="jobWriteState || jobWriteError">
            <span class="wText" :class="jobWriteError ? 'jobErr' : 'jobOk'">{{
              jobWriteError || jobWriteState
            }}</span>
          </div>
          <div class="sessBox">
            <div class="sessHead" @click="toggleJobSessions">
              <i
                :class="
                  jobSessionsExpanded
                    ? 'el-icon-arrow-down'
                    : 'el-icon-arrow-right'
                "
              ></i>
              <span class="sessTitle">WorkBuddy 会话（端口）</span>
              <span class="sessMeta" v-if="jobSessionsLoading">读取中…</span>
              <span class="sessMeta" v-else-if="jobSessions.length">
                {{ jobSessions.length }} 个 · 运行中 {{ runningSessionCount
                }}<template v-if="jobSpawnInfo.limit"
                  > · 自动 {{ jobSpawnInfo.count }}/{{ jobSpawnInfo.limit }}</template
                >
              </span>
              <span class="sessMeta" v-else-if="jobSessionsError"
                >读不到（点开看原因）</span
              >
            </div>
            <div class="sessBody" v-if="jobSessionsExpanded">
              <p class="jobHint jobErr" v-if="jobSessionsError">
                {{ jobSessionsError }}
              </p>
              <div
                class="sessRow"
                v-for="s in jobSessions"
                :key="s.url"
                :class="{ picked: s.url === jobGateway }"
                :title="'点这一行 = 派发固定用它'"
                @click="chooseSession(s)"
              >
                <span
                  class="sessDot"
                  :class="s.running.length ? 'busy' : 'idle'"
                ></span>
                <span class="sessPort">:{{ s.port || '?' }}</span>
                <span class="sessName" :title="s.title || s.cwd">{{
                  s.title || s.cwd || '(未命名会话)'
                }}</span>
                <span
                  class="sessState"
                  :class="s.running.length ? 'busy' : 'idle'"
                >
                  {{
                    s.running.length
                      ? '运行中 · ' +
                        s.running
                          .map(j => jobNodeText(j) || j.name || j.id)
                          .join('、')
                      : '闲置'
                  }}
                </span>
                <span class="sessAuto" v-if="s.spawned" title="桥接自动起的会话"
                  >自动</span
                >
                <span class="sessUsing" v-if="s.url === jobGateway"
                  >派发用这条</span
                >
                <el-button
                  v-if="s.spawned"
                  class="sessKill"
                  type="text"
                  size="mini"
                  @click.stop="releaseSession(s)"
                  >回收</el-button
                >
              </div>
              <p
                class="jobHint"
                v-if="!jobSessions.length && !jobSessionsError && !jobSessionsLoading"
              >
                这台机器上没读到 WorkBuddy 会话（桌面版没开？）
              </p>
              <div class="sessFoot">
                <el-button
                  type="text"
                  size="mini"
                  :loading="jobSpawning"
                  :disabled="!canSpawnMore"
                  @click="createSession"
                  >新建会话</el-button
                >
                <el-button
                  type="text"
                  size="mini"
                  :loading="jobSessionsLoading"
                  @click="loadJobSessions"
                  >刷新</el-button
                >
              </div>
            </div>
          </div>
          <div
            class="histBody mdBody"
            v-if="jobActiveHtml"
            v-html="jobActiveHtml"
          ></div>
          <p class="jobHint" v-else-if="jobFullLoading">正在取内容…</p>
          <p class="jobHint" v-else>
            左侧选一条记录看内容；只有摘要时点「重取全文」。任务跑完会自动写到运行节点下。
          </p>
          <div class="histComposer">
            <el-input
              v-model="jobFollowPrompt"
              type="textarea"
              :rows="2"
              resize="none"
              placeholder="继续执行：写要接着做的事，Ctrl+Enter 或点右侧按钮"
              @keydown.native.ctrl.enter.prevent="runFollowUp"
            ></el-input>
            <div class="composerBar">
              <span class="jobHint" :class="jobStatusType">{{ jobStatus }}</span>
              <span class="composerBtns">
                <el-button
                  v-if="jobPending && jobPolling"
                  type="text"
                  size="mini"
                  @click="stopJob"
                  >停止</el-button
                >
                <el-button
                  v-else-if="activeJobRunning"
                  type="text"
                  size="mini"
                  :loading="jobStopBusyId === jobActiveId"
                  @click="stopHistoryItem(activeJobItem)"
                  >停止</el-button
                >
                <el-button
                  v-if="jobCurrentId && !jobPolling"
                  type="text"
                  size="mini"
                  :loading="jobFullLoading"
                  @click="loadJobFullText"
                  >重取全文</el-button
                >
                <el-button
                  type="primary"
                  size="small"
                  :loading="jobFollowDispatching"
                  :disabled="
                    !String(jobFollowPrompt).trim() || !jobSelectedHost
                  "
                  @click="runFollowUp"
                  >继续执行</el-button
                >
              </span>
            </div>
          </div>
        </section>
      </div>
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
import MarkdownIt from 'markdown-it'
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
  fetchJobArtifacts,
  attachFilesViaBridge,
  describeEmptyGateways,
  dispatchWorkbuddyJob,
  listSpawnedSessions,
  spawnHostSession,
  releaseHostSession
} from '@/utils/workbuddyJobBridge'
import { buildNodeRunPrompt, buildFollowUpPrompt } from '@/utils/mindmapRunPrompt'
import {
  lastTaskContainer,
  isFollowUpPlaceholder
} from '@/utils/jobResultWriter'

// 任务结果按 Markdown 渲染，配置与项目其他对话页保持一致
const jobMd = new MarkdownIt({ html: false, linkify: true, breaks: true })
const openLink = jobMd.renderer.rules.link_open
jobMd.renderer.rules.link_open = function (tokens, idx, options, env, self) {
  tokens[idx].attrSet('target', '_blank')
  tokens[idx].attrSet('rel', 'noopener noreferrer')
  return openLink
    ? openLink(tokens, idx, options, env, self)
    : self.renderToken(tokens, idx, options)
}

const JOB_POLL_INTERVAL = 2500
// 派发后在主机上一直找不到这条任务时的容忍次数（2.5s × 24 ≈ 1 分钟）。
// 任务记录是**执行主机的 WorkBuddy 内存里**的：WorkBuddy 重启、桥接重开、
// 换了会话，这条记录就查不到了 —— 再轮询下去永远不会结束，得停手并说清楚。
const JOB_POLL_MISS_LIMIT = 24
// 「没有可派端口（会话）」时不再干等 —— 直接让桥接起一个（见 autoSpawnSession）。
// 上限由桥接管（MAX_SPAWNED_SESSIONS=5，只算桥接自己起的）。
// 概要：点它 = 选中「按这条概要继续」，真正的派发还是由「运行」按钮触发
const GENERALIZATION_TEXT_LIMIT = 60

function clipJobText(text, limit = GENERALIZATION_TEXT_LIMIT) {
  const value = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}
// 执行位置固定为「这台电脑」，不再让用户选主机/任务
const LOCAL_JOB_HOST_KEY = '127.0.0.1:8799'

/** 会话地址（http://127.0.0.1:52369）→ 端口「52369」，取不到给空 */
function sessionPort(url) {
  const m = /:(\d+)\/?$/.exec(String(url || ''))
  return m ? m[1] : ''
}
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
      jobHosts: [],
      jobHostsLoading: false,
      jobHostsError: '',
      jobHostKey: '',
      jobGateways: [],
      jobGatewaysError: '',
      jobGateway: '',
      jobStatus: '',
      jobStatusType: 'jobOk',
      jobCurrentId: '',
      jobPollTimer: null,
      jobFullText: '',
      jobFullChars: 0,
      jobFullSource: '',
      jobFullLoading: false,
      jobCopied: false,
      jobHistoryVisible: false,
      jobHistory: [],
      jobHistoryLoading: false,
      jobHistoryError: '',
      jobSearch: '',
      jobActiveId: '',
      jobFollowPrompt: '',
      jobFollowDispatching: false,
      // 已经派出去、还在等结果的任务 —— **可以同时有好几条**。
      // 每条的 hostKey / gateway 都记在自己身上：现在会自动挑闲置会话、自动起会话，
      // 连着开几个任务很可能落在**不同**会话上，拿"当前选中的那条"去查必然查不到。
      // ⚠️ 以前这里只存一条，后一个任务会把前一个覆盖掉 —— 前几个跑完了没人写回导图
      //（2026-09-28 的真实故障：连开三个，只有最后一个有产物）。
      jobPendingList: [],
      // 最新那条查不到的次数（状态栏与提示用）
      jobPendingMiss: 0,
      // 一轮轮询没跑完就别再进来（写回要几秒，避免重复处理同一条）
      jobPollBusy: false,
      // 正在被「停止」的那条 id（行内停止按钮的 loading）
      jobStopBusyId: '',
      // 「派发固定用哪条会话」，按主机分；localStorage 的兜底（隐私模式下用它）
      rememberedSession: null,
      // 执行主机上的 WorkBuddy 会话（= 端口）一览：默认收起，点开看谁在跑谁闲置
      jobSessions: [],
      jobSessionsLoading: false,
      jobSessionsError: '',
      jobSessionsExpanded: false,
      // 桥接自动起的会话额度（「自动 X/5」；满了就不许再起）
      jobSpawnInfo: { count: 0, limit: 0, remaining: 0, canSpawn: true },
      jobSpawning: false,
      // 结果写回导图：运行节点 uid、写回状态、已写过的任务 id
      jobRunNodeUid: '',
      jobRunNodeTitle: '',
      jobWriteState: '',
      jobWriteError: '',
      jobWrittenJobId: '',
      jobWriteBusy: false,
      jobWriteResult: null,
      // 本次派发的任务内容（落点没落在任务容器里、需要现建时用它当容器里的任务内容）
      jobPendingPrompt: '',
      // 点过的概要 = 这次运行的「继续执行」指令来源 { ownerUid, genUid, title }
      jobGeneralization: null,
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

    /** 当前选中的节点（概要点不算节点，不能当运行落点） */
    activeJobNode() {
      const node = (this.activeNodes || [])[0]
      return node && !node.isGeneralization ? node : null
    },

    /** 「运行」按钮的悬停提示：选中过概要时说明这次是「接着这条概要继续」 */
    runButtonTitle() {
      const gen = this.jobGeneralization
      if (!gen) return '按当前选中节点直接派发到本机 WorkBuddy'
      return `点运行 → 接着「${gen.title || '当前节点'}」的概要继续执行（不是重跑 SOP）`
    },

    /** 执行主机上这个会话的工作目录（产物落在这里，写进提示词给它当输出目录） */
    jobGatewayCwd() {
      const gateway = (this.jobGateways || []).find(
        item => item.url === this.jobGateway
      )
      return (gateway && gateway.cwd) || ''
    },

    /** 还能不能再起自动会话（额度没用完） */
    canSpawnMore() {
      const info = this.jobSpawnInfo || {}
      if (info.canSpawn === false) return false
      if (!info.limit) return true
      return info.remaining > 0
    },

    /** 有几个会话正忙（头部的「运行中 N」用） */
    runningSessionCount() {
      return (this.jobSessions || []).filter(s => (s.running || []).length)
        .length
    },

    /** 只读展示「跑在哪台电脑的哪条任务」 */
    jobTargetLabel() {
      const host = this.jobSelectedHost
      if (!host) return this.jobHostsLoading ? '正在识别这台电脑…' : ''
      const gateway = (this.jobGateways || []).find(
        item => item.url === this.jobGateway
      )
      const name = (gateway && (gateway.title || gateway.cwd)) || ''
      return name ? `${name} · ${host.label}` : host.label
    },

    /** 右侧内容：Markdown 渲染 */
    jobActiveHtml() {
      const text = String(this.jobFullText || '')
      if (!text.trim()) return ''
      try {
        return jobMd.render(text)
      } catch (err) {
        return ''
      }
    },

    /** 左侧列表：按搜索词过滤（任务名 / 意图 / 内容 / id） */
    filteredJobHistory() {
      const key = String(this.jobSearch || '').trim().toLowerCase()
      const rows = this.jobHistory || []
      if (!key) return rows
      return rows.filter(item =>
        [item.name, item.intent, item.detail, item.id]
          .filter(Boolean)
          .some(text => String(text).toLowerCase().indexOf(key) !== -1)
      )
    },

    activeJobTitle() {
      const item = (this.jobHistory || []).find(x => x.id === this.jobActiveId)
      if (!item) return '内容'
      const name = item.name || '(未命名)'
      const when = this.jobTimeText(item)
      return when ? `${name} · ${when}` : name
    },

    jobPolling() {
      return this.jobPollTimer != null
    },

    /** 最近派出去、还在等结果的那条（状态栏和「停止」按钮看它） */
    jobPending() {
      const list = this.jobPendingList || []
      return list.length ? list[list.length - 1] : null
    },

    /** 还有几个任务在等结果 */
    jobPendingCount() {
      return (this.jobPendingList || []).length
    },

    /** 运行历史里当前选中的那条（底部「停止」按钮用） */
    activeJobItem() {
      return (
        (this.jobHistory || []).find(x => x.id === this.jobActiveId) || null
      )
    },

    /**
     * 选中的运行记录是否还在跑。
     *
     * ⚠️ 为什么需要它（2026-09-28）：底部那个「停止」按钮原来的条件是
     * `jobPending && jobPolling` —— 两者都是**本页面内存态**，只覆盖「这次打开页面
     * 之后自己派出去、且轮询还没停」的那一条。刷新页面 / 关掉面板再打开，历史列表里
     * 明明还挂着一条「执行中」，却**再也找不到停止按钮**。改成也认「选中的这条还在跑」。
     */
    activeJobRunning() {
      return !!this.activeJobItem && this.isJobRunning(this.activeJobItem)
    },

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
    // 概要点：点它只记下「按这条概要继续」，派发仍由「运行」按钮触发
    this.$bus.$on('node_click', this.onJobNodeClick)
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
    this.$bus.$off('node_click', this.onJobNodeClick)
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

    /** 概要点所属的那个节点（概要自己不能当运行落点） */
    generalizationOwner(node) {
      return (node && (node.generalizationBelongNode || node.parent)) || null
    },

    /**
     * 点概要点：只把「这条概要」记成这次的继续指令，不直接派发。
     * 派发交给工具栏「运行」按钮 —— 点概要 → 点运行，跑的是接着这条概要继续，
     * 而不是把整张脑图当 SOP 重跑一遍。
     */
    onJobNodeClick(node) {
      if (!node || !node.isGeneralization || this.isReadonly) return
      const owner = this.generalizationOwner(node)
      const ownerUid = String((owner && owner.getData && owner.getData('uid')) || '')
      if (!ownerUid) return
      this.jobGeneralization = {
        ownerUid,
        genUid: String((node.getData && node.getData('uid')) || ''),
        title: this.nodePlainTitle(owner)
      }
      const text = this.nodePlainTitle(node)
      if (text && !isFollowUpPlaceholder(text)) {
        this.$message.success(
          `已选中这条概要，点「运行」就按它继续执行：${clipJobText(text)}`
        )
      } else {
        this.$message.info(
          '这条概要还没写内容：双击概要写上「下一步做什么」，再点「运行」；不写就按节点默认任务跑。'
        )
      }
    },

    /**
     * 这次运行的指令：点过同节点的概要且写了内容 → 接着它继续；否则按节点默认任务。
     * 概要文字在运行时现取（双击改完文字也能拿到新的）。
     */
    async resolveRunPrompt(runNode) {
      const gen = this.jobGeneralization
      const uid = String((runNode && runNode.getData && runNode.getData('uid')) || '')
      if (gen && uid && gen.ownerUid === uid) {
        const text = await this.readGeneralizationText(gen)
        if (text && !isFollowUpPlaceholder(text)) {
          return { prompt: this.buildFollowUpJobPrompt(text, runNode), continued: true }
        }
        this.$message.info('概要里还没写内容，这次按节点默认任务跑')
      }
      return { prompt: this.buildDefaultJobPrompt(runNode), continued: false }
    },

    /** 向 Edit 要概要的最新文字（概要点数据其实存在所属节点的 generalization 里） */
    async readGeneralizationText(gen) {
      const box = { ok: false }
      this.$bus.$emit('read_generalization', {
        result: box,
        nodeUid: gen && gen.ownerUid,
        genUid: gen && gen.genUid
      })
      if (!box.promise) return ''
      try {
        const out = await box.promise
        if (!out || out.ok === false) return ''
        return getTextFromHtml(String(out.text || '')).trim()
      } catch (err) {
        return ''
      }
    },

    nodePlainTitle(node) {
      if (!node || typeof node.getData !== 'function') return ''
      return getTextFromHtml(node.getData('text') || '').trim()
    },

    /**
     * 按当前节点派发的任务内容：只做这一步，并把前面几步跑出来的结果当输入继续往下做
     * （不是把整张脑图当 SOP 从头再跑一遍）。组装逻辑在 utils/mindmapRunPrompt.js
     */
    buildDefaultJobPrompt(wanted = null) {
      const active = (this.activeNodes || [])[0]
      const selected =
        wanted || (active && !active.isGeneralization ? active : null)
      const room = String(
        (this.$route.query && this.$route.query.room) || ''
      ).trim()
      if (!selected) {
        return room
          ? `请分析并执行脑图房间「${room}」相关任务，给出可执行结论。`
          : '请分析当前脑图并给出可执行结论。'
      }
      return buildNodeRunPrompt({
        node: selected,
        room,
        cwd: this.jobGatewayCwd
      })
    },

    buildFollowUpJobPrompt(text, wanted = null) {
      const room = String(
        (this.$route.query && this.$route.query.room) || ''
      ).trim()
      const active = (this.activeNodes || [])[0]
      const node = wanted || (active && !active.isGeneralization ? active : null)
      if (!node) return String(text || '').trim()
      return buildFollowUpPrompt(text, {
        node,
        room,
        cwd: this.jobGatewayCwd
      })
    },

    /** 运行历史：左列表 + 右内容 + 底部继续执行 */
    async openJobHistory() {
      this.jobHistoryVisible = true
      this.jobSearch = ''
      await this.prepareLocalTarget()
      await this.loadJobHistory()
      const first = this.jobHistory[0]
      if (first) await this.openHistoryItem(first)
    },

    onJobHistoryClosed() {
      // 面板关了也继续等：跑完要写回导图；任务都结束后 pollJob 自己会停
      if (!(this.jobPendingList || []).length) this.stopJobPoll()
    },

    /** 选中一条记录 → 右侧取它的完整回答 */
    async openHistoryItem(item) {
      if (!item || !item.id) return
      this.jobActiveId = item.id
      this.jobCurrentId = item.id
      this.resetJobFullText()
      this.jobFullText = String(item.detail || '')
        .replace(/^result:\s*/i, '')
        .trim()
      if (this.isJobRunning(item)) {
        // 正在跑的交给 pollJob 盯（只盯本次派发的那个），这里只提示
        this.jobStatus = '这个任务还在跑，跑完会自动写入运行节点'
        this.jobStatusType = 'jobWait'
        return
      }
      await this.loadJobFullText()
    },

    /** 输入框里写内容 → 在同一位置继续派一个任务 */
    async runFollowUp() {
      const prompt = String(this.jobFollowPrompt || '').trim()
      if (!prompt || this.jobFollowDispatching) return
      const target = await this.ensureDispatchTarget()
      if (!target.ok) {
        this.$message.warning(target.error)
        return
      }
      const { host, gateway } = target
      this.jobFollowDispatching = true
      this.rememberRunTarget({ reuseContainer: true })
      this.jobStatus = '正在继续执行…'
      this.jobStatusType = 'jobWait'
      try {
        const promptText = this.buildFollowUpJobPrompt(prompt)
        const result = await dispatchWorkbuddyJob({
          host,
          gateway,
          prompt: promptText,
          name: `脑图运行 · ${
            this.nodePlainTitle(this.activeJobNode) || '继续'
          }`
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
        this.jobActiveId = jobId
        this.jobPendingPrompt = promptText
        this.addPendingJob({
          id: jobId,
          nodeUid: this.jobRunNodeUid,
          nodeTitle: this.jobRunNodeTitle
        })
        this.jobStatus = `已派发${jobId ? ` · ${jobId}` : ''}${this.pendingSuffix()}`
        this.jobStatusType = 'jobOk'
        this.jobFollowPrompt = ''
        await this.loadJobHistory()
        const created = this.jobHistory.find(item => item.id === jobId)
        if (created) await this.openHistoryItem(created)
      } catch (err) {
        this.jobStatus = `派发失败：${(err && err.message) || '未知错误'}`
        this.jobStatusType = 'jobErr'
      } finally {
        this.jobFollowDispatching = false
      }
    },

    /** 静默识别这台电脑上可派的会话（对应 test1.py 桥接的 /api/gateways） */
    async prepareLocalTarget() {
      this.jobHostsLoading = true
      this.jobHostsError = ''
      try {
        const res = await resolveJobHosts()
        this.jobHosts = res.hosts || []
        const local = this.jobHosts.find(
          item => item.key === LOCAL_JOB_HOST_KEY
        )
        // 默认派给本机；但本机桥接没跑时不能死盯着它 —— 局域网里别的电脑是好的，
        // 直接在点「运行」时报「连不上本机任务桥」等于把整条路堵死。
        const online = this.jobHosts.find(item => item.online)
        this.jobHostKey =
          (local && local.online && local.key) ||
          (online && online.key) ||
          (local && local.key) ||
          ''
        // 只要还有能用（在线）的主机，就不是错误，别弹红字吓人
        this.jobHostsError = online ? '' : res.error || ''
      } catch (err) {
        this.jobHosts = []
        this.jobHostKey = ''
        this.jobHostsError = (err && err.message) || '读取失败'
      } finally {
        this.jobHostsLoading = false
      }
      await this.loadJobGateways()
      if (!this.jobGateway) {
        this.jobStatus =
          this.jobHostsError ||
          this.jobGatewaysError ||
          '这台电脑上没有可派的 WorkBuddy 会话'
        this.jobStatusType = 'jobErr'
      }
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

    async loadJobGateways() {
      const host = this.jobSelectedHost
      this.jobGateways = []
      this.jobGateway = ''
      this.jobGatewaysError = ''
      if (!host) return
      const res = await listHostGateways(host)
      if (!res.ok) {
        this.jobGatewaysError = res.error || '读取失败'
      } else {
        this.jobGateways = res.gateways || []
        if (this.jobGateways.length) {
          this.jobGateway = this.pickJobGateway(
            this.jobGateways,
            this.recallSession(host)
          )
        } else {
          this.jobGatewaysError = describeEmptyGateways(res.diag, host)
        }
      }
      await this.loadJobHistory()
    },

    /** 记住「派发用哪条会话」的 key（按主机分，同一个浏览器开多个房间/主机不串） */
    sessionStoreKey(host) {
      return `mindmap-job-session:${(host && host.key) || 'default'}`
    },

    /** 上次派发用的那条会话（刷新页面也不变）；没记住就给空 */
    recallSession(host = null) {
      // 不传就当"当前选中的那台主机"（免得调用方忘记传，key 变成 default）
      const target = host || this.jobSelectedHost
      const key = this.sessionStoreKey(target)
      const remembered = this.rememberedSession
      if (remembered && remembered[key]) return remembered[key]
      try {
        // 隐私模式 / 单测里没有 window，取不到就当没记住
        return String(window.localStorage.getItem(key) || '')
      } catch (err) {
        return ''
      }
    },

    /** 记住/清掉「派发用哪条会话」 */
    rememberSession(url) {
      const host = this.jobSelectedHost
      const key = this.sessionStoreKey(host)
      const value = String(url || '')
      if (!this.rememberedSession) this.rememberedSession = {}
      if (value) this.rememberedSession[key] = value
      else delete this.rememberedSession[key]
      try {
        if (value) window.localStorage.setItem(key, value)
        else window.localStorage.removeItem(key)
      } catch (err) {
        /* 隐私模式写不进去，靠内存里那份兜着 */
      }
    },

    /**
     * 选一条派发用的会话（端口）—— **要稳定，别乱跳**。
     *
     * ⚠️ 2026-09-28 改：以前这里会「优先挑没在跑任务的那条」，结果用户看到的是
     * "每次运行端口都变了、像把上一个回收了换最新的，也不管上个任务跑完没"：
     * 桥接给的会话列表是按**心跳新鲜度**排的（刚用过那条排最前），页面一刷新
     * 顺序就变，按顺序挑自然每次都不一样。
     *
     * 现在：
     * ① 上次用的那条还在 → **就用它**（忙也用它，任务排在这条会话里就是了）
     * ② 不在了 → 用记住过的那条（localStorage，刷新页面也算数）
     * ③ 都没有 → 第一条
     * 想换端口：在「WorkBuddy 会话（端口）」里**点那一条**即选中并记住。
     */
    pickJobGateway(list, previous = '') {
      const rows = list || []
      if (!rows.length) return ''
      const kept = rows.find(item => item.url === previous)
      if (kept) return kept.url
      const remembered = this.recallSession(this.jobSelectedHost)
      const hit = rows.find(item => item.url === remembered)
      if (hit) return hit.url
      return rows[0].url
    },

    /** 手动指定派发用哪条会话（点会话栏那一行），并记住 */
    chooseSession(row) {
      if (!row || !row.url) return
      if (row.url === this.jobGateway) return
      this.jobGateway = row.url
      this.rememberSession(row.url)
      this.$message.success(
        `派发改用会话 :${row.port || '?'}（${
          row.title || row.cwd || '未命名'
        }）—— 以后一直用它`
      )
    },

    /**
     * 派发前确认有可用的会话（端口）。
     *
     * 「没有派发端口」要分两种，处理方式不一样：
     * - **桥接都没在线** → 等也没用，直接把原因给出来
     * - **桥接在线但还没会话** → 等一下再找：刚重启桥接、刚打开 WorkBuddy 的那几秒
     *   很常见，等到了就**直接派出去**，不用用户自己再点一次
     */
    async ensureDispatchTarget() {
      if (this.jobSelectedHost && this.jobGateway) {
        return {
          ok: true,
          host: this.jobSelectedHost,
          gateway: this.jobGateway
        }
      }
      // 桥接在线但没会话 → 直接**让桥接起一个**（点运行时优先构建会话，最多 5 个）。
      // 起完就用它派发，不用用户自己去桌面版开一条任务。
      const cur = this.jobSelectedHost
      let spawnError = ''
      if (cur && cur.online) {
        this.jobStatus = '这台机器上没有可派的会话，正在让桥接起一个…'
        this.jobStatusType = 'jobWait'
        const got = await this.autoSpawnSession()
        if (got.ok) {
          await this.prepareLocalTarget()
          if (this.jobSelectedHost && this.jobGateway) {
            return {
              ok: true,
              host: this.jobSelectedHost,
              gateway: this.jobGateway
            }
          }
        } else {
          spawnError = got.error || ''
        }
      }
      const host = this.jobSelectedHost
      return {
        ok: false,
        host,
        error:
          !host || !host.online
            ? this.jobHostsError ||
              '连不上这台机器的任务桥（桥接没在跑？双击 run_bridge.bat 后再点运行）'
            : spawnError ||
              this.jobGatewaysError ||
              '这台机器上没有可派的 WorkBuddy 会话，桥接也没能起新的 —— ' +
                '打开 WorkBuddy 桌面版（进一个对话）再试'
      }
    },

    /**
     * 这台电脑上的后台任务记录（含以前派发的）。
     * ⚠️ 拉取失败时**保留上一次的记录**，绝不先清空 —— 停任务时网关（刚被杀进程）
     * 会短暂不可用，那时候清空会让人以为历史记录全没了。
     */
    async loadJobHistory() {
      const host = this.jobSelectedHost
      if (!host) {
        this.jobHistory = []
        this.jobHistoryError = ''
        return
      }
      this.jobHistoryLoading = true
      try {
        const res = await listHostJobs({ host, gateway: this.jobGateway })
        if (!res.ok) {
          this.jobHistoryError = res.error || '拿不到运行记录'
          return
        }
        this.jobHistoryError = ''
        this.jobHistory = (res.jobs || [])
          .slice()
          .sort(
            (a, b) =>
              (b.updatedAt || b.startedAt || 0) -
              (a.updatedAt || a.startedAt || 0)
          )
          .slice(0, 20)
      } catch (err) {
        this.jobHistoryError = (err && err.message) || '拿不到运行记录'
      } finally {
        this.jobHistoryLoading = false
        // 会话（端口）那一栏如果展开着，顺手刷一下忙/闲
        if (this.jobSessionsExpanded) await this.loadJobSessions()
      }
    },

    /** 刚停完任务时网关要重建列表，第一次没拿到就等一下再拉（失败也不清空） */
    async refreshJobHistorySoon() {
      await this.loadJobHistory()
      if (!this.jobHistoryError || this._isDestroyed) return
      await new Promise(resolve => setTimeout(resolve, 900))
      if (this._isDestroyed) return
      await this.loadJobHistory()
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

    /** 记录来自哪个节点（派发时写进 intent 的「节点：xxx」） */
    jobNodeText(item) {
      const matched = String((item && item.intent) || '').match(
        /节点[:：]\s*(.+)/
      )
      return matched ? matched[1].trim() : ''
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

    /** 当前选中的节点 —— 运行结果的落点（概要点不是节点，跳过） */
    currentRunNodeUid() {
      const node = (this.activeNodes || [])[0]
      if (!node || node.isGeneralization) return ''
      if (typeof node.getData !== 'function') return ''
      return String(node.getData('uid') || '')
    },

    /**
     * 派发前记住落点。
     * 点「运行」时：落点就是当前节点，随后 prepareJobContainer 会新建「任务」容器并把落点
     * 换成容器 —— 运行输出永远紧跟这次的任务，不会甩在 SOP 末尾。
     * 「继续执行」时：接着当前最后一个任务容器往下做（reuseContainer）。
     */
    rememberRunTarget({ reuseContainer = false, node: wanted = null } = {}) {
      const active = (this.activeNodes || [])[0]
      const node = wanted || (active && !active.isGeneralization ? active : null)
      const uid = node
        ? String((node.getData && node.getData('uid')) || '')
        : ''
      if (uid) {
        this.jobRunNodeUid = uid
        this.jobRunNodeTitle = this.nodePlainTitle(node)
      }
      if (!node || !reuseContainer) return
      const container = lastTaskContainer(node)
      const containerUid = container && container.getData && container.getData('uid')
      if (containerUid) {
        this.jobRunNodeUid = String(containerUid)
        this.jobRunNodeTitle = this.nodePlainTitle(container)
      }
    },

    /**
     * 开跑前先建「任务 · 时间」容器节点：这次的任务内容与结果都挂在它下面，
     * 一次运行一个 —— 运行输出紧跟在任务后面。
     */
    async prepareJobContainer(prompt, wanted = null) {
      const active = (this.activeNodes || [])[0]
      const node = wanted || (active && !active.isGeneralization ? active : null)
      if (!node) return true
      const box = { ok: false }
      this.jobRunNodeUid = String((node.getData && node.getData('uid')) || '')
      this.jobRunNodeTitle = this.nodePlainTitle(node)
      this.$bus.$emit('create_job_container', {
        result: box,
        nodeUid: this.jobRunNodeUid,
        prompt
      })
      if (!box.promise) return false
      const out = await box.promise
      if (!out || out.ok === false) {
        const errText = (out && out.error) || '建任务节点失败'
        this.jobStatus = errText
        this.jobStatusType = 'jobErr'
        this.$message.error(errText)
        return false
      }
      this.jobRunNodeUid = out.uid || this.jobRunNodeUid
      this.jobRunNodeTitle = out.title || this.jobRunNodeTitle
      return true
    },

    /**
     * 任务跑完 → 把输出写回运行节点：节点下末尾追加「运行输出 · 时间」子分支，
     * 完整输出存成 .md、任务产出的文件一起挂成附件。同一条任务只写一次（force 除外）。
     */
    async writeJobResultToNode(job, options = {}) {
      // 默认用当前选中的主机/会话；多任务并行时调用方会把它自己那份传进来
      const host = options.host || this.jobSelectedHost
      const gateway = options.gateway || this.jobGateway
      const jobId = (job && job.id) || ''
      const nodeUid = options.nodeUid || this.jobRunNodeUid
      const nodeTitle = options.nodeTitle || this.jobRunNodeTitle
      if (!host || !jobId || this.jobWriteBusy) return
      if (!options.force && this.jobWrittenJobId === jobId) return
      const text = String(
        options.markdown != null ? options.markdown : this.jobFullText || ''
      ).trim()
      if (!text) {
        this.jobWriteError = '这次运行没有文字输出，没东西写进导图'
        return
      }
      this.jobWriteBusy = true
      this.jobWriteError = ''
      this.jobWriteState = '正在读取产物文件…'
      try {
        let artifacts = []
        let artifactSkips = []
        try {
          const res = await fetchJobArtifacts({ host, gateway, jobId })
          if (res && res.ok) {
            artifacts = res.files || []
            artifactSkips = res.skipped || []
          }
        } catch (err) {
          // 产物读不到不影响把文字写进去
        }
        this.jobWriteState = '正在写入导图…'
        const box = { ok: false }
        this.$bus.$emit('write_job_result', {
          result: box,
          nodeUid,
          markdown: text,
          prompt: options.prompt || this.jobPendingPrompt || '',
          job,
          artifacts,
          artifactSkips,
          // 附件优先经桥接的 MCP 通道挂（服务器部署时比协同服务上传那条路稳），
          // 桥接不通会自动退回原来的上传方式
          bridgeAttach: args => attachFilesViaBridge({ host, ...args }),
          onProgress: label => {
            if (label) this.jobWriteState = label
          }
        })
        if (!box.promise) throw new Error('当前页面没有导图，写不进去')
        const out = await box.promise
        if (!out || out.ok === false) {
          throw new Error((out && out.error) || '写入导图失败')
        }
        this.jobWrittenJobId = jobId
        this.jobWriteResult = out
        const missing = (out.missing || []).length
        this.jobWriteState = `已写入「${nodeTitle || '运行节点'}」：${out.title}（${
          out.nodes
        } 个节点${
          out.attachments.length ? `、${out.attachments.length} 个附件` : ''
        }${out.generalization ? '、已加概要（双击概要写下一步）' : ''}）`
        if (out.warnings && out.warnings.length) {
          const needService = out.warnings.some(item => /没挂上/.test(item))
          this.jobWriteError =
            out.warnings.join('；') +
            (needService
              ? '（附件要经过协同服务上传，确认 启动.bat 起了再试）'
              : '')
          this.$message.warning(this.jobWriteError)
        } else if (missing) {
          this.$message.warning(
            `还需要补 ${missing} 项数据（已列在「待补充数据」里）：${(out.missing || [])
              .slice(0, 3)
              .join('；')}`
          )
        } else {
          this.$message.success(this.jobWriteState)
        }
        if (this.jobHistoryVisible) await this.loadJobHistory()
      } catch (err) {
        this.jobWriteState = ''
        this.jobWriteError = (err && err.message) || '写入导图失败'
        this.$message.error(this.jobWriteError)
      } finally {
        this.jobWriteBusy = false
      }
    },

    /**
     * 手动重写某条记录（运行历史右上「写入导图」）。
     * 落点用**当前选中的节点** —— 上次派发的落点早过期了，拿它会把内容写错地方；
     * 所以也顺带修「附件没挂上」的老记录：选中那条记录原本的节点，再点这里重写即可。
     */
    async rewriteActiveJob() {
      const item = (this.jobHistory || []).find(x => x.id === this.jobActiveId)
      if (!item) return
      if (this.isJobRunning(item)) {
        this.$message.warning('这个任务还在跑，跑完再写')
        return
      }
      this.rememberRunTarget()
      if (!this.jobRunNodeUid) {
        this.$message.warning('先在图上选中要写入的那个节点，再点「写入导图」')
        return
      }
      const markdown = (await this.fetchJobText(item.id)) || this.jobFullText
      await this.writeJobResultToNode(item, { force: true, markdown })
      if (this.jobWriteError) this.$message.error(this.jobWriteError)
      else if (this.jobWriteState) this.$message.success(this.jobWriteState)
    },

    /**
     * 工具栏「运行」：不等弹窗，直接派发。
     * @param {Object} options
     * @param {Object} options.node   指定要跑的节点（点概要时传概要所属节点；默认当前选中）
     * @param {String} options.prompt 指定任务内容（点概要时用概要里写的「下一步」）
     */
    async runWorkbuddyJob(options = {}) {
      if (this.jobDispatching || this.isReadonly) return
      this.jobDispatching = true
      const active = (this.activeNodes || [])[0]
      const runNode =
        options.node || (active && !active.isGeneralization ? active : null)
      try {
        await this.prepareLocalTarget()
        // 没会话时不再直接拒绝：等一下再找，找到就派（见 ensureDispatchTarget）
        const target = await this.ensureDispatchTarget()
        if (!target.ok) {
          this.$message.warning(target.error)
          return
        }
        const { host, gateway } = target
        this.rememberRunTarget({ node: runNode })
        // 点过概要 → 接着它继续；否则按节点默认任务。两种都不重跑整张 SOP。
        let prompt = ''
        let continued = false
        if (options.prompt) {
          prompt = this.buildFollowUpJobPrompt(options.prompt, runNode)
          continued = true
        } else {
          const picked = await this.resolveRunPrompt(runNode)
          prompt = picked.prompt
          continued = picked.continued
        }
        // 先建「任务 · 时间」容器，这次的任务内容与结果都挂在它下面
        if (!(await this.prepareJobContainer(prompt, runNode))) return
        const result = await dispatchWorkbuddyJob({
          host,
          gateway,
          prompt,
          name: `脑图运行 · ${
            this.nodePlainTitle(runNode) || '当前节点'
          }${continued ? ' · 继续' : ''}`
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
        this.jobActiveId = jobId
        this.jobPendingPrompt = prompt
        this.addPendingJob({
          id: jobId,
          nodeUid: this.jobRunNodeUid,
          nodeTitle: this.jobRunNodeTitle
        })
        this.jobStatus = `${continued ? '已派发继续执行' : '已派发'}${
          jobId ? ` · ${jobId}` : ''
        } · 结果写到「${this.jobRunNodeTitle || '运行节点'}」下${this.pendingSuffix()}`
        this.jobStatusType = 'jobOk'
        this.$message.success(
          `${continued ? '已按概要继续执行' : '已派发'}${
            jobId ? ` · ${jobId}` : ''
          }，跑完结果挂在「${this.jobRunNodeTitle || '运行节点'}」下面`
        )
        if (this.jobHistoryVisible) await this.loadJobHistory()
        return
      } catch (err) {
        this.jobStatus = `派发失败：${(err && err.message) || '未知错误'}`
        this.jobStatusType = 'jobErr'
        this.$message.error(this.jobStatus)
      } finally {
        this.jobDispatching = false
      }
    },

    /** 展开/收起「WorkBuddy 会话（端口）」；展开时现拉一次 */
    toggleJobSessions() {
      this.jobSessionsExpanded = !this.jobSessionsExpanded
      if (this.jobSessionsExpanded) return this.loadJobSessions()
      return null
    },

    /**
     * 这台机器上**所有** WorkBuddy 会话（一个会话一个端口）+ 各自忙/闲。
     *
     * 会话从桥接 /api/gateways 拿；闲不闲看那个会话自己的任务列表里有没有在跑的
     * （JOB_RUNNING_STATES 或 alive）。所以「运行中」= 那个端口现在有事在干。
     */
    async loadJobSessions() {
      const host = this.jobSelectedHost
      this.jobSessionsLoading = true
      this.jobSessionsError = ''
      if (!host) {
        this.jobSessions = []
        this.jobSessionsLoading = false
        return
      }
      try {
        const res = await listHostGateways(host)
        if (!res.ok) {
          this.jobSessions = []
          this.jobSessionsError = res.error || '拿不到会话列表'
          return
        }
        const sessions = []
        // 串行查：会话通常个位数，别一波并发把桥接打满
        for (const gw of res.gateways || []) {
          const url = String((gw && gw.url) || '')
          const row = {
            url,
            port: sessionPort(url),
            title: (gw && (gw.title || gw.cwd)) || '',
            cwd: (gw && gw.cwd) || '',
            // 桥接自己起的会话：面板标「自动」并允许回收
            spawned: !!(gw && gw.spawned),
            pid: (gw && (gw.spawnedPid || gw.pid)) || 0,
            running: []
          }
          if (url) {
            const jobs = await listHostJobs({ host, gateway: url })
            row.running = (jobs.jobs || []).filter(item =>
              this.isJobRunning(item)
            )
          }
          sessions.push(row)
        }
        this.jobSessions = sessions
        if (typeof this.loadSpawnInfo === 'function') {
          await this.loadSpawnInfo(host)
        }
      } catch (err) {
        this.jobSessions = []
        this.jobSessionsError = (err && err.message) || '拿不到会话列表'
      } finally {
        this.jobSessionsLoading = false
      }
    },

    /** 自动会话额度（面板显示「自动 X/5」，也决定还能不能再起） */
    async loadSpawnInfo(host) {
      const res = await listSpawnedSessions(host)
      if (!res.ok) return res
      this.jobSpawnInfo = {
        count: res.count || 0,
        limit: res.limit || 0,
        remaining: res.remaining || 0,
        canSpawn: res.canSpawn !== false
      }
      return res
    },

    /**
     * 没有可派端口时**让桥接起一个**（点运行 → 优先构建会话，最多 5 个）。
     *
     * 以前这里是「等它自己出现」，现在直接起：会话就是一个 codebuddy --serve 进程，
     * 桥接起完会等它注册出端口（实测 ~2s）再回话，所以拿到就能派。
     */
    async autoSpawnSession() {
      const host = this.jobSelectedHost
      if (!host || !host.online) return { ok: false, error: '' }
      if (this.jobSpawning) return { ok: false, error: '' }
      // 额度以桥接**现报的**为准（面板里那份可能已经过期，限额判断不能靠它）
      if (typeof this.loadSpawnInfo === 'function') {
        await this.loadSpawnInfo(host)
      }
      const info = this.jobSpawnInfo || {}
      if (info.canSpawn === false) {
        return {
          ok: false,
          error:
            '这台机器上的桥接起不了会话（找不到 WorkBuddy 的 codebuddy —— ' +
            '用 WORKBUDDY_HOME / WORKBUDDY_CLI 指一下安装目录）'
        }
      }
      if (info.limit && !info.remaining) {
        return {
          ok: false,
          error: `自动起的会话已经到上限 ${info.limit} 个了 —— 先在会话栏里回收几个再运行`
        }
      }
      this.jobSpawning = true
      try {
        const res = await spawnHostSession({
          host,
          cwd: this.jobGatewayCwd || '',
          count: 1
        })
        if (res.limit !== undefined) {
          this.jobSpawnInfo = {
            count: res.count || 0,
            limit: res.limit || 0,
            remaining: res.remaining || 0,
            canSpawn: true
          }
        }
        if (!res.ok) return { ok: false, error: res.error || '' }
        this.jobStatus = `已让桥接起了一个新会话（${
          res.gateway && res.gateway.port ? ':' + res.gateway.port : res.gateway.url
        }），正在派发…`
        this.jobStatusType = 'jobWait'
        return { ok: true, item: res.gateway }
      } catch (err) {
        return { ok: false, error: (err && err.message) || '起会话失败' }
      } finally {
        this.jobSpawning = false
      }
    },

    /** 面板里手动「新建会话」 */
    async createSession() {
      const host = this.jobSelectedHost
      if (!host || !host.online) {
        this.$message.warning(this.jobHostsError || '这台机器的任务桥没在跑')
        return
      }
      const res = await spawnHostSession({
        host,
        cwd: this.jobGatewayCwd || '',
        count: 1
      })
      if (!res.ok) {
        this.$message.error(res.error || '起会话失败')
      } else {
        const item = res.gateway || {}
        this.$message.success(`已起一个新会话（${item.port ? ':' + item.port : item.url}）`)
      }
      await this.loadJobSessions()
    },

    /** 面板里「回收」一个自动起的会话 */
    async releaseSession(row) {
      const host = this.jobSelectedHost
      if (!host || !row) return
      const res = await releaseHostSession({ host, url: row.url, pid: row.pid })
      if (!res.ok) {
        this.$message.error(res.error || '回收失败')
        return
      }
      if (row.url === this.jobGateway) {
        this.jobGateway = ''
      }
      this.$message.success('已回收这个自动会话')
      await this.loadJobSessions()
      await this.loadJobGateways()
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

    /**
     * 轮询在主机上查不到这条任务 —— 那台机器上已经没有它了。
     *
     * 任务记录在执行主机的 WorkBuddy 内存里：WorkBuddy 重启、桥接重开、
     * 换了会话都会让记录消失。以前这里直接 return，于是永远轮询下去，
     * 界面上只停在「已派发…」，结果悄无声息地丢掉（用户看到的就是"没回传、
     * 运行历史也没记录"）。所以数到上限就停手，并把原因写在状态栏和提示里。
     * 计数**按条目算**（同时可能有好几条在等）。
     */
    notePendingJobMissing(entry, why = '') {
      if (!entry) return
      entry.miss = (entry.miss || 0) + 1
      this.jobPendingMiss = entry.miss
      if (entry.miss < JOB_POLL_MISS_LIMIT) {
        if (entry.miss === 6) {
          this.jobStatus = '已派发，等主机上报任务记录…'
          this.jobStatusType = 'jobWait'
        }
        return
      }
      this.jobPendingList = (this.jobPendingList || []).filter(
        x => x.id !== entry.id
      )
      const host = this.hostOfEntry(entry) || {}
      const label = host.label || host.key || '那台机器'
      const who = `「${entry.nodeTitle || '这个节点'}」`
      this.jobStatus = '没等到结果'
      this.jobStatusType = 'jobErr'
      this.jobWriteError = why
        ? `连不上 ${label} 的任务桥（${why}）—— ${who}这次没有写回导图，可以重跑一次。`
        : `${label} 的任务桥里找不到这条任务（WorkBuddy 或桥接重启过，任务记录会跟着消失）` +
          `—— ${who}这次没有写回导图，可以重跑一次。`
      this.$message.error(this.jobWriteError)
      if (!(this.jobPendingList || []).length) this.stopJobPoll()
      this.loadJobHistory()
    },

    /** 这条任务派到哪台机器上（用条目自己记的，不用当前选中的） */
    hostOfEntry(entry) {
      if (entry && entry.hostKey) {
        const hit = (this.jobHosts || []).find(h => h.key === entry.hostKey)
        if (hit) return hit
      }
      return this.jobSelectedHost
    },

    /** 记下一条"派出去等结果"的任务，并保证轮询在跑 */
    addPendingJob(entry) {
      if (!entry || !entry.id) return
      this.rememberSession(this.jobGateway)
      const list = (this.jobPendingList || []).filter(x => x.id !== entry.id)
      list.push(
        Object.assign(
          {
            miss: 0,
            at: Date.now(),
            // 派到哪个会话要记牢：下面轮询、取全文、写回产物都按它来
            hostKey: this.jobHostKey,
            gateway: this.jobGateway
          },
          entry
        )
      )
      this.jobPendingList = list
      this.jobPendingMiss = 0
      this.startJobPoll()
    },

    /** 「还有 N 个在跑」后缀（同时开多个任务时状态栏好看清） */
    pendingSuffix() {
      const n = (this.jobPendingList || []).length
      return n > 1 ? ` · 同时 ${n} 个在跑` : ''
    },

    /** 一条任务跑完了：取它自己的全文 → 写回它自己的容器 */
    async finishPendingJob(entry, cur, state) {
      const jobId = entry.id
      const detail = String((cur && cur.detail) || '').replace(/^result:\s*/i, '')
      const who = `「${entry.nodeTitle || '这个节点'}」`
      if (state === 'failed' || state === 'stopped') {
        this.jobStatus = state === 'failed' ? '执行失败' : '已停止'
        this.jobStatusType = 'jobErr'
        this.jobWriteState = ''
        this.jobWriteError =
          state === 'failed'
            ? `${who}那次运行失败了，没有写回导图`
            : `${who}那次运行被停止了，没有写回导图`
        this.$message.error(this.jobWriteError)
        this.loadJobHistory()
        return
      }
      this.jobStatus = `已完成（${state || 'done'}）`
      this.jobStatusType = 'jobOk'
      const markdown = (await this.fetchJobText(jobId, entry)) || detail
      if (this.jobCurrentId === jobId) {
        this.jobFullText = markdown || '没有文字结果'
        this.jobFullChars = (markdown || '').length
      }
      if (this.jobHistoryVisible && !this.jobActiveId) this.jobActiveId = jobId
      // 落到**这条任务自己的**容器下（nodeUid 是派发时就记下的）
      await this.writeJobResultToNode(
        { id: jobId },
        {
          nodeUid: entry.nodeUid,
          nodeTitle: entry.nodeTitle,
          markdown,
          host: this.hostOfEntry(entry),
          gateway: entry.gateway
        }
      )
      this.loadJobHistory()
    },

    /**
     * 轮询**所有**还在等结果的任务。
     *
     * ⚠️ 必须遍历列表，不能用单个槽位 —— 连着开多个任务时后一个会把前一个覆盖掉，
     * 前几个跑完了也没人写回导图（2026-09-28 实测：连开三个，只有最后一个有产物，
     * 另外两个任务其实都 `done` 了）。每条的 host/gateway 也按条目自己带的来查。
     */
    async pollJob() {
      const list = this.jobPendingList || []
      if (!list.length) {
        this.stopJobPoll()
        return
      }
      if (this.jobPollBusy) return
      this.jobPollBusy = true
      try {
        const finished = []
        let running = 0
        let missed = 0
        for (const entry of list.slice()) {
          const host = this.hostOfEntry(entry)
          if (!host) {
            this.notePendingJobMissing(entry, '找不到执行主机')
            continue
          }
          const res = await listHostJobs({ host, gateway: entry.gateway })
          if (!res.ok) {
            missed += 1
            this.notePendingJobMissing(entry, res.error || '拿不到任务列表')
            continue
          }
          const cur = (res.jobs || []).find(item => item.id === entry.id)
          if (!cur) {
            missed += 1
            this.notePendingJobMissing(entry, '')
            continue
          }
          entry.miss = 0
          const state = cur.state || cur.status || ''
          const isRunning =
            JOB_RUNNING_STATES.indexOf(state) !== -1 || cur.alive === true
          if (isRunning) {
            running += 1
            const detail = String(cur.detail || '').replace(/^result:\s*/i, '')
            // 面板正看着这条时，先把摘要顶上去
            if (detail && this.jobCurrentId === entry.id) {
              this.jobFullText = detail
            }
            continue
          }
          finished.push({ entry, cur, state })
        }
        // 先从列表里摘掉再写回：写回要几秒，别让下一轮轮询重复处理同一条
        if (finished.length) {
          const ids = finished.map(x => x.entry.id)
          this.jobPendingList = (this.jobPendingList || []).filter(
            x => ids.indexOf(x.id) === -1
          )
        }
        for (const item of finished) {
          await this.finishPendingJob(item.entry, item.cur, item.state)
        }
        // 这一轮没报"查不到"就把计数清零（不然会拿着上一轮的残留值误判）
        if (!missed) this.jobPendingMiss = 0
        // 还有在跑的就把状态顶成「执行中 · N 个在跑」——放在写回**之后**，
        // 否则会被 finishPendingJob 里的「已完成」盖掉（单测抓出来的）
        if (running) {
          this.jobStatus = `执行中 · ${running} 个在跑`
          this.jobStatusType = 'jobWait'
        }
        if (!(this.jobPendingList || []).length) this.stopJobPoll()
      } finally {
        this.jobPollBusy = false
      }
    },

    /**
     * 取某个任务的完整回答（只返回文本，不动界面状态）。
     * 传 entry 时按**它派发时那台主机/那条会话**去取 —— 多任务并行时各行其是。
     */
    async fetchJobText(jobId, entry = null) {
      const host = this.hostOfEntry(entry)
      if (!host || !jobId) return ''
      const res = await fetchJobTranscript({
        host,
        gateway: (entry && entry.gateway) || this.jobGateway,
        jobId
      })
      return (res && res.ok && res.text) || ''
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
        if (res.text) this.jobFullText = res.text
        this.jobFullChars = res.chars || this.jobFullText.length
        this.jobFullSource = res.source || ''
      } finally {
        this.jobFullLoading = false
      }
    },

    copyJobResult() {
      const text = this.jobFullText
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
      const pending = this.jobPending
      return this.stopJobById((pending && pending.id) || this.jobCurrentId)
    },

    /**
     * 从**运行历史列表**里停一条（2026-09-28 新增）。
     *
     * 与 `stopJob` 的区别：那个只认「本页面刚派出去、轮询还没停」的内存记录
     * （`jobPendingList` 不持久化），**刷新页面之后就什么也停不了** —— 用户看到的
     * 就是「历史里明明挂着执行中，却没有停止按钮」。
     * 这个直接按列表里那条的 id 停，刷新后照样可用；链路不变
     * （`stopJobById` → `stopHostJob` → 桥接 `/api/stop`），桥接成功后会把台账那条
     * 钉成 `stopped`，下一次拉列表就显示「已停止」。
     */
    async stopHistoryItem(item) {
      const id = (item && item.id) || ''
      if (!id || this.jobStopBusyId) return
      this.jobStopBusyId = id
      try {
        await this.stopJobById(id)
      } finally {
        this.jobStopBusyId = ''
      }
    },

    /** 停**全部**还在等结果的任务（同时开了好几个时用） */
    async stopAllPendingJobs() {
      const ids = (this.jobPendingList || []).map(x => x.id).filter(Boolean)
      for (const id of ids) {
        await this.stopJobById(id)
      }
      return ids.length
    },

    async stopJobById(jobId) {
      // 按条目定位到它派发时那台机器/那条会话（多任务并行时不能用当前选中的）
      const entry =
        (this.jobPendingList || []).find(x => x.id === jobId) || null
      const host = this.hostOfEntry(entry)
      if (!host || !jobId) return
      const res = await stopHostJob({
        host,
        gateway: (entry && entry.gateway) || this.jobGateway,
        id: jobId
      })
      if (res.ok) {
        if (jobId === this.jobCurrentId) {
          this.jobStatus = '已请求停止'
          this.jobStatusType = 'jobWait'
        }
        // 停止会让网关重建任务列表，这里带一次重试，别拉不到就把列表留着空
        this.refreshJobHistorySoon()
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

        .refreshIcon {
          display: inline-block;
          line-height: 1;
        }
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
  .jobHint {
    margin: 6px 0 0;
    font-size: 12px;
    line-height: 1.5;
    color: #909399;
    &.warn {
      color: #e6a23c;
    }
  }
  .jobTarget {
    margin: 0 0 12px;
    font-size: 12px;
    line-height: 1.5;
    color: #909399;
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
  code {
    padding: 1px 4px;
    font-size: 12px;
    background: #f5f7fa;
    border-radius: 3px;
  }

  /* 两栏：左边执行记录（可搜索），右边内容，底部继续执行 */
  .hist {
    display: flex;
    gap: 14px;
    height: 560px;
    min-height: 0;

    &.isDark {
      .jobHint {
        color: hsla(0, 0%, 100%, 0.45);
        &.warn {
          color: #e0a94f;
        }
      }
      .jobTarget {
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
      code {
        color: hsla(0, 0%, 100%, 0.85);
        background: #1e2226;
      }
      .histList {
        border-color: #3a3a37;
      }
      .histItem {
        border-top-color: #3a3a37;
        &:hover {
          background: rgba(255, 255, 255, 0.04);
        }
        &.active {
          background: rgba(255, 255, 255, 0.09);
        }
      }
      .histItem .hName {
        color: hsla(0, 0%, 100%, 0.85);
      }
      .histItem .hMeta {
        color: hsla(0, 0%, 100%, 0.45);
      }
      .histHead {
        color: hsla(0, 0%, 100%, 0.7);
        border-bottom-color: #3a3a37;
      }
      .sessBox {
        border-color: #3a3a37;
      }
      .sessHead {
        background: rgba(255, 255, 255, 0.04);
        &:hover {
          background: rgba(255, 255, 255, 0.08);
        }
      }
      .sessTitle {
        color: hsla(0, 0%, 100%, 0.8);
      }
      .sessRow {
        border-top-color: #3a3a37;
        &:hover {
          background: rgba(255, 255, 255, 0.06);
        }
        &.picked {
          background: rgba(127, 168, 232, 0.14);
        }
      }
      .sessName {
        color: hsla(0, 0%, 100%, 0.85);
      }
      .sessState {
        color: #7bc99a;
        &.idle {
          color: hsla(0, 0%, 100%, 0.45);
        }
      }
      .sessAuto {
        color: #e0a94f;
        border-color: #5a4a2a;
      }
      .histBody {
        color: hsla(0, 0%, 100%, 0.85);
        background: #1e2226;
      }
      .histWrite .wText {
        color: hsla(0, 0%, 100%, 0.6);
        &.jobOk {
          color: #7bc99a;
        }
        &.jobErr {
          color: #e08a8a;
        }
      }
      .mdBody {
        pre,
        code {
          background: #14181c;
        }
        blockquote {
          color: hsla(0, 0%, 100%, 0.6);
          border-left-color: #4a4a48;
        }
        table {
          th,
          td {
            border-color: #3a3a37;
          }
          th {
            background: #14181c;
          }
        }
        hr {
          border-top-color: #3a3a37;
        }
        a {
          color: #7fa8e8;
        }
      }
    }
  }

  .histLeft {
    display: flex;
    flex: 0 0 268px;
    flex-direction: column;
    min-width: 0;
  }
  /* WorkBuddy 会话（端口）一览：默认收起，点开看哪个端口在跑、哪个闲着 */
  .sessBox {
    margin-bottom: 10px;
    overflow: hidden;
    font-size: 12px;
    border: 1px solid #ebeef5;
    border-radius: 4px;
  }
  .sessHead {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    cursor: pointer;
    background: #f7f9fc;
    &:hover {
      background: #eef3fa;
    }
  }
  .sessTitle {
    font-weight: 500;
    color: #606266;
  }
  .sessMeta {
    margin-left: auto;
    color: #909399;
  }
  .sessBody {
    padding: 4px 8px 6px;
  }
  .sessRow {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 0;
    cursor: pointer;
    border-top: 1px solid #f2f4f8;
    &:first-child {
      border-top: 0;
    }
    &:hover {
      background: #f7f9fc;
    }
    &.picked {
      background: #eef3fa;
    }
  }
  .sessDot {
    flex: 0 0 auto;
    width: 7px;
    height: 7px;
    background: #c0c4cc;
    border-radius: 50%;
    &.busy {
      background: #67c23a;
    }
  }
  .sessPort {
    flex: 0 0 auto;
    color: #909399;
    font-family: Menlo, Consolas, monospace;
  }
  .sessName {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    color: #303133;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sessState {
    flex: 0 0 auto;
    color: #67c23a;
    &.idle {
      color: #909399;
    }
  }
  .sessUsing {
    flex: 0 0 auto;
    color: #409eff;
  }
  .sessAuto {
    flex: 0 0 auto;
    padding: 0 4px;
    color: #e6a23c;
    line-height: 16px;
    border: 1px solid #f0c78a;
    border-radius: 2px;
  }
  .sessKill {
    flex: 0 0 auto;
    padding: 0;
  }
  .sessFoot {
    padding-top: 4px;
    text-align: right;
  }
  .histList {
    flex: 1;
    margin-top: 8px;
    overflow: auto;
    border: 1px solid #ebeef5;
    border-radius: 4px;
  }
  .histItem {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 8px;
    font-size: 12px;
    cursor: pointer;
    border-top: 1px solid #ebeef5;
    &:first-child {
      border-top: 0;
    }
    &:hover {
      background: #f7f9fc;
    }
    &.active {
      background: #ecf2fb;
    }
  }
  .histItem .hDot {
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
    // 「已停止」：默认灰点是 #c0c4cc，跟「未知状态」分不开，用深一档的灰
    // （2026-09-28：桥接新增 stopped 状态后才用得上）
    &.s-stopped {
      background: #909399;
    }
  }
  // 行内「停止」：只在运行中的条目上出现，别被 hName 的省略号吃掉
  .histItem .hStop {
    flex: 0 0 auto;
    margin-left: 6px;
    padding: 0 4px;
    font-size: 12px;
  }
  .histItem .hName {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #303133;
  }
  .histItem .hMeta {
    flex: 0 0 auto;
    color: #909399;
  }
  .histFoot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-top: 6px;
  }

  .histRight {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
  }
  .histHead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding-bottom: 6px;
    font-size: 13px;
    color: #606266;
    border-bottom: 1px solid #ebeef5;
  }
  .histTitle {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .histHeadBtns {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  /* 写回导图的状态行 */
  .histWrite {
    margin-top: 6px;
    font-size: 12px;
    line-height: 1.5;
  }
  .histWrite .wText {
    color: #606266;
    &.jobOk {
      color: #529b2e;
    }
    &.jobErr {
      color: #c45656;
    }
  }
  .histBody {
    flex: 1;
    margin-top: 8px;
    padding: 10px;
    overflow: auto;
    font-size: 12.5px;
    line-height: 1.65;
    word-break: break-word;
    background: #f5f7fa;
    border-radius: 4px;
  }
  .histComposer {
    margin-top: 10px;
  }
  .composerBar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-top: 6px;
  }
  .composerBar .jobHint {
    flex: 1;
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .composerBtns {
    flex: 0 0 auto;
    white-space: nowrap;
  }

  /* Markdown 渲染：pre-wrap 会把标签间换行撑成空行，这里必须正常排版 */
  .mdBody {
    white-space: normal;
    > :first-child {
      margin-top: 0;
    }
    > :last-child {
      margin-bottom: 0;
    }
    h1,
    h2,
    h3,
    h4,
    h5,
    h6 {
      margin: 14px 0 8px;
      font-weight: 600;
      line-height: 1.35;
    }
    h1 {
      font-size: 17px;
    }
    h2 {
      font-size: 15px;
    }
    h3 {
      font-size: 14px;
    }
    h4,
    h5,
    h6 {
      font-size: 13px;
    }
    p {
      margin: 0 0 8px;
    }
    ul,
    ol {
      margin: 0 0 8px;
      padding-left: 20px;
    }
    li {
      margin: 2px 0;
    }
    li > ul,
    li > ol {
      margin: 2px 0;
    }
    pre {
      margin: 8px 0;
      padding: 10px;
      overflow: auto;
      background: #e9edf2;
      border-radius: 6px;
      code {
        padding: 0;
        background: transparent;
      }
    }
    code {
      padding: 1px 4px;
      font-family: Consolas, 'SF Mono', monospace;
      font-size: 12px;
      background: #e9edf2;
      border-radius: 3px;
    }
    blockquote {
      margin: 8px 0;
      padding: 4px 10px;
      color: #606266;
      border-left: 3px solid #dcdfe6;
    }
    table {
      width: 100%;
      margin: 8px 0;
      font-size: 12px;
      border-collapse: collapse;
      th,
      td {
        padding: 5px 8px;
        text-align: left;
        vertical-align: top;
        word-break: break-word;
        border: 1px solid #dcdfe6;
      }
      th {
        font-weight: 600;
        background: #e9edf2;
      }
    }
    hr {
      margin: 12px 0;
      border: 0;
      border-top: 1px solid #dcdfe6;
    }
    a {
      color: #409eff;
    }
    img {
      max-width: 100%;
    }
  }
}
</style>
