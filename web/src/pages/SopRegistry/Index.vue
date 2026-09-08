<template>
  <div class="sopPage">
    <header class="sopHeader">
      <div class="left">
          <el-button size="mini" @click="goBack">{{
            roomKey ? '打开导图' : '返回文件'
          }}</el-button>
          <h1>SOP 台账</h1>
      </div>
      <div class="right">
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
    </header>

    <p class="hint">
      只识别标题以「D数字：」开头的节点（如 D1：销售目标）。运行时若大纲含「AI发起通知 /
      通知 / 知会」，会经 WorkBuddy 派发并写入导图待办树；标题含等待 / 确认 / 审批 /
      阻塞则暂停，待办完成后再点「检查并继续」。
    </p>
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
        title="双击编辑并同步"
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
          <span class="metaChip">{{ item.id || 'SOP' }}</span>
          <span class="metaChip">出现 {{ item.occurrenceCount || 1 }} 次</span>
          <span class="metaChip">{{
            (item.frequency && item.frequency.label) || '频率未知'
          }}</span>
        </div>
        <div class="cardBlock">
          <div class="blockLabel">最近运行</div>
          <div class="blockBody">{{ latestRunLabel(item) }}</div>
        </div>
        <div class="cardBlock">
          <div class="blockLabel">最新产物</div>
          <div class="blockBody">{{ latestDelLabel(item) }}</div>
        </div>
      </article>
    </div>

    <div
      class="sopTaskPanel"
      v-if="sopTaskJobs.length"
    >
      <div class="taskPanelHead">
        <div class="taskTitleRow">
          <strong>SOP 任务</strong>
          <span class="taskSummary">{{ sopQueueSummary }}</span>
        </div>
        <div class="taskHeadActions">
          <el-button
            size="mini"
            type="danger"
            plain
            :disabled="!sopActiveJobCount"
            @click="cancelAllSopJobs"
          >
            全部取消
          </el-button>
        </div>
      </div>
      <div class="taskBody">
        <ul class="taskList">
          <li
            v-for="job in sopTaskJobs"
            :key="job.id"
            class="taskItem"
            :class="{ active: selectedSopJobId === job.id, [job.state]: true }"
            @click="selectSopJob(job.id)"
          >
            <div class="taskItemMain">
              <span class="taskState">{{ sopJobStateLabel(job) }}</span>
              <span class="taskName">{{ job.sopId || 'SOP' }}：{{ job.sopTitle }}</span>
            </div>
            <div class="taskItemStatus">{{ shortJobStatus(job) }}</div>
            <div class="taskItemActions" @click.stop>
              <el-button
                v-if="job.state === 'waiting_human'"
                type="text"
                size="mini"
                @click="resumeSopJob(job.id)"
              >
                检查并继续
              </el-button>
              <el-button
                v-if="job.state === 'waiting_data'"
                type="text"
                size="mini"
                @click="openDataFillDialog(job.id)"
              >
                去补数
              </el-button>
              <el-button
                v-if="job.state === 'done'"
                type="text"
                size="mini"
                @click="openJobDeliverables(job)"
              >
                看产物
              </el-button>
              <el-button
                v-if="
                  job.state === 'running' ||
                    job.state === 'queued' ||
                    job.state === 'waiting_human' ||
                    job.state === 'waiting_data'
                "
                type="text"
                size="mini"
                @click="cancelSopJob(job.id)"
              >
                取消
              </el-button>
            </div>
          </li>
        </ul>
        <div class="taskDetail" v-if="selectedSopJob">
          <div class="liveHead">
            <strong>{{ selectedSopJob.sopTitle }}</strong>
            <span class="liveStatus">{{ shortJobStatus(selectedSopJob) }}</span>
          </div>
          <div
            ref="dataFillBox"
            class="dataFillCallout"
            v-if="selectedSopJob.state === 'waiting_data'"
          >
            <div class="calloutMain">
              <div class="calloutTitle">待补数 · 不是失败</div>
              <p class="calloutHint">{{ shortDataFillHint }}</p>
            </div>
            <el-button
              type="primary"
              size="small"
              @click="openDataFillDialog(selectedSopJob.id)"
            >
              填写并继续
            </el-button>
          </div>
          <div class="ctxBox" v-if="selectedSopJob.context">
            <div class="ctxMeta">
              <span>节点 uid：{{ selectedSopJob.context.sopUid || '无' }}</span>
              <span>来源：{{ selectedSopJob.context.outlineSource }}</span>
              <span>大纲 {{ selectedSopJob.context.outlineChars || 0 }} 字</span>
            </div>
          </div>
          <div
            class="eventBox"
            v-if="selectedSopJob.eventLog && selectedSopJob.eventLog.length"
          >
            <div class="boxLabel">事件流</div>
            <ul class="eventList">
              <li v-for="(ev, i) in selectedSopJob.eventLog" :key="i">
                <span class="evTime">{{ ev.time }}</span>
                <span class="evLabel">{{ ev.label }}</span>
              </li>
            </ul>
          </div>
          <div class="streamBox">
            <div class="boxLabel">流式输出</div>
            <pre ref="runStreamPre" class="streamText">{{
              selectedJobStreamDisplay
            }}</pre>
          </div>
          <div
            class="runPreview"
            v-if="selectedSopJob.result && selectedSopJob.result.deliverables"
          >
            <div class="previewMeta">
              <span>{{ selectedSopJob.result.runResult }}</span>
              <span v-if="selectedSopJob.result.elapsedSec"
                >约 {{ selectedSopJob.result.elapsedSec }}s</span
              >
            </div>
            <ul
              v-if="selectedSopJob.result.deliverables.length"
            >
              <li
                v-for="(d, i) in selectedSopJob.result.deliverables"
                :key="i"
              >
                {{ d.name }}
              </li>
            </ul>
          </div>
        </div>
      </div>
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
        配置「{{ runTarget.id }}：{{ runTarget.title }}」后加入任务队列；可关闭本窗口，任务在后台并行执行（WorkBuddy 多会话）。
      </p>
      <div class="runModelRow">
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
      <el-input
        v-model="runExtraNote"
        type="textarea"
        :rows="2"
        placeholder="额外要求，例如：我要招聘一个初级客服（流程型可不勾产物）"
        class="runExtra"
      ></el-input>
      <span slot="footer">
        <el-button size="small" @click="runDialogVisible = false"
          >取消</el-button
        >
        <el-button
          type="primary"
          size="small"
          @click="confirmRunSop"
        >
          加入队列并开始
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
      :title="dialogTitle"
      :visible.sync="dialogVisible"
      width="90%"
      top="4vh"
      append-to-body
      :close-on-click-modal="false"
      :destroy-on-close="false"
      :custom-class="'sopMindDialog'"
      @opened="onDialogOpened"
      @closed="onDialogClosed"
    >
      <el-tabs v-model="dialogTab" class="dialogTabs">
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
        <el-tab-pane label="历史" name="runs">
          <div class="ledgerPane" v-loading="ledgerSaving">
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
              <li v-for="r in activeLedger.runs" :key="r.id">
                <span class="liMain">{{
                  [r.at, r.result, r.note].filter(Boolean).join(' · ')
                }}</span>
                <span class="liActor" v-if="r.actor">{{ r.actor }}</span>
              </li>
            </ul>
            <div v-else class="paneEmpty">暂无运行记录</div>
          </div>
        </el-tab-pane>
        <el-tab-pane label="产物" name="dels">
          <div class="ledgerPane" v-loading="ledgerSaving">
            <div class="addForm">
              <el-input
                v-model="delForm.name"
                size="small"
                placeholder="产物名称"
                class="formField"
              ></el-input>
              <el-input
                v-model="delForm.uri_or_path"
                size="small"
                placeholder="链接或 COS 路径"
                class="formField wide"
              ></el-input>
              <el-select v-model="delForm.kind" size="small" class="formField short">
                <el-option label="链接" value="link"></el-option>
                <el-option label="文件" value="file"></el-option>
                <el-option label="COS" value="cos"></el-option>
              </el-select>
              <el-button size="mini" @click="fillCosHint">填路径提示</el-button>
              <el-button
                type="primary"
                size="small"
                :disabled="!activeSopUid"
                @click="submitDeliverable"
              >
                追加产物
              </el-button>
            </div>
            <p class="cosHint" v-if="cosHint">建议路径：{{ cosHint }}</p>
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
  latestRunText,
  latestDeliverableText,
  addRunToLedger,
  addDeliverableToLedger,
  persistSopLedger,
  suggestCosPath,
  readLedgerFromNodeLike,
  formatMinuteStamp
} from '@/utils/sopLedger'
import { SOP_OUTPUT_PRESETS, extractMissingDataNeeds } from '@/utils/sopRun'
import {
  getSharedSopRunQueue,
  resolveSopRunConcurrency
} from '@/utils/sopRunQueue'
import { areWaitingTodosDone } from '@/utils/sopNotify'
import {
  fetchWorkbuddyModels,
  getWorkbuddyConfig,
  WORKBUDDY_CUSTOM_MODEL_HINTS
} from '@/utils/workbuddyChat'

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
      activeSop: null,
      activeSopUid: '',
      activeLedger: {
        frequency: { label: '未知', cron_hint: null },
        runs: [],
        deliverables: []
      },
      ledgerSaving: false,
      runForm: { at: '', result: '完成', note: '' },
      delForm: { name: '', uri_or_path: '', kind: 'link' },
      cosHint: '',
      outputPresets: SOP_OUTPUT_PRESETS,
      runDialogVisible: false,
      runTarget: null,
      runOutputIds: [],
      runExtraNote: '',
      runModel: 'deepseek-v4-flash',
      runModelsLoading: false,
      runCustomModels: WORKBUDDY_CUSTOM_MODEL_HINTS.slice(),
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
    selectedSopJob() {
      if (!this.selectedSopJobId) return this.sopTaskJobs[0] || null
      return (
        this.sopTaskJobs.find(j => j.id === this.selectedSopJobId) ||
        (this.sopRunQueue && this.sopRunQueue.getJob(this.selectedSopJobId)) ||
        null
      )
    },
    selectedJobStreamDisplay() {
      const job = this.selectedSopJob
      if (!job) return ''
      const modelText = String(job.streamText || '').trim()
      if (modelText) return job.streamText
      const progress = String(job.progressText || '').trim()
      if (progress) {
        return (
          progress +
          (job.state === 'running' || job.state === 'queued'
            ? '\n\n（模型正文会在生成后出现在此处）'
            : '')
        )
      }
      if (job.state === 'running' || job.state === 'queued') {
        return '等待 WorkBuddy 输出…'
      }
      return job.error || ''
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
    }
  },
  async created() {
    this.initLocalConfig()
    this._sopPageAlive = true
    // 台账页固定浅色产品风格，避免跟随编辑器暗色把弹窗/输入框弄成黑底浅字
    this._hadBodyDark = document.body.classList.contains('isDark')
    document.body.classList.remove('isDark')
    this.sopRunQueue = getSharedSopRunQueue({
      getConcurrency: () => resolveSopRunConcurrency(),
      onChange: snap => {
        if (!this._sopPageAlive) return
        this.sopQueueSnap = snap
        this.syncLedgersFromQueue(snap)
        this.scrollRunStream()
      }
    })
    // 重新挂载 / 整页刷新后立刻同步已有任务（含 session 恢复的待补数）
    if (this.sopRunQueue && this.sopRunQueue.getSnapshot) {
      this.sopQueueSnap = this.sopRunQueue.getSnapshot()
      const snap = this.sopQueueSnap
      const prefer =
        (snap.waiting || []).find(j => j.state === 'waiting_data') ||
        (snap.waiting || [])[0] ||
        (snap.running || [])[0] ||
        (snap.pending || [])[0]
      if (prefer && !this.selectedSopJobId) {
        this.selectedSopJobId = prefer.id
      }
    }
    this.roomKey = roomFromLocation(this.$route) || ''
    await this.loadSpaces()
    if (this.roomKey) this.refreshRoomList()
    else this.statusText = '请选择空间'
  },
  beforeDestroy() {
    this._sopPageAlive = false
    this.teardownPreview()
    // 不 cancelAll：任务继续在单例队列里跑；只卸掉本页监听
    if (this.sopRunQueue && this.sopRunQueue.setOnChange) {
      try {
        this.sopRunQueue.setOnChange(null)
      } catch (e) {
        /* ignore */
      }
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
      if (this.roomKey) {
        this.$router.push({ path: '/', query: { room: this.roomKey } })
        return
      }
      this.$router.push({ path: '/files' })
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
    latestRunLabel(item) {
      const runs =
        (item && item.sopLedger && item.sopLedger.runs) ||
        (item && item.runs) ||
        []
      return latestRunText(runs)
    },
    latestDelLabel(item) {
      const dels =
        (item && item.sopLedger && item.sopLedger.deliverables) ||
        (item && item.deliverables) ||
        []
      return latestDeliverableText(dels)
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
      this.delForm = { name: '', uri_or_path: '', kind: 'file' }
      this.cosHint = ''
    },
    fillCosHint() {
      const hint = suggestCosPath(
        this.roomKey,
        (this.activeSop && this.activeSop.id) || 'SOP',
        this.delForm.name || 'file'
      )
      this.cosHint = hint
      if (!this.delForm.uri_or_path) {
        this.delForm.uri_or_path = hint
        this.delForm.kind = 'cos'
      }
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
    async submitDeliverable() {
      if (!this.delForm.name && !this.delForm.uri_or_path) {
        this.$message.warning('请填写产物名称或路径')
        return
      }
      try {
        this.activeLedger = addDeliverableToLedger(
          this.activeLedger,
          this.delForm
        )
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
      this.runModel = getWorkbuddyConfig().model || 'deepseek-v4-flash'
      this.runDialogVisible = true
      this.loadRunModels()
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
        const n = (job.waitingTaskUids && job.waitingTaskUids.length) || 0
        return n ? `等待人工待办 ${n} 条` : '等待人工确认'
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
      const isJunkField = f => {
        const label = String((f && f.label) || '').trim()
        if (!label || label.length > 16) return true
        if (/[。；;！!？?\n]/.test(label)) return true
        if (
          /节点|uid|未完成|历史|运行|推进|阻塞|阻断|容器|待办|产物|大纲|台账|校验|房间|本次|本单|流程型|登记|拟稿|数据源|示例|仍缺/.test(
            label
          )
        ) {
          return true
        }
        return false
      }
      let fields =
        (job.missingFields && job.missingFields.length
          ? job.missingFields
          : job.result && job.result.missingFields) || []
      if (fields.length && fields.some(isJunkField)) {
        fields = []
      }
      const reply =
        job.streamText || (job.result && job.result.reply) || job.status || ''
      const parsed = extractMissingDataNeeds(reply)
      if (
        (!fields.length || fields.length < 3) &&
        parsed.fields &&
        parsed.fields.length
      ) {
        fields = parsed.fields
      }
      this.dataFillHintText =
        (parsed.summary && !/节点\*\*|未完成\*\*|uid/.test(parsed.summary)
          ? parsed.summary
          : '') ||
        (job.missingSummary && !/节点\*\*|未完成\*\*|uid/.test(job.missingSummary)
          ? job.missingSummary
          : '') ||
        (job.result &&
        job.result.missingSummary &&
        !/节点\*\*|未完成\*\*|uid/.test(job.result.missingSummary)
          ? job.result.missingSummary
          : '') ||
        '模型缺少关键数据，请按字段填写后继续执行。'
      if (!fields.length) {
        fields = [
          { key: 'f_company', label: '公司主体', value: '' },
          { key: 'f_dept', label: '招聘部门', value: '' },
          { key: 'f_gender', label: '性别要求', value: '' },
          { key: 'f_count', label: '人数', value: '' },
          { key: 'f_reason', label: '招聘原因', value: '' },
          { key: 'f_jd', label: '岗位/JD', value: '' },
          { key: 'f_level', label: '职级', value: '' },
          { key: 'f_city', label: '城市', value: '' }
        ]
      }
      this.dataFillFields = fields
        .filter(f => !isJunkField(f))
        .map((f, i) => {
          let label = String(f.label || '')
            .replace(/（.*?）|\(.*?\)/g, '')
            .replace(/[（(][^）)]*$/, '')
            .trim()
          if (!label || label.length > 16) return null
          return {
            key: f.key || `f_${i + 1}`,
            label,
            value: ''
          }
        })
        .filter(Boolean)
      if (!this.dataFillFields.length) {
        this.dataFillFields = [
          { key: 'f_company', label: '公司主体', value: '' },
          { key: 'f_dept', label: '招聘部门', value: '' },
          { key: 'f_gender', label: '性别要求', value: '' },
          { key: 'f_count', label: '人数', value: '' },
          { key: 'f_reason', label: '招聘原因', value: '' },
          { key: 'f_jd', label: '岗位/JD', value: '' },
          { key: 'f_level', label: '职级', value: '' },
          { key: 'f_city', label: '城市', value: '' }
        ]
      }
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
        const uids = job.waitingTaskUids || []
        if (!uids.length) {
          try {
            await this.$confirm(
              '未写入导图待办节点。若已人工处理完通知，可继续执行 SOP。',
              '确认继续',
              { type: 'warning' }
            )
          } catch (e) {
            return
          }
        } else {
          const check = await areWaitingTodosDone(
            job.roomKey || this.roomKey,
            uids
          )
          if (!check.done) {
            const left = (check.pending || []).length
            const miss = (check.missing || []).length
            this.$message.warning(
              left
                ? `还有 ${left} 条阻塞待办未完成，请先在导图「待办」中完成`
                : miss
                  ? '待办节点已找不到，请确认是否被删除'
                  : '阻塞待办尚未完成'
            )
            return
          }
        }
        const res = this.sopRunQueue.resumeWaiting(jobId)
        if (!res.ok) {
          this.$message.warning(res.message || '无法继续')
          return
        }
        this.$message.success('已继续执行 SOP')
      } catch (err) {
        this.$message.error((err && err.message) || '检查待办失败')
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
      this.openSubtree(item)
      this.$nextTick(() => {
        this.dialogTab = 'dels'
      })
    },
    scrollRunStream() {
      this.$nextTick(() => {
        const el = this.$refs.runStreamPre
        if (el) el.scrollTop = el.scrollHeight
      })
    },
    confirmRunSop() {
      if (!this.runTarget || !this.roomKey || !this.sopRunQueue) return
      if (this.runModel) {
        this.setLocalConfig({ workbuddyModel: this.runModel })
      }
      const sop = {
        ...this.runTarget,
        uid: this.resolveSopUid(this.runTarget)
      }
      const enqueued = this.sopRunQueue.enqueue({
        roomKey: this.roomKey,
        sop,
        outputIds: this.runOutputIds.slice(),
        extraNote: this.runExtraNote,
        model: this.runModel,
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
          if (result && result.waitingData) {
            this.$message.info(
              `「${job.sopTitle}」缺少数据，请点击「去补数」填写后继续`
            )
            this.openDataFillDialog(job.id)
            return
          }
          const n = (job.waitingTaskUids && job.waitingTaskUids.length) || 0
          this.$message.warning(
            `「${job.sopTitle}」已派发阻塞通知，请完成导图待办后点「检查并继续」${
              n ? `（${n} 条）` : ''
            }`
          )
        }
      })
      if (!enqueued.ok) {
        this.$message.warning(enqueued.message || '入队失败')
        return
      }
      this.selectedSopJobId = enqueued.job.id
      this.runDialogVisible = false
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
      this.teardownPreview()
      this.pendingRoot = null
      this.pendingVersion = 0
      this.subtreeError = ''
      this.activeSop = null
      this.activeSopUid = ''
      this.dialogTab = 'map'
      if (this.roomKey) this.refreshRoomList()
    },
    async openSubtree(item) {
      const uid = this.resolveSopUid(item)
      if (!this.roomKey) {
        this.$message.warning('请先选择空间')
        return
      }
      if (!uid) {
        this.$message.warning('找不到该 SOP 对应的节点')
        return
      }
      this.activeSop = item
      this.activeSopUid = uid
      this.activeLedger = mergeLedgerSources(readLedgerFromNodeLike(item), {
        frequency: item.frequency,
        runs: item.runs,
        deliverables: item.deliverables
      })
      this.resetLedgerForms()
      this.dialogTab = 'map'
      this.dialogTitle = (item.title || 'SOP') + '（可编辑 · 协同同步）'
      this.dialogVisible = true
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
        // 子树根上可能有更新的 sopLedger
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
          // 打开时清掉过程数据 / MCP 噪声，并静默回写
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
        if (this.dialogVisible) {
          this.$nextTick(() => {
            setTimeout(
              () => this.mountPreviewMindMap(root, this.pendingVersion),
              60
            )
          })
        }
      } catch (err) {
        console.error('[sopRegistry subtree]', err)
        this.subtreeError = (err && err.message) || '加载子树失败'
      } finally {
        this.subtreeLoading = false
      }
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

  .hint,
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
.sopMindDialog {
  .el-dialog__body {
    padding: 8px 16px 16px;
  }

  .dialogTabs {
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
    min-height: 360px;
    max-height: 68vh;
    overflow: auto;
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

  .cosHint {
    margin: 0 0 10px;
    font-size: 12px;
    color: #909399;
    word-break: break-all;
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
