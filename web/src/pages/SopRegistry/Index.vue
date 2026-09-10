<template>
  <div class="sopPage" :class="{ detailMode: detailMode }">
    <header class="sopHeader">
      <div class="left">
        <el-button size="mini" @click="goBack">{{ headerBackLabel }}</el-button>
        <h1 v-if="!detailMode">SOP 台账</h1>
        <h1 v-else class="detailTitle">
          {{ (activeSop && activeSop.title) || dialogTitle || 'SOP 详情' }}
        </h1>
      </div>
      <div class="right" v-if="!detailMode">
        <span class="spaceLabel">空间</span>
        <el-select
          v-model="roomKey"
          size="small"
          filterable
          clearable
          placeholder="选择抽取空间"
          class="spaceSelect"
          :loading="spacesLoading"
          @change="onSpaceChange"
        >
          <el-option
            v-for="item in spaceOptions"
            :key="item.room_key"
            :label="item.label"
            :value="item.room_key"
          ></el-option>
        </el-select>
        <el-button
          size="mini"
          type="primary"
          :loading="pullLoading"
          :disabled="!roomKey"
          @click="refreshRoomList"
        >
          刷新
        </el-button>
      </div>
      <div class="right" v-else>
        <el-button
          size="mini"
          type="primary"
          :disabled="!activeSop"
          @click="openRunDialog(activeSop)"
        >
          运行
        </el-button>
        <el-button size="mini" :loading="subtreeLoading" @click="reloadDetail">
          刷新导图
        </el-button>
      </div>
    </header>

    <template v-if="!detailMode">
      <div class="statusLine" v-if="statusText">{{ statusText }}</div>
      <div class="statusLine runStatus" v-if="sopQueueSummary">
        {{ sopQueueSummary }}
      </div>

      <div v-if="!roomKey" class="emptyState">请先选择空间</div>
      <div v-else-if="!pullLoading && !sops.length" class="emptyState">
        该空间未找到 SOP
      </div>
      <div v-else class="cardGrid">
        <article
          class="sopCard"
          v-for="item in sops"
          :key="item.rowKey"
          title="双击打开导图 / 历史任务 / 产物"
          @dblclick="openSubtree(item)"
        >
          <div class="cardHead">
            <h2 class="cardTitle">{{ item.title }}</h2>
            <div class="cardActions">
              <span
                v-if="sopCardJobState(item)"
                class="jobChip"
                :class="sopCardJobState(item)"
                >{{ sopCardJobLabel(item) }}</span
              >
              <el-button
                type="primary"
                size="mini"
                :loading="sopCardJobState(item) === 'running'"
                :disabled="!!sopCardJobState(item)"
                @click.stop="openRunDialog(item)"
              >
                运行
              </el-button>
            </div>
          </div>
          <div class="cardMeta">
            <span
              class="metaChip"
              v-for="(chip, idx) in sopCardMetaChips(item)"
              :key="idx"
              >{{ chip }}</span
            >
          </div>
          <div class="cardBlock">
            <div class="blockBody">{{ latestRunLabel(item) }}</div>
          </div>
        </article>
      </div>
    </template>

    <div class="sopDetailPage" v-else>
      <el-tabs v-model="dialogTab" class="detailTabs">
        <el-tab-pane label="导图" name="map">
          <div class="syncBar">
            <span class="syncDot" :class="syncStatus"></span>
            <span>{{ syncLabel }}</span>
            <span class="syncTip">编辑会同步到房间；导图页也会收到更新</span>
          </div>
          <div class="mindWrap" v-loading="subtreeLoading">
            <div v-if="subtreeError" class="emptyState">{{ subtreeError }}</div>
            <div
              v-show="!subtreeError"
              ref="mindMapContainer"
              class="mindMapContainer"
            ></div>
          </div>
        </el-tab-pane>
        <el-tab-pane label="历史任务" name="runs">
          <div class="historyPane">
            <SopTaskBoard
              v-if="detailSopTaskJobs.length"
              embedded
              title="SOP 任务"
              :jobs="detailSopTaskJobs"
              :selected-id="selectedSopJobId"
              @select="selectSopJob"
              @cancel="cancelSopJob"
              @cancel-all="cancelAllSopJobs"
              @resume="resumeSopJob"
              @fill-data="openDataFillDialog"
            />
            <div v-else class="paneEmpty soft">
              暂无进行中的 SOP 任务；可点右上角「运行」发起。
              <el-button type="text" @click="$router.push('/sop-tasks')"
                >打开多任务页</el-button
              >
            </div>

            <div class="ledgerPane historyLedger" v-loading="ledgerSaving">
              <el-collapse v-model="historyLedgerOpen">
                <el-collapse-item name="ledger">
                  <template slot="title">
                    <span class="sectionLabel inline"
                      >台账运行记录（{{ activeLedger.runs.length }}）</span
                    >
                  </template>
                  <div class="addForm">
                    <el-input
                      v-model="runForm.at"
                      size="small"
                      placeholder="时间（如 2026-09-04 18:00）"
                      class="formField"
                    ></el-input>
                    <el-input
                      v-model="runForm.result"
                      size="small"
                      placeholder="结果（完成 / 失败…）"
                      class="formField short"
                    ></el-input>
                    <el-input
                      v-model="runForm.note"
                      size="small"
                      placeholder="备注"
                      class="formField"
                    ></el-input>
                    <el-button
                      type="primary"
                      size="small"
                      :disabled="!activeSopUid"
                      @click="submitRun"
                    >
                      追加运行
                    </el-button>
                  </div>
                  <ul class="ledgerList" v-if="activeLedger.runs.length">
                    <li
                      v-for="r in visibleLedgerRuns"
                      :key="r.id"
                      :title="[r.at, r.result, r.note].filter(Boolean).join(' · ')"
                    >
                      <span class="liMain">{{ shortLedgerRunLabel(r) }}</span>
                      <span class="liActor" v-if="r.actor">{{ r.actor }}</span>
                    </li>
                  </ul>
                  <div
                    v-if="activeLedger.runs.length > ledgerRunLimit"
                    class="ledgerMore"
                  >
                    <el-button type="text" size="mini" @click="toggleLedgerRunLimit">
                      {{
                        ledgerRunExpanded
                          ? '收起'
                          : `展开全部 ${activeLedger.runs.length} 条`
                      }}
                    </el-button>
                  </div>
                  <div v-if="!activeLedger.runs.length" class="paneEmpty">
                    暂无运行记录
                  </div>
                </el-collapse-item>
              </el-collapse>
            </div>
          </div>
        </el-tab-pane>
        <el-tab-pane label="产物" name="dels">
          <div class="ledgerPane" v-loading="ledgerSaving">
            <ul class="ledgerList" v-if="activeLedger.deliverables.length">
              <li v-for="d in activeLedger.deliverables" :key="d.id">
                <span class="liMain">
                  <a
                    v-if="isHttp(d.uri_or_path)"
                    :href="d.uri_or_path"
                    target="_blank"
                    rel="noopener"
                    >{{ d.name }}</a
                  >
                  <template v-else>{{ d.name }}</template>
                  <span
                    class="liPath"
                    v-if="d.uri_or_path && !isHttp(d.uri_or_path)"
                  >
                    {{ d.uri_or_path }}
                  </span>
                  <span class="liAt" v-if="d.at">{{ d.at }}</span>
                </span>
                <span class="liActions">
                  <el-button
                    v-if="canPreviewDeliverable(d)"
                    type="text"
                    size="mini"
                    @click="previewDeliverable(d)"
                  >
                    预览
                  </el-button>
                  <el-button
                    v-if="canDownloadDeliverable(d)"
                    type="text"
                    size="mini"
                    @click="downloadDeliverable(d)"
                  >
                    下载
                  </el-button>
                  <span class="liKind">{{ d.kind }}</span>
                </span>
              </li>
            </ul>
            <div v-else class="paneEmpty">暂无产物</div>
          </div>
        </el-tab-pane>
      </el-tabs>
    </div>

    <el-dialog
      title="运行 SOP"
      :visible.sync="runDialogVisible"
      width="640px"
      top="8vh"
      append-to-body
      :close-on-click-modal="false"
      custom-class="sopRunDialog"
    >
      <p class="runDialogLead" v-if="runTarget">
        配置「{{ runTarget.id }}：{{ runTarget.title }}」后加入任务队列；可关闭本窗口，任务在后台并行执行。
      </p>
      <div class="runModelRow">
        <span class="runModelLabel">执行引擎</span>
        <el-radio-group v-model="runBackend" size="small" @change="onRunBackendChange">
          <el-radio-button :label="AI_BACKEND_WORKBUDDY">WorkBuddy</el-radio-button>
          <el-radio-button :label="AI_BACKEND_XIAOCE">小策</el-radio-button>
          <el-radio-button :label="AI_BACKEND_OPENCLAW">助理</el-radio-button>
        </el-radio-group>
      </div>
      <div class="runModelRow" v-if="runBackend === AI_BACKEND_XIAOCE">
        <span class="runModelLabel">企业</span>
        <el-select v-model="runOrganizationId" size="small" :loading="runScopeLoading" placeholder="选择企业" class="runModelSelect" @change="onRunOrganizationChange">
          <el-option v-for="item in runOrganizations" :key="item.id" :label="item.name" :value="String(item.id)"></el-option>
        </el-select>
        <el-button size="mini" :loading="runScopeLoading" @click="loadRunXiaoceScope(true)">刷新</el-button>
      </div>
      <div class="runModelRow" v-if="runBackend === AI_BACKEND_XIAOCE">
        <span class="runModelLabel">智能体</span>
        <el-select v-model="runAgentId" size="small" :loading="runScopeLoading" placeholder="选择智能体" class="runModelSelect">
          <el-option v-for="item in runAgents" :key="item.id" :label="`${item.emoji || '🤖'} ${item.name}`" :value="String(item.id)"></el-option>
        </el-select>
      </div>
      <div class="runModelRow" v-else-if="runBackend === AI_BACKEND_OPENCLAW">
        <span class="runModelLabel">模型</span>
        <el-select
          v-model="runModel"
          size="small"
          filterable
          allow-create
          default-first-option
          :loading="runModelsLoading"
          placeholder="选择助理模型"
          class="runModelSelect"
          @visible-change="onRunModelDropdown"
        >
          <el-option
            v-for="item in runOpenclawModels"
            :key="'oc-' + item.id"
            :label="item.name || item.id"
            :value="item.id"
          ></el-option>
        </el-select>
        <el-button
          size="mini"
          :loading="runModelsLoading"
          @click="loadRunModels(true)"
          >刷新</el-button
        >
      </div>
      <div class="runModelRow" v-else>
        <span class="runModelLabel">模型</span>
        <el-select
          v-model="runModel"
          size="small"
          filterable
          :loading="runModelsLoading"
          placeholder="选择 WorkBuddy 模型"
          class="runModelSelect"
          @visible-change="onRunModelDropdown"
        >
          <el-option-group
            v-if="runCustomModels.length"
            label="自定义模型（推荐，不耗积分）"
          >
            <el-option
              v-for="item in runCustomModels"
              :key="'c-' + item.id"
              :label="item.name || item.id"
              :value="item.id"
            ></el-option>
          </el-option-group>
          <el-option-group
            v-if="runPlatformModels.length"
            label="平台模型"
          >
            <el-option
              v-for="item in runPlatformModels"
              :key="'p-' + item.id"
              :label="item.name || item.id"
              :value="item.id"
            ></el-option>
          </el-option-group>
        </el-select>
        <el-button
          size="mini"
          :loading="runModelsLoading"
          @click="loadRunModels(true)"
          >刷新</el-button
        >
      </div>
      <el-checkbox-group v-model="runOutputIds" class="outputChecks">
        <el-checkbox
          v-for="opt in outputPresets"
          :key="opt.id"
          :label="opt.id"
        >
          <span class="optLabel">{{ opt.label }}</span>
          <span class="optHint">{{ opt.hint }}</span>
        </el-checkbox>
      </el-checkbox-group>
      <p class="runOutputTip">
        流程型 SOP（通知 / 招聘 / 审批）可不勾产物，直接执行；需要落盘文件时再勾选。
      </p>
      <div v-if="runSubmitLoading" class="runSubmitLoading">正在读取资料模板…</div>
      <div
        class="runSubmitBox"
        v-else-if="runSubmitFields.length"
      >
        <div class="runSubmitHead">
          <strong>先填写资料再执行</strong>
          <span v-if="runSubmitZoneHint">{{ runSubmitZoneHint }}</span>
        </div>
        <p class="runSubmitTip">
          检测到「提交资料 / 提供」类节点，请按模板填写；内容会随任务一并交给执行助手。
        </p>
        <div class="runSubmitGrid">
          <div
            class="runSubmitField"
            v-for="f in runSubmitFields"
            :key="f.key"
          >
            <label>{{ f.label }}</label>
            <el-input
              v-model="f.value"
              size="small"
              clearable
              :placeholder="f.hint || '请填写'"
            ></el-input>
          </div>
        </div>
      </div>
      <el-input
        v-model="runExtraNote"
        type="textarea"
        :rows="runSubmitFields.length ? 2 : 3"
        :placeholder="
          runSubmitFields.length
            ? '其它补充说明（可选）。发代办可写：给张三发个代办 / 代办人：张三'
            : '额外要求，例如：给黄炜龙发个代办；或：我要招聘一个初级客服'
        "
        class="runExtra"
      ></el-input>
      <span slot="footer">
        <el-button size="small" @click="runDialogVisible = false"
          >取消</el-button
        >
        <el-button
          type="primary"
          size="small"
          :loading="runSubmitLoading"
          @click="confirmRunSop"
        >
          {{ runSubmitFields.length ? '提交资料并开始' : '加入队列并开始' }}
        </el-button>
      </span>
    </el-dialog>

    <el-dialog
      title="补充缺失数据"
      :visible.sync="dataFillDialogVisible"
      width="640px"
      top="8vh"
      append-to-body
      :close-on-click-modal="false"
      custom-class="sopDataFillDialog"
    >
      <p class="fillDialogLead" v-if="dataFillJobTitle">
        「{{ dataFillJobTitle }}」缺少关键数据，填完后继续执行。
      </p>
      <p class="fillDialogHint" v-if="shortDataFillHint">{{ shortDataFillHint }}</p>
      <div class="fillDialogGrid">
        <div class="fillDialogField" v-for="f in dataFillFields" :key="f.key">
          <label>{{ f.label }}</label>
          <el-input
            v-model="f.value"
            size="small"
            clearable
            placeholder="请填写"
          ></el-input>
        </div>
      </div>
      <div class="fillDialogExtra">
        <label>其它补充说明（可选）</label>
        <el-input
          v-model="dataFillExtra"
          type="textarea"
          :rows="3"
          placeholder="补充上下文、约束或链接等"
        ></el-input>
      </div>
      <span slot="footer" class="fillDialogFooter">
        <el-button size="small" @click="dataFillDialogVisible = false"
          >取消</el-button
        >
        <el-button
          type="primary"
          size="small"
          :loading="dataFillSubmitting"
          @click="submitMissingDataAndResume"
        >
          提交并继续
        </el-button>
      </span>
    </el-dialog>

    <el-dialog
      :title="artifactPreviewTitle"
      :visible.sync="artifactPreviewVisible"
      width="860px"
      append-to-body
      custom-class="artifactPreviewDialog"
      @closed="onArtifactPreviewClosed"
    >
      <iframe
        v-if="artifactPreviewUrl"
        class="artifactPreviewFrame"
        :src="artifactPreviewUrl"
        title="产物预览"
      ></iframe>
      <div v-else class="paneEmpty">无法预览</div>
      <span slot="footer" class="dialog-footer">
        <el-button
          v-if="artifactPreviewDownloadUrl"
          type="primary"
          size="small"
          @click="openUrl(artifactPreviewDownloadUrl)"
        >
          下载
        </el-button>
        <el-button size="small" @click="artifactPreviewVisible = false"
          >关闭</el-button
        >
      </span>
    </el-dialog>
  </div>
</template>

<script>
import { mapMutations } from 'vuex'
import { io } from 'socket.io-client'
import MindMap from 'simple-mind-map'
import Drag from 'simple-mind-map/src/plugins/Drag.js'
import Select from 'simple-mind-map/src/plugins/Select.js'
import TouchEvent from 'simple-mind-map/src/plugins/TouchEvent.js'
import Cooperate from 'simple-mind-map/src/plugins/Cooperate.js'
import exampleData from 'simple-mind-map/example/exampleData'
import { createCollaborationAdapter } from 'simple-mind-map/bin/collabV2/adapter'
import { getLocalConfig } from '@/api'
import { getCurrentUser } from '@/utils/auth'
import { roomFromLocation } from '@/utils/roomLocation'
import { getRuntimeConfig } from '@/utils/runtimeConfig'
import {
  listFiles,
  getFileSubtree,
  getFileExport,
  getFileNodes,
  locateFileNode,
  getMapOperations,
  getMapVersion,
  addFileNode,
  patchFileNode,
  deleteFileNode,
  replaceFileTree,
  undoMapOperation,
  redoMapOperation,
  artifactLocalUrl
} from '@/utils/fileApi'
import {
  listRoomDRegistrySops,
  dedupeSopsForRegistry,
  fillDefaultCpda
} from '@/utils/sopRegistryPrompt'
import {
  normalizeLedger,
  mergeLedgerSources,
  latestDeliverableText,
  addRunToLedger,
  persistSopLedger,
  readLedgerFromNodeLike,
  formatMinuteStamp
} from '@/utils/sopLedger'
import { SOP_OUTPUT_PRESETS, extractMissingDataNeeds, loadSopRunContext } from '@/utils/sopRun'
import {
  getSharedSopRunQueue,
  resolveSopRunConcurrency
} from '@/utils/sopRunQueue'
import { areWaitingWecomTodosDone } from '@/utils/sopNotify'
import {
  extractSubmitMaterialFields,
  formatSubmitMaterialNote,
  missingSubmitMaterialLabels,
  parseProvidedFieldLabels
} from '@/utils/sopSubmitMaterial'
import {
  fetchAiModels,
  fetchWorkbuddyModels,
  getWorkbuddyConfig,
  getOpenclawConfig,
  saveOpenclawConfig,
  WORKBUDDY_CUSTOM_MODEL_HINTS,
  fetchXiaoceOrganizations,
  fetchXiaoceAgents,
  AI_BACKEND_WORKBUDDY,
  AI_BACKEND_XIAOCE,
  AI_BACKEND_OPENCLAW,
  normalizeAiBackend
} from '@/utils/agentChat'
import SopTaskBoard from './components/SopTaskBoard.vue'

MindMap.usePlugin(Drag)
  .usePlugin(Select)
  .usePlugin(TouchEvent)
  .usePlugin(Cooperate)

const V2_CLIENT_KEY = 'mind-map-collab-v2-client'

function tabClientId() {
  try {
    let id = sessionStorage.getItem(V2_CLIENT_KEY)
    if (!id || !String(id).trim()) {
      id =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      sessionStorage.setItem(V2_CLIENT_KEY, id)
    }
    return String(id).trim()
  } catch (e) {
    return `c_${Date.now()}`
  }
}

function stripHtml(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim()
}

function toMindMapTree(tree) {
  if (!tree) return null
  const data = (tree && tree.data) || {}
  const uid = data.uid || tree.uid || ''
  const rawText = stripHtml(data.text || tree.text || '')
  const note = data.note || tree.note || ''
  const children = (tree.children || [])
    .map(child => toMindMapTree(child))
    .filter(Boolean)
  return {
    data: {
      ...data,
      text: rawText || '(空)',
      expand: true,
      ...(uid ? { uid } : {}),
      ...(note ? { note: String(note) } : {}),
      ...(data.sopLedger ? { sopLedger: data.sopLedger } : {})
    },
    children
  }
}

export default {
  name: 'SopRegistryPage',
  components: { SopTaskBoard },
  data() {
    return {
      sops: [],
      statusText: '',
      pullLoading: false,
      spacesLoading: false,
      roomKey: '',
      spaceOptions: [],
      dialogVisible: false,
      dialogTitle: '',
      dialogTab: 'map',
      historyLedgerOpen: [],
      ledgerRunExpanded: false,
      activeSop: null,
      activeSopUid: '',
      activeLedger: {
        frequency: { label: '未知', cron_hint: null },
        runs: [],
        deliverables: []
      },
      ledgerSaving: false,
      runForm: { at: '', result: '完成', note: '' },
      outputPresets: SOP_OUTPUT_PRESETS,
      runDialogVisible: false,
      runTarget: null,
      runOutputIds: [],
      runExtraNote: '',
      runSubmitFields: [],
      runSubmitZones: [],
      runSubmitLoading: false,
      runSubmitSource: '',
      runModel: 'deepseek-v4-flash',
      runBackend: 'workbuddy',
      runOrganizationId: '',
      runAgentId: '',
      runOrganizations: [],
      runAgents: [],
      runScopeLoading: false,
      AI_BACKEND_WORKBUDDY: 'workbuddy',
      AI_BACKEND_XIAOCE: 'xiaoce',
      AI_BACKEND_OPENCLAW: 'openclaw',
      runModelsLoading: false,
      runCustomModels: WORKBUDDY_CUSTOM_MODEL_HINTS.slice(),
      runOpenclawModels: [
        { id: 'openclaw/default', name: 'openclaw/default' }
      ],
      runPlatformModels: [],
      sopRunQueue: null,
      sopQueueSnap: {
        pending: [],
        running: [],
        waiting: [],
        recent: [],
        queuedCount: 0,
        runningCount: 0,
        waitingCount: 0,
        total: 0,
        concurrency: 2
      },
      selectedSopJobId: '',
      dataFillDialogVisible: false,
      dataFillJobId: '',
      dataFillJobTitle: '',
      dataFillHintText: '',
      dataFillFields: [],
      dataFillExtra: '',
      dataFillSubmitting: false,
      subtreeLoading: false,
      subtreeError: '',
      pendingRoot: null,
      pendingVersion: 0,
      previewMindMap: null,
      collabV2Adapter: null,
      syncStatus: 'idle',
      artifactPreviewVisible: false,
      artifactPreviewTitle: '产物预览',
      artifactPreviewUrl: '',
      artifactPreviewDownloadUrl: ''
    }
  },
  computed: {
    syncLabel() {
      if (this.subtreeLoading) return '加载中…'
      if (this.syncStatus === 'live') return '已协同同步'
      if (this.syncStatus === 'connecting') return '正在连接协同…'
      if (this.syncStatus === 'error') return '协同异常（本地仍可改）'
      return '未连接协同'
    },
    userInfo() {
      const user = getCurrentUser() || {}
      return {
        id: String(user.id || user.userId || 'local').replace(/^wecom:/, ''),
        name: user.name || '用户',
        color: user.color || '#409EFF'
      }
    },
    sopQueueSummary() {
      const s = this.sopQueueSnap || {}
      if (!s.total && !(s.recent && s.recent.length)) return ''
      return `执行 ${s.runningCount || 0} · 等待 ${s.waitingCount || 0} · 排队 ${
        s.queuedCount || 0
      } · 并发 ${s.concurrency || 2}`
    },
    sopActiveJobCount() {
      return (
        (this.sopQueueSnap.runningCount || 0) +
        (this.sopQueueSnap.queuedCount || 0) +
        (this.sopQueueSnap.waitingCount || 0)
      )
    },
    sopTaskJobs() {
      const s = this.sopQueueSnap || {}
      const active = [
        ...(s.running || []),
        ...(s.waiting || []),
        ...(s.pending || [])
      ]
      const activeIds = new Set(active.map(j => j.id))
      const recent = (s.recent || []).filter(j => !activeIds.has(j.id))
      return [...active, ...recent].slice(0, 20)
    },
    detailMode() {
      return !!(this.activeSopUid || (this.$route.query && this.$route.query.sopUid))
    },
    headerBackLabel() {
      if (this.detailMode) return '返回SOP台账'
      return this.roomKey ? '打开导图' : '返回文件'
    },
    detailSopTaskJobs() {
      const uid = String(this.activeSopUid || '').trim()
      if (!uid) return this.sopTaskJobs
      return this.sopTaskJobs.filter(
        j =>
          String(j.sopUid || '') === uid ||
          (this.activeSop &&
            j.sopRowKey &&
            j.sopRowKey === this.activeSop.rowKey)
      )
    },
    detailActiveJobCount() {
      return this.detailSopTaskJobs.filter(j =>
        /^(running|queued|waiting_human|waiting_data)$/.test(j.state)
      ).length
    },
    detailTaskSummary() {
      const list = this.detailSopTaskJobs
      if (!list.length) return ''
      const running = list.filter(j => j.state === 'running').length
      const waiting = list.filter(j =>
        /waiting_/.test(j.state)
      ).length
      return `本 SOP · 执行 ${running} · 等待 ${waiting} · 共 ${list.length}`
    },
    ledgerRunLimit() {
      return this.ledgerRunExpanded ? 200 : 6
    },
    visibleLedgerRuns() {
      const runs = (this.activeLedger && this.activeLedger.runs) || []
      return runs.slice(0, this.ledgerRunLimit)
    },
    selectedSopJob() {
      const pool = this.detailMode ? this.detailSopTaskJobs : this.sopTaskJobs
      if (!this.selectedSopJobId) return pool[0] || null
      return (
        pool.find(j => j.id === this.selectedSopJobId) ||
        this.sopTaskJobs.find(j => j.id === this.selectedSopJobId) ||
        (this.sopRunQueue && this.sopRunQueue.getJob(this.selectedSopJobId)) ||
        null
      )
    },
    selectedDetailJob() {
      return this.selectedSopJob
    },
    selectedNotifyRows() {
      const job = this.selectedSopJob
      if (!job) return []
      const list =
        (job.notifyResults && job.notifyResults.length
          ? job.notifyResults
          : job.result && job.result.notifyResults) || []
      return list.map(r => {
        const assignee = String((r && r.assignee) || '负责人').trim() || '负责人'
        const text = String(
          (r && (r.displayTitle || r.text)) || ''
        ).trim()
        const parts = []
        if (r.cpdaOk) parts.push(`导图待办 ${r.taskUid || '已写'}`)
        else if (r.cpdaError) parts.push(`导图失败：${r.cpdaError}`)
        else parts.push('导图待办未写入')
        const backendName =
          r.dispatchBackendLabel ||
          (r.dispatchVia === 'xiaoce-wecom'
            ? '小策'
            : r.dispatchVia === 'openclaw-wecom'
              ? '助理'
              : 'WorkBuddy')
        if (r.dispatchOk) parts.push(`${backendName} 企微已派发`)
        else if (r.dispatchError)
          parts.push(`${backendName} 失败：${String(r.dispatchError).slice(0, 48)}`)
        else if (r.dispatchReply)
          parts.push(`${backendName}：${String(r.dispatchReply).slice(0, 48)}`)
        else parts.push(`${backendName} 未确认`)
        return {
          kind: r.block ? '阻塞' : '知会',
          assignee,
          text,
          meta: parts.join(' · '),
          block: !!r.block,
          failed: !r.cpdaOk && !r.dispatchOk
        }
      })
    },
    selectedJobStreamDisplay() {
      const job = this.selectedSopJob
      if (!job) return ''
      const parts = []
      const running = job.state === 'running' || job.state === 'queued'
      const status = String(job.status || '').trim()
      if (running && status) {
        const sec = job.liveElapsedSec
          ? ` · ${job.liveElapsedSec}s`
          : ''
        parts.push(`[进行中${sec}] ${status}`)
      }
      const progress = String(job.progressText || '').trim()
      if (progress) parts.push(progress)
      const modelText = String(job.streamText || '').trim()
      if (modelText) {
        parts.push(parts.length ? `\n—— 模型输出 ——\n${modelText}` : modelText)
      } else if (running && !progress) {
        const backendName =
          (job && job.backendLabel) ||
          (job && job.backend === 'xiaoce'
            ? '小策'
            : job && job.backend === 'openclaw'
              ? '助理'
              : 'WorkBuddy')
        parts.push(`等待 ${backendName} 输出…（状态与工具事件会在此滚动更新）`)
      } else if (!running && job.error) {
        parts.push(job.error)
      }
      return parts.filter(Boolean).join('\n')
    },
    shortDataFillHint() {
      const n = (this.dataFillFields || []).length
      const labels = (this.dataFillFields || [])
        .map(f => f.label)
        .filter(Boolean)
        .slice(0, 8)
      if (labels.length) {
        return `需补充 ${n} 项：${labels.join('、')}`
      }
      const raw = String(this.dataFillHintText || '').trim()
      if (!raw) return '模型缺少关键数据，请填写后继续。'
      return raw.length > 80 ? raw.slice(0, 80) + '…' : raw
    },
    runSubmitZoneHint() {
      if (this.runSubmitSource === 'recruit_fallback') {
        return '招聘类保底模板（大纲未抽出字段）'
      }
      if (this.runSubmitSource === 'outline_zone_empty') {
        return '大纲有「提交资料」区，请按实际要求填写'
      }
      const zones = this.runSubmitZones || []
      if (!zones.length) return ''
      return `来自：${zones.slice(0, 2).join(' / ')}`
    }
  },
  watch: {
    selectedSopJob: {
      immediate: true,
      handler(job) {
        if (job && job.state === 'waiting_data' && !this.dataFillDialogVisible) {
          this.prepareDataFillFields(job)
        }
      }
    },
    dialogTab(val) {
      if (val === 'map' && this.previewMindMap) {
        this.$nextTick(() => {
          try {
            const view = this.previewMindMap && this.previewMindMap.view
            if (view && typeof view.fit === 'function') view.fit()
            if (typeof window !== 'undefined') {
              window.dispatchEvent(new Event('resize'))
            }
          } catch (e) {
            /* ignore */
          }
        })
      }
    },
    '$route.query.room'(val) {
      const next = String(val || '').trim()
      if (next !== this.roomKey) {
        this.roomKey = next
        this.refreshRoomList()
      }
    },
    '$route.query.sopUid'(val) {
      const uid = String(val || '').trim()
      if (!uid) {
        if (this.activeSopUid) {
          this.teardownPreview()
          this.activeSop = null
          this.activeSopUid = ''
          this.pendingRoot = null
        }
        return
      }
      this.openDetailFromRoute()
    },
    '$route.query.tab'(val) {
      if (!this.detailMode) return
      const tab = String(val || 'map')
      if (tab === 'runs' || tab === 'dels' || tab === 'map') {
        this.dialogTab = tab
      }
    }
  },
  async created() {
    this.initLocalConfig()
    this._sopPageAlive = true
    // 台账页固定浅色产品风格，避免跟随编辑器暗色把弹窗/输入框弄成黑底浅字
    this._hadBodyDark = document.body.classList.contains('isDark')
    document.body.classList.remove('isDark')
    this.sopRunQueue = getSharedSopRunQueue({
      getConcurrency: () => resolveSopRunConcurrency()
    })
    this._sopQueueUnsub =
      this.sopRunQueue && this.sopRunQueue.subscribe
        ? this.sopRunQueue.subscribe(snap => {
            if (!this._sopPageAlive) return
            this.sopQueueSnap = snap
            this.syncLedgersFromQueue(snap)
            this.scrollRunStream()
          })
        : null
    // 重新挂载 / 整页刷新后立刻同步已有任务（含 session 恢复的排队/续跑/待补数）
    if (this.sopRunQueue && this.sopRunQueue.getSnapshot) {
      this.sopQueueSnap = this.sopRunQueue.getSnapshot()
      const snap = this.sopQueueSnap
      this.syncLedgersFromQueue(snap)
      const prefer =
        (snap.waiting || []).find(j => j.state === 'waiting_data') ||
        (snap.waiting || [])[0] ||
        (snap.running || [])[0] ||
        (snap.pending || []).find(
          j => j && /刷新后自动续跑|刷新后恢复排队/.test(String(j.status || ''))
        ) ||
        (snap.pending || [])[0]
      if (prefer && !this.selectedSopJobId) {
        this.selectedSopJobId = prefer.id
      }
    }
    this.roomKey = roomFromLocation(this.$route) || ''
    await this.loadSpaces()
    if (this.roomKey) {
      await this.refreshRoomList()
      if (this.$route.query && this.$route.query.sopUid) {
        await this.openDetailFromRoute()
      }
    } else this.statusText = '请选择空间'
  },
  beforeDestroy() {
    this._sopPageAlive = false
    this.teardownPreview()
    // 不 cancelAll：任务继续在单例队列里跑；只卸掉本页监听
    if (this._sopQueueUnsub) {
      try {
        this._sopQueueUnsub()
      } catch (e) {
        /* ignore */
      }
      this._sopQueueUnsub = null
    }
    if (this._hadBodyDark) document.body.classList.add('isDark')
    else document.body.classList.remove('isDark')
  },
  methods: {
    ...mapMutations(['setLocalConfig']),
    initLocalConfig() {
      const config = getLocalConfig()
      if (config) {
        this.setLocalConfig({
          ...this.$store.state.localConfig,
          ...config
        })
      }
    },
    goBack() {
      if (this.detailMode) {
        this.leaveDetail()
        return
      }
      if (this.roomKey) {
        this.$router.push({ path: '/', query: { room: this.roomKey } })
        return
      }
      this.$router.push({ path: '/files' })
    },
    leaveDetail() {
      this.teardownPreview()
      this.pendingRoot = null
      this.pendingVersion = 0
      this.subtreeError = ''
      this.activeSop = null
      this.activeSopUid = ''
      this.dialogTab = 'map'
      this.dialogVisible = false
      const room = String(this.roomKey || '').trim()
      this.$router
        .replace({
          path: '/sop',
          query: room ? { room } : {}
        })
        .catch(() => {})
      if (room) this.refreshRoomList()
    },
    reloadDetail() {
      if (this.activeSop) this.loadSubtreeContent(this.activeSop)
    },
    spaceOptionLabel(item) {
      const key = item.room_key || item.roomKey || ''
      const title = item.title || item.name || ''
      if (title && title !== key) return `${title}（${key}）`
      return key || title || '未命名'
    },
    async loadSpaces() {
      this.spacesLoading = true
      try {
        const data = await listFiles({ limit: 200, offset: 0 })
        const list = data.list || []
        this.spaceOptions = list
          .map(item => ({
            room_key: item.room_key || item.roomKey || '',
            title: item.title || item.name || '',
            label: this.spaceOptionLabel(item)
          }))
          .filter(item => item.room_key)
        if (
          this.roomKey &&
          !this.spaceOptions.some(s => s.room_key === this.roomKey)
        ) {
          this.spaceOptions.unshift({
            room_key: this.roomKey,
            title: this.roomKey,
            label: this.roomKey
          })
        }
      } catch (err) {
        this.spaceOptions = this.roomKey
          ? [
              {
                room_key: this.roomKey,
                title: this.roomKey,
                label: this.roomKey
              }
            ]
          : []
      } finally {
        this.spacesLoading = false
      }
    },
    onSpaceChange(val) {
      const room = String(val || '').trim()
      if (this.activeSopUid) {
        this.teardownPreview()
        this.activeSop = null
        this.activeSopUid = ''
        this.pendingRoot = null
        this.dialogTab = 'map'
      }
      this.$router.replace({
        path: '/sop',
        query: room ? { room } : {}
      })
      if (room) this.refreshRoomList()
      else {
        this.sops = []
        this.statusText = '请选择空间'
      }
    },
    formatRuns(runs) {
      return (runs || [])
        .slice(0, 3)
        .map(r => [r.at, r.result, r.note].filter(Boolean).join(' '))
        .join('；')
    },
    formatDeliverables(list) {
      return (list || [])
        .slice(0, 4)
        .map(d => d.name || d.uri_or_path)
        .filter(Boolean)
        .join('、')
    },
    sopLedgerRuns(item) {
      return (
        (item && item.sopLedger && item.sopLedger.runs) ||
        (item && item.runs) ||
        []
      )
    },
    sopLedgerDeliverables(item) {
      return (
        (item && item.sopLedger && item.sopLedger.deliverables) ||
        (item && item.deliverables) ||
        []
      )
    },
    sopRunCount(item) {
      return this.sopLedgerRuns(item).length
    },
    sopDeliverableCount(item) {
      return this.sopLedgerDeliverables(item).length
    },
    sopJobsForItem(item) {
      if (!item) return []
      const uid = String(this.resolveSopUid(item) || '').trim()
      const rowKey = String(item.rowKey || '').trim()
      return (this.sopTaskJobs || []).filter(j => {
        if (!j) return false
        if (uid && String(j.sopUid || '') === uid) return true
        if (rowKey && j.sopRowKey && j.sopRowKey === rowKey) return true
        return false
      })
    },
    sopSuccessRateLabel(item) {
      const jobs = this.sopJobsForItem(item)
      const done = jobs.filter(j => j.state === 'done').length
      const failed = jobs.filter(j => j.state === 'error').length
      const denom = done + failed
      if (!denom) return '成功占比 —'
      const pct = Math.round((done / denom) * 100)
      return `成功占比 ${pct}%`
    },
    sopCardMetaChips(item) {
      return [
        `运行 ${this.sopRunCount(item)} 次`,
        `产物 ${this.sopDeliverableCount(item)} 个`,
        this.sopSuccessRateLabel(item)
      ].slice(0, 3)
    },
    latestRunLabel(item) {
      const runs = this.sopLedgerRuns(item)
      if (!runs.length) return '暂无'
      return String((runs[0] && runs[0].at) || '').trim() || '暂无'
    },
    latestDelLabel(item) {
      return latestDeliverableText(this.sopLedgerDeliverables(item))
    },
    shortLedgerRunLabel(r) {
      const raw = [r && r.at, r && r.result, r && r.note]
        .filter(Boolean)
        .join(' · ')
      if (raw.length <= 96) return raw
      return raw.slice(0, 96) + '…'
    },
    toggleLedgerRunLimit() {
      this.ledgerRunExpanded = !this.ledgerRunExpanded
    },
    isHttp(uri) {
      return /^https?:\/\//i.test(String(uri || ''))
    },
    isLocalAbsPath(uri) {
      return /^[A-Za-z]:[\\/]/.test(String(uri || ''))
    },
    deliverableOpenUrl(d, { download = false } = {}) {
      const uri = String((d && d.uri_or_path) || '')
      const name = String((d && d.name) || '')
      if (this.isHttp(uri)) return uri
      if (this.isLocalAbsPath(uri) || /\.(html?|xlsx?|pdf|md|csv)$/i.test(name || uri)) {
        return artifactLocalUrl(this.isLocalAbsPath(uri) ? uri : name || uri, {
          download,
          name: name || uri
        })
      }
      return ''
    },
    canDownloadDeliverable(d) {
      const uri = String((d && d.uri_or_path) || '')
      const name = String((d && d.name) || '')
      return (
        this.isHttp(uri) ||
        this.isLocalAbsPath(uri) ||
        /\.(html?|xlsx?|pdf|md|csv)$/i.test(name || uri)
      )
    },
    canPreviewDeliverable(d) {
      const uri = String((d && d.uri_or_path) || '')
      const name = String((d && d.name) || '')
      if (this.isHttp(uri)) {
        return (
          /\.(html?|pdf|md|txt)(\?|#|$)/i.test(uri) ||
          /执行单|报告/i.test(name)
        )
      }
      if (this.isLocalAbsPath(uri)) {
        return /\.(html?|pdf|md|txt)$/i.test(uri)
      }
      return /\.(html?|pdf|md|txt)$/i.test(name)
    },
    openUrl(url) {
      if (!url) return
      window.open(url, '_blank', 'noopener')
    },
    previewDeliverable(d) {
      const url = this.deliverableOpenUrl(d, { download: false })
      if (!url) {
        this.$message.warning('无法预览该产物')
        return
      }
      this.artifactPreviewTitle = (d && d.name) || '产物预览'
      this.artifactPreviewUrl = url
      this.artifactPreviewDownloadUrl = this.deliverableOpenUrl(d, {
        download: true
      })
      this.artifactPreviewVisible = true
    },
    downloadDeliverable(d) {
      const url = this.deliverableOpenUrl(d, { download: true })
      if (!url) {
        this.$message.warning('无法下载该产物')
        return
      }
      this.openUrl(url)
    },
    onArtifactPreviewClosed() {
      this.artifactPreviewUrl = ''
      this.artifactPreviewDownloadUrl = ''
    },
    resetLedgerForms() {
      const at = formatMinuteStamp()
      this.runForm = { at, result: '完成', note: '' }
    },
    async saveActiveLedger() {
      if (!this.roomKey || !this.activeSopUid) {
        throw new Error('缺少房间或节点')
      }
      this.ledgerSaving = true
      try {
        await persistSopLedger(
          this.roomKey,
          this.activeSopUid,
          {
            id: (this.activeSop && this.activeSop.id) || '',
            title: (this.activeSop && this.activeSop.title) || ''
          },
          this.activeLedger
        )
        // 同步回列表卡片
        const idx = this.sops.findIndex(
          s => this.resolveSopUid(s) === this.activeSopUid || s === this.activeSop
        )
        if (idx >= 0) {
          const next = {
            ...this.sops[idx],
            runs: this.activeLedger.runs,
            deliverables: this.activeLedger.deliverables,
            frequency: this.activeLedger.frequency,
            sopLedger: normalizeLedger(this.activeLedger)
          }
          this.$set(this.sops, idx, next)
          this.activeSop = next
        }
        this.$message.success('已写入节点台账')
      } finally {
        this.ledgerSaving = false
      }
    },
    async submitRun() {
      try {
        this.activeLedger = addRunToLedger(this.activeLedger, {
          ...this.runForm,
          actor: this.userInfo.name
        })
        await this.saveActiveLedger()
        this.resetLedgerForms()
      } catch (err) {
        this.$message.error((err && err.message) || '保存失败')
      }
    },
    openRunDialog(item) {
      if (!this.roomKey) {
        this.$message.warning('请先选择空间')
        return
      }
      if (this.sopCardJobState(item)) {
        this.$message.info('该 SOP 已在运行或排队中')
        const job = this.sopRunQueue.findActiveBySop(
          this.roomKey,
          this.resolveSopUid(item)
        )
        if (job) this.selectSopJob(job.id)
        return
      }
      this.runTarget = item
      this.runOutputIds = []
      this.runExtraNote = ''
      this.runSubmitFields = []
      this.runSubmitZones = []
      this.runSubmitSource = ''
      const localConfig = getLocalConfig() || {}
      this.runBackend = normalizeAiBackend(localConfig.aiBackend)
      this.runOrganizationId = String(localConfig.xiaoceOrganizationId || '')
      this.runAgentId = String(localConfig.xiaoceAgentId || '')
      if (this.runBackend === AI_BACKEND_OPENCLAW) {
        this.runModel =
          getOpenclawConfig().model || 'openclaw/default'
      } else {
        this.runModel = getWorkbuddyConfig().model || 'deepseek-v4-flash'
      }
      this.runDialogVisible = true
      if (this.runBackend === AI_BACKEND_XIAOCE) this.loadRunXiaoceScope()
      else this.loadRunModels()
      this.loadRunSubmitTemplate(item)
    },
    onRunBackendChange(value) {
      this.setLocalConfig({ aiBackend: value })
      if (value === AI_BACKEND_XIAOCE) {
        this.loadRunXiaoceScope(true)
      } else if (value === AI_BACKEND_OPENCLAW) {
        this.runModel =
          getOpenclawConfig().model || 'openclaw/default'
        this.loadRunModels(true)
      } else {
        this.runModel = getWorkbuddyConfig().model || 'deepseek-v4-flash'
        this.loadRunModels()
      }
    },
    async onRunOrganizationChange(value) {
      this.runOrganizationId = String(value || '')
      this.runAgentId = ''
      await this.loadRunXiaoceAgents(true)
    },
    async loadRunXiaoceAgents(selectFallback = false) {
      this.runAgents = this.runOrganizationId
        ? await fetchXiaoceAgents(this.runOrganizationId)
        : []
      if (!this.runAgents.some(item => String(item.id) === this.runAgentId)) {
        this.runAgentId = selectFallback && this.runAgents[0]
          ? String(this.runAgents[0].id)
          : ''
      }
    },
    async loadRunXiaoceScope(showError = false) {
      if (this.runScopeLoading) return
      this.runScopeLoading = true
      try {
        this.runOrganizations = await fetchXiaoceOrganizations()
        if (!this.runOrganizations.some(item => String(item.id) === this.runOrganizationId)) {
          const preferred = this.runOrganizations.find(item => item.isCurrent) || this.runOrganizations[0]
          this.runOrganizationId = preferred ? String(preferred.id) : ''
        }
        await this.loadRunXiaoceAgents(true)
      } catch (err) {
        if (showError) this.$message.error(`小策配置加载失败：${err.message || '未知错误'}`)
      } finally {
        this.runScopeLoading = false
      }
    },
    async loadRunSubmitTemplate(item) {
      if (!item || !this.roomKey) return
      this.runSubmitLoading = true
      try {
        const sop = {
          ...item,
          uid: this.resolveSopUid(item)
        }
        const ctx = await loadSopRunContext(this.roomKey, sop)
        const parsed = extractSubmitMaterialFields(ctx.outline || '', {
          sopTitle: item.title || item.id || ''
        })
        this.runSubmitFields = (parsed.fields || []).map(f => ({
          key: f.key,
          label: f.label,
          hint: f.hint || `请填写${f.label}`,
          value: f.value || ''
        }))
        this.runSubmitZones = parsed.zones || []
        this.runSubmitSource = parsed.source || ''
      } catch (err) {
        console.warn('[sopRegistry] load submit template failed', err)
        this.runSubmitFields = []
        this.runSubmitZones = []
        this.runSubmitSource = ''
      } finally {
        this.runSubmitLoading = false
      }
    },
    onRunModelDropdown(visible) {
      if (visible && !this.runPlatformModels.length) {
        this.loadRunModels()
      }
    },
    async loadRunModels(force = false) {
      if (this.runModelsLoading) return
      this.runModelsLoading = true
      try {
        if (this.runBackend === AI_BACKEND_OPENCLAW) {
          const models = await fetchAiModels(AI_BACKEND_OPENCLAW)
          this.runOpenclawModels =
            models && models.length
              ? models
              : [{ id: 'openclaw/default', name: 'openclaw/default' }]
          const ids = new Set(this.runOpenclawModels.map(m => m.id))
          if (!ids.has(this.runModel)) {
            this.runModel =
              (this.runOpenclawModels[0] && this.runOpenclawModels[0].id) ||
              'openclaw/default'
          }
          return
        }
        const models = await fetchWorkbuddyModels()
        this.runCustomModels = models.filter(m => m.custom)
        this.runPlatformModels = models.filter(m => !m.custom)
        if (!this.runCustomModels.length) {
          this.runCustomModels = WORKBUDDY_CUSTOM_MODEL_HINTS.slice()
        }
        const ids = new Set(
          [...this.runCustomModels, ...this.runPlatformModels].map(m => m.id)
        )
        if (!ids.has(this.runModel)) {
          this.runModel =
            (this.runCustomModels[0] && this.runCustomModels[0].id) ||
            'deepseek-v4-flash'
        }
      } catch (err) {
        if (force && this.$message) {
          this.$message.warning(
            '模型列表加载失败：' + ((err && err.message) || '未知错误')
          )
        }
        if (this.runBackend === AI_BACKEND_OPENCLAW) {
          this.runOpenclawModels = [
            { id: 'openclaw/default', name: 'openclaw/default' }
          ]
        }
      } finally {
        this.runModelsLoading = false
      }
    },
    sopCardJobState(item) {
      if (!this.sopRunQueue || !item) return ''
      const job = this.sopRunQueue.findActiveBySop(
        this.roomKey,
        this.resolveSopUid(item)
      )
      return (job && job.state) || ''
    },
    sopCardJobLabel(item) {
      const state = this.sopCardJobState(item)
      if (state === 'running') return '运行中'
      if (state === 'queued') return '排队中'
      if (state === 'waiting_human') return '等待人工'
      if (state === 'waiting_data') return '待补数'
      return ''
    },
    sopJobStateLabel(job) {
      const map = {
        running: '运行中',
        queued: '排队',
        waiting_human: '等待人工',
        waiting_data: '待补数',
        done: '完成',
        error: '失败',
        cancelled: '已取消'
      }
      return map[job && job.state] || (job && job.state) || ''
    },
    shortJobStatus(job) {
      if (!job) return ''
      if (job.state === 'waiting_data') {
        const n = (job.missingFields && job.missingFields.length) ||
          (this.selectedSopJobId === job.id && this.dataFillFields.length) ||
          0
        return n ? `待补数 · ${n} 项` : '待补数 · 点击填写后继续'
      }
      if (job.state === 'waiting_human') {
        const n =
          (job.waitingWecomTodos && job.waitingWecomTodos.length) ||
          (job.waitingTaskUids && job.waitingTaskUids.length) ||
          0
        return n ? `等待企微待办 ${n} 条` : '等待企微待办确认'
      }
      const s = String(job.status || '').replace(/\s+/g, ' ').trim()
      if (s.length > 48) return s.slice(0, 48) + '…'
      return s
    },
    selectSopJob(jobId) {
      this.selectedSopJobId = jobId
      this.scrollRunStream()
      this.$nextTick(() => this.scrollDataFillIntoView())
    },
    prepareDataFillFields(job) {
      if (!job) return
      const provided = parseProvidedFieldLabels(job.extraNote || '')
      const isJunkField = f => {
        const label = String((f && f.label) || '').trim()
        if (!label || label.length > 24) return true
        if (/[。；;！!？?\n“”"']/.test(label)) return true
        if (
          /节点|uid|未完成|已完成|已消除|历史|运行|推进|阻塞|阻断|容器|待办|产物|大纲|台账|校验|房间|本次|本单|流程型|登记|拟稿|数据源|示例|仍缺|缺少|字段|初稿|产出|发起|知会|账号|简历池|即时|并发|可即时|AI侧|Boss|直聘/.test(
            label
          )
        ) {
          return true
        }
        if (/^(?:但|且|并|可|已|无|有|项)/.test(label)) return true
        if (
          /(?:产出|发起|消除|生成|发布|登录|缺少|没有|无法)/.test(label) &&
          label.length > 8
        ) {
          return true
        }
        return false
      }
      let fields =
        (job.missingFields && job.missingFields.length
          ? job.missingFields
          : job.result && job.result.missingFields) || []
      fields = (fields || []).filter(f => !isJunkField(f))
      const reply =
        job.streamText || (job.result && job.result.reply) || job.status || ''
      const parsed = extractMissingDataNeeds(reply, {
        alreadyProvided: provided
      })
      // 优先用模型明确仍缺项；仅当库内字段空/过少时才用解析结果
      if (!fields.length && parsed.fields && parsed.fields.length) {
        fields = parsed.fields
      } else if (fields.length && provided.length) {
        fields = fields.filter(
          f =>
            !provided.some(p => {
              const a = String(f.label || '')
                .replace(/\s+/g, '')
                .toLowerCase()
              const b = String(p || '')
                .replace(/\s+/g, '')
                .toLowerCase()
              return a === b || a.includes(b) || b.includes(a)
            })
        )
      }
      this.dataFillFields = fields
        .filter(f => !isJunkField(f))
        .map((f, i) => {
          let label = String(f.label || '')
            .replace(/（.*?）|\(.*?\)/g, '')
            .replace(/[（(][^）)]*$/, '')
            .trim()
          if (!label || label.length > 24) return null
          if (!/^[A-Za-z0-9\u4e00-\u9fff/／_-]{2,16}$/.test(label)) return null
          return {
            key: f.key || `f_${i + 1}`,
            label,
            value: ''
          }
        })
        .filter(Boolean)
      this.dataFillHintText =
        (parsed.summary && parsed.fields && parsed.fields.length
          ? parsed.summary
          : '') ||
        (this.dataFillFields.length &&
        job.missingSummary &&
        !/节点\*\*|未完成\*\*|uid|已消除|AI侧|简历池/.test(job.missingSummary)
          ? job.missingSummary
          : '') ||
        (this.dataFillFields.length
          ? '模型缺少关键数据，请按字段填写后继续执行。'
          : '未识别到可填写的字段（多为状态说明，不是待补数据）。')
    },
    openDataFillDialog(jobId) {
      const job =
        (this.sopRunQueue && this.sopRunQueue.getJob(jobId)) ||
        this.sopTaskJobs.find(j => j.id === jobId)
      if (!job || job.state !== 'waiting_data') {
        this.$message.warning('该任务不在待补数状态')
        return
      }
      this.selectedSopJobId = jobId
      this.dataFillJobId = jobId
      this.dataFillJobTitle = `${job.sopId || 'SOP'}：${job.sopTitle || ''}`
      this.dataFillExtra = ''
      this.prepareDataFillFields(job)
      this.dataFillDialogVisible = true
    },
    scrollDataFillIntoView() {
      const el = this.$refs.dataFillBox
      if (el && el.scrollIntoView) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      }
    },
    cancelSopJob(jobId) {
      if (!this.sopRunQueue) return
      this.sopRunQueue.cancel(jobId)
    },
    async submitMissingDataAndResume() {
      if (!this.sopRunQueue) return
      const jobId = this.dataFillJobId || (this.selectedSopJob && this.selectedSopJob.id)
      const job = this.sopRunQueue.getJob(jobId) || this.selectedSopJob
      if (!job || job.state !== 'waiting_data') {
        this.$message.warning('该任务不在待补数状态')
        return
      }
      const lines = (this.dataFillFields || [])
        .map(f => {
          const v = String(f.value || '').trim()
          if (!v) return ''
          return `${f.label}：${v}`
        })
        .filter(Boolean)
      const extra = String(this.dataFillExtra || '').trim()
      if (!lines.length && !extra) {
        this.$message.warning('请至少填写一项缺失数据')
        return
      }
      const append = [
        '## 用户补充数据',
        ...lines,
        extra ? `其它说明：${extra}` : ''
      ]
        .filter(Boolean)
        .join('\n')
      this.dataFillSubmitting = true
      try {
        const res = this.sopRunQueue.resumeWaiting(job.id, {
          extraNoteAppend: append
        })
        if (!res.ok) {
          this.$message.warning(res.message || '无法继续')
          return
        }
        this.dataFillExtra = ''
        this.dataFillDialogVisible = false
        this.$message.success('已提交补充数据，继续执行')
      } finally {
        this.dataFillSubmitting = false
      }
    },
    async resumeSopJob(jobId) {
      if (!this.sopRunQueue) return
      const job = this.sopRunQueue.getJob(jobId)
      if (!job || job.state !== 'waiting_human') {
        this.$message.warning('该任务不在等待人工状态')
        return
      }
      try {
        const todos =
          (job.waitingWecomTodos && job.waitingWecomTodos.length
            ? job.waitingWecomTodos
            : null) ||
          (job.notifyResults || [])
            .filter(r => r && r.block && r.dispatchOk && !r.skipped)
            .map(r => ({
              todoId: r.todoId || '',
              title: r.wxTitle || r.text || r.title || '',
              assignee: r.assignee || '',
              via: r.dispatchVia || ''
            }))
        if (!todos.length) {
          try {
            await this.$confirm(
              '未记录企微待办信息。若你已在企业微信里完成，可继续执行 SOP。',
              '确认继续',
              { type: 'warning' }
            )
          } catch (e) {
            return
          }
        } else {
          const check = await areWaitingWecomTodosDone(todos, {
            backend: (job && job.backend) || undefined
          })
          if (!check.done) {
            const left = (check.pending || []).length
            const unk = (check.unknown || []).length
            if (left) {
              this.$message.warning(
                `还有 ${left} 条企微待办未完成，请先在企业微信点「已完成」`
              )
              return
            }
            if (unk) {
              try {
                await this.$confirm(
                  '暂时查不到企微待办状态。若你已在企业微信完成，可强制继续。',
                  '确认继续',
                  { type: 'warning' }
                )
              } catch (e) {
                return
              }
            }
          }
        }
        const res = this.sopRunQueue.resumeWaiting(jobId)
        if (!res.ok) {
          this.$message.warning(res.message || '无法继续')
          return
        }
        this.$message.success('已继续执行 SOP')
      } catch (err) {
        this.$message.error((err && err.message) || '检查企微待办失败')
      }
    },
    cancelAllSopJobs() {
      if (!this.sopRunQueue) return
      this.sopRunQueue.cancelAll()
      this.$message.info('已取消全部 SOP 任务')
    },
    applyJobLedgerToList(job, ledger) {
      if (!job || !ledger) return
      // 严格按节点 uid 归属，避免多任务回写串到别的 SOP 卡片
      const idx = this.sops.findIndex(s => {
        if (job.sopUid) {
          if (this.resolveSopUid(s) === job.sopUid) return true
          if (s.uids && s.uids.includes(job.sopUid)) return true
          return false
        }
        return !!(job.sopRowKey && s.rowKey === job.sopRowKey)
      })
      if (idx < 0) return
      const scoped = this.scopeLedgerToSop(ledger, {
        id: job.sopId,
        uid: job.sopUid,
        title: job.sopTitle
      })
      const next = {
        ...this.sops[idx],
        runs: scoped.runs,
        deliverables: scoped.deliverables,
        frequency: scoped.frequency,
        sopLedger: scoped
      }
      this.$set(this.sops, idx, next)
    },
    scopeLedgerToSop(ledger, sopMeta) {
      const L = normalizeLedger(ledger)
      const wantId = String((sopMeta && sopMeta.id) || '')
        .trim()
        .toUpperCase()
      if (!wantId) return L
      const titleKey = String((sopMeta && sopMeta.title) || '')
        .replace(/\s+/g, '')
        .slice(0, 12)
      const keep = d => {
        const blob = `${d.name || ''}\n${d.uri_or_path || ''}`
        const fileId = (blob.match(/(?:^|[^A-Za-z0-9])(D\d+)(?=[^A-Za-z0-9]|$)/i) ||
          [])[1]
        if (fileId && fileId.toUpperCase() !== wantId) return false
        if (d.sop_id && String(d.sop_id).toUpperCase() !== wantId) return false
        if (d.sop_uid && sopMeta.uid && d.sop_uid !== sopMeta.uid) return false
        // 有其它 D 编号痕迹且标题也对不上时丢掉
        if (
          fileId &&
          titleKey &&
          titleKey.length >= 2 &&
          !blob.includes(titleKey) &&
          fileId.toUpperCase() !== wantId
        ) {
          return false
        }
        return true
      }
      return normalizeLedger({
        ...L,
        deliverables: (L.deliverables || []).filter(keep)
      })
    },
    syncLedgersFromQueue(snap) {
      const jobs = [
        ...((snap && snap.running) || []),
        ...((snap && snap.waiting) || []),
        ...((snap && snap.recent) || [])
      ]
      // 只回写已结束/等待且带 ledger 的任务；按 uid 精确落到对应卡片
      jobs.forEach(job => {
        if (
          job &&
          job.result &&
          job.result.ledger &&
          (job.state === 'done' ||
            job.state === 'error' ||
            job.state === 'cancelled' ||
            job.state === 'waiting_human' ||
            job.state === 'waiting_data')
        ) {
          this.applyJobLedgerToList(job, job.result.ledger)
        }
      })
    },
    /** 刷新列表时保留内存台账 + 队列已回写结果，避免「最近运行/产物」被刷空 */
    mergeSopsPreservingRuns(fetched) {
      const prevByUid = new Map()
      const prevByRow = new Map()
      ;(this.sops || []).forEach(s => {
        const uid = this.resolveSopUid(s)
        if (uid) prevByUid.set(uid, s)
        if (s.rowKey) prevByRow.set(s.rowKey, s)
        ;(s.uids || []).forEach(u => {
          if (u && !prevByUid.has(u)) prevByUid.set(u, s)
        })
      })
      const queueLedgers =
        (this.sopRunQueue &&
          this.sopRunQueue.collectLedgers &&
          this.sopRunQueue.collectLedgers(this.roomKey)) ||
        new Map()

      return (fetched || []).map(item => {
        const uid = this.resolveSopUid(item)
        const prev =
          (uid && prevByUid.get(uid)) ||
          (item.rowKey && prevByRow.get(item.rowKey)) ||
          null
        let ledger = mergeLedgerSources(
          item.sopLedger || item,
          prev ? prev.sopLedger || prev : null
        )
        if (uid && queueLedgers.has(uid)) {
          ledger = mergeLedgerSources(ledger, queueLedgers.get(uid))
        }
        if (item.uids) {
          item.uids.forEach(u => {
            if (queueLedgers.has(u)) {
              ledger = mergeLedgerSources(ledger, queueLedgers.get(u))
            }
          })
        }
        return {
          ...item,
          runs: ledger.runs,
          deliverables: ledger.deliverables,
          frequency: ledger.frequency || item.frequency,
          sopLedger: ledger
        }
      })
    },
    openJobDeliverables(job) {
      const item = this.sops.find(
        s =>
          s.rowKey === job.sopRowKey ||
          this.resolveSopUid(s) === job.sopUid
      )
      if (!item) {
        this.$message.warning('列表中找不到该 SOP')
        return
      }
      this.openSubtree(item, { tab: 'dels' })
    },
    scrollRunStream() {
      this.$nextTick(() => {
        const el = this.$refs.runStreamPre
        if (el) el.scrollTop = el.scrollHeight
      })
    },
    confirmRunSop() {
      if (!this.runTarget || !this.roomKey || !this.sopRunQueue) return
      if (this.runSubmitLoading) {
        this.$message.info('资料模板加载中，请稍候')
        return
      }
      if (this.runBackend === AI_BACKEND_XIAOCE && (!this.runOrganizationId || !this.runAgentId)) {
        this.$message.warning('请先选择企业和智能体')
        return
      }
      this.setLocalConfig({
        aiBackend: this.runBackend,
        xiaoceOrganizationId: this.runOrganizationId,
        xiaoceAgentId: this.runAgentId
      })
      if (this.runSubmitFields.length) {
        const missing = missingSubmitMaterialLabels(this.runSubmitFields)
        if (missing.length) {
          this.$message.warning(`请先填写：${missing.slice(0, 5).join('、')}`)
          return
        }
      }
      if (this.runModel) {
        if (this.runBackend === AI_BACKEND_OPENCLAW) {
          this.setLocalConfig({ openclawModel: this.runModel })
          saveOpenclawConfig({ model: this.runModel })
        } else {
          this.setLocalConfig({ workbuddyModel: this.runModel })
        }
      }
      const sop = {
        ...this.runTarget,
        uid: this.resolveSopUid(this.runTarget)
      }
      const materialNote = formatSubmitMaterialNote(
        this.runSubmitFields,
        this.runExtraNote
      )
      const enqueued = this.sopRunQueue.enqueue({
        roomKey: this.roomKey,
        sop,
        outputIds: this.runOutputIds.slice(),
        extraNote: materialNote || this.runExtraNote,
        model: this.runModel,
        backend: this.runBackend,
        actor: this.userInfo.name || '台账',
        onSuccess: (result, job) => {
          if (!this._sopPageAlive) return
          if (result && result.ledger) {
            this.applyJobLedgerToList(job, result.ledger)
          }
          if (result && result.ok) {
            this.$message.success(
              `「${job.sopTitle}」完成（约 ${result.elapsedSec}s，产物 ${
                (result.deliverables && result.deliverables.length) || 0
              } 个）`
            )
          } else {
            const reason =
              (result &&
                result.assessment &&
                result.assessment.reason) ||
              (result && result.runResult) ||
              '未确认真执行'
            this.$message.warning(`「${job.sopTitle}」：${reason}`)
          }
        },
        onError: (err, msg) => {
          if (!this._sopPageAlive) return
          if (err && err.ledger) {
            this.applyJobLedgerToList(
              {
                sopRowKey: sop.rowKey,
                sopUid: sop.uid
              },
              err.ledger
            )
          }
          if (!(err && err.name === 'AbortError')) {
            this.$message.error(`「${sop.title}」：${msg}`)
          }
        },
        onWaiting: (result, job) => {
          if (!this._sopPageAlive) return
          if (result && result.ledger) {
            this.applyJobLedgerToList(job, result.ledger)
          }
          this.selectedSopJobId = job.id
          if (this.detailMode) this.dialogTab = 'runs'
          const assignees = ((result && result.notifyResults) || [])
            .map(r => String((r && r.assignee) || '').trim())
            .filter(Boolean)
          const uniq = [...new Set(assignees)]
          const who = uniq.length ? `代办发给：${uniq.join('、')}` : ''
          if (result && result.waitingData) {
            this.$message.info(
              `「${job.sopTitle}」缺少数据，请点击「去补数」填写后继续${
                who ? `（${who}）` : ''
              }`
            )
            this.openDataFillDialog(job.id)
            return
          }
          const n =
            (job.waitingWecomTodos && job.waitingWecomTodos.length) ||
            (job.waitingTaskUids && job.waitingTaskUids.length) ||
            0
          this.$message.warning(
            `「${job.sopTitle}」已派发阻塞通知${
              who ? `，${who}` : ''
            }，请在企业微信完成待办后点「检查并继续」${n ? `（${n} 条）` : ''}`
          )
        }
      })
      if (!enqueued.ok) {
        this.$message.warning(enqueued.message || '入队失败')
        return
      }
      this.selectedSopJobId = enqueued.job.id
      this.runDialogVisible = false
      if (this.detailMode) {
        this.dialogTab = 'runs'
        this.$router
          .replace({
            path: '/sop',
            query: {
              ...this.$route.query,
              room: this.roomKey,
              sopUid: this.activeSopUid,
              tab: 'runs'
            }
          })
          .catch(() => {})
      } else if (this.runTarget) {
        // 从台账列表运行：直接进入该 SOP 详情的「历史任务」
        this.openSubtree(this.runTarget, { tab: 'runs' })
      }
      this.$message.success(
        `已加入队列：${sop.title}（并发上限 ${
          this.sopQueueSnap.concurrency || 2
        }）`
      )
    },
    resolveSopUid(item) {
      if (!item) return ''
      if (item.uid) return item.uid
      if (item.uids && item.uids.length) return item.uids[0]
      const fromSource =
        item.sources && item.sources.map(s => s.uid).find(Boolean)
      return fromSource || ''
    },
    useCollabV2() {
      return getRuntimeConfig().collabV2 !== false
    },
    teardownPreview() {
      const cooperate = this.previewMindMap && this.previewMindMap.cooperate
      if (this.collabV2Adapter) {
        try {
          if (cooperate && typeof cooperate.setCollabV2Adapter === 'function') {
            cooperate.setCollabV2Adapter(null)
          }
          if (this.collabV2Adapter.disconnect) this.collabV2Adapter.disconnect()
        } catch (e) {
          /* ignore */
        }
        this.collabV2Adapter = null
      }
      if (this.previewMindMap) {
        try {
          this.previewMindMap.destroy()
        } catch (e) {
          /* ignore */
        }
        this.previewMindMap = null
      }
      this.syncStatus = 'idle'
    },
    enableHttpCollab(version) {
      const mindMap = this.previewMindMap
      const cooperate = mindMap && mindMap.cooperate
      const roomKey = this.roomKey
      if (!cooperate || !roomKey) return
      cooperate.setHttpCollab({
        roomKey,
        version: Number(version) || 0,
        fetchSubtree: (uid, options) => getFileSubtree(roomKey, uid, options),
        fetchDeepSubtree: (uid, options) =>
          getFileSubtree(roomKey, uid, {
            deep: true,
            maxNodes: 800,
            ...(options || {})
          }),
        fetchExportTree: () => getFileExport(roomKey),
        fetchNodes: uids => getFileNodes(roomKey, uids),
        fetchLocate: uid => locateFileNode(roomKey, uid),
        fetchOperations: after => getMapOperations(roomKey, after),
        fetchVersion: () => getMapVersion(roomKey),
        undoOperation: operationId => undoMapOperation(roomKey, operationId),
        redoOperation: operationId => redoMapOperation(roomKey, operationId),
        patchNode: (uid, body) =>
          patchFileNode(roomKey, uid, {
            ...(body || {}),
            confirm_sop_change: true
          }),
        addNode: body =>
          addFileNode(roomKey, {
            ...(body || {}),
            confirm_sop_change: true
          }),
        deleteNode: (uid, options) =>
          deleteFileNode(roomKey, uid, {
            ...(options || {}),
            confirm_sop_change: true
          }),
        replaceTree: (tree, extra) =>
          replaceFileTree(roomKey, tree, {
            allowFullTree: true,
            source: 'sop-registry',
            confirm_sop_change: true,
            ...(extra || {})
          })
      })
    },
    ensureCollabV2() {
      if (this.collabV2Adapter) return this.collabV2Adapter
      const cooperate = this.previewMindMap && this.previewMindMap.cooperate
      const clientId = tabClientId()
      const user = this.userInfo
      const adapter = createCollaborationAdapter({
        clientId,
        name: user.name,
        color: user.color,
        createSocket: () => {
          const cfg = getRuntimeConfig()
          const raw = String(cfg.collabApi || '')
            .replace(/^ws/i, 'http')
            .replace(/\/$/, '')
            .replace(/\/collab$/i, '')
          return io(raw || window.location.origin, {
            path: '/collab-v2',
            auth: {
              clientId,
              userId: user.id
            },
            withCredentials: true,
            transports: ['websocket', 'polling'],
            reconnection: true,
            reconnectionAttempts: 8,
            reconnectionDelay: 800,
            reconnectionDelayMax: 15000
          })
        },
        httpSync: async ({ afterRevision }) => {
          const api = getRuntimeConfig().collabApi || ''
          const roomKey = encodeURIComponent(this.roomKey || '')
          const res = await fetch(
            `${api}/api/collab-v2/ops?roomKey=${roomKey}&afterRevision=${Number(
              afterRevision
            ) || 0}`,
            { credentials: 'include', headers: { Accept: 'application/json' } }
          )
          return res.json().catch(() => ({ ok: false }))
        },
        onRemoteOperation: op => {
          if (
            cooperate &&
            typeof cooperate.applyV2RemoteOperation === 'function'
          ) {
            return cooperate.applyV2RemoteOperation(op)
          }
        },
        onReloadRequired: () => {
          if (
            cooperate &&
            typeof cooperate.recoverHttpCollab === 'function'
          ) {
            return cooperate.recoverHttpCollab(
              this.collabV2Adapter &&
                this.collabV2Adapter.getStatus().lastServerRevision
            )
          }
        },
        onRejected: () => {
          this.syncStatus = 'error'
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
      return adapter
    },
    async connectCollabV2(version) {
      if (!this.useCollabV2()) {
        this.syncStatus = 'live'
        return
      }
      this.syncStatus = 'connecting'
      try {
        const adapter = this.ensureCollabV2()
        const ver = Number(version) || 0
        adapter.setLastServerRevision(ver)
        await adapter.connect({
          roomKey: this.roomKey,
          userId: this.userInfo.id,
          clientId: adapter.getClientId && adapter.getClientId(),
          lastServerRevision: ver
        })
        this.syncStatus = 'live'
      } catch (err) {
        console.warn('[sopRegistry] collab v2 connect failed', err)
        this.syncStatus = 'error'
      }
    },
    mountPreviewMindMap(root, version) {
      this.teardownPreview()
      const el = this.$refs.mindMapContainer
      if (!el || !root) return
      el.innerHTML = ''
      const theme = (exampleData && exampleData.theme) || {}
      this.previewMindMap = new MindMap({
        el,
        data: root,
        fit: true,
        readonly: false,
        layout: (exampleData && exampleData.layout) || 'logicalStructure',
        theme: theme.template || 'default',
        themeConfig: theme.config || {},
        mousewheelAction: 'zoom',
        enableFreeDrag: false,
        initRootNodePosition: ['center', 'center'],
        onlyOneEnableActiveNodeOnCooperate: true
      })
      const cooperate = this.previewMindMap.cooperate
      if (cooperate) {
        if (typeof cooperate.setPreviewApplied === 'function') {
          cooperate.setPreviewApplied(true)
        }
        this.enableHttpCollab(version)
        if (typeof cooperate.markTreeUids === 'function') {
          cooperate.markTreeUids(root)
        }
        if (typeof cooperate.seedPreviewHydration === 'function') {
          cooperate.seedPreviewHydration(root)
        }
        if (typeof cooperate.setPreviewApplied === 'function') {
          cooperate.setPreviewApplied(false)
        }
      }
      this.$nextTick(() => {
        try {
          if (this.previewMindMap && this.previewMindMap.view) {
            this.previewMindMap.view.fit()
          }
        } catch (e) {
          /* ignore */
        }
        this.connectCollabV2(version)
      })
    },
    onDialogOpened() {
      if (this.pendingRoot && !this.subtreeError) {
        this.$nextTick(() => {
          setTimeout(
            () =>
              this.mountPreviewMindMap(this.pendingRoot, this.pendingVersion),
            60
          )
        })
      }
    },
    onDialogClosed() {
      // 兼容旧逻辑：详情已改为全页，关闭时等同离开详情
      if (this.detailMode) this.leaveDetail()
    },
    async openSubtree(item, opts = {}) {
      const uid = this.resolveSopUid(item)
      if (!this.roomKey) {
        this.$message.warning('请先选择空间')
        return
      }
      if (!uid) {
        this.$message.warning('找不到该 SOP 对应的节点')
        return
      }
      const tab = opts.tab || 'map'
      this.dialogTab = tab
      this.dialogTitle = (item.title || 'SOP') + '（可编辑 · 协同同步）'
      this.activeSop = item
      this.activeSopUid = uid
      const room = String(this.roomKey || '').trim()
      // 全页跳转：不再弹窗
      await this.$router
        .push({
          path: '/sop',
          query: { room, sopUid: uid, tab }
        })
        .catch(() => {})
      await this.loadSubtreeContent(item)
    },
    async loadSubtreeContent(item) {
      const uid = this.resolveSopUid(item)
      if (!uid || !this.roomKey) return
      this.activeSop = item
      this.activeSopUid = uid
      this.activeLedger = mergeLedgerSources(readLedgerFromNodeLike(item), {
        frequency: item.frequency,
        runs: item.runs,
        deliverables: item.deliverables
      })
      this.resetLedgerForms()
      this.dialogVisible = false
      this.subtreeLoading = true
      this.subtreeError = ''
      this.pendingRoot = null
      this.pendingVersion = 0
      this.teardownPreview()
      try {
        const data = await getFileSubtree(this.roomKey, uid, {
          deep: true,
          maxNodes: 2000
        })
        const tree = (data && data.tree) || data
        const root = toMindMapTree(tree)
        if (!root) {
          this.subtreeError = '未拉取到子树'
          return
        }
        const nodeData = (root && root.data) || {}
        if (nodeData.sopLedger || nodeData.note) {
          const rawDels =
            (nodeData.sopLedger && nodeData.sopLedger.deliverables) ||
            item.deliverables ||
            []
          this.activeLedger = mergeLedgerSources(
            readLedgerFromNodeLike(nodeData),
            {
              frequency: item.frequency,
              runs: item.runs,
              deliverables: item.deliverables
            }
          )
          if (
            Array.isArray(rawDels) &&
            rawDels.length > this.activeLedger.deliverables.length
          ) {
            try {
              await persistSopLedger(
                this.roomKey,
                this.activeSopUid,
                {
                  id: (item && item.id) || '',
                  title: (item && item.title) || ''
                },
                this.activeLedger
              )
              const idx = this.sops.findIndex(
                s =>
                  this.resolveSopUid(s) === this.activeSopUid || s === item
              )
              if (idx >= 0) {
                const next = {
                  ...this.sops[idx],
                  deliverables: this.activeLedger.deliverables,
                  sopLedger: normalizeLedger(this.activeLedger)
                }
                this.$set(this.sops, idx, next)
                this.activeSop = next
              }
            } catch (e) {
              console.warn('[sopRegistry] clean junk deliverables failed', e)
            }
          }
        }
        this.pendingRoot = root
        this.pendingVersion = Number((data && data.version) || 0)
        this.$nextTick(() => {
          setTimeout(
            () => this.mountPreviewMindMap(root, this.pendingVersion),
            80
          )
        })
      } catch (err) {
        console.error('[sopRegistry subtree]', err)
        this.subtreeError = (err && err.message) || '加载子树失败'
      } finally {
        this.subtreeLoading = false
      }
    },
    async openDetailFromRoute() {
      const uid = String(
        (this.$route.query && this.$route.query.sopUid) || ''
      ).trim()
      if (!uid || !this.roomKey) return
      const tab = String(
        (this.$route.query && this.$route.query.tab) || 'map'
      )
      if (tab === 'runs' || tab === 'dels' || tab === 'map') {
        this.dialogTab = tab
      }
      if (
        this.activeSopUid === uid &&
        (this.previewMindMap || this.subtreeLoading || this.pendingRoot)
      ) {
        return
      }
      if (!this.sops.length) {
        await this.refreshRoomList()
      }
      const item =
        this.sops.find(s => this.resolveSopUid(s) === uid) ||
        ({
          uid,
          title: this.dialogTitle || 'SOP',
          id: 'D',
          frequency: null,
          runs: [],
          deliverables: []
        })
      await this.loadSubtreeContent(item)
    },
    async refreshRoomList() {
      const roomKey = String(this.roomKey || '').trim()
      if (!roomKey) {
        this.sops = []
        this.statusText = '请选择空间'
        return
      }
      this.pullLoading = true
      this.statusText = '正在抽取 SOP…'
      try {
        const result = await listRoomDRegistrySops(roomKey)
        const unique = dedupeSopsForRegistry(
          fillDefaultCpda({ sops: result.sops || [] }).sops
        )
        // 合并内存/队列台账，避免刷新冲掉「最近运行」和任务面板对应展示
        this.sops = this.mergeSopsPreservingRuns(unique)
        const space =
          (this.spaceOptions.find(s => s.room_key === roomKey) || {}).label ||
          roomKey
        this.statusText = `「${space}」共 ${this.sops.length} 条 SOP`
        if (this.sopRunQueue && this.sopRunQueue.getSnapshot) {
          this.sopQueueSnap = this.sopRunQueue.getSnapshot()
        }
      } catch (err) {
        console.error('[sopRegistry page]', err)
        this.$message.error((err && err.message) || '读取失败')
        this.statusText = '读取失败'
      } finally {
        this.pullLoading = false
      }
    }
  }
}
</script>

<style lang="less" scoped>
.sopPage {
  min-height: calc(100vh - 48px);
  padding: 20px 28px 36px;
  background: var(--ui-bg, #f7f9f8);
  color: var(--ui-text, #17261f);
  box-sizing: border-box;

  &.detailMode {
    height: calc(100vh - 52px);
    max-height: calc(100vh - 52px);
    padding: 10px 16px 10px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .detailTitle {
    font-size: 18px;
    max-width: 52vw;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sopDetailPage {
    margin-top: 4px;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .detailTabs {
    background: #fff;
    border-radius: 10px;
    padding: 4px 12px 12px;
    border: 1px solid #e4eee9;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;

    /deep/ .el-tabs__header {
      margin-bottom: 8px;
      flex-shrink: 0;
    }

    /deep/ .el-tabs__content {
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }

    /deep/ .el-tab-pane {
      height: 100%;
      overflow: hidden;
    }
  }

  .historyPane {
    height: 100%;
    min-height: 0;
    display: grid;
    grid-template-rows: minmax(0, 1fr) auto;
    gap: 10px;
    overflow: hidden;
  }

  .sectionLabel {
    font-size: 13px;
    font-weight: 600;
    color: #17362c;
    margin-bottom: 8px;

    &.inline {
      margin: 0;
    }
  }

  .paneEmpty.soft {
    padding: 16px;
    color: #80948c;
    background: #f3f7f5;
    border-radius: 8px;
  }

  .sopTaskPanel.embedded {
    margin: 0;
    border: 1px solid #e4eee9;
    border-radius: 8px;
    background: #fafcfb;
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .mindWrap {
    min-height: calc(100vh - 240px);
  }
}

.sopDetailPage {
  .mindWrap {
    height: calc(100vh - 220px);
    min-height: 360px;
  }

  .historyLedger {
    min-height: 0;
    max-height: 34vh;
    overflow: auto;
    border: 1px solid #e4eee9;
    border-radius: 8px;
    background: #fff;
    padding: 0 8px;

    /deep/ .el-collapse {
      border: none;
    }

    /deep/ .el-collapse-item__header {
      height: 40px;
      line-height: 40px;
      border-bottom: none;
    }

    /deep/ .el-collapse-item__wrap {
      border-bottom: none;
    }

    /deep/ .el-collapse-item__content {
      padding-bottom: 10px;
    }

    .ledgerList li {
      padding: 6px 0;
    }

    .liMain {
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      font-size: 12px;
      line-height: 1.4;
    }

    .ledgerMore {
      text-align: center;
      padding-top: 4px;
    }
  }
}

.sopPage {
  .sopHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 8px;

    .left,
    .right {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    h1 {
      margin: 0;
      font-size: 20px;
      font-weight: 600;
      color: var(--ui-text, #17261f);
    }

    .spaceLabel {
      font-size: 13px;
      color: var(--ui-text-secondary, #66756e);
    }

    .spaceSelect {
      width: 280px;
    }
  }

  .statusLine {
    margin: 0 0 10px;
    font-size: 13px;
    color: var(--ui-text-muted, #7b8982);
    line-height: 1.5;
  }

  .runStatus {
    color: var(--ui-primary, #087854);
  }

  .emptyState {
    margin-top: 48px;
    text-align: center;
    color: var(--ui-text-muted, #7b8982);
    font-size: 14px;
  }

  .cardGrid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 14px;
    margin-top: 8px;
  }

  .sopTaskPanel {
    margin-top: 20px;
    border: 1px solid var(--ui-border, #e7ece9);
    border-radius: var(--ui-radius-lg, 12px);
    background: var(--ui-surface, #fff);
    overflow: hidden;

    .taskPanelHead {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--ui-border, #e7ece9);
      background: var(--ui-surface-muted, #f1f5f3);
    }

    .taskTitleRow {
      display: flex;
      align-items: baseline;
      gap: 10px;
      flex-wrap: wrap;

      strong {
        font-size: 14px;
        color: var(--ui-text, #17261f);
      }
    }

    .taskSummary {
      font-size: 12px;
      color: #909399;
    }

    .taskBody {
      display: grid;
      grid-template-columns: minmax(220px, 320px) 1fr;
      min-height: 240px;
      max-height: 520px;
    }

    &.embedded {
      .taskPanelHead {
        flex-shrink: 0;
      }

      .taskBody {
        flex: 1;
        min-height: 0;
        max-height: none;
      }

      .taskDetail {
        overflow: auto;
        min-height: 0;
      }

      .eventList {
        max-height: 100px;
      }

      .streamBox .streamText {
        max-height: 180px;
        min-height: 80px;
      }
    }

    .taskList {
      list-style: none;
      margin: 0;
      padding: 0;
      overflow: auto;
      border-right: 1px solid #ebeef5;
    }

    .taskItem {
      padding: 10px 12px;
      border-bottom: 1px solid #f2f3f5;
      cursor: pointer;

      &:hover,
      &.active {
        background: #f5faf7;
      }

      &.error .taskState {
        color: #f56c6c;
      }

      &.done .taskState {
        color: #67c23a;
      }

      &.running .taskState {
        color: #409eff;
      }

      &.queued .taskState {
        color: #e6a23c;
      }

      &.waiting_data .taskState,
      &.waiting_human .taskState {
        color: #d48806;
      }
    }

    .taskItemMain {
      display: flex;
      gap: 8px;
      align-items: baseline;
      margin-bottom: 4px;
    }

    .taskState {
      flex-shrink: 0;
      font-size: 12px;
      font-weight: 600;
    }

    .taskName {
      font-size: 13px;
      color: #303133;
      word-break: break-word;
    }

    .taskItemStatus {
      font-size: 12px;
      color: #909399;
      line-height: 1.4;
      max-height: 2.8em;
      overflow: hidden;
    }

    .taskItemActions {
      margin-top: 4px;
    }

    .taskDetail {
      padding: 12px 14px;
      overflow: auto;
      min-height: 0;

      .liveHead {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        align-items: baseline;
        margin-bottom: 10px;
        font-size: 13px;

        strong {
          flex: 0 1 auto;
          color: #17261f;
        }

        .liveStatus {
          flex: 1 1 auto;
          text-align: right;
          color: #80948c;
          font-size: 12px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
      }

      .dataFillCallout {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 14px;
        margin-bottom: 12px;
        padding: 12px 14px;
        border: 1px solid #f0d9a8;
        border-radius: 10px;
        background: linear-gradient(180deg, #fffaf0 0%, #fff7e8 100%);
      }

      .calloutMain {
        min-width: 0;
        flex: 1 1 auto;
      }

      .calloutTitle {
        font-size: 13px;
        font-weight: 600;
        color: #8a6116;
        margin-bottom: 4px;
      }

      .calloutHint {
        margin: 0;
        font-size: 12px;
        color: #a07830;
        line-height: 1.45;
      }

      .ctxBox,
      .eventBox,
      .notifyBox,
      .streamBox {
        margin-bottom: 10px;
      }

      .eventList {
        max-height: 120px;
        overflow: auto;
      }

      .streamText {
        max-height: 220px;
        margin: 0;
        padding: 10px;
        overflow: auto;
        background: #f3f7f5;
        color: #24352d;
        border: 1px solid #e7ece9;
        border-radius: 8px;
        font-size: 12px;
        line-height: 1.55;
        white-space: pre-wrap;
        word-break: break-word;
      }
    }
  }

  @media (max-width: 900px) {
    .sopTaskPanel .taskBody {
      grid-template-columns: 1fr;
      max-height: none;
    }

    .sopTaskPanel .taskList {
      border-right: 0;
      border-bottom: 1px solid #ebeef5;
      max-height: 160px;
    }
  }

  .sopCard {
    background: var(--ui-surface, #fff);
    border: 1px solid var(--ui-border, #e7ece9);
    border-radius: var(--ui-radius-lg, 12px);
    padding: 16px;
    box-shadow: 0 1px 2px rgba(23, 38, 31, 0.03);
    cursor: pointer;
    user-select: none;
    transition: box-shadow 0.15s ease, transform 0.15s ease, border-color 0.15s ease;

    &:hover {
      border-color: var(--ui-border-strong, #cbd8d2);
      box-shadow: var(--ui-shadow-hover, 0 6px 18px rgba(23, 38, 31, 0.07));
      transform: translateY(-1px);
    }

    .cardHead {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 10px;
    }

    .cardActions {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }

    .jobChip {
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 4px;
      background: #ecf5ff;
      color: #409eff;

      &.running {
        background: #f0f9eb;
        color: #67c23a;
      }

      &.queued {
        background: #fdf6ec;
        color: #e6a23c;
      }

      &.waiting_human {
        background: #fef0f0;
        color: #f56c6c;
      }

      &.waiting_data {
        background: #fdf6ec;
        color: #e6a23c;
      }
    }

    .cardTitle {
      margin: 0;
      font-size: 16px;
      font-weight: 600;
      color: var(--ui-text, #17261f);
      line-height: 1.4;
      word-break: break-word;
      flex: 1;
    }

    .cardMeta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 12px;
    }

    .metaChip {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 12px;
      background: var(--ui-surface-muted, #f1f5f3);
      color: var(--ui-text-secondary, #66756e);
    }

    .cardBlock {
      margin-top: 10px;
    }

    .blockLabel {
      font-size: 12px;
      color: var(--ui-text-muted, #7b8982);
      margin-bottom: 4px;
    }

    .blockBody {
      font-size: 13px;
      color: var(--ui-text-secondary, #66756e);
      line-height: 1.5;
      word-break: break-word;
    }
  }
}
</style>

<style lang="less">
.sopMindDialog,
.sopDetailPage {
  .el-dialog__body {
    padding: 8px 16px 16px;
  }

  .dialogTabs,
  .detailTabs {
    .el-tabs__header {
      margin-bottom: 10px;
    }
  }

  .syncBar {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
    font-size: 12px;
    color: #606266;

    .syncDot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #c0c4cc;

      &.connecting {
        background: #e6a23c;
      }
      &.live {
        background: #67c23a;
      }
      &.error {
        background: #f56c6c;
      }
    }

    .syncTip {
      margin-left: auto;
      color: #909399;
    }
  }

  .mindWrap {
    position: relative;
    height: 68vh;
    min-height: 400px;
    border: 1px solid #ebeef5;
    border-radius: 8px;
    overflow: hidden;
    background: #fafbfc;
  }

  .mindMapContainer {
    width: 100%;
    height: 100%;
  }

  .ledgerPane {
    min-height: 200px;
    max-height: 50vh;
    overflow: auto;
  }

  .historyLedger.ledgerPane {
    min-height: 0;
    max-height: 34vh;
  }

  .addForm {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    margin-bottom: 12px;

    .formField {
      width: 180px;

      &.short {
        width: 110px;
      }

      &.wide {
        width: 280px;
        flex: 1;
        min-width: 180px;
      }
    }
  }

  .ledgerList {
    list-style: none;
    margin: 0;
    padding: 0;

    li {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 0;
      border-bottom: 1px solid #ebeef5;
      font-size: 13px;
      color: #606266;
    }

    .liMain {
      flex: 1;
      word-break: break-word;
      line-height: 1.5;

      a {
        color: #409eff;
      }
    }

    .liPath,
    .liAt,
    .liActor,
    .liKind {
      flex-shrink: 0;
      font-size: 12px;
      color: #909399;
    }

    .liPath {
      display: block;
      margin-top: 4px;
      word-break: break-all;
    }

    .liAt {
      display: inline-block;
      margin-top: 4px;
      margin-right: 8px;
      color: #a0a4ab;
    }

    .liActions {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
    }
  }

  .paneEmpty {
    padding: 48px 0;
    text-align: center;
    color: #909399;
    font-size: 14px;
  }

  .emptyState {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #909399;
    z-index: 2;
  }
}

.sopRunDialog {
  .runDialogLead {
    margin: 0 0 14px;
    font-size: 14px;
    color: #303133;
    line-height: 1.5;
  }

  .runModelRow {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 14px;

    .runModelLabel {
      flex: 0 0 auto;
      font-size: 13px;
      color: #606266;
    }

    .runModelSelect {
      flex: 1 1 auto;
      min-width: 0;
    }
  }

  .outputChecks {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-bottom: 14px;

    .el-checkbox {
      display: flex;
      align-items: flex-start;
      margin-right: 0;
      white-space: normal;
      height: auto;
    }

    .optLabel {
      font-weight: 600;
      color: #17362c;
    }

    .optHint {
      display: block;
      margin-top: 2px;
      font-size: 12px;
      color: #909399;
      font-weight: 400;
    }
  }

  .runExtra {
    margin-bottom: 8px;
  }

  .runOutputTip {
    margin: -4px 0 12px;
    font-size: 12px;
    color: #80948c;
    line-height: 1.45;
  }

  .runSubmitLoading {
    margin: 0 0 12px;
    padding: 10px 12px;
    border-radius: 8px;
    background: #f7faf8;
    color: #5f7369;
    font-size: 12px;
  }

  .runSubmitBox {
    margin: 0 0 14px;
    padding: 12px 14px;
    border: 1px solid #d9ebe3;
    border-radius: 10px;
    background: linear-gradient(180deg, #f7fcf9 0%, #f3f9f6 100%);
  }

  .runSubmitHead {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 6px;

    strong {
      font-size: 13px;
      color: #0f5c42;
    }

    span {
      font-size: 12px;
      color: #6f857b;
    }
  }

  .runSubmitTip {
    margin: 0 0 12px;
    font-size: 12px;
    color: #5f7369;
    line-height: 1.45;
  }

  .runSubmitGrid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px 12px;
  }

  .runSubmitField {
    label {
      display: block;
      margin-bottom: 4px;
      font-size: 12px;
      font-weight: 600;
      color: #3d4f46;
    }
  }

  .dataFillHint {
    margin: 0 0 12px;
    font-size: 12px;
    color: #a26b1c;
    line-height: 1.45;
  }

  .dataFillField {
    margin-bottom: 10px;

    label {
      display: block;
      margin-bottom: 4px;
      font-size: 12px;
      color: #606266;
    }
  }

  .dataFillExtra {
    margin-top: 4px;
  }
}

.sopDataFillDialog {
  .el-dialog__body {
    max-height: 62vh;
    overflow: auto;
    padding-top: 12px;
    padding-bottom: 8px;
  }

  .fillDialogLead {
    margin: 0 0 8px;
    font-size: 14px;
    color: #24352d;
    line-height: 1.5;
  }

  .fillDialogHint {
    margin: 0 0 14px;
    padding: 8px 10px;
    border-radius: 8px;
    background: #f7faf8;
    border: 1px solid #e7ece9;
    font-size: 12px;
    color: #5f7369;
    line-height: 1.45;
  }

  .fillDialogGrid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px 14px;
    margin-bottom: 14px;
  }

  .fillDialogField {
    label {
      display: block;
      margin-bottom: 6px;
      font-size: 12px;
      font-weight: 600;
      color: #3d4f46;
    }
  }

  .fillDialogExtra {
    margin-bottom: 4px;

    label {
      display: block;
      margin-bottom: 6px;
      font-size: 12px;
      color: #5f7369;
    }
  }

  .fillDialogFooter {
    display: inline-flex;
    gap: 8px;
  }
}

@media (max-width: 640px) {
  .sopDataFillDialog .fillDialogGrid {
    grid-template-columns: 1fr;
  }

  .sopRunDialog .runSubmitGrid {
    grid-template-columns: 1fr;
  }
}

.runLivePanel {
  margin-top: 12px;
  border: 1px solid #dce7e1;
  border-radius: 10px;
  background: #f7faf8;
  padding: 10px 12px 12px;

  .liveHead {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    align-items: baseline;
    margin-bottom: 8px;
    font-size: 13px;

    strong {
      color: #087854;
    }

    span {
      color: #647c71;
      font-size: 12px;
    }
  }

  .ctxBox {
    margin-bottom: 10px;
    font-size: 12px;
    color: #52665f;

    .ctxMeta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 14px;
      margin-bottom: 6px;
    }

    details summary {
      cursor: pointer;
      color: #087854;
    }

    .ctxPreview {
      max-height: 140px;
      overflow: auto;
      margin: 6px 0 0;
      padding: 8px;
      background: #fff;
      border-radius: 6px;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 11px;
      line-height: 1.45;
    }
  }

  .boxLabel {
    font-size: 12px;
    color: #80948c;
    margin-bottom: 4px;
  }

  .notifyBox {
    margin-bottom: 10px;
  }

  .notifyList {
    list-style: none;
    margin: 0;
    padding: 0;
    background: #fff;
    border-radius: 6px;
    border: 1px solid #e4eee9;

    li {
      padding: 8px 10px;
      border-bottom: 1px solid #eef3f0;

      &:last-child {
        border-bottom: none;
      }

      &.block .notifyKind {
        background: #f3e6d4;
        color: #8a5a12;
      }

      &.fail {
        background: #fff8f7;
      }
    }
  }

  .notifyMain {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    margin-bottom: 4px;
  }

  .notifyKind {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 4px;
    background: #e4f3ec;
    color: #0d6b4c;
    font-size: 11px;
  }

  .notifyTo {
    font-weight: 600;
    color: #0b3d2e;
    font-size: 13px;
  }

  .notifyText {
    font-size: 12px;
    color: #314940;
    word-break: break-word;
  }

  .notifyMeta {
    margin-top: 3px;
    font-size: 11px;
    color: #80948c;
  }

  .eventBox {
    margin-bottom: 10px;
  }

  .eventList {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 120px;
    overflow: auto;
    background: #fff;
    border-radius: 6px;

    li {
      display: flex;
      gap: 10px;
      padding: 4px 8px;
      border-bottom: 1px solid #eef3f0;
      font-size: 12px;
    }

    .evTime {
      color: #98a59f;
      flex-shrink: 0;
      font-variant-numeric: tabular-nums;
    }

    .evLabel {
      color: #17362c;
      word-break: break-word;
    }
  }

  .streamBox .streamText {
    max-height: 260px;
    min-height: 120px;
    overflow: auto;
    margin: 0;
    padding: 10px;
    background: #f3f7f5;
    color: #24352d;
    border: 1px solid #e7ece9;
    border-radius: 8px;
    font-size: 12px;
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .runPreview {
    margin-top: 14px;
    padding-top: 12px;
    border-top: 1px solid #ebeef5;

    .previewMeta {
      display: flex;
      gap: 12px;
      font-size: 13px;
      color: #087854;
      margin-bottom: 8px;
    }

    ul {
      margin: 0 0 8px;
      padding-left: 18px;
      font-size: 13px;
    }

    .previewReply {
      max-height: 220px;
      overflow: auto;
      margin: 0;
      padding: 10px;
      background: #f5f7f6;
      border-radius: 8px;
      font-size: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
      color: #606266;
    }
  }
}
</style>

<style lang="less">
.artifactPreviewDialog {
  .el-dialog__body {
    padding: 8px 16px 0;
  }

  .artifactPreviewFrame {
    width: 100%;
    height: 70vh;
    border: 1px solid #ebeef5;
    border-radius: 8px;
    background: #fff;
  }
}

/* 强制浅色弹窗：避免 body.isDark 全局样式把弹窗/输入框弄成黑底浅字 */
body.isDark .sopRunDialog,
.sopRunDialog,
body.isDark .sopDataFillDialog,
.sopDataFillDialog {
  background: #fff !important;

  .el-dialog__header,
  .el-dialog__body,
  .el-dialog__footer {
    background: #fff !important;
    color: #17261f;
  }

  .el-dialog__title,
  .runDialogLead,
  .runModelLabel,
  .optLabel {
    color: #17261f !important;
  }

  .optHint {
    color: #7b8982 !important;
  }

  .el-input__inner,
  .el-textarea__inner {
    background: #fff !important;
    color: #17261f !important;
    border-color: #d5ddd8 !important;
    caret-color: #17261f;

    &::placeholder {
      color: #98a59f !important;
    }
  }

  .el-checkbox__label {
    color: #17261f !important;
  }

  .el-button {
    background-color: #fff !important;
    color: #17261f !important;
    border-color: #d5ddd8 !important;

    &.el-button--primary {
      background-color: var(--ui-primary, #087854) !important;
      border-color: var(--ui-primary, #087854) !important;
      color: #fff !important;
    }
  }
}

body.isDark .sopMindDialog,
.sopMindDialog {
  background: #fff !important;

  .el-dialog__header,
  .el-dialog__body {
    background: #fff !important;
    color: #17261f;
  }

  .el-dialog__title {
    color: #17261f !important;
  }

  .el-input__inner,
  .el-textarea__inner {
    background: #fff !important;
    color: #17261f !important;
    border-color: #d5ddd8 !important;
  }
}

</style>
