<template>
  <div class="toolbarContainer" :class="{ isDark: isDark }">
    <div class="toolbar" ref="toolbarRef">
      <!-- 节点操作 -->
      <div
        class="toolbarBlockWrapper nodeToolbarWrapper"
        :class="{ collapsed: nodeToolbarCollapsed }"
        v-if="!isReadonly"
      >
        <div class="toolbarBlock" ref="nodeToolbarBlock">
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
              <span class="icon el-icon-more moreIcon"></span>
              <span class="text">{{ $t('toolbar.more') }}</span>
            </div>
          </el-popover>
        </div>
      </div>
      <!-- 文件与协作操作 -->
      <div
        class="toolbarBlockWrapper fileToolbarWrapper"
        :class="{ collapsed: fileToolbarCollapsed }"
      >
        <div class="toolbarBlock" ref="fileToolbarBlock">
          <button
            type="button"
            class="collapseToggleBtn"
            :class="{ collapsed: fileToolbarCollapsed }"
            :title="fileToolbarCollapsed ? $t('toolbar.expandToolbar') : $t('toolbar.collapseToolbar')"
            :aria-label="fileToolbarCollapsed ? $t('toolbar.expandToolbar') : $t('toolbar.collapseToolbar')"
            :aria-expanded="String(!fileToolbarCollapsed)"
            @click.stop="toggleFileToolbar"
          >
            <span class="iconfont iconjiantouyou"></span>
          </button>
          <div
            class="collabStatus"
            data-testid="collab-status"
            :class="[displayedSaveChip, { cooperating: collabLive }]"
          >
            <el-popover
              placement="bottom"
              width="240"
              trigger="hover"
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
              <button
                slot="reference"
                type="button"
                class="collabPresence"
                data-testid="collab-peers"
                :aria-label="$t('cooperate.onlineCount', { count: collabPeers.length })"
              >
                <span class="avatarStack" aria-hidden="true">
                  <span
                    v-for="peer in visibleCollabPeers"
                    :key="peer.id"
                    class="miniAvatar"
                    :style="peerAvatarStyle(peer)"
                  >{{ peer.shortName || '?' }}</span>
                </span>
                <span class="peerCount">{{ $t('cooperate.onlineCount', { count: collabPeers.length }) }}</span>
              </button>
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
          <ToolbarFileBtnList
            :list="fileHorizontalActions"
            :is-dark="isDark"
            @select="onFileToolbarAction"
          />
          <el-popover
            v-if="fileVerticalActions.length"
            v-model="filePopoverShow"
            placement="bottom-end"
            width="120"
            trigger="hover"
          >
            <ToolbarFileBtnList
              dir="v"
              :list="fileVerticalActions"
              :is-dark="isDark"
              @select="onFileToolbarAction"
            />
            <div slot="reference" class="toolbarBtn fileMoreBtn">
              <span class="icon el-icon-more moreIcon"></span>
              <span class="text">{{ $t('toolbar.more') }}</span>
            </div>
          </el-popover>
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
      :visible.sync="jobHistoryVisible"
      width="960px"
      :custom-class="`workbuddyJobDialog jobHistoryDialog${isDark ? ' isDark' : ''}`"
      append-to-body
      @closed="onJobHistoryClosed"
    >
      <div slot="title" class="histDialogTitle">
        <span class="histEyebrow">WORKBUDDY · 执行记录</span>
        <span class="histHeading">运行历史</span>
        <span class="histCount">{{ jobHistory.length }} 条</span>
      </div>
      <div class="hist" :class="{ isDark: isDark }">
        <aside class="histLeft">
          <div class="histSidebarHead">
            <strong>执行记录</strong>
            <button
              type="button"
              class="histRefresh"
              :disabled="jobHistoryLoading"
              aria-label="刷新运行历史"
              @click="loadJobHistory"
            >
              <i :class="jobHistoryLoading ? 'el-icon-loading' : 'el-icon-refresh'"></i>
              刷新
            </button>
          </div>
          <el-input
            v-model="jobSearch"
            size="mini"
            clearable
            placeholder="搜索节点 / 任务名 / 内容"
            prefix-icon="el-icon-search"
            data-testid="run-history-search"
          ></el-input>
          <div class="histListCount" aria-live="polite">
            {{ jobSearch ? `找到 ${filteredJobHistory.length} 条` : `共 ${jobHistory.length} 条记录` }}
          </div>
          <div class="histList">
            <button
              type="button"
              class="histItem"
              :class="{ active: item.id === jobActiveId }"
              v-for="item in filteredJobHistory"
              :key="item.id"
              :aria-pressed="String(item.id === jobActiveId)"
              @click="openHistoryItem(item)"
            >
              <span class="hDot" :class="jobStateClass(item)"></span>
              <span class="histItemText">
                <span class="hName" :title="item.intent || ''">{{
                  jobNodeText(item) || item.name || '(未命名)'
                }}</span>
                <span class="hMeta">{{ jobTimeText(item) }}</span>
              </span>
              <span class="hState" :class="jobStateClass(item)" :title="item.detail || ''">{{ jobStateText(item) }}</span>
              <el-button
                v-if="isJobRunning(item)"
                class="hStop"
                type="text"
                size="mini"
                :loading="jobStopBusyId === item.id"
                @click.stop="stopHistoryItem(item)"
                >停止</el-button
              >
            </button>
            <div class="histEmpty" v-if="!filteredJobHistory.length">
              <i :class="jobHistoryLoading ? 'el-icon-loading' : 'el-icon-tickets'"></i>
              <strong>{{ jobHistoryLoading ? '正在读取记录' : jobHistoryError ? '暂时无法读取' : jobSearch ? '没有匹配的记录' : '还没有运行记录' }}</strong>
              <p>{{ jobHistoryError || (jobSearch ? '换个关键词试试' : '运行节点后，记录会显示在这里') }}</p>
            </div>
          </div>
          <div class="histFoot">
            <span class="jobHint" :title="jobTargetLabel">{{ jobTargetLabel || '尚未识别执行主机' }}</span>
          </div>
        </aside>
        <section class="histRight">
          <div class="histHead">
            <div class="histHeadInfo">
              <span class="histEyebrow">执行结果</span>
              <strong class="histTitle" :title="activeJobTitle">{{ activeJobTitle }}</strong>
            </div>
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
                <span
                  class="sessAuto"
                  v-if="s.spawned"
                  title="桥接自动起的无头会话：不落回执，结果要等几分钟兜回来（产物在它的 output/ 下）"
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
                这台机器上没读到 WorkBuddy 会话（桌面版没开？自动会话已停用）
              </p>
              <p class="jobHint" v-if="(jobQueue || []).length">
                排队等待派发：{{ (jobQueue || []).length }} 个（按顺序执行，上一个跑完自动派下一个）
              </p>
              <div class="sessFoot">
                <!-- 「新建会话」按钮已按用户要求撤掉（2026-09-29）：桥接起的自动会话
                     在旧版 WorkBuddy 上走 runs 回退通道，任务进不去、状态不更新，
                     一律不再创建。要加会话请在执行机上打开 WorkBuddy 桌面版。 -->
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
          <div class="histDetailEmpty" v-else-if="jobFullLoading">
            <i class="el-icon-loading"></i><span>正在读取执行内容…</span>
          </div>
          <div class="histDetailEmpty" v-else>
            <i class="el-icon-document"></i>
            <strong>{{ jobActiveId ? '暂无完整内容' : '选择一条运行记录' }}</strong>
            <span>{{ jobActiveId ? '可尝试点击“重取全文”' : '在左侧查看节点执行结果和后续任务' }}</span>
          </div>
          <div class="histComposer">
            <label class="histComposerLabel">继续执行</label>
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
    <CPDCheckPanel
      ref="cpdCheckPanel"
      :room-key="cpdRoomKey"
      :node-uid="activeJobNodeUid"
      :node-title="activeJobNode ? nodePlainTitle(activeJobNode) : ''"
      :readonly="isReadonly"
      :before-check="waitForCpdSnapshot"
    ></CPDCheckPanel>
    <!-- 运行通道选择（2026-10-08 用户要求）：默认助理（OpenClaw） -->
    <el-dialog
      title="用哪种方式执行？"
      :visible.sync="runChannelVisible"
      width="460px"
      append-to-body
      :close-on-click-modal="false"
      @close="cancelRunChannel"
    >
      <div class="runChannelBox">
        <label
          class="runChannelItem"
          :class="{ active: runChannelPick === 'openclaw' }"
        >
          <input
            type="radio"
            value="openclaw"
            v-model="runChannelPick"
            class="runChannelRadio"
          />
          <span class="runChannelBody">
            <span class="runChannelTitle">
              助理（OpenClaw）
              <span class="runChannelTag">默认</span>
            </span>
            <span class="runChannelDesc"
              >直连助理流式执行，出结果快；正文和产出的文件都写回导图</span
            >
          </span>
        </label>
        <label
          class="runChannelItem"
          :class="{ active: runChannelPick === 'bridge' }"
        >
          <input
            type="radio"
            value="bridge"
            v-model="runChannelPick"
            class="runChannelRadio"
          />
          <span class="runChannelBody">
            <span class="runChannelTitle">桥接（执行机的 WorkBuddy）</span>
            <span class="runChannelDesc"
              >派到执行机的 WorkBuddy 会话跑，执行机上产出的文件会挂成附件</span
            >
          </span>
        </label>
      </div>
      <div slot="footer">
        <el-button size="small" @click="cancelRunChannel">取消</el-button>
        <el-button size="small" type="primary" @click="confirmRunChannel"
          >开始运行</el-button
        >
      </div>
    </el-dialog>
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
import CPDCheckPanel from './CPDCheckPanel.vue'
import { mapState } from 'vuex'
import { Notification } from 'element-ui'
import MarkdownIt from 'markdown-it'
import exampleData from 'simple-mind-map/example/exampleData'
import { getData } from '../../../api'
import ToolbarNodeBtnList from './ToolbarNodeBtnList.vue'
import ToolbarFileBtnList from './ToolbarFileBtnList.vue'
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
  fetchRecentArtifacts,
  attachFilesViaBridge,
  describeEmptyGateways,
  dispatchWorkbuddyJob,
  listSpawnedSessions,
  spawnHostSession,
  releaseHostSession
} from '@/utils/workbuddyJobBridge'
import {
  buildNodeRunPrompt,
  buildFollowUpPrompt,
  withCpdAdvisor
} from '@/utils/mindmapRunPrompt'
import {
  lastTaskContainer,
  isFollowUpPlaceholder
} from '@/utils/jobResultWriter'
import { streamChat } from '@/utils/agentChat'

/**
 * 运行通道（2026-10-08 用户要求）：点「运行」先选走哪条路，**默认助理（OpenClaw）**。
 *   助理：直连 OpenClaw 流式执行（没有派发/轮询/回执那套），正文回来就写回导图
 *   桥接：派到执行机的 WorkBuddy 会话（老路子，支持产物附件回传）
 */
const RUN_CHANNEL_STORE = 'mindmap:runChannel'
const RUN_CHANNEL_OPENCLAW = 'openclaw'
const RUN_CHANNEL_BRIDGE = 'bridge'

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

/**
 * 会话地址归一化：去尾斜杠 + 主机小写，用来跨接口对同一个会话。
 * 桥接的 /api/gateways 与 /api/sessions/spawned 都回 `http://127.0.0.1:<port>`，
 * 但一个是回环、一个可能带尾斜杠，字符串直接比会漏。
 */
function normSessionUrl(url) {
  return String(url || '')
    .trim()
    .replace(/\/+$/, '')
    .toLowerCase()
}
const JOB_RUNNING_STATES = ['working', 'busy', 'active', 'running', 'pending']

/**
 * 明确表示「已经结束了」的状态。
 *
 * 为什么需要它（2026-09-29 实测）：任务里 `alive` 的含义是「这个 run 还挂在会话上」，
 * 而任务跑完后它**可能仍是 true**（那台旧版桥接回的就是恒 true）。判断在不在跑时
 * 若把 state 与 alive 用 `||` 连起来，任务就永远显示「执行中」——
 * 前端也就**永远不触发回写**，用户看到的是「跑完了不回写 / 一直卡在已派发」。
 * 所以 state 一旦是终态，一律按「跑完了」处理。
 */
const JOB_FINISHED_STATES = [
  'done',
  'completed',
  'complete',
  'success',
  'succeeded',
  'failed',
  'error',
  'stopped',
  'canceled',
  'cancelled',
  'aborted'
]

/**
 * 这条会话是不是「桥接自动起的」（面板里标「自动」的那种 headless 实例）。
 *
 * 为什么要单独认它（2026-09-29 现场查明）：这类会话**不落回执** —— 派给它的 run
 * 永远停在 working/dispatched（`startedAt === updatedAt`），任务其实跑了、正文也
 * 取得到，但状态永远判不出终态，页面就永远显示「已派发」。所以挑派发会话时要
 * **避开它**；万一只剩它，也要靠 JOB_RECEIPT_GRACE_MS 兜回来。
 *
 * 老版桥接的 /api/gateways 不带 spawned 字段（远程实测），靠 /api/sessions/spawned
 * 的 url/pid 索引兜底。写成模块级纯函数，免得各处要 this。
 */
function rowIsAuto(item, idx) {
  if (!item) return false
  if (item.spawned) return true
  const set = idx
  if (!set || !set.size) return false
  if (set.has(normSessionUrl(item.url))) return true
  const pid = Number(item.pid || 0)
  return pid > 0 && set.has(pid)
}

/**
 * 已知的「回执收不收得回」：true 安全 / false 不安全 / null 还不知道。
 * key = `hostKey::url`（不同机器的 url 可能撞端口，必须带主机）。
 * 同样写成模块级纯函数 —— 单测里的手搓 vm 没有 `this` 上的方法（踩过两次）。
 */
function receiptSafeFrom(store, hostKey, url) {
  const key = `${hostKey || 'default'}::${String(url || '')}`
  const map = store || {}
  return Object.prototype.hasOwnProperty.call(map, key) ? !!map[key] : null
}

/**
 * 待回写任务落盘用的 key。
 *
 * 为什么需要它（2026-09-29 反馈「产物没有回填，都要我去 WorkBuddy 说一声」）：
 * `jobPendingList` 原来是纯内存的，页面一刷新就空 —— 任务其实在会话里跑完了、
 * 产物也在（桥接 /api/job-artifacts 取得到，实测 3.8KB 的 md 就在），
 * 但**再没有人轮询它**，导图于是永远不回写。存一份在 localStorage，
 * 页面回来时接着轮询、把欠下的回写补上。
 */
const JOB_PENDING_STORE = 'mindmap:pendingJobs'
/**
 * 只补「刚派发不久」的任务。
 *
 * 窗口开太大（原来 12 小时）会把早上跑完、早就被手动处理过的任务也捡回来重写一遍
 * —— 用户看到的就是「还没执行完就写回了、而且写的是之前的产物」（2026-09-29 反馈）。
 * 刷新后真正需要续等的，本来就是刚刚那一条，30 分钟足够。
 */
const JOB_PENDING_TTL_MS = 30 * 60 * 1000

/**
 * 「回执取不回」的宽限时间 —— 超过它就主动去会话历史里收一次结果。
 *
 * 为什么需要（2026-09-29 现场查明）：桥接自己起的 headless 会话（`codebuddy --serve`
 * 实例，面板里标「自动」的那种）**不落回执** —— 派给它的 run 永远停在
 * working/dispatched，`startedAt === updatedAt` 一动不动；而任务其实已经跑完，
 * 桥接 `/api/transcript` 能从会话历史里取到正文（实测 500 字）。
 *
 * 没有这一步，页面就永远停在「已派发，等待该会话的 Agent 回复」，导图也永不回写
 * ——用户只能自己去 WorkBuddy 里追问一句。
 *
 * 所以：派发超过这个时间还判不出终态时，主动拉一次正文；拉得到就按「完成」收尾。
 */
const JOB_RECEIPT_GRACE_MS = 4 * 60 * 1000

/**
 * 每条会话「回执收不收得回」的学习结果（key = `hostKey::url`）。
 * 来源是派发响应里的 `mode`：走 jobs 就安全，走 runs（那台会话没挂 Jobs 接口）
 * 就取不回结果。见 noteReceiptSafe()。
 */
const JOB_RECEIPT_SAFE_STORE = 'mindmap:jobReceiptSafe'

/**
 * 任务失败时最多自动重派几次 —— **每次换一条会话**。
 *
 * 为什么需要（2026-09-29）：那台机器的「自动」会话跑不出结果（任务进不去、
 * 状态不更新），用户在页面上只能自己发现、自己再点一次运行。加这道保障：
 * 判死 / 失败 / 任务记录消失时，自动换个会话重派，最多 3 次，第 3 次才真放弃。
 * 必须换会话 —— 原地重试只会再进同一个坑（失败原因多半就是那条会话）。
 */
const JOB_RETRY_LIMIT = 3

/**
 * 宽限也拉不到正文时的放弃线（派发后 6 分钟）。
 * 到点还没正文，就别再占着轮询了 —— 直接收尾并提示用户去 output/ 找产物。
 */
const JOB_RECEIPT_GIVEUP_MS = 6 * 60 * 1000

/**
 * 「已知走 runs 回退通道」的会话，宽限期缩短到 90 秒。
 *
 * 现场（2026-09-29 服务器 192.168.1.114）：那台的 WorkBuddy 是 **2.132.0** ——
 * **所有**会话（连非自动的）派发都返回 `mode=runs`，`POST /api/v1/jobs` 一律 404。
 * 这类会话的 run 状态**从来不会更新**，所以「等 4 分钟再去看」纯属白等：
 * 任务照样在跑、产物照样落盘，早点去扫就能早点把结果兜回来。
 * 逐条会话学一遍（`receiptSafeOf === false` 就是已知走 runs），学到的就早点收。
 */
const JOB_RUNS_GRACE_MS = 90 * 1000

/**
 * 派发队列落盘用的 key（用户要求 2026-09-29：「用队列排队执行」）。
 *
 * 一条 WorkBuddy 会话同时只跑一个任务，所以派发**串行化**：已经有任务在路上就先入队，
 * 等它回来再派下一个。存一份在 localStorage，刷新页面也不会把排队中的任务弄丢。
 */
const JOB_QUEUE_STORE = 'mindmap:jobQueue'

/** 「这台机器的会话都走回退通道」这句提示，按主机记一次就够（别每次派发都弹） */
const RUNS_TIP_STORE = 'mindmap:runsTipShown'

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
    CPDCheckPanel,
    ToolbarNodeBtnList,
    ToolbarFileBtnList
  },
  data() {
    return {
      isMobile: isMobile(),
      horizontalList: [],
      verticalList: [],
      showMoreBtn: true,
      popoverShow: false,
      fileHorizontalCount: 0,
      filePopoverShow: false,
      toolbarLayoutRevision: 0,
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
      // 运行通道选择弹窗（2026-10-08）：默认助理（OpenClaw）
      runChannelVisible: false,
      runChannelPick: RUN_CHANNEL_OPENCLAW,
      runChannelPending: null,
      // 这次运行实际用的通道（''=还没选/取消）
      jobChannel: '',
      // 助理通道的流式正文与中止句柄
      jobOpenclawText: '',
      jobOpenclawAbort: null,
      // 助理通道**正在跑**一个任务。助理没有回执也没有 jobId，
      // 所以队列的"占用"判据就是它（见 jobBusyCount / startOpenclawRun）。
      // 为什么不让助理真并发：网关侧是共享 agent 会话 + 产物按共享 output 目录时间窗扫，
      // 同时跑两个会串正文、把附件挂到别人的任务上。
      jobOpenclawBusy: false,
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
      // 排队等待派发的任务（串行执行：上一个跑完才轮到下一个）
      jobQueue: [],
      // 最新那条查不到的次数（状态栏与提示用）
      jobPendingMiss: 0,
      // 一轮轮询没跑完就别再进来（写回要几秒，避免重复处理同一条）
      jobPollBusy: false,
      // 正在被「停止」的那条 id（行内停止按钮的 loading）
      jobStopBusyId: '',
      // 「派发固定用哪条会话」，按主机分；localStorage 的兜底（隐私模式下用它）
      rememberedSession: null,
      // 用户是否**手动点过**会话栏（点过 = 他的明确选择，派发前不再自动换人）
      jobGatewayPinned: false,
      // 执行主机上的 WorkBuddy 会话（= 端口）一览：默认收起，点开看谁在跑谁闲置
      jobSessions: [],
      // 「自动」会话的 url/pid 索引（桥接自己起的 headless 实例，不落回执，挑会话时避开）
      jobSpawnedIndex: null,
      // 每条会话「回执收不收得回」的学习结果（hostKey::url → bool），落 localStorage
      rememberedReceiptSafe: null,
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
      return (this.collabPeers || []).slice(0, 2)
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

    fileToolbarLayoutKey() {
      return [this.isMobile, this.isReadonly, !!this.$route.query.room].join('|')
    },

    fileToolbarActions() {
      const actions = []
      if (this.$route.query.room) {
        actions.push({ key: 'maps', label: '脑图', icon: 'el-icon-back', title: '返回脑图', testId: 'back-to-my-maps' })
      }
      actions.push({
        key: 'refresh', label: this.$t('toolbar.refresh'),
        iconClass: 'refreshIcon',
        icon: this.refreshing ? 'el-icon-loading' : 'el-icon-refresh',
        disabled: this.refreshing, testId: 'refresh'
      })
      if (this.cpdRoomKey) {
        actions.push({
          key: 'check', label: '检查', icon: 'el-icon-circle-check',
          title: this.activeJobNode
            ? `检查「${this.nodePlainTitle(this.activeJobNode) || '当前节点'}」对应的整条 CPD 链路`
            : '请先选中一个节点',
          testId: 'cpd-check-button'
        })
      }
      if (!this.isReadonly) {
        // 转圈只转 .icon 里的 <i class="runIcon">（ToolbarFileBtnList 负责套这层），
        // 外层方块不动；派发中挂 busy：图标方块高亮 + 文字色拉回，不是纯灰掉。
        actions.push({
          key: 'run', label: '运行',
          iconClass: 'runIcon',
          icon: this.jobDispatching ? 'el-icon-loading' : 'el-icon-video-play',
          disabled: this.jobDispatching, busy: this.jobDispatching,
          title: this.runButtonTitle, testId: 'run-workbuddy-job'
        })
      }
      if (this.$route.query.room) {
        actions.push({ key: 'copyInvite', label: this.$t('acl.copyLink'), icon: 'iconfont iconfuzhi', title: this.$t('cooperate.copyInvite'), testId: 'copy-invite' })
      }
      actions.push({ key: 'share', label: this.$t('acl.permissions'), icon: 'iconfont iconxietongwendang', testId: 'share' })
      if (!this.isReadonly) {
        actions.push({ key: 'import', label: this.$t('toolbar.import'), icon: 'iconfont icondaoru', testId: 'import' })
      }
      actions.push({ key: 'export', label: this.$t('toolbar.export'), icon: 'iconfont iconexport' })
      if (this.$route.query.room) {
        actions.push({ key: 'history', label: '历史版本', icon: 'el-icon-time', testId: 'history-versions' })
      }
      if (!this.isMobile) {
        actions.push(
          { key: 'new', label: this.$t('toolbar.newFile'), icon: 'iconfont iconxinjian', title: this.$t('toolbar.newFileTip') },
          { key: 'saveAs', label: this.$t('toolbar.saveAs'), icon: 'iconfont iconlingcunwei' }
        )
      }
      return actions
    },

    fileHorizontalActions() {
      return this.fileToolbarActions.slice(0, this.fileHorizontalCount)
    },

    fileVerticalActions() {
      return this.fileToolbarActions.slice(this.fileHorizontalCount)
    },

    jobSelectedHost() {
      return this.jobHosts.find(item => item.key === this.jobHostKey) || null
    },

    /** 当前选中的节点（概要点不算节点，不能当运行落点） */
    activeJobNode() {
      const node = (this.activeNodes || [])[0]
      return node && !node.isGeneralization ? node : null
    },

    cpdRoomKey() {
      return String((this.$route.query && this.$route.query.room) || '').trim()
    },

    activeJobNodeUid() {
      const node = this.activeJobNode
      return String((node && node.getData && node.getData('uid')) || '')
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
    // 待回写列表一变就落盘：刷新/换页回来还能接着等、接着补回写
    jobPendingList() {
      this.savePendingJobs()
    },
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
    fileToolbarLayoutKey() {
      this.computeToolbarShow()
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
    this.$bus.$on('open_workbuddy_job_history', this.openJobHistory)
    this.$bus.$on('open_local_directory', this.openDirectory)
    this.$bus.$on('open_local_file', this.openLocalFile)
  },
  mounted() {
    this.computeToolbarShow()
    this.computeToolbarShowThrottle = throttle(this.computeToolbarShow, 300)
    window.addEventListener('resize', this.computeToolbarShowThrottle)
    this.$bus.$on('lang_change', this.computeToolbarShowThrottle)
    window.addEventListener('beforeunload', this.onUnload)
    this.$bus.$on('node_note_dblclick', this.onNodeNoteDblclick)
    // 上次没回写完的任务：捡回来接着轮询（刷新页面不该让任务白跑）
    // 「哪条会话回执收得回」也是跨刷新记住的 —— 挑派发会话要用
    this.restoreReceiptSafe()
    this.restoreJobQueue()
    const restored = this.restorePendingJobs()
    if (restored) {
      this.prepareLocalTarget()
        .then(() => {
          if (this._isDestroyed) return
          if ((this.jobPendingList || []).length) this.startJobPoll()
        })
        .catch(() => {})
    }
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
    this.$bus.$off('open_workbuddy_job_history', this.openJobHistory)
    this.$bus.$off('open_local_directory', this.openDirectory)
    this.$bus.$off('open_local_file', this.openLocalFile)
    window.removeEventListener('resize', this.computeToolbarShowThrottle)
    this.$bus.$off('lang_change', this.computeToolbarShowThrottle)
    window.removeEventListener('beforeunload', this.onUnload)
    this.$bus.$off('node_note_dblclick', this.onNodeNoteDblclick)
  },
  methods: {
    async waitForCpdSnapshot() {
      const deadline = Date.now() + 8000
      for (;;) {
        const state = (this.$store && this.$store.state) || {}
        const status = typeof window !== 'undefined' && typeof window.__COLLAB_V2_STATUS__ === 'function'
          ? window.__COLLAB_V2_STATUS__() || {} : {}
        const pending = status.outboxPending === true || Number(status.outboxPending || status.pendingCount || 0) > 0 ||
          status.outboxSending === true || Number(status.outboxSending || 0) > 0 ||
          Number(state.collabPendingCount || 0) > 0 || state.collabSaveState === 'saving'
        if (!pending) return
        if (Date.now() >= deadline) throw new Error('脑图修改尚未保存，请同步完成后再检查')
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    },
    openCpdCheck() {
      if (!this.activeJobNode) {
        this.$message.warning('请先选中需要检查的节点')
        return
      }
      if (!this.cpdRoomKey) {
        this.$message.warning('CPD 检查需要在已保存的脑图房间中使用')
        return
      }
      if (this.$refs.cpdCheckPanel) this.$refs.cpdCheckPanel.open()
    },
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
    async resolveRunPrompt(runNode, runDir = '') {
      const gen = this.jobGeneralization
      const uid = String((runNode && runNode.getData && runNode.getData('uid')) || '')
      if (gen && uid && gen.ownerUid === uid) {
        const text = await this.readGeneralizationText(gen)
        if (text && !isFollowUpPlaceholder(text)) {
          return {
            prompt: this.buildFollowUpJobPrompt(text, runNode, runDir),
            continued: true
          }
        }
        this.$message.info('概要里还没写内容，这次按节点默认任务跑')
      }
      return { prompt: this.buildDefaultJobPrompt(runNode, runDir), continued: false }
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
    buildDefaultJobPrompt(wanted = null, runDir = '') {
      const active = (this.activeNodes || [])[0]
      const selected =
        wanted || (active && !active.isGeneralization ? active : null)
      const room = String(
        (this.$route.query && this.$route.query.room) || ''
      ).trim()
      if (!selected) {
        return withCpdAdvisor(
          room
            ? `请分析并执行脑图房间「${room}」相关任务，给出可执行结论。`
            : '请分析当前脑图并给出可执行结论。'
        )
      }
      return buildNodeRunPrompt({
        node: selected,
        room,
        cwd: this.jobGatewayCwd,
        // 助理通道会给一个「本次运行专用」的产物目录，页面跑完只按它挂附件
        runDir
      })
    },

    buildFollowUpJobPrompt(text, wanted = null, runDir = '') {
      const room = String(
        (this.$route.query && this.$route.query.room) || ''
      ).trim()
      const active = (this.activeNodes || [])[0]
      const node = wanted || (active && !active.isGeneralization ? active : null)
      if (!node) return withCpdAdvisor(text)
      return buildFollowUpPrompt(text, {
        node,
        room,
        cwd: this.jobGatewayCwd,
        runDir
      })
    },

    /**
     * 本次运行的产物目录名（对应 output/&lt;runDir&gt;/）。
     *
     * 2026-10-08 用户要求「只挂这一次运行的东西，不要乱不要多不要少」：
     * 提示词把产物**写死**到这个专属子目录，页面跑完只按这个目录挂附件 ——
     * 既不会捞到别的任务/别的工具写的文件，也不会被 8 条上限截断。
     */
    makeRunDir() {
      const d = new Date()
      const p = n => String(n).padStart(2, '0')
      return (
        `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
        `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
      )
    },

    /** 运行历史：左列表 + 右内容 + 底部继续执行 */
    async openJobHistory() {
      if (this.isReadonly || this.jobHistoryVisible) return
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
      // ⚠️ 防重入标志必须放在 `await` **之前**（2026-09-28 修）：以前设在
      // `ensureDispatchTarget()` 之后，那 1~2 秒窗口里重复点「继续」会**并发**起会话/派发
      // （实测一口气起过 9 条会话，把机器堆满）。
      this.jobFollowDispatching = true
      try {
        const target = await this.followUpTarget()
        if (!target.ok) {
          this.$message.warning(target.error)
          return
        }
        const { host, gateway } = target
        const runTarget = this.rememberRunTarget({ reuseContainer: true })
        this.jobStatus = `正在继续执行…（会话 ${this.gatewayShort(gateway)}）`
        this.jobStatusType = 'jobWait'
        const promptText = this.buildFollowUpJobPrompt(prompt)
        const result = await dispatchWorkbuddyJob({
          host,
          gateway,
          prompt: promptText,
          name: `脑图运行 · ${
            this.nodePlainTitle(this.activeJobNode) || '继续'
          }`
        })
        // 记下这条会话走的是 jobs 还是 runs（见 noteReceiptSafe）
        if (result.ok) this.noteReceiptSafe(gateway, result.mode)
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
          nodeUid: runTarget.nodeUid,
          nodeTitle: runTarget.nodeTitle,
          hostKey: host.key,
          gateway,
          // 重试要用（见 retryPendingJob）
          prompt: promptText
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

    /**
     * 「继续执行」该派到哪条会话（2026-09-28 新增）。
     *
     * ⚠️ 以前直接用 sticky 的 `this.jobGateway`，**不保证是这条任务原来所在的会话** ——
     * 用户换过派发会话、或开了多条会话之后点「继续」，任务会被接到别的会话上，上下文直接断
     * （页面表现就是「继续」后一直执行中 / 答非所问）。
     * 现在**优先锚定这条运行记录自己的 `gateway`**（桥接 `/api/jobs` 每条都带），
     * 那条会话已经不在时才回落到当前选中的会话，并明确告诉用户改派了。
     */
    async followUpTarget() {
      const item = this.activeJobItem
      const own = String((item && item.gateway) || '').replace(/\/$/, '')
      const target = await this.ensureDispatchTarget()
      if (!target.ok) return target
      if (!own) return target
      if (own === String(this.jobGateway || '').replace(/\/$/, '')) return target
      const list = this.jobGateways || []
      const known = list.some(g => String(g.url || '').replace(/\/$/, '') === own)
      if (list.length && !known) {
        this.$message.warning(
          `这条任务原来的会话（${this.gatewayShort(own)}）已经不在了，改派到当前会话`
        )
        return target
      }
      this.jobGateway = own
      return { ok: true, host: this.jobSelectedHost, gateway: own }
    },

    /** 会话地址 → 好认的短名字（`:端口`） */
    gatewayShort(url) {
      const m = String(url || '').match(/:(\d+)\s*$/)
      return m ? ':' + m[1] : String(url || '当前会话')
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
      // 「自动」会话索引：挑派发会话时要避开它们（不落回执，见 isAutoSession）。
      // 这次响应顺带带回额度，省一次桥接往返；老桥接不支持也不影响。
      const spawned =
        typeof this.fetchSpawnedIndex === 'function'
          ? await this.fetchSpawnedIndex(host).catch(() => null)
          : null
      this.jobSpawnedIndex = (spawned && spawned.index) || null
      if (spawned && spawned.info) this.jobSpawnInfo = spawned.info
      if (!res.ok) {
        this.jobGatewaysError = res.error || '读取失败'
      } else {
        this.jobGateways = res.gateways || []
        if (this.jobGateways.length) {
          this.jobGateway = this.pickJobGateway(
            this.jobGateways,
            this.recallSession(host),
            this.jobSpawnedIndex
          )
          if (this.jobGateway) {
            this.jobGatewaysError = ''
          } else {
            // pickJobGateway 返回空 = 只剩「没被证实能用」的自动会话。
            // 别派进去（任务进不去、状态不更新、白等 4~6 分钟），直接说清出路。
            this.jobGatewaysError =
              '这台机器上只有「自动」起的会话，而它们上面的任务跑不出结果' +
              '（派过去也不会回执）—— 请在它上面打开 WorkBuddy 桌面版、进入任意一个对话，' +
              '再回来点运行。'
          }
        } else {
          this.jobGatewaysError = describeEmptyGateways(res.diag, host)
        }
      }
      // ⚠️ 这里**不能 await**：运行历史是跨会话拉取（每个会话一个请求，公网页面还要走中继），
      // 慢的时候好几秒。而它在派发路径上（prepareLocalTarget / ensureDispatchTarget 都会调本方法），
      // 一 await 就等于「点运行后按钮多转好几秒」（2026-09-29 反馈）。历史只是面板信息，后台刷新即可。
      this.loadJobHistory()
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
    pickJobGateway(list, previous = '', spawnedIndex = null) {
      const rows = list || []
      if (!rows.length) return ''
      const idx = spawnedIndex || this.jobSpawnedIndex
      const remembered = this.recallSession(this.jobSelectedHost)
      const safeOf = url =>
        receiptSafeFrom(this.rememberedReceiptSafe, this.jobHostKey, url)
      // ① **不用自动会话**（用户要求 2026-09-29：「不走自动会话、不创建自动会话，反正都不能用」）。
      //    那类会话（桥接 spawn 的 headless 实例）在旧版 WorkBuddy 上走 runs 回退通道，
      //    任务进不去、状态不更新，留着只会把任务带进黑洞 —— 直接全部剔除。
      //    一条可用的都没有就返回空，让上层给明确提示，而不是偷偷起一条新的。
      const usable = rows.filter(item => !rowIsAuto(item, idx))
      if (!usable.length) return ''
      // ② 在可用会话里挑分最高的：
      //    已知走 jobs（回执收得回）+8 / 未知 +2 / 已知走 runs -6
      //    上次用的 +3、记住过的 +2 —— **端口稳定这条原则不变**
      //    （并行不再靠"换一条会话"，而是靠**队列串行**，见 enqueueDispatch）
      const score = item => {
        let s = 0
        const safe = safeOf(item.url)
        if (safe === true) s += 8
        else if (safe === null) s += 2
        else s -= 6
        if (item.url === previous) s += 3
        else if (item.url === remembered) s += 2
        return s
      }
      let best = usable[0]
      let bestScore = null
      usable.forEach(item => {
        const s = score(item)
        if (bestScore === null || s > bestScore) {
          bestScore = s
          best = item
        }
      })
      return best.url
    },

    /**
     * 这条会话是不是「桥接自动起的」（见模块级 rowIsAuto 的说明）。
     */
    isAutoSession(item, idx = null) {
      return rowIsAuto(item, idx || this.jobSpawnedIndex)
    },

    /**
     * 这条会话「回执收不收得回」—— 由**派发时实际走的接口**学出来。
     *
     * 为什么不能只看「是不是自动会话」（2026-09-29 实测踩到）：
     * 本机 WorkBuddy 2.137.1 起的**自动会话**派发走 `POST /api/v1/jobs`，
     * 任务正常 done（连写文件都成功）；而服务器 2.132.0 起的自动会话
     * 只能回退到 `POST /api/v1/runs` —— run 台账不更新、回执取不回。
     * 所以真正决定成败的是「那条会话支不支持 Jobs 接口」，不是它怎么起的。
     * 这条事实在派发响应里就有（`mode`），记下来即可，不用额外探测。
     */
    receiptSafeKey(url) {
      return `${this.jobHostKey || 'default'}::${String(url || '')}`
    },

    /** 已知的回执安全性：true 安全 / false 不安全 / null 还不知道 */
    receiptSafeOf(url) {
      return receiptSafeFrom(this.rememberedReceiptSafe, this.jobHostKey, url)
    },

    /** 派发之后按实际 mode 记一笔（jobs 安全 / runs 不安全） */
    noteReceiptSafe(url, mode) {
      const m = String(mode || '')
      if (!url || !m) return
      const key = `${this.jobHostKey || 'default'}::${String(url)}`
      const value = m !== 'runs'
      if (!this.rememberedReceiptSafe) this.rememberedReceiptSafe = {}
      if (this.rememberedReceiptSafe[key] === value) return
      this.rememberedReceiptSafe[key] = value
      try {
        // 和 restoreReceiptSafe 用同一个全局名，测试里的桩也认它
        if (typeof localStorage === 'undefined') return
        localStorage.setItem(
          JOB_RECEIPT_SAFE_STORE,
          JSON.stringify(this.rememberedReceiptSafe)
        )
      } catch (err) {
        /* 隐私模式写不进去，内存里那份兜着 */
      }
    },

    /** 手动指定派发用哪条会话（点会话栏那一行），并记住 */
    chooseSession(row) {
      if (!row || !row.url) return
      if (row.url === this.jobGateway) return
      this.jobGateway = row.url
      // 用户手动指定 = 明确选择，派发前不再自动换人（见 ensureDispatchTarget）
      this.jobGatewayPinned = true
      this.rememberSession(row.url)
      const label = `:${row.port || '?'}（${row.title || row.cwd || '未命名'}）`
      if (row.spawned) {
        // 自动会话不落回执：结果会晚几分钟才由会话历史兜回来（见 JOB_RECEIPT_GRACE_MS）
        this.$message.warning(
          `派发改用会话 ${label} —— 这是「自动」起的会话，不落回执，` +
            '结果要等几分钟兜回来；要立刻拿结果就换成不带「自动」的那条'
        )
        return
      }
      this.$message.success(`派发改用会话 ${label} —— 以后一直用它`)
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
      // 派发前**再评估一次**目标会话：缓存里的 jobGateway 可能是后来被证明走 runs 的、
      // 或者压根是自动会话（已停用）。用户手动点过的（pinned）除外。
      if (
        this.jobGateway &&
        !this.jobGatewayPinned &&
        (this.jobGateways || []).length
      ) {
        const better = this.pickJobGateway(
          this.jobGateways,
          this.jobGateway,
          this.jobSpawnedIndex
        )
        if (better && better !== this.jobGateway) this.jobGateway = better
      }
      if (this.jobSelectedHost && this.jobGateway) {
        return {
          ok: true,
          host: this.jobSelectedHost,
          gateway: this.jobGateway
        }
      }
      // 目标为空 → 先快速拉一次会话列表：多数情况只是页面刚打开、还没加载完
      if (this.jobSelectedHost && this.jobSelectedHost.online) {
        const quick = await listHostGateways(this.jobSelectedHost).catch(() => null)
        if (quick && quick.ok && (quick.gateways || []).length) {
          this.jobGateways = quick.gateways
          const spawned = await this.fetchSpawnedIndex(this.jobSelectedHost).catch(
            () => null
          )
          this.jobSpawnedIndex = (spawned && spawned.index) || null
          if (spawned && spawned.info) this.jobSpawnInfo = spawned.info
          this.jobGateway = this.pickJobGateway(
            this.jobGateways,
            this.recallSession(this.jobSelectedHost),
            this.jobSpawnedIndex
          )
          if (this.jobGateway) {
            this.jobGatewaysError = ''
            return {
              ok: true,
              host: this.jobSelectedHost,
              gateway: this.jobGateway
            }
          }
        }
      }
      // 用户要求（2026-09-29）：**不创建自动会话** —— 那类会话（桥接 spawn 的 headless 实例）
      // 在旧版 WorkBuddy 上走 runs 回退通道，任务进不去、状态不更新，起了也白起。
      // 没有可用会话就直说，让人自己去桌面版开一条。
      const host = this.jobSelectedHost
      return {
        ok: false,
        host,
        error:
          !host || !host.online
            ? this.jobHostsError ||
              '连不上这台机器的任务桥（桥接没在跑？双击 run_bridge.bat 后再点运行）'
            : this.jobGatewaysError ||
              '这台机器上没有可用的 WorkBuddy 会话（自动会话已停用）—— ' +
                '请在它上面打开 WorkBuddy 桌面版、进入任意一个对话，再回来点运行。'
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
        // 运行历史要**跨会话**看：任务派到哪个会话，就存在那个会话自己的任务列表里
        // （桥接的 /api/jobs 是实时问会话的 `/api/v1/jobs`）。只问当前选中的那一个，
        // 换个会话就「之前的记录不见了」（2026-09-29 反馈）。这里把所有会话的都拉回来
        // 合并，每条自带 gateway，停止与取完整回答照样找得到目标。
        const gwRes = await listHostGateways(host)
        const urls = ((gwRes && gwRes.ok && gwRes.gateways) || [])
          .map(gw => String((gw && gw.url) || ''))
          .filter(Boolean)
        if (!urls.length) {
          this.jobHistory = []
          this.jobHistoryError =
            gwRes && !gwRes.ok ? gwRes.error || '拿不到运行记录' : ''
          return
        }
        const batches = await Promise.all(
          urls.map(url =>
            listHostJobs({ host, gateway: url }).catch(err => ({
              ok: false,
              error: (err && err.message) || '拉取失败'
            }))
          )
        )
        const seen = new Set()
        const merged = []
        batches.forEach((item, index) => {
          if (!item || !item.ok) return
          ;(item.jobs || []).forEach(job => {
            if (!job || typeof job !== 'object') return
            const id = String(job.id || '')
            if (id) {
              if (seen.has(id)) return
              seen.add(id)
            }
            merged.push({ ...job, gateway: job.gateway || urls[index] })
          })
        })
        // 全都没拉到才算错；只要有一个会话答上，就按拿到的显示。
        // 错误原样透出来 —— 「网关暂时不可用」比一句「拿不到运行记录」有用得多
        if (!merged.length && batches.every(item => !item || !item.ok)) {
          const first = batches.find(item => item && item.error)
          this.jobHistoryError = (first && first.error) || '拿不到运行记录'
          return
        }
        this.jobHistoryError = ''
        this.jobHistory = merged
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
      const state = String((item && (item.state || item.status)) || '')
        .trim()
        .toLowerCase()
      // 终态优先：别让 alive 把已经结束的任务拖成「执行中」（否则永不回写）
      if (JOB_FINISHED_STATES.indexOf(state) !== -1) return false
      return JOB_RUNNING_STATES.indexOf(state) !== -1 || item.alive === true
    },

    /**
     * 排队中的那条：桥接把位置写在 detail（`排队中（第 N 位）：…`），
     * 但 state 仍是 `working`（对「跑完没」来说它确实没跑完）——
     * 只认 state 的话列表永远显示「执行中」，用户看不出自己是在排队。
     */
    jobQueueText(item) {
      const matched = String((item && item.detail) || '').match(
        /排队中（第\s*(\d+)\s*位）/
      )
      return matched ? `排队中（第 ${matched[1]} 位）` : ''
    },

    jobStateText(item) {
      const queued = this.jobQueueText(item)
      if (queued) return queued
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
      // 排队的 state 是 working，但配色该跟「执行中」区分开（.s-pending 已有样式）
      if (this.jobQueueText(item)) return 's-pending'
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
      if (node && reuseContainer) {
        const container = lastTaskContainer(node)
        const containerUid =
          container && container.getData && container.getData('uid')
        if (containerUid) {
          this.jobRunNodeUid = String(containerUid)
          this.jobRunNodeTitle = this.nodePlainTitle(container)
        }
      }
      // 落点也回传给调用方：并发时不要再去读共享的实例变量
      return { nodeUid: this.jobRunNodeUid, nodeTitle: this.jobRunNodeTitle }
    },

    /**
     * 开跑前先建「任务 · 时间」容器节点：这次的任务内容与结果都挂在它下面，
     * 一次运行一个 —— 运行输出紧跟在任务后面。
     */
    /**
     * ⚠️ 落点必须**由返回值带回去**，不能用 this.jobRunNodeUid 传：
     * 这里有一次 await，两个任务连着点「运行」时会在这里交错，
     * 共享的实例变量会被后一条覆盖 —— 2026-09-29 的现场就是「两个任务
     * 只有一个出现 / 手动写回挂到第一个任务」，根因在此。
     */
    async prepareJobContainer(prompt, wanted = null) {
      const active = (this.activeNodes || [])[0]
      const node = wanted || (active && !active.isGeneralization ? active : null)
      if (!node) {
        return {
          ok: true,
          nodeUid: this.jobRunNodeUid,
          nodeTitle: this.jobRunNodeTitle
        }
      }
      const box = { ok: false }
      const ownerUid = String((node.getData && node.getData('uid')) || '')
      const ownerTitle = this.nodePlainTitle(node)
      // 实例变量只留给「当前这一条」做界面显示用，不作为并发时的数据来源
      this.jobRunNodeUid = ownerUid
      this.jobRunNodeTitle = ownerTitle
      this.$bus.$emit('create_job_container', {
        result: box,
        nodeUid: ownerUid,
        prompt
      })
      if (!box.promise) return { ok: false, nodeUid: '', nodeTitle: '' }
      const out = await box.promise
      if (!out || out.ok === false) {
        const errText = (out && out.error) || '建任务节点失败'
        this.jobStatus = errText
        this.jobStatusType = 'jobErr'
        this.$message.error(errText)
        return { ok: false, nodeUid: '', nodeTitle: '' }
      }
      return {
        ok: true,
        nodeUid: out.uid || ownerUid,
        nodeTitle: out.title || ownerTitle
      }
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
      // 助理（OpenClaw）通道没有执行会话、也没有 runId —— 别按桥接那套门槛挡住它
      const viaOpenclaw = options.channel === RUN_CHANNEL_OPENCLAW
      if (this.jobWriteBusy) return
      if (!viaOpenclaw && (!host || !jobId)) return
      if (!viaOpenclaw && !options.force && this.jobWrittenJobId === jobId) return
      const text = String(
        options.markdown != null ? options.markdown : this.jobFullText || ''
      ).trim()
      // 调用方已经扫好的产物（比如「自动」会话拿不到回执、只能按时间窗扫目录那种）
      const presetArtifacts = Array.isArray(options.artifacts)
        ? options.artifacts.filter(Boolean)
        : null
      // 只有产物、没有正文也照写 —— 以前这里直接 return，产物就跟着一起丢了
      // （2026-09-29 用户反馈：「新建会话这种自动的，没法返回产物」）
      if (!text && !(presetArtifacts && presetArtifacts.length)) {
        this.jobWriteError = '这次运行没有文字输出，也没扫到产物文件'
        return
      }
      // 正文位置放一句说明，别让节点是个空白
      const bodyText =
        text ||
        '（这个会话不返回文字结果，产物已挂在下面「附件」里；' +
          '想拿到正文，请在它上面打开 WorkBuddy 桌面版，或把它升级到新版）'
      this.jobWriteBusy = true
      this.jobWriteError = ''
      this.jobWriteState = '正在读取产物文件…'
      try {
        let artifacts = []
        let artifactSkips = []
        if (presetArtifacts) {
          artifacts = presetArtifacts
        } else if (!viaOpenclaw) {
          // 助理通道没有执行会话，扫不到产物（文件在助理那边）
          try {
            const res = await fetchJobArtifacts({ host, gateway, jobId })
            if (res && res.ok) {
              artifacts = res.files || []
              artifactSkips = res.skipped || []
            }
          } catch (err) {
            // 产物读不到不影响把文字写进去
          }
        }
        this.jobWriteState = '正在写入导图…'
        const box = { ok: false }
        this.$bus.$emit('write_job_result', {
          result: box,
          nodeUid,
          markdown: bodyText,
          prompt: options.prompt || this.jobPendingPrompt || '',
          job,
          artifacts,
          artifactSkips,
          // 附件优先经桥接的 MCP 通道挂（服务器部署时比协同服务上传那条路稳），
          // 桥接不通会自动退回原来的上传方式。
          // 助理通道没有执行主机，直接走协同服务上传（bridgeAttach 给 null 即可）。
          bridgeAttach: viaOpenclaw
            ? null
            : args => attachFilesViaBridge({ host, ...args }),
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
        const attCount = (out.attachments || []).length
        // 新结构（2026-10-08）不铺正文节点：结果全在「任务 → 附件」里，
        // 文案就别再报一个已经不存在的「运行输出」节点名。
        this.jobWriteState = out.inlineNodes
          ? `已写入「${nodeTitle || '运行节点'}」：${out.title}（${
              out.nodes
            } 个节点${
              attCount ? `、${attCount} 个附件` : ''
            }${out.generalization ? '、已加概要（双击概要写下一步）' : ''}）`
          : `已写入「${nodeTitle || '运行节点'}」的「附件」（${attCount} 个文件${
              out.generalization ? '、已加概要（双击概要写下一步）' : ''
            }）`
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
    /** 上次用的运行通道；没存过就是助理（OpenClaw）—— 用户要求默认它 */
    recallRunChannel() {
      try {
        const saved = String(localStorage.getItem(RUN_CHANNEL_STORE) || '')
        if (saved === RUN_CHANNEL_OPENCLAW || saved === RUN_CHANNEL_BRIDGE) {
          return saved
        }
      } catch (err) {
        /* 隐私模式：用默认值 */
      }
      return RUN_CHANNEL_OPENCLAW
    },

    rememberRunChannel(channel) {
      try {
        localStorage.setItem(RUN_CHANNEL_STORE, String(channel || ''))
      } catch (err) {
        /* 存不下不影响这次运行 */
      }
    },

    /**
     * 弹「用哪条通道执行」的窗，等用户选。
     * 返回 Promise<'openclaw' | 'bridge' | ''>（'' = 用户取消）。
     */
    pickRunChannel() {
      this.runChannelPick = this.recallRunChannel()
      this.runChannelVisible = true
      return new Promise(resolve => {
        this.runChannelPending = resolve
      })
    },

    /** 弹窗里点「开始运行」 */
    confirmRunChannel() {
      const channel = this.runChannelPick || RUN_CHANNEL_OPENCLAW
      this.rememberRunChannel(channel)
      this.runChannelVisible = false
      const done = this.runChannelPending
      this.runChannelPending = null
      if (done) done(channel)
    },

    /** 弹窗关闭 / 点取消 */
    cancelRunChannel() {
      this.runChannelVisible = false
      const done = this.runChannelPending
      this.runChannelPending = null
      if (done) done('')
    },

    /**
     * 捞这次的产物（后端 /api/artifacts/recent）。
     *
     * 助理（OpenClaw）的 workspace/output 挂在宿主 ./output（见 docker-compose 的
     * openclaw-gateway 卷），后端这个接口按 mtime 找出 `since` 之后新增的文件，可选回 base64。
     *
     * 首选**本次运行的专属目录**（提示词要求产物只能写 `output/<dir>/`）：
     * 只收这一次运行的东西 —— 不夹带历史产物、不被 8 条上限截断（用户要求：不多不少不乱）。
     * 兜底：目录没扫到（Agent 没按目录写、或目录名对不上）→ 退回按时间窗扫共享 output，
     * 宁可多也别把产物丢了。
     */
    async fetchOpenclawArtifacts(since, dir = '') {
      const runDir = String(dir || '').trim()
      const query = async qs => {
        const res = await fetch(`/api/artifacts/recent?${qs}`, {
          cache: 'no-store',
          credentials: 'include'
        })
        if (!res.ok) return []
        const json = await res.json().catch(() => ({}))
        return (json && json.items) || []
      }
      if (runDir) {
        try {
          const pinned = await query(
            `dir=${encodeURIComponent(runDir)}&limit=20&content=1`
          )
          if (pinned.length) return pinned
        } catch (err) {
          /* 掉到下面的时间窗兜底 */
        }
      }
      try {
        return await query(
          `since=${encodeURIComponent(Number(since) || 0)}&limit=8&content=1`
        )
      } catch (err) {
        // 捞不到不影响正文写回
        return []
      }
    },

    /**
     * 走「助理（OpenClaw）」通道执行一次：**只负责准备 + 起跑**。
     *
     * 跟桥接最大的不同：助理是**流式直连**，没有「派发 → 轮询 → 回执」这一套 ——
     * 提示词发过去、正文流回来就算完，所以不需要执行会话、jobs/runs 判定。
     * 产物照样有：助理的 workspace/output 挂在宿主 ./output（docker-compose 里配的），
     * 跑完按时间窗捞这次新增的文件，跟桥接走同一套写回（任务 → 附件 → 产物|完整输出）。
     *
     * ⚠️ 真正的执行在 startOpenclawRun() 里**后台跑**，这里不 await 到跑完 ——
     * 2026-10-08 用户反馈：「用助理运行时运行按钮一直转圈、不能点第二个任务」，
     * 根因就是这里原来 await 到整条流结束（分钟级），按钮的 busy 一直挂着。
     */
    async runViaOpenclaw({ runNode = null, options = {} } = {}) {
      this.rememberRunTarget({ node: runNode })
      // 这次运行专属的产物目录：提示词写死到它里面，页面跑完只按它挂附件 ——
      // 「这一次运行的东西」不多不少（用户 2026-10-08 要求）。
      // 排队条目要把 runDir 一起带上：晚点真的跑起来时，扫的就是同一个目录。
      const runDir = String(options.runDir || this.makeRunDir())
      // 点过概要 → 接着它继续；否则按节点默认任务（跟桥接同一套取词逻辑）
      let prompt = ''
      if (options.prompt) {
        prompt = this.buildFollowUpJobPrompt(options.prompt, runNode, runDir)
      } else {
        const picked = await this.resolveRunPrompt(runNode, runDir)
        prompt = picked.prompt
      }

      // 由队列派下来的条目：容器在入队时就建好了，别再建一个任务节点
      let container = options.container || null
      if (!container || !container.ok) {
        this.jobStatus = '正在准备任务节点…'
        this.jobStatusType = 'jobWait'
        container = await this.prepareJobContainer(prompt, runNode)
        if (!container || !container.ok) return
      }

      // —— 队列闸门（跟桥接口径一致：一次只跑一个任务）——
      // 助理没有回执、也没有 jobId，所以「有没有在跑」看 jobOpenclawBusy（见 jobBusyCount）。
      // 不让助理真并发的原因：这条路在网关侧落在**同一个 agent 会话**
      // （phase2b1 探针里 A/B 都是 agent:main:main），产物又是按共享 output 目录的
      // 时间窗扫的 —— 同时跑两个，正文会串、附件会挂到别人的任务上。
      if (this.jobBusyCount() > 0) {
        this.enqueueDispatch({
          channel: RUN_CHANNEL_OPENCLAW,
          prompt,
          container,
          runDir,
          continued: !!options.prompt,
          name: `脑图运行 · ${this.nodePlainTitle(runNode) || '当前节点'}${
            options.prompt ? ' · 继续' : ''
          }`
        })
        return
      }
      // 起跑即返回（不 await 到跑完）：按钮在派出去那一刻就解锁，第二个任务能接着点，
      // 到闸门处自动排队 —— 这才叫「一次一个任务」，而不是「按钮锁死」
      this.startOpenclawRun({ prompt, container, runDir })
    },

    /**
     * 真正跑一次助理：流式收正文 → 按这次运行的专属目录捞产物 → 写回导图。
     *
     * 后台跑（调用方不 await），所以**错误必须自己收干净** —— 没人接它的 rejected promise。
     * 跑完 / 失败 / 取消都会清 jobOpenclawBusy，并把队列里的下一个派出去。
     */
    async startOpenclawRun({ prompt = '', container = null, runDir = '' } = {}) {
      const nodeUid = (container && container.nodeUid) || ''
      const nodeTitle = (container && container.nodeTitle) || ''
      const outDir = String(runDir || '')
      this.jobOpenclawBusy = true
      const controller =
        typeof AbortController !== 'undefined' ? new AbortController() : null
      this.jobOpenclawAbort = controller
      this.jobOpenclawText = ''
      this.jobFullText = ''
      this.jobStatus = '正在通过助理执行…'
      this.jobStatusType = 'jobWait'
      // 记下起跑时刻：产物目录没扫到时要回退按时间窗捞，所以这个还得留着
      // （往前放宽 2 秒，避开「来不及落盘 / 时间戳粒度」的时间差）
      const startedAt = Date.now() - 2000
      try {
        const res = await streamChat({
          messages: [{ role: 'user', content: prompt }],
          conversationId: `mind-openclaw-${Date.now().toString(36)}`,
          signal: controller ? controller.signal : undefined,
          onDelta: text => {
            // agentChat 的 onDelta 给的是**累计全文**
            this.jobOpenclawText = String(text || '')
            this.jobFullText = this.jobOpenclawText
            this.jobStatus = `助理执行中…（${this.jobOpenclawText.length} 字）`
          },
          onEvent: label => {
            if (label) this.jobStatus = `助理：${label}`
          }
        })
        const markdown = String(
          (res && res.content) || this.jobOpenclawText || ''
        ).trim()
        if (!markdown) {
          this.jobStatus = '助理没有返回内容'
          this.jobStatusType = 'jobErr'
          this.$message.warning('助理没有返回内容，没有东西写回导图')
          return
        }
        this.jobStatus = '正在写回导图…'
        // 助理的产物落在 workspace/output（挂宿主 ./output）——
        // 只按**这次运行的专属目录**捞，回形针上就只有这一次的东西
        const artifacts = await this.fetchOpenclawArtifacts(startedAt, outDir)
        await this.writeJobResultToNode(
          { id: `openclaw-${Date.now().toString(36)}` },
          {
            channel: RUN_CHANNEL_OPENCLAW,
            markdown,
            artifacts,
            // 落点用这次任务自己的（并发/排队时读实例变量会被别的任务覆盖）
            nodeUid,
            nodeTitle,
            prompt,
            force: true
          }
        )
      } catch (err) {
        if (err && err.name === 'AbortError') {
          this.jobStatus = '已取消'
          this.jobStatusType = 'jobErr'
          return
        }
        const msg = (err && err.message) || String(err)
        this.jobStatus = `助理执行失败：${msg}`
        this.jobStatusType = 'jobErr'
        this.$message.error(`助理执行失败：${msg}`)
      } finally {
        this.jobOpenclawAbort = null
        // 这一条落地了（不管成没成）→ 放开闸门，把排队里的下一个放出去
        this.jobOpenclawBusy = false
        if ((this.jobQueue || []).length) this.drainJobQueue()
      }
    },

    /** 助理通道正在跑 → 停掉它 */
    stopOpenclawRun() {
      if (this.jobOpenclawAbort) {
        try {
          this.jobOpenclawAbort.abort()
        } catch (err) {
          /* ignore */
        }
        this.jobOpenclawAbort = null
      }
    },

    async runWorkbuddyJob(options = {}) {
      if (this.jobDispatching || this.isReadonly) return
      this.jobDispatching = true
      const active = (this.activeNodes || [])[0]
      const runNode =
        options.node || (active && !active.isGeneralization ? active : null)
      try {
        // —— 选通道（2026-10-08 用户要求）：默认「助理（OpenClaw）」——
        // 手搓 vm 的单测没有 pickRunChannel 这个方法，自动退回桥接，老测试不受影响
        const channel =
          options.channel ||
          (typeof this.pickRunChannel === 'function'
            ? await this.pickRunChannel()
            : RUN_CHANNEL_BRIDGE)
        if (!channel) return
        this.jobChannel = channel
        if (channel === RUN_CHANNEL_OPENCLAW) {
          await this.runViaOpenclaw({ runNode, options })
          return
        }
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
        // 先建「任务 · 时间」容器，这次的任务内容与结果都挂在它下面。
        // 落点从返回值拿 —— 并发时读 this.jobRunNodeUid 会被后一条覆盖
        // 给个阶段提示：这一步之后是网络派发，公网页面走中继会有一两秒，
        // 没有提示的话用户只看到按钮转圈（2026-09-29 反馈「要等好久」）
        this.jobStatus = '正在准备任务节点…'
        this.jobStatusType = 'jobWait'
        const container = await this.prepareJobContainer(prompt, runNode)
        if (!container.ok) return
        // —— 队列闸门（用户要求 2026-09-29：「用队列排队执行」）——
        // 一条 WorkBuddy 会话同时只跑一个任务。已经有任务在路上就先入队，
        // 等它回来由 drainJobQueue 派下一个；不再并发挤进去，也不再换别的会话。
        if (this.jobBusyCount() > 0) {
          this.enqueueDispatch({
            host,
            gateway,
            prompt,
            name: `脑图运行 · ${this.nodePlainTitle(runNode) || '当前节点'}${
              continued ? ' · 继续' : ''
            }`,
            container,
            continued
          })
          return
        }
        this.jobStatus = `正在派发…（会话 ${this.gatewayShort(gateway)}）`
        this.jobStatusType = 'jobWait'
        // 派发超时给到 60s（公网页面要走中继：浏览器→服务器→通讯页→执行机→会话，
        // 偶尔会慢）。但用户不能一直对着转圈的按钮猜 —— 3 秒还没回来就把话说清楚。
        const slowTip = setTimeout(() => {
          if (this.jobDispatching) {
            this.jobStatus = `还在派发…（${this.gatewayShort(
              gateway
            )}）网络较慢，请稍等`
          }
        }, 3000)
        let result = null
        try {
          result = await dispatchWorkbuddyJob({
            host,
            gateway,
            prompt,
            name: `脑图运行 · ${
              this.nodePlainTitle(runNode) || '当前节点'
            }${continued ? ' · 继续' : ''}`
          })
        } finally {
          clearTimeout(slowTip)
        }
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
        // 记下这条会话实际走的是 jobs 还是 runs（见 noteReceiptSafe）——
        // 走 runs 说明它不支持 Jobs 接口，回执取不回，下次挑会话就绕开它
        this.noteReceiptSafe(gateway, result.mode)
        this.jobCurrentId = jobId
        this.jobActiveId = jobId
        this.jobPendingPrompt = prompt
        this.addPendingJob({
          id: jobId,
          nodeUid: container.nodeUid,
          nodeTitle: container.nodeTitle,
          // 会话/主机用这次的局部值 —— 并发时实例变量可能已被后一条改掉
          hostKey: host.key,
          gateway,
          // 重试要用（见 retryPendingJob）
          prompt
        })
        const runsMode = result.mode === 'runs'
        this.jobStatus = runsMode
          ? `已派发（这条会话没有 Jobs 接口，结果可能要等几分钟兜回来）${
              jobId ? ` · ${jobId}` : ''
            }`
          : `${continued ? '已派发继续执行' : '已派发'}${
              jobId ? ` · ${jobId}` : ''
            } · 结果写到「${container.nodeTitle || '运行节点'}」下${this.pendingSuffix()}`
        this.jobStatusType = runsMode ? 'jobWait' : 'jobOk'
        if (runsMode) {
          // runs 是那台机器 WorkBuddy 版本的**常态**（所有会话都走），每次都弹会烦死人 ——
          // 同一台主机只弹一次；状态栏每次都照旧提示（2026-09-29 用户反馈）
          let shown = false
          try {
            shown = localStorage.getItem(RUNS_TIP_STORE) === this.jobHostKey
          } catch (err) {
            /* 隐私模式：当没提示过 */
          }
          if (!shown) {
            this.$message.warning(
              '这条 WorkBuddy 会话没有 Jobs 接口，桥接走回退通道：任务照常跑、产物也照常出，' +
                '但状态不更新，结果要等一会儿由会话历史兜回来。' +
                '想立刻见效，把它上面的 WorkBuddy 升级到新版（2.137+）；' +
                '这台机器上的会话都这样，之后不再重复弹这句提示。'
            )
            try {
              localStorage.setItem(RUNS_TIP_STORE, this.jobHostKey || '')
            } catch (err) {
              /* 写不进去就算了 */
            }
          }
        } else {
          this.$message.success(
            `${continued ? '已按概要继续执行' : '已派发'}${
              jobId ? ` · ${jobId}` : ''
            }，跑完结果挂在「${this.jobRunNodeTitle || '运行节点'}」下面`
          )
        }
        // 历史是跨会话拉取（每会话一个请求，公网页面还要走中继）—— 后台刷，
        // 别让它拖住 jobDispatching 复位（那直接表现为「运行按钮好久才能再点」）
        if (this.jobHistoryVisible) this.loadJobHistory()
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
        const spawned = await this.fetchSpawnedIndex(host)
        this.jobSpawnedIndex = spawned.index || null
        const sessions = []
        // 串行查：会话通常个位数，别一波并发把桥接打满
        for (const gw of res.gateways || []) {
          const url = String((gw && gw.url) || '')
          const pid = Number((gw && (gw.spawnedPid || gw.pid)) || 0) || 0
          const row = {
            url,
            port: sessionPort(url),
            title: (gw && (gw.title || gw.cwd)) || '',
            cwd: (gw && gw.cwd) || '',
            // 桥接自己起的会话：面板标「自动」并允许回收。
            // 老版桥接的 /api/gateways 不带 spawned（远程实测），退回用自动会话清单认。
            spawned: rowIsAuto(
              { spawned: !!(gw && gw.spawned), url, pid },
              spawned.index
            ),
            pid,
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
        // 自动会话额度：上面那次 /api/sessions/spawned 已经带回来了，别再打一遍桥接
        if (spawned.info) this.jobSpawnInfo = spawned.info
      } catch (err) {
        this.jobSessions = []
        this.jobSessionsError = (err && err.message) || '拿不到会话列表'
      } finally {
        this.jobSessionsLoading = false
      }
    },

    /**
     * 拉一次「桥接自动起的会话」清单，产出两样东西：
     *   · index —— url / pid 的集合，判断某个会话能不能回收
     *   · info  —— 额度（面板上的「自动 X/5」）
     *
     * 为什么需要它（2026-09-29 远程实测）：服务器执行主机上的桥接是 09-28 之前的版本，
     * `/api/gateways` **没有 spawned 字段**（但 `/api/sessions/spawned` 有，5 个会话都在里面）。
     * 只认 gw.spawned 的话，「回收」按钮永远不出现 —— 会话攒满 5 个把执行机拖卡，
     * 而面板里再也收不回去。
     */
    async fetchSpawnedIndex(host) {
      const out = { index: new Set(), info: null }
      if (typeof listSpawnedSessions !== 'function') return out
      try {
        const res = await listSpawnedSessions(host)
        if (!res || !res.ok) return out
        ;(res.items || []).forEach(item => {
          const url = normSessionUrl(item && item.url)
          if (url) out.index.add(url)
          const pid = Number((item && item.pid) || 0)
          if (pid > 0) out.index.add(pid)
        })
        out.info = {
          count: res.count || 0,
          limit: res.limit || 0,
          remaining: res.remaining || 0,
          canSpawn: res.canSpawn !== false
        }
      } catch (err) {
        // 老桥接没这个接口也无妨：按钮退化成只看 gateways 的字段
      }
      return out
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

    /** 当前房间号（落盘/恢复待回写任务时用来区分房间） */
    currentRoomKey() {
      return String(
        (this.$route && this.$route.query && this.$route.query.room) || ''
      ).trim()
    },

    /** 待回写任务落盘：刷新页面不丢，回来接着轮询、把欠下的回写补上 */
    savePendingJobs() {
      try {
        if (typeof localStorage === 'undefined') return
        const room = this.currentRoomKey()
        const rows = (this.jobPendingList || [])
          .filter(item => item && item.id && item.gateway)
          .map(item => ({
            ...item,
            room: item.room || room,
            at: item.at || Date.now()
          }))
        if (!rows.length) {
          localStorage.removeItem(JOB_PENDING_STORE)
          return
        }
        localStorage.setItem(JOB_PENDING_STORE, JSON.stringify(rows.slice(-20)))
      } catch (err) {
        // 存不下也不影响主流程
      }
    },

    /**
     * 页面打开时把「还没回写完」的任务捡回来。
     *
     * 现场（2026-09-29）：任务在会话里跑完了、产物也在，但用户中途刷新过页面，
     * 内存里的 jobPendingList 一空，就再没人轮询 → 导图永远不回写，
     * 用户只能自己跑去 WorkBuddy 里催一句。这里让它跨刷新活下来。
     */
    /** 恢复「哪条会话回执收得回」的学习结果（见 noteReceiptSafe） */
    restoreReceiptSafe() {
      try {
        if (typeof localStorage === 'undefined') return
        const raw = localStorage.getItem(JOB_RECEIPT_SAFE_STORE)
        if (!raw) return
        const obj = JSON.parse(raw)
        if (obj && typeof obj === 'object') this.rememberedReceiptSafe = obj
      } catch (err) {
        /* 坏了就当没学过，不影响使用 */
      }
    },

    restorePendingJobs() {
      try {
        if (typeof localStorage === 'undefined') return 0
        const raw = localStorage.getItem(JOB_PENDING_STORE)
        if (!raw) return 0
        const rows = JSON.parse(raw)
        if (!Array.isArray(rows)) {
          localStorage.removeItem(JOB_PENDING_STORE)
          return 0
        }
        const room = this.currentRoomKey()
        const now = Date.now()
        const keep = rows.filter(item => {
          if (!item || !item.id || !item.gateway) return false
          // 只认当前房间：换图了就别把别的房间的任务带过来
          if (item.room && room && item.room !== room) return false
          const at = Number(item.at || 0)
          return !at || now - at < JOB_PENDING_TTL_MS
        })
        if (!keep.length) {
          localStorage.removeItem(JOB_PENDING_STORE)
          return 0
        }
        this.jobPendingList = keep
        return keep.length
      } catch (err) {
        return 0
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

    /**
     * 轮询在主机上查不到这条任务 —— 那台机器上已经没有它了。
     *
     * 任务记录在执行主机的 WorkBuddy 内存里：WorkBuddy 重启、桥接重开、
     * 换了会话都会让记录消失。以前这里直接 return，于是永远轮询下去，
     * 界面上只停在「已派发…」，结果悄无声息地丢掉（用户看到的就是"没回传、
     * 运行历史也没记录"）。所以数到上限就停手，并把原因写在状态栏和提示里。
     * 计数**按条目算**（同时可能有好几条在等）。
     */
    async notePendingJobMissing(entry, why = '') {
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
      // 连报了一分钟"找不到这条任务" —— 先**换条会话重派**（最多 JOB_RETRY_LIMIT 次），
      // 别一上来就跟用户说"任务记录消失、可以重跑一次"（2026-09-29 反馈）
      if (await this.retryPendingJob(entry, why)) return
      this.jobPendingList = (this.jobPendingList || []).filter(
        x => x.id !== entry.id
      )
      const host = this.hostOfEntry(entry) || {}
      const label = host.label || host.key || '那台机器'
      const who = `「${entry.nodeTitle || '这个节点'}」`
      const tried = Number(entry.retry || 0)
      const suffix = tried ? `（已自动换会话重试 ${tried} 次仍未成）` : ''
      this.jobStatus = '没等到结果'
      this.jobStatusType = 'jobErr'
      this.jobWriteError = why
        ? `连不上 ${label} 的任务桥（${why}）—— ${who}这次没有写回导图${suffix}，可以重跑一次。`
        : `${label} 的任务桥里找不到这条任务（WorkBuddy 或桥接重启过，任务记录会跟着消失）` +
          `—— ${who}这次没有写回导图${suffix}，可以重跑一次。`
      this.$message.error(this.jobWriteError)
      if (!(this.jobPendingList || []).length) this.stopJobPoll()
      this.loadJobHistory()
    },

    /**
     * 兜底：按**时间窗**扫这条任务所在会话的产物 —— 不看回执。
     *
     * 用于「会话不返回结果、但任务确实跑了」这种情况（旧版 WorkBuddy 的 headless
     * 会话走 runs 通道：既判不出终态、transcript 也空），此时 /api/job-artifacts
     * 无从下手（它靠任务正文里的路径），只能按派发时间扫目录。
     */
    async fetchRecentArtifactsFor(entry) {
      const host = this.hostOfEntry(entry)
      if (!host || typeof fetchRecentArtifacts !== 'function') return []
      try {
        const res = await fetchRecentArtifacts({
          host,
          gateway: (entry && entry.gateway) || this.jobGateway,
          // 往前放宽 2 分钟：从派发到落盘之间有时间差
          since: Math.max(0, Number((entry && entry.at) || 0) - 120000),
          limit: 12,
          content: true
        })
        return (res && res.ok && res.files) || []
      } catch (err) {
        return []
      }
    },

    /** 派发够久了（见 JOB_RECEIPT_GRACE_MS）—— 该主动去会话历史收一次结果 */
    pendingReceiptTimedOut(entry) {
      const at = Number((entry && entry.at) || 0)
      if (!at) return false
      // 这条会话**已知走 runs**（状态永远不更新）→ 早点去取，别白等 4 分钟
      const safe = receiptSafeFrom(
        this.rememberedReceiptSafe,
        this.jobHostKey,
        entry && entry.gateway
      )
      const grace = safe === false ? JOB_RUNS_GRACE_MS : JOB_RECEIPT_GRACE_MS
      return Date.now() - at > grace
    },

    /** 过了放弃线还没正文（见 JOB_RECEIPT_GIVEUP_MS） */
    pendingReceiptGaveUp(entry) {
      const at = Number((entry && entry.at) || 0)
      if (!at) return false
      return Date.now() - at > JOB_RECEIPT_GIVEUP_MS
    },

    /** 重试时挑一条会话：**排除刚失败的那条**（失败原因往往就是它） */
    pickRetryGateway(failedUrl = '') {
      const rows = (this.jobGateways || []).filter(r => r.url !== failedUrl)
      if (!rows.length) return ''
      return this.pickJobGateway(rows, '', this.jobSpawnedIndex)
    },

    /**
     * 自动换一条会话，把这条任务重派一次（见 JOB_RETRY_LIMIT）。
     *
     * 返回 true = **已经重派**，调用方别再把这条从待回写列表里摘掉，接着轮询新的 id；
     * false = 不能重试（次数用完 / 没有别的会话 / 派发本身失败）→ 按原逻辑收尾。
     *
     * 为什么必须换会话：失败原因多半就是"那条会话不可用"（旧版 WorkBuddy 的自动
     * 会话走 runs、任务根本进不去），原地重试只会再进同一个坑。
     */
    async retryPendingJob(entry, reason = '') {
      if (!entry || !entry.id) return false
      const tries = Number(entry.retry || 0)
      if (tries >= JOB_RETRY_LIMIT) return false
      const host = this.hostOfEntry(entry)
      if (!host) return false
      const prompt = String(entry.prompt || '')
      // 没记下原提示词就没法重派（老版本落盘的条目可能没有）
      if (!prompt) return false
      if (!(this.jobGateways || []).length) {
        // 刷新后恢复的场景：会话列表可能还没加载
        await this.loadJobGateways().catch(() => {})
      }
      const gateway = this.pickRetryGateway(entry.gateway)
      if (!gateway) return false
      let result = null
      try {
        result = await dispatchWorkbuddyJob({
          host,
          gateway,
          prompt,
          name: `脑图运行 · ${entry.nodeTitle || '重试'}`
        })
      } catch (err) {
        return false
      }
      if (!result || !result.ok) return false
      const jobId = (result.job && (result.job.id || result.job.jobId)) || ''
      if (!jobId) return false
      this.noteReceiptSafe(gateway, result.mode)
      entry.retry = tries + 1
      entry.id = jobId
      entry.gateway = gateway
      entry.at = Date.now()
      entry.miss = 0
      entry.cachedText = ''
      entry.lastError = String(reason || '')
      // finishPendingJob 那条路会先把条目摘出列表再收尾，所以这里要保证它回到列表里，
      // 否则新的 id 没人轮询
      if (!(this.jobPendingList || []).some(x => x.id === entry.id)) {
        this.jobPendingList = [...(this.jobPendingList || []), entry]
      } else {
        this.jobPendingList = [...(this.jobPendingList || [])]
      }
      this.jobStatus = `第 ${entry.retry}/${JOB_RETRY_LIMIT} 次重试（换到 ${this.gatewayShort(
        gateway
      )}）…`
      this.jobStatusType = 'jobWait'
      this.startJobPoll()
      return true
    },

    /**
     * 放弃一条等不到回执的任务。
     *
     * 用于「会话活着、任务也跑了，但回执取不回」这种（见 JOB_RECEIPT_GRACE_MS）：
     * 页面必须**自己收尾**，不能永远停在「已派发」转圈。产物其实可能在会话的
     * 工作目录 output/ 下，所以提示里明确让用户去那儿看，或点「重取全文」再试。
     */
    async abandonPendingJob(entry, reason = '') {
      if (!entry) return
      // 先试着重派（换一条会话，最多 JOB_RETRY_LIMIT 次）—— 能救回来就不算放弃
      if (await this.retryPendingJob(entry, reason)) return
      const who = `「${entry.nodeTitle || '这个节点'}」`
      const tried = Number(entry.retry || 0)
      const suffix = tried
        ? `（已自动换会话重试 ${tried} 次仍未成功）`
        : ''
      this.jobPendingList = (this.jobPendingList || []).filter(
        x => x.id !== entry.id
      )
      this.jobStatus = '结果取不回'
      this.jobStatusType = 'jobErr'
      this.jobWriteError = reason
        ? `${who}这次运行${reason}${suffix}`
        : `${who}那次任务其实已经执行，但这个会话（多半是「自动」起的无头会话）` +
          `不落回执，结果取不回${suffix} —— 产物一般在会话工作目录的 output/ 下；` +
          '也可以选中这条点「重取全文」再试一次。'
      this.$message.warning(this.jobWriteError)
      if (!(this.jobPendingList || []).length) this.stopJobPoll()
      this.loadJobHistory()
    },

    /**
     * 在**别的会话**里找这条任务。
     *
     * 为什么需要（2026-09-29）：派发目标可能在两次派发之间被换掉，于是
     * `entry.gateway` 记的那条会话里根本没有这条任务 —— 旧逻辑会连报
     * `JOB_POLL_MISS_LIMIT` 次「找不到这条任务」然后放弃，用户看到的是
     * 「任务桥里找不到这条任务（WorkBuddy 或桥接重启过）」这种吓人的结论，
     * 而任务其实好好地跑在另一条会话里。只在"当前会话找不到"时才走这里。
     */
    async findJobAcrossGateways(host, jobId, excludeGateway = '') {
      if (!host || !jobId) return null
      try {
        const gwRes = await listHostGateways(host)
        const urls = ((gwRes && gwRes.ok && gwRes.gateways) || [])
          .map(gw => String((gw && gw.url) || ''))
          .filter(url => url && url !== excludeGateway)
        for (const url of urls) {
          const r = await listHostJobs({ host, gateway: url }).catch(() => null)
          if (!r || !r.ok) continue
          const hit = (r.jobs || []).find(item => item.id === jobId)
          if (hit) return { job: hit, gateway: url }
        }
      } catch (err) {
        /* 找不到就按原逻辑走（继续累计 miss） */
      }
      return null
    },

    /** 这条任务派到哪台机器上（用条目自己记的，不用当前选中的） */
    hostOfEntry(entry) {
      if (entry && entry.hostKey) {
        const hit = (this.jobHosts || []).find(h => h.key === entry.hostKey)
        if (hit) return hit
      }
      return this.jobSelectedHost
    },

    /** 已经在路上（派出去还没收回）的任务数 —— 队列的"占用"判据 */
    jobBusyCount() {
      // 桥接：等回执的条数；助理：有没有一条在流式跑。
      // 两条通道共用一个闸门 —— 一次只跑一个任务，写回才不会互相抢（见 startOpenclawRun）。
      return (this.jobPendingList || []).length + (this.jobOpenclawBusy ? 1 : 0)
    },

    /**
     * 入队：把"组装好、只差派发"的这条任务排到队尾。
     *
     * 用户要求（2026-09-29）：「用队列排队执行」—— 一条会话（或助理）同时只跑一个任务，
     * 与其并发挤进去（后几条干等）或换到别的会话（端口乱跳），不如老老实实排队：
     * 上一个跑完，drainJobQueue 自动派下一个。
     *
     * 助理（OpenClaw）条目也会进这个队（channel=openclaw）：它没有 host/会话/回执，
     * 所以落点靠 container（入队时就建好了的任务容器）带回去，跑完由 drainJobQueue 起跑。
     */
    enqueueDispatch(item) {
      if (!item || !item.prompt) return
      if (!this.jobQueue) this.jobQueue = []
      this.jobQueue.push({
        key: `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        at: Date.now(),
        channel: item.channel || RUN_CHANNEL_BRIDGE,
        hostKey: (item.host && item.host.key) || this.jobHostKey,
        gateway: item.gateway || this.jobGateway,
        prompt: item.prompt,
        name: item.name || '脑图运行 · 排队',
        container: item.container || null,
        // 助理条目的产物目录（跑起来时按它捞产物）
        runDir: item.runDir || '',
        // 落点也平铺一份：万一 container 丢了（老数据 / 手工改），还能按 uid 挂回去
        nodeUid: (item.container && item.container.nodeUid) || '',
        nodeTitle: (item.container && item.container.nodeTitle) || '',
        continued: !!item.continued
      })
      this.saveJobQueue()
      const ahead = this.jobBusyCount() + (this.jobQueue || []).length - 1
      this.jobStatus = `已排队，前面还有 ${ahead} 个任务 —— 上一个跑完就轮到它`
      this.jobStatusType = 'jobWait'
      this.$message.info(`已排队（前面 ${ahead} 个），会按顺序执行`)
    },

    /** 有任务回来了 → 从队首取一个派出去（严格串行） */
    async drainJobQueue() {
      if (!(this.jobQueue || []).length) return
      if (this.jobBusyCount() > 0) return
      const item = this.jobQueue.shift()
      this.saveJobQueue()
      if (!item) return
      // 助理条目：没有 host / 会话 / 回执，直接把这条起跑（startOpenclawRun 自己收尾再 drain）
      if (item.channel === RUN_CHANNEL_OPENCLAW) {
        const container = item.container || {
          ok: true,
          nodeUid: item.nodeUid || '',
          nodeTitle: item.nodeTitle || ''
        }
        this.jobStatus = `队列到它了（助理）· ${
          container.nodeTitle || '当前节点'
        }`
        this.jobStatusType = 'jobWait'
        return this.startOpenclawRun({
          prompt: item.prompt,
          container,
          runDir: item.runDir || ''
        })
      }
      const host =
        (this.jobHosts || []).find(h => h.key === item.hostKey) || this.jobSelectedHost
      if (!host) {
        this.$message.error('排队任务没有可用主机，已跳过')
        return this.drainJobQueue()
      }
      try {
        const res = await dispatchWorkbuddyJob({
          host,
          gateway: item.gateway,
          prompt: item.prompt,
          name: item.name
        })
        if (!res || !res.ok) {
          const err =
            res && typeof res.error === 'string' ? res.error : '派发失败'
          this.jobStatus = `排队任务派发失败：${err}`
          this.jobStatusType = 'jobErr'
          this.$message.error(`排队中的任务派发失败：${err}`)
          return this.drainJobQueue()
        }
        const jobId = (res.job && (res.job.id || res.job.jobId)) || ''
        this.noteReceiptSafe(item.gateway, res.mode)
        this.addPendingJob({
          id: jobId,
          nodeUid: (item.container && item.container.nodeUid) || '',
          nodeTitle: (item.container && item.container.nodeTitle) || '',
          hostKey: host.key,
          gateway: item.gateway,
          prompt: item.prompt
        })
        this.jobStatus = `队列任务已派发（${this.gatewayShort(item.gateway)}）${
          jobId ? ` · ${jobId}` : ''
        }${this.pendingSuffix()}`
        this.jobStatusType = 'jobOk'
        this.startJobPoll()
      } catch (err) {
        this.$message.error(`排队任务派发异常：${(err && err.message) || err}`)
      }
    },

    /** 队列落盘：刷新页面不丢排队中的任务 */
    saveJobQueue() {
      try {
        if (typeof localStorage === 'undefined') return
        const rows = (this.jobQueue || []).filter(x => x && x.prompt)
        if (!rows.length) {
          localStorage.removeItem(JOB_QUEUE_STORE)
          return
        }
        localStorage.setItem(JOB_QUEUE_STORE, JSON.stringify(rows.slice(-20)))
      } catch (err) {
        /* 存不下不影响主流程 */
      }
    },

    /** 页面打开时把排队中的任务捡回来 */
    restoreJobQueue() {
      try {
        if (typeof localStorage === 'undefined') return 0
        const raw = localStorage.getItem(JOB_QUEUE_STORE)
        if (!raw) return 0
        const rows = JSON.parse(raw)
        if (!Array.isArray(rows)) {
          localStorage.removeItem(JOB_QUEUE_STORE)
          return 0
        }
        this.jobQueue = rows.filter(x => x && x.prompt)
        return this.jobQueue.length
      } catch (err) {
        return 0
      }
    },

    /** 记下一条"派出去等结果"的任务，并保证轮询在跑 */
    addPendingJob(entry) {
      if (!entry || !entry.id) return
      // 会话与主机**以 entry 自己带的为准**：并发派发时 this.jobGateway /
      // this.jobHostKey 可能已经被后一条改掉，取错会话就会拉到别的任务的全文和产物
      // （2026-09-29：写回内容对不上就是这么来的）。实例变量只在没传时兜底。
      const gateway = String((entry && entry.gateway) || this.jobGateway || '')
      const hostKey = String((entry && entry.hostKey) || this.jobHostKey || '')
      this.rememberSession(gateway)
      const list = (this.jobPendingList || []).filter(x => x.id !== entry.id)
      list.push(
        Object.assign({ miss: 0, at: Date.now() }, entry, { gateway, hostKey })
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
        // 「执行失败」先换个会话重试（最多 JOB_RETRY_LIMIT 次）；
        // 「已停止」是用户主动停的，不重试。
        if (state === 'failed' && (await this.retryPendingJob(entry, '执行失败'))) {
          return
        }
        this.jobStatus = state === 'failed' ? '执行失败' : '已停止'
        this.jobStatusType = 'jobErr'
        this.jobWriteState = ''
        const triedFail = Number(entry.retry || 0)
        const suffixFail = triedFail
          ? `（已自动换会话重试 ${triedFail} 次）`
          : ''
        this.jobWriteError =
          state === 'failed'
            ? `${who}那次运行失败了，没有写回导图${suffixFail}`
            : `${who}那次运行被停止了，没有写回导图`
        this.$message.error(this.jobWriteError)
        this.loadJobHistory()
        return
      }
      this.jobStatus = `已完成（${state || 'done'}）`
      this.jobStatusType = 'jobOk'
      const markdown =
        entry.cachedText || (await this.fetchJobText(jobId, entry)) || detail
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
          // 「自动」会话扫回来的产物（没有正文时也要把文件挂上）
          artifacts: entry.cachedArtifacts || null,
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
            await this.notePendingJobMissing(entry, '找不到执行主机')
            continue
          }
          const res = await listHostJobs({ host, gateway: entry.gateway })
          if (!res.ok) {
            missed += 1
            await this.notePendingJobMissing(entry, res.error || '拿不到任务列表')
            continue
          }
          let cur = (res.jobs || []).find(item => item.id === entry.id)
          if (!cur) {
            // 这条会话里没有 → 很可能任务被派到了**别的会话**（派发目标在两次
            // 派发之间被换过），而不是"记录消失"。跨会话再找一遍，
            // 别一上来就报「任务桥里找不到这条任务、可以重跑一次」（2026-09-29）。
            const hit = await this.findJobAcrossGateways(host, entry.id, entry.gateway)
            if (hit) {
              cur = hit.job
              if (hit.gateway) entry.gateway = hit.gateway
            }
          }
          if (!cur) {
            missed += 1
            await this.notePendingJobMissing(entry, '')
            continue
          }
          entry.miss = 0
          const state = cur.state || cur.status || ''
          // 与 isJobRunning 同源：终态优先，别让 alive 把跑完的任务一直挂着不回写
          const isRunning = this.isJobRunning(cur)
          if (isRunning) {
            // 有些会话**不落回执**（见 JOB_RECEIPT_GRACE_MS）：run 永远判不出终态，
            // 但正文其实能从会话历史里取到。派发够久了就主动收一次，别让页面永远转圈。
            if (this.pendingReceiptTimedOut(entry)) {
              const text = await this.fetchJobText(entry.id, entry)
              if (text) {
                entry.cachedText = text
                cur.detail = text
                finished.push({ entry, cur, state: 'recovered' })
                continue
              }
              // 拉不到正文：这类会话（旧版 WorkBuddy 的 headless 实例）连会话历史
              // 都没有，但**产物文件确实落在 output/ 下** —— 按时间窗扫一遍，
              // 有就先把产物挂回导图（用户：「没法返回产物，但是能知道跑了」）
              const files = await this.fetchRecentArtifactsFor(entry)
              if (files.length) {
                entry.cachedArtifacts = files
                cur.detail =
                  `（这个会话不返回文字结果，已把 ${files.length} 个产物挂到「附件」下）`
                finished.push({ entry, cur, state: 'artifacts' })
                continue
              }
              // 还是什么都没有：可能真在跑（长任务），给到放弃线再收尾
              if (this.pendingReceiptGaveUp(entry)) {
                await this.abandonPendingJob(entry)
                continue
              }
            }
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
        if (!(this.jobPendingList || []).length) {
          this.stopJobPoll()
          // 队列里还有排队的 → 派下一个（严格串行执行）
          if ((this.jobQueue || []).length) {
            await this.drainJobQueue()
            if ((this.jobPendingList || []).length) this.startJobPoll()
          }
        }
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
      // ⚠️ 2026-09-28：**也要在运行历史里找**。以前只查 `jobPendingList`（内存态、刷新即空），
      // 于是从历史列表点「停止」时 entry 为空 → gateway 回落到「当前选中的那条会话」，
      // 停的可能是别人的任务（串台）。桥接现在给每条 job 都带了 `gateway`，正好能用。
      const entry =
        (this.jobPendingList || []).find(x => x.id === jobId) ||
        (this.jobHistory || []).find(x => x.id === jobId) ||
        null
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
      if (this.fileToolbarCollapsed) this.filePopoverShow = false
    },

    onFileToolbarAction(key) {
      this.filePopoverShow = false
      switch (key) {
        case 'new': return this.createNewLocalFile()
        case 'saveAs': return this.saveLocalFile()
        case 'import': return this.$bus.$emit('showImport')
        case 'copyInvite': return this.$bus.$emit('copyInviteLink')
        case 'share': return this.$bus.$emit('showShareAcl')
        case 'history': return this.$emit('open-history')
        case 'maps': return this.goToMyMaps()
        case 'refresh': return this.refreshPage()
        case 'check': return this.openCpdCheck()
        case 'run': return this.runWorkbuddyJob()
        case 'export': return this.$bus.$emit('showExport')
      }
    },

    // 两侧面板等宽；首次溢出时同时出现“更多”，之后各自按半区宽度收纳。
    async computeToolbarShow() {
      if (!this.$refs.toolbarRef) return
      const revision = (this.toolbarLayoutRevision || 0) + 1
      this.toolbarLayoutRevision = revision
      const nodeActions = this.isReadonly ? [] : [...this.btnLit]
      this.horizontalList = nodeActions
      this.verticalList = []
      this.showMoreBtn = false
      this.fileHorizontalCount = this.fileToolbarActions.length
      this.popoverShow = false
      this.filePopoverShow = false
      await this.$nextTick()
      const overflows = block => {
        if (!block) return false
        const blockStyle = window.getComputedStyle(block)
        const available = block.clientWidth -
          parseFloat(blockStyle.paddingLeft) -
          parseFloat(blockStyle.paddingRight)
        const used = Array.from(block.children).reduce((width, child) => {
          const style = window.getComputedStyle(child)
          if (style.position === 'absolute') return width
          return width + child.getBoundingClientRect().width +
            parseFloat(style.marginLeft) + parseFloat(style.marginRight)
        }, 0)
        return used > available + 1
      }
      const nodeOverflows = () => overflows(this.$refs.nodeToolbarBlock)
      const fileOverflows = () => overflows(this.$refs.fileToolbarBlock)
      while (
        revision === this.toolbarLayoutRevision &&
        (nodeOverflows() || fileOverflows())
      ) {
        let changed = false
        if (
          this.horizontalList.length > 0 &&
          (nodeOverflows() || !this.showMoreBtn)
        ) {
          this.horizontalList = nodeActions.slice(0, this.horizontalList.length - 1)
          this.verticalList = nodeActions.slice(this.horizontalList.length)
          this.showMoreBtn = this.verticalList.length > 0
          changed = true
        }
        if (
          this.fileHorizontalCount > 0 &&
          (fileOverflows() || this.fileVerticalActions.length === 0)
        ) {
          this.fileHorizontalCount--
          changed = true
        }
        if (!changed) break
        await this.$nextTick()
      }
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
        .collabPresence {
          color: hsla(0, 0%, 100%, 0.8);
        }
        .miniAvatar {
          border-color: #262a2e;
        }
        .saveChip {
          border-color: rgba(255, 255, 255, 0.14);
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

        // 派发中：图标方块亮成主题色（深色主题下的配色）
        // 文字色也要拉回来 —— .disabled 的 #54595f 在 #262a2e 工具栏上几乎看不见，
        // 而此刻按钮只是「暂时不可重复点」，不是「坏掉」
        &.busy {
          color: hsla(0, 0%, 100%, 0.9);

          .icon {
            border-color: rgba(64, 158, 255, 0.55);
            background: rgba(64, 158, 255, 0.16);
          }
        }
      }
    }
  }
  .toolbar {
    position: fixed;
    left: 20px;
    right: 20px;
    top: 20px;
    display: flex;
    gap: 20px;
    font-size: 12px;
    font-family:
      PingFangSC-Regular,
      PingFang SC;
    font-weight: 400;
    color: rgba(26, 26, 26, 0.8);
    z-index: 2;
    .toolbarBlockWrapper {
      position: relative;
      flex: 1 1 0;
      min-width: 0;
      transition: transform 0.3s;

      &.nodeToolbarWrapper .toolbarBlock {
        margin-left: auto;
        margin-right: 0;
      }

      &.fileToolbarWrapper .toolbarBlock {
        margin-left: 0;
        margin-right: auto;
      }

      &.collapsed {
        transform: translateY(calc(-100% - 20px));
      }

      .collapseToggleBtn {
        position: absolute;
        left: 50%;
        top: 100%;
        width: 60px;
        height: 20px;
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
        z-index: 0;

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
      justify-content: center;
      box-sizing: border-box;
      width: max-content;
      max-width: 100%;
      margin: 0 auto;
      background-color: #fff;
      padding: 10px 20px;
      border-radius: 6px;
      box-shadow: 0 2px 16px 0 rgba(0, 0, 0, 0.06);
      border: 1px solid rgba(0, 0, 0, 0.06);
      position: relative;
      z-index: 1;

      /deep/ .toolbarNodeBtnList,
      /deep/ .toolbarFileBtnList,
      .collabStatus {
        flex-shrink: 0;
      }

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

      // 派发中：图标方块亮成主题色，一眼看出「在跑」而不是「按钮坏了」。
      // 文字色也一起拉回来（.disabled 的 #bcbcbc 太淡），因为此刻按钮只是
      // 「暂时不可重复点」，不是真禁用。
      // 两条 .busy 各有主题：深色那条带 .isDark 多一层类，优先级更高，不会互相覆盖。
      &.busy {
        color: rgba(26, 26, 26, 0.8);

        .icon {
          border-color: #409eff;
          background: #ecf5ff;
        }
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

        // 图标本体。转圈只转它，外层的方块（边框+白底）保持静止。
        // inline-block 是转圈动画生效的前提，别删。
        i {
          display: inline-block;
          line-height: 1;
        }

        .refreshIcon {
          display: inline-block;
          line-height: 1;
        }
      }

      .text {
        margin-top: 3px;
      }
    }

    .fileMoreBtn {
      align-items: center;
      margin-left: 20px;
      margin-right: 0;
      text-align: center;

      .icon {
        box-sizing: border-box;
        width: 28px;
        height: 26px;
        padding: 0;
        align-items: center;
        font-size: 18px;
      }
    }

    .moreIcon {
      font-size: 18px;
    }

    .collabStatus {
      display: flex;
      align-items: center;
      margin-right: 20px;
      padding: 5px 10px;
      border-radius: 999px;
      background: rgba(15, 23, 42, 0.04);
      border: 1px solid rgba(15, 23, 42, 0.08);
      cursor: default;

      &.cooperating {
        border-color: rgba(16, 185, 129, 0.35);
      }

      .collabPresence {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 0;
        border: 0;
        background: transparent;
        color: #475569;
        font: inherit;
        white-space: nowrap;
        cursor: pointer;
        &:hover {
          color: #334155;
        }
        &:focus-visible {
          outline: 2px solid #409eff;
          outline-offset: 3px;
        }
      }

      .avatarStack {
        display: inline-flex;
        align-items: center;
        margin-right: 3px;
      }
      .miniAvatar {
        width: 19px;
        height: 19px;
        margin-left: -5px;
        border: 2px solid #fff;
        border-radius: 50%;
        box-sizing: border-box;
        color: #fff;
        font-size: 10px;
        line-height: 15px;
        text-align: center;
        &:first-child {
          margin-left: 0;
        }
      }
      .peerCount {
        font-weight: 500;
        color: inherit;
      }

      .saveChip {
        margin-left: 9px;
        padding-left: 9px;
        border-left: 1px solid rgba(15, 23, 42, 0.12);
        font-size: 11px;
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
/**
 * 轻提示（$message）默认弹在**视口顶部居中**，而「运行」按钮就在顶部工具栏上 ——
 * 每次派发/失败/重试弹一条就把按钮盖住（2026-09-29 用户反馈：「不要弹出信息挡住运行按钮」）。
 *
 * 统一往下挪一截。这里刻意用 `margin-top` 而不是改 `top`：
 * element-ui 靠给每条消息算 inline `top` 来堆叠，改 top 会把堆叠算坏（多条会叠在一起），
 * margin 是在其之上再偏移，堆叠不受影响。
 */
.el-message {
  margin-top: 72px;
}

/**
 * 运行通道选择弹窗（2026-10-08）。
 * 必须放**非 scoped** 里 —— 弹窗用了 append-to-body，会挂到 body 下，
 * scoped 的 data-v 属性选不到它。
 */
.runChannelBox {
  display: flex;
  flex-direction: column;

  .runChannelItem {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 12px 14px;
    border: 1px solid #e4e7ed;
    border-radius: 8px;
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;

    & + .runChannelItem {
      margin-top: 10px;
    }

    &:hover {
      border-color: #c6e2ff;
    }

    &.active {
      border-color: #409eff;
      background: #ecf5ff;
    }
  }

  .runChannelRadio {
    margin: 3px 0 0;
    flex: none;
  }

  .runChannelBody {
    display: flex;
    flex-direction: column;
  }

  .runChannelTitle {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 14px;
    font-weight: 600;
    color: #1a1a1a;
  }

  .runChannelTag {
    padding: 0 4px;
    border: 1px solid #b3d8ff;
    border-radius: 3px;
    font-size: 11px;
    font-weight: 400;
    line-height: 16px;
    color: #409eff;
  }

  .runChannelDesc {
    margin-top: 4px;
    font-size: 12px;
    line-height: 1.5;
    color: #7a7f85;
  }
}

/* 深色主题（画布夜间模式）下的通道弹窗 */
.isDark .runChannelBox,
.el-dialog__wrapper.isDark .runChannelBox {
  .runChannelItem {
    border-color: #3a4046;
    background: #262a2e;

    &:hover {
      border-color: #4a6b8a;
    }

    &.active {
      border-color: #409eff;
      background: rgba(64, 158, 255, 0.16);
    }
  }

  .runChannelTitle {
    color: #e8eaed;
  }

  .runChannelDesc {
    color: #9aa1a9;
  }
}

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
  max-width: calc(100vw - 32px);
  margin-top: 8vh !important;
  border-radius: 16px;
  overflow: hidden;
  box-shadow: 0 24px 64px rgba(18, 38, 61, 0.22);

  .el-dialog__header {
    padding: 20px 24px 16px;
    border-bottom: 1px solid #e8edf2;
  }
  .el-dialog__headerbtn {
    top: 24px;
    right: 24px;
  }
  .el-dialog__body {
    padding: 0;
  }
  .histDialogTitle {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding-right: 36px;
  }
  .histEyebrow {
    color: #83909d;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
  }
  .histHeading {
    color: #20354a;
    font-size: 19px;
    font-weight: 650;
  }
  .histCount {
    padding: 2px 8px;
    border-radius: 999px;
    background: #edf4fb;
    color: #366487;
    font-size: 11px;
    white-space: nowrap;
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
    height: 68vh;
    max-height: 610px;
    min-height: 400px;

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
    flex: 0 0 290px;
    flex-direction: column;
    min-width: 0;
    padding: 18px 14px 14px;
    border-right: 1px solid #e8edf2;
    background: #f8fafc;
  }
  .histSidebarHead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
    color: #20354a;
    font-size: 13px;
  }
  .histRefresh {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 5px 6px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: #3974a4;
    font-size: 12px;
    cursor: pointer;
    &:hover:not(:disabled) {
      background: #e8f2fa;
    }
    &:disabled {
      opacity: 0.6;
      cursor: default;
    }
  }
  .histListCount {
    margin: 12px 2px 8px;
    color: #83909d;
    font-size: 11px;
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
    overflow: auto;
    min-height: 0;
    border: 0;
  }
  .histItem {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    width: 100%;
    padding: 11px 10px;
    margin-bottom: 6px;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
    border: 1px solid transparent;
    border-radius: 10px;
    background: transparent;
    &:hover {
      background: #eef4f8;
    }
    &.active {
      border-color: #b8d5eb;
      background: #e8f3fb;
    }
    &:focus-visible {
      outline: 2px solid #409eff;
      outline-offset: 1px;
    }
  }
  .histItem .hDot {
    flex: 0 0 auto;
    width: 7px;
    height: 7px;
    margin-top: 5px;
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
  .histItemText {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .histItem .hName {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #24384a;
    font-size: 12px;
    font-weight: 600;
  }
  .histItem .hMeta {
    color: #83909d;
    font-size: 11px;
  }
  .histItem .hState {
    flex: 0 0 auto;
    padding: 2px 5px;
    border-radius: 4px;
    background: #e9eef3;
    color: #637181;
    font-size: 10px;
    &.s-done,
    &.s-completed {
      background: #e6f5ed;
      color: #167349;
    }
    &.s-working,
    &.s-running,
    &.s-busy,
    &.s-active,
    &.s-pending {
      background: #fff3dc;
      color: #9b691a;
    }
    &.s-failed {
      background: #feebea;
      color: #b93e39;
    }
  }
  .histEmpty,
  .histDetailEmpty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    min-height: 170px;
    padding: 20px;
    color: #8796a5;
    text-align: center;
    i {
      font-size: 24px;
      color: #a5b9c8;
    }
    strong {
      color: #4d6072;
      font-size: 13px;
    }
    p,
    span {
      margin: 0;
      font-size: 11px;
      line-height: 1.5;
      word-break: break-word;
    }
  }
  .histFoot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid #e8edf2;
    .jobHint {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }

  .histRight {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    padding: 20px 22px 18px;
  }
  .histHead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding-bottom: 16px;
    font-size: 13px;
    color: #606266;
    border-bottom: 1px solid #ebeef5;
  }
  .histHeadInfo {
    display: flex;
    flex-direction: column;
    gap: 5px;
    min-width: 0;
  }
  .histTitle {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #20354a;
    font-size: 14px;
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
    min-height: 0;
    margin-top: 14px;
    padding: 16px 18px;
    overflow: auto;
    font-size: 13px;
    line-height: 1.65;
    word-break: break-word;
    color: #344658;
    background: #f8fafc;
    border: 1px solid #e8edf2;
    border-radius: 10px;
  }
  .histDetailEmpty {
    flex: 1;
    min-height: 0;
    margin-top: 14px;
    border: 1px dashed #d8e3eb;
    border-radius: 10px;
    background: #fbfcfe;
  }
  .histComposer {
    margin-top: 14px;
    padding-top: 14px;
    border-top: 1px solid #e8edf2;
  }
  .histComposerLabel {
    display: block;
    margin-bottom: 8px;
    color: #344658;
    font-size: 12px;
    font-weight: 600;
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

  &.isDark {
    background: #242a2f;
    color: #dce6ed;
    .el-dialog__header,
    .histHead,
    .histComposer,
    .histFoot {
      border-color: #3b454d;
    }
    .histHeading,
    .histSidebarHead,
    .histTitle,
    .histComposerLabel {
      color: #e1eaf0;
    }
    .histCount {
      background: #304252;
      color: #a9d1ef;
    }
    .histLeft {
      border-color: #3b454d;
      background: #20262b;
    }
    .histRefresh {
      color: #9fcdf0;
      &:hover:not(:disabled) {
        background: #30404c;
      }
    }
    .histItem {
      &.active {
        border-color: #52738d;
        background: #2d4050;
      }
    }
    .histItem .hState {
      background: #35414b;
      color: #b5c6d2;
      &.s-done,
      &.s-completed {
        background: #1f493b;
        color: #9de0bd;
      }
      &.s-working,
      &.s-running,
      &.s-busy,
      &.s-active,
      &.s-pending {
        background: #574730;
        color: #f0c983;
      }
      &.s-failed {
        background: #543636;
        color: #f1aaaa;
      }
    }
    .histEmpty,
    .histDetailEmpty {
      color: #a8b7c2;
      strong {
        color: #d4e0e8;
      }
    }
    .histDetailEmpty {
      border-color: #45515a;
      background: #20262b;
    }
    .histBody {
      border-color: #3b454d;
    }
  }
}

@media screen and (max-width: 720px) {
  .workbuddyJobDialog {
    width: calc(100vw - 24px) !important;
    max-width: none;
    margin-top: 12px !important;
    .el-dialog__header {
      padding: 14px 16px 12px;
    }
    .el-dialog__headerbtn {
      top: 17px;
      right: 16px;
    }
    .histDialogTitle {
      flex-wrap: wrap;
      gap: 3px 8px;
    }
    .histEyebrow {
      width: 100%;
    }
    .hist {
      flex-direction: column;
      height: calc(100vh - 104px);
      min-height: 0;
    }
    .histLeft {
      flex: 0 0 200px;
      padding: 12px;
      border-right: 0;
      border-bottom: 1px solid #e8edf2;
    }
    .histRight {
      min-height: 0;
      padding: 12px;
    }
    .histHead {
      padding-bottom: 9px;
    }
    .histHeadBtns {
      gap: 0;
    }
    .histComposer {
      margin-top: 9px;
      padding-top: 9px;
    }
    .composerBar {
      flex-wrap: wrap;
    }
    .composerBtns {
      margin-left: auto;
    }
  }
}
</style>
