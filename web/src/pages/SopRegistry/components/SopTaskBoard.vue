<template>
  <div class="sopTaskBoard" :class="{ embedded: embedded }">
    <div class="boardHead">
      <strong class="boardTitle">{{ title }}</strong>
      <span class="summary" v-if="jobs.length">{{ jobs.length }}</span>
    </div>

    <div class="boardBody">
      <ul class="taskList">
        <li
          v-for="job in jobs"
          :key="job.id"
          class="taskItem"
          :class="{ active: selectedId === job.id, [job.state]: true }"
          @click="$emit('select', job.id)"
        >
          <div class="taskItemMain">
            <span class="taskState">{{ stateLabel(job) }}</span>
            <span class="taskName" :title="jobTitle(job)">{{ jobTitle(job) }}</span>
            <span
              v-if="deliverablesForJob(job).length"
              class="artifactMark"
              :title="`产物 ${deliverablesForJob(job).length} 个`"
            >
              产物
            </span>
          </div>
          <div class="taskMeta" v-if="shortStatus(job)">
            {{ shortStatus(job) }}
          </div>
          <div class="taskItemActions" @click.stop>
            <el-button
              v-if="job.state === 'waiting_human'"
              type="text"
              size="mini"
              @click="$emit('resume', job.id)"
            >
              继续
            </el-button>
            <el-button
              v-if="canContinuePartial(job)"
              type="text"
              size="mini"
              @click="$emit('continue-partial', job.id)"
            >
              续跑
            </el-button>
            <el-button
              v-if="isCancellable(job)"
              type="text"
              size="mini"
              @click="$emit('cancel', job.id)"
            >
              取消
            </el-button>
          </div>
        </li>
        <li v-if="!jobs.length" class="taskEmpty">暂无任务</li>
      </ul>

      <div class="taskDetail" v-if="selectedJob">
        <div class="liveHead">
          <strong>{{ jobTitle(selectedJob) }}</strong>
          <span class="liveState" :class="selectedJob.state">{{
            stateLabel(selectedJob)
          }}</span>
        </div>

        <section class="nodePanel" v-if="nodeSteps.length">
          <div class="sectionTitle">节点流</div>
          <div class="flowScroll">
            <ol class="flowRail">
              <li
                v-for="(step, index) in nodeSteps"
                :key="step.uid"
                class="flowNode"
                :class="[
                  step.status,
                  {
                    selected: detailNode && detailNode.uid === step.uid,
                    'is-break': step.isBreak
                  }
                ]"
                :title="step.title"
                @click="openNodeDetail(step)"
              >
                <span class="flowLabel">{{ step.title }}</span>
                <span class="flowTrack">
                  <span
                    class="flowLine before"
                    :class="flowLineBeforeClass(index, step)"
                  ></span>
                  <span class="dot" aria-hidden="true"></span>
                  <span
                    class="flowLine after"
                    :class="flowLineAfterClass(index, step)"
                  ></span>
                </span>
              </li>
            </ol>
          </div>
        </section>

        <section class="execPanel">
          <div class="sectionTitle">执行过程</div>
          <div
            class="streamMd"
            v-if="renderedStream"
            v-html="renderedStream"
          ></div>
          <div class="streamMd empty" v-else>
            <p class="streamPlaceholder">等待输出…</p>
          </div>
          <div class="artifactBlock" v-if="jobDeliverables.length">
            <div class="artifactTitle">产物</div>
            <ul class="artifactList">
              <li
                v-for="d in jobDeliverables"
                :key="d.id || d.uri_or_path || d.name"
                :class="{ derived: !!d.derived_from }"
              >
                <span class="artifactName" :title="d.name">
                  {{ d.name }}
                  <span v-if="d.derived_from" class="artifactDerivedMark">优化版</span>
                </span>
                <span class="artifactActions">
                  <el-button
                    v-if="isOptimizableFormat(d)"
                    type="text"
                    size="mini"
                    :disabled="artifactOptimizeBusy || !!optimizeUnavailableReason(d)"
                    :title="optimizeUnavailableReason(d)"
                    @click="openArtifactOptimizer(d)"
                  >
                    优化产物内容
                  </el-button>
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
                  <el-button
                    v-else-if="isHttp(d.uri_or_path)"
                    type="text"
                    size="mini"
                    @click="openUrl(d.uri_or_path)"
                  >
                    打开
                  </el-button>
                </span>
              </li>
            </ul>
          </div>
        </section>
      </div>
      <div class="taskDetail empty" v-else>
        <p>选择左侧任务</p>
      </div>
    </div>

    <el-drawer
      title="节点详情"
      :visible.sync="nodeDrawerVisible"
      size="360px"
      append-to-body
    >
      <div v-if="detailNode" class="nodeDetailBody">
        <p><strong>标题</strong>：{{ detailNode.title }}</p>
        <p><strong>状态</strong>：{{ stepStatusLabel(detailNode.status) }}</p>
        <p v-if="detailNode.kind"><strong>类型</strong>：{{ detailNode.kind }}</p>
        <p v-if="detailNode.detail">
          <strong>说明</strong>：{{ detailNode.detail }}
        </p>
        <div
          v-if="detailNode.events && detailNode.events.length"
          class="nodeEvents"
        >
          <strong>事件</strong>
          <ul>
            <li v-for="(ev, i) in detailNode.events" :key="i">
              {{ ev.label || JSON.stringify(ev) }}
            </li>
          </ul>
        </div>
      </div>
    </el-drawer>

    <el-dialog
      title="优化产物内容"
      :visible.sync="artifactOptimizeVisible"
      width="760px"
      append-to-body
      custom-class="artifactOptimizeDialog"
      :close-on-click-modal="!artifactOptimizeBusy"
      :before-close="beforeCloseArtifactOptimizer"
    >
      <div class="optimizeSource">
        <span>源产物</span>
        <strong>{{ artifactOptimizeSource && artifactOptimizeSource.name }}</strong>
      </div>
      <div v-if="artifactOptimizeRulesLoading" class="optimizeRulesStatus">
        <i class="el-icon-loading"></i> 正在读取脑图输入规则…
      </div>
      <div v-else-if="artifactOptimizeSavedRules.length" class="optimizeRulesStatus loaded">
        已加载 {{ artifactOptimizeSavedRules.length }} 条脑图规则，生成时会自动应用
      </div>
      <div ref="optimizeMessages" class="optimizeMessages">
        <div v-if="!artifactOptimizeMessages.length" class="optimizeEmpty">
          {{ artifactOptimizeSavedRules.length
            ? '已加载脑图规则，可直接生成；也可以继续补充新的优化要求。'
            : '告诉助理你希望如何修改这个产物。可以连续讨论，确认后再生成新文件。' }}
        </div>
        <div
          v-for="(message, index) in artifactOptimizeMessages"
          :key="index"
          class="optimizeMessage"
          :class="message.role"
        >
          <div class="optimizeRole">{{ message.role === 'user' ? '你' : '助理' }}</div>
          <div class="optimizeBubble">{{ message.content }}</div>
        </div>
      </div>
      <el-input
        v-model="artifactOptimizeInput"
        type="textarea"
        :rows="3"
        maxlength="2000"
        show-word-limit
        :disabled="artifactOptimizeBusy"
        placeholder="例如：把页面改成蓝色商务风，并突出季度增长趋势"
        @keydown.native.ctrl.enter="sendArtifactOptimizeMessage"
      />
      <div class="optimizeComposerActions">
        <span class="optimizeHint">Ctrl + Enter 发送</span>
        <el-button
          size="small"
          :disabled="artifactOptimizeBusy || !artifactOptimizeInput.trim()"
          @click="sendArtifactOptimizeMessage"
        >发送</el-button>
        <el-button
          v-if="artifactOptimizeChatting"
          size="small"
          type="danger"
          plain
          @click="stopArtifactOptimization"
        >停止</el-button>
      </div>
      <div v-if="artifactOptimizeError" class="optimizeError">
        {{ artifactOptimizeError }}
      </div>
      <span slot="footer" class="optimizeFooter">
        <el-button
          size="small"
          :disabled="artifactOptimizeBusy || !artifactOptimizeMessages.length"
          @click="clearArtifactOptimization"
        >清空对话</el-button>
        <span class="optimizeFooterSpacer"></span>
        <el-button size="small" :disabled="artifactOptimizeBusy" @click="closeArtifactOptimizer">取消</el-button>
        <el-button
          type="primary"
          size="small"
          :loading="artifactOptimizeGenerating"
          :disabled="!canGenerateOptimizedArtifact"
          @click="generateOptimizedArtifact"
        >生成优化产物</el-button>
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
      <div
        v-if="artifactPreviewHtml"
        class="artifactSpreadsheetPreview"
        v-html="artifactPreviewHtml"
      ></div>
      <iframe
        v-else-if="artifactPreviewUrl"
        class="artifactPreviewFrame"
        :src="artifactPreviewUrl"
        title="产物预览"
      ></iframe>
      <div v-else class="artifactPreviewEmpty">无法预览</div>
      <span slot="footer">
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
import MarkdownIt from 'markdown-it'
import * as XLSX from 'xlsx'
import { extractDeliverablesFromReply, jobNeedsWecomResume } from '@/utils/sopRun'
import {
  artifactLocalUrl,
  getFileSubtree,
  saveSopOutputRules
} from '@/utils/fileApi'
import { AI_BACKEND_OPENCLAW, streamChat } from '@/utils/agentChat'
import {
  extractOutputRulesFromTree,
  formatOutputRulesPrompt,
  uniqueOutputRules
} from '@/utils/sopOutputRules'

const streamMd = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true
})

function stripDeliverableSections(text) {
  let t = String(text || '')
  t = t.replace(
    /(?:^|\n)\s*(?:#{1,6}\s*|\*{1,2}\s*)?产物清单\s*\*{0,2}\s*[:：]?\s*\n([\s\S]*?)(?=\n\s*(?:#{1,6}\s|\*{1,2}\s*[^*\n]+\*{0,2}\s*$|\n---|\s*$))/gim,
    '\n'
  )
  t = t.replace(/^\s*[-*]\s*\*{0,2}name\*{0,2}\s*[:：].*$/gim, '')
  t = t.replace(/^\s*\*{0,2}path\*{0,2}\s*[:：]\s*.*$/gim, '')
  return t.replace(/\n{3,}/g, '\n\n').trim()
}

function streamTextOf(job) {
  if (!job) return ''
  return String(
    job.streamText ||
      (job.result && job.result.reply) ||
      job.progressText ||
      ''
  ).trim()
}

function sourceKey(item) {
  return String(item && (item.id || item.uri_or_path || item.name) || '').trim()
}

function stableArtifactKey(item) {
  return String(item && (item.uri_or_path || item.id || item.name) || '').trim()
}

function transcriptText(messages) {
  return (messages || [])
    .map(item => `${item.role === 'user' ? '用户' : '助理'}：${item.content}`)
    .join('\n\n')
}

export default {
  name: 'SopTaskBoard',
  props: {
    jobs: { type: Array, default: () => [] },
    selectedId: { type: String, default: '' },
    embedded: { type: Boolean, default: false },
    title: { type: String, default: 'SOP 任务' },
    roomKey: { type: String, default: '' },
    sopUid: { type: String, default: '' },
    ledgerDeliverables: { type: Array, default: () => [] }
  },
  data() {
    return {
      nodeDrawerVisible: false,
      detailNode: null,
      artifactPreviewVisible: false,
      artifactPreviewTitle: '产物预览',
      artifactPreviewUrl: '',
      artifactPreviewHtml: '',
      artifactPreviewDownloadUrl: '',
      artifactOptimizeVisible: false,
      artifactOptimizeSource: null,
      artifactOptimizeMessages: [],
      artifactOptimizeInput: '',
      artifactOptimizeChatting: false,
      artifactOptimizeGenerating: false,
      artifactOptimizeError: '',
      artifactOptimizeController: null,
      artifactOptimizeSavedRules: [],
      artifactOptimizeRulesLoading: false
    }
  },
  computed: {
    selectedJob() {
      return (this.jobs || []).find(j => j.id === this.selectedId) || null
    },
    nodeSteps() {
      const job = this.selectedJob
      const all = (job && job.nodeProgress) || []
      if (!all.length) return []

      let breakIdx = all.findIndex(s =>
        ['waiting', 'failed', 'stopped'].includes(String(s.status || ''))
      )

      // 任务已卡住，但断点被标成 done：断在最后一个已推进节点
      const jobBlocked = [
        'waiting_human',
        'error',
        'cancelled'
      ].includes(String((job && job.state) || ''))
      if (breakIdx < 0 && jobBlocked) {
        breakIdx = -1
        for (let i = 0; i < all.length; i++) {
          const st = String(all[i].status || '')
          if (st === 'pending' || st === 'skipped') {
            breakIdx = i - 1
            break
          }
          breakIdx = i
        }
      }

      if (breakIdx < 0) return all

      return all.slice(0, breakIdx + 1).map((s, i) => ({
        ...s,
        isBreak: i === breakIdx
      }))
    },
    streamRawText() {
      return streamTextOf(this.selectedJob)
    },
    renderedStream() {
      const text = stripDeliverableSections(this.streamRawText)
      if (!text) return ''
      return streamMd.render(text)
    },
    jobDeliverables() {
      return this.orderDerivedDeliverables(this.deliverablesForJob(this.selectedJob))
    },
    artifactOptimizeBusy() {
      return this.artifactOptimizeChatting || this.artifactOptimizeGenerating
    },
    canGenerateOptimizedArtifact() {
      return (
        !this.artifactOptimizeBusy &&
        !this.artifactOptimizeRulesLoading &&
        this.artifactOptimizeSource &&
        (this.artifactOptimizeSavedRules.length > 0 ||
          this.artifactOptimizeMessages.some(
            item => item.role === 'user' && String(item.content || '').trim()
          ))
      )
    }
  },
  methods: {
    jobTitle(job) {
      const title = String((job && job.sopTitle) || '').trim()
      const id = String((job && job.sopId) || '').trim()
      if (!title) return id || '任务'
      if (!id || id.toUpperCase() === 'D') {
        if (/^[Dd](?!\d)\s*[：:]/.test(title)) return title
        return id.toUpperCase() === 'D' ? `D：${title}` : title
      }
      return `${id}：${title}`
    },
    deliverablesForJob(job) {
      if (!job) return []
      const seen = new Set()
      const out = []
      const push = item => {
        if (!item) return
        const uri = String(item.uri_or_path || '').trim()
        const name =
          String(item.name || '').trim() || uri.split(/[\\/]/).pop() || ''
        if (!name && !uri) return
        const key = (uri || name).replace(/\\/g, '/').toLowerCase()
        if (!key || seen.has(key)) return
        seen.add(key)
        out.push({
          id: item.id || `d_${out.length}_${key.slice(-24)}`,
          name,
          uri_or_path: uri || name,
          kind: item.kind || 'file',
          at: item.at || '',
          createdAt: item.createdAt || '',
          derived_from: item.derived_from || item.derivedFrom || '',
          optimization_instruction:
            item.optimization_instruction || item.optimizationInstruction || '',
          optimization_version: Number(
            item.optimization_version || item.optimizationVersion || 0
          ) || 0,
          optimization_root:
            item.optimization_root || item.optimizationRoot || '',
          output_rules: uniqueOutputRules(
            item.output_rules || item.outputRules || []
          )
        })
      }
      const runDels =
        (job.result && job.result.deliverables) || job.deliverables || []
      runDels.forEach(push)
      ;(job.priorDeliverables || []).forEach(push)
      extractDeliverablesFromReply(streamTextOf(job), [], [], {
        id: job.sopId,
        title: job.sopTitle,
        uid: job.sopUid,
        sopId: job.sopId,
        sopTitle: job.sopTitle,
        sopUid: job.sopUid
      }).forEach(push)
      // 旧版本曾把 SOP 台账的全部历史产物写进单次任务。
      // 一旦存在优化链，只展示参与本次优化的源文件及其派生版本。
      const derived = out.filter(item => item.derived_from)
      if (!derived.length) return out
      const included = new Set(derived.map(item => sourceKey(item)))
      let changed = true
      while (changed) {
        changed = false
        out.forEach(item => {
          if (!included.has(sourceKey(item))) return
          const parent = String(item.derived_from || '').trim()
          if (parent && !included.has(parent)) {
            included.add(parent)
            changed = true
          }
        })
      }
      derived.forEach(item => included.add(String(item.derived_from || '').trim()))
      return out.filter(item => included.has(sourceKey(item)))
    },
    orderDerivedDeliverables(items) {
      const list = Array.isArray(items) ? items : []
      const keyOf = item =>
        String(item && (item.id || item.uri_or_path || item.name) || '').trim()
      const children = new Map()
      const roots = []
      list.forEach(item => {
        const parent = String((item && item.derived_from) || '').trim()
        if (!parent || !list.some(candidate => keyOf(candidate) === parent)) {
          roots.push(item)
          return
        }
        if (!children.has(parent)) children.set(parent, [])
        children.get(parent).push(item)
      })
      const out = []
      const append = item => {
        out.push(item)
        ;(children.get(keyOf(item)) || []).forEach(append)
      }
      roots.forEach(append)
      return out
    },
    stateLabel(job) {
      const runResult =
        (job && job.result && job.result.runResult) ||
        (job && job.runResult) ||
        ''
      if (runResult === '部分完成' || job.state === 'partial') return '部分完成'
      const map = {
        queued: '排队',
        running: '运行',
        waiting_human: '等待',
        done: '完成',
        partial: '部分完成',
        error: '失败',
        cancelled: '停止'
      }
      return map[job.state] || job.state
    },
    shortStatus(job) {
      const raw = String((job && (job.status || job.error)) || '').trim()
      if (!raw) return ''
      return raw.length > 36 ? `${raw.slice(0, 36)}…` : raw
    },
    isCancellable(job) {
      return ['running', 'queued', 'waiting_human'].includes(job.state)
    },
    canContinuePartial(job) {
      if (!job) return false
      // 无企微待办/人工确认衔接：不提供续跑，应重新「打开」一次跑完
      if (!jobNeedsWecomResume(job)) return false
      if (job.state === 'partial') return true
      const rr =
        (job.result && job.result.runResult) || job.runResult || ''
      if (rr !== '部分完成') return false
      return ['done', 'partial', 'error'].includes(String(job.state || ''))
    },
    stepStatusLabel(status) {
      const map = {
        pending: '未开始',
        active: '进行中',
        done: '已完成',
        waiting: '等待',
        skipped: '跳过',
        failed: '失败',
        stopped: '已停止'
      }
      return map[status] || status || '未开始'
    },
    isFlowReached(status) {
      return ['done', 'active', 'waiting'].includes(String(status || ''))
    },
    flowLineBeforeClass(index, step) {
      if (index === 0) return 'hidden'
      const prev = this.nodeSteps[index - 1]
      if (
        (prev && (prev.status === 'done' || prev.isBreak)) ||
        this.isFlowReached(step.status) ||
        step.isBreak
      ) {
        return 'done'
      }
      return ''
    },
    flowLineAfterClass(index, step) {
      // 断点 / 未完成：不向右连线；仅已完成且非断点才向右画绿线
      if (index === this.nodeSteps.length - 1 || step.isBreak) return 'hidden'
      if (step.status === 'done') return 'done'
      return 'hidden'
    },
    openNodeDetail(step) {
      this.detailNode = step
      this.nodeDrawerVisible = true
    },
    isHttp(uri) {
      return /^https?:\/\//i.test(String(uri || ''))
    },
    isLocalAbsPath(uri) {
      const u = String(uri || '')
      return /^[A-Za-z]:[\\/]/.test(u) || u.startsWith('/')
    },
    deliverableOpenUrl(d, { download = false } = {}) {
      const uri = String((d && d.uri_or_path) || '')
      const name = String((d && d.name) || '')
      if (this.isHttp(uri)) return uri
      if (
        this.isLocalAbsPath(uri) ||
        /\.(html?|xlsx?|docx?|pdf|md|csv|json)$/i.test(name || uri)
      ) {
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
        /\.(html?|xlsx?|docx?|pdf|md|csv|json)$/i.test(name || uri)
      )
    },
    isOptimizableFormat(d) {
      const uri = String((d && d.uri_or_path) || '')
      const name = String((d && d.name) || '')
      return /\.(html?|xlsx?|docx?|pdf|md|csv|json)(?:\?|#|$)/i.test(name || uri)
    },
    optimizeUnavailableReason(d) {
      if (!this.selectedJob || this.selectedJob.state !== 'done') {
        return '任务完成后才可优化产物'
      }
      if (this.isHttp(d && d.uri_or_path)) return '远程产物暂不支持直接优化'
      if (!this.isOptimizableFormat(d)) return '该文件格式暂不支持优化'
      return ''
    },
    async openArtifactOptimizer(d) {
      const unavailable = this.optimizeUnavailableReason(d)
      if (unavailable) {
        this.$message.warning(unavailable)
        return
      }
      try {
        await this.verifyGeneratedDeliverable(d)
      } catch (error) {
        this.$message.error('源文件不存在或当前无法读取')
        return
      }
      this.artifactOptimizeSource = { ...d }
      this.artifactOptimizeMessages = []
      this.artifactOptimizeInput = ''
      this.artifactOptimizeError = ''
      this.artifactOptimizeSavedRules = []
      this.artifactOptimizeVisible = true
      this.loadArtifactOptimizeRules()
    },
    selectedSopLocation() {
      const firstValid = values => {
        for (const value of values) {
          const text = String(value == null ? '' : value).trim()
          if (text && !/^(?:null|undefined)$/i.test(text)) return text
        }
        return ''
      }
      const query = (this.$route && this.$route.query) || {}
      return {
        // The detail route identifies the currently opened SOP. Prefer it over
        // legacy jobs where missing ids were serialized as the string "null".
        roomKey: firstValid([
          this.roomKey,
          query.room,
          this.selectedJob && this.selectedJob.roomKey
        ]),
        sopUid: firstValid([
          this.sopUid,
          query.sopUid,
          this.selectedJob && this.selectedJob.sopUid
        ])
      }
    },
    async fetchCurrentSopTree(location) {
      const { roomKey, sopUid } = location || this.selectedSopLocation()
      if (!roomKey || !sopUid) return null
      const data = await getFileSubtree(roomKey, sopUid, {
        deep: true,
        maxNodes: 800,
        priority: 'high'
      })
      return (data && data.tree) || data
    },
    async loadArtifactOptimizeRules() {
      this.artifactOptimizeRulesLoading = true
      try {
        const tree = await this.fetchCurrentSopTree()
        this.artifactOptimizeSavedRules = extractOutputRulesFromTree(tree)
      } catch (error) {
        this.artifactOptimizeSavedRules = []
        this.artifactOptimizeError = '暂时无法读取脑图输入规则；仍可输入新要求后生成'
      } finally {
        this.artifactOptimizeRulesLoading = false
      }
    },
    currentUserOutputRules() {
      return uniqueOutputRules(
        this.artifactOptimizeMessages
          .filter(item => item.role === 'user')
          .map(item => item.content)
      )
    },
    effectiveOptimizationInstruction() {
      const saved = formatOutputRulesPrompt(this.artifactOptimizeSavedRules)
      const conversation = transcriptText(this.artifactOptimizeMessages)
      return [saved, conversation ? `## 本轮优化对话\n${conversation}` : '']
        .filter(Boolean)
        .join('\n\n')
    },
    optimizerConversationId(mode = 'chat') {
      const jobId = String((this.selectedJob && this.selectedJob.id) || 'job')
      const source = sourceKey(this.artifactOptimizeSource)
        .replace(/[^\w.-]+/g, '-')
        .slice(-60)
      return `sop-artifact-${mode}-${jobId}-${source}`
    },
    scrollOptimizeMessages() {
      this.$nextTick(() => {
        const el = this.$refs.optimizeMessages
        if (el) el.scrollTop = el.scrollHeight
      })
    },
    async sendArtifactOptimizeMessage() {
      const input = String(this.artifactOptimizeInput || '').trim()
      if (!input || this.artifactOptimizeBusy || !this.artifactOptimizeSource)
        return
      this.artifactOptimizeMessages.push({ role: 'user', content: input })
      this.artifactOptimizeInput = ''
      this.artifactOptimizeError = ''
      this.artifactOptimizeChatting = true
      const assistant = { role: 'assistant', content: '' }
      this.artifactOptimizeMessages.push(assistant)
      this.artifactOptimizeController = new AbortController()
      this.scrollOptimizeMessages()
      try {
        const source = this.artifactOptimizeSource
        const savedRules = formatOutputRulesPrompt(this.artifactOptimizeSavedRules)
        const prompt = [
          '你是 SOP 产物优化顾问。现在只讨论修改方案，不得调用工具、不得读写或生成文件。',
          `源产物：${source.name || source.uri_or_path}`,
          savedRules,
          '结合以下完整对话，回应用户最新要求；需要时主动指出冲突或提出具体建议。',
          transcriptText(this.artifactOptimizeMessages.filter(item => item !== assistant))
        ].join('\n\n')
        const result = await streamChat({
          backend: AI_BACKEND_OPENCLAW,
          model: 'openclaw/default',
          conversationId: this.optimizerConversationId('chat'),
          messages: [{ role: 'user', content: prompt }],
          signal: this.artifactOptimizeController.signal,
          onDelta: text => {
            assistant.content = String(text || '')
            this.$forceUpdate()
            this.scrollOptimizeMessages()
          }
        })
        assistant.content = String((result && result.content) || assistant.content).trim()
        if (!assistant.content) assistant.content = '已记录。你可以继续补充，或生成优化产物。'
      } catch (error) {
        if (error && error.name === 'AbortError') {
          if (!assistant.content) assistant.content = '已停止本轮回复。'
        } else {
          this.artifactOptimizeError =
            (error && error.message) || '助理回复失败，请稍后重试'
          if (!assistant.content) this.artifactOptimizeMessages.pop()
        }
      } finally {
        this.artifactOptimizeChatting = false
        this.artifactOptimizeController = null
        this.scrollOptimizeMessages()
      }
    },
    stopArtifactOptimization() {
      if (this.artifactOptimizeController) this.artifactOptimizeController.abort()
    },
    clearArtifactOptimization() {
      this.artifactOptimizeMessages = []
      this.artifactOptimizeInput = ''
      this.artifactOptimizeError = ''
    },
    beforeCloseArtifactOptimizer(done) {
      if (this.artifactOptimizeBusy) {
        this.$message.info('请先停止当前生成')
        return
      }
      done()
    },
    closeArtifactOptimizer() {
      if (!this.artifactOptimizeBusy) this.artifactOptimizeVisible = false
    },
    async verifyGeneratedDeliverable(deliverable) {
      const url = artifactLocalUrl(deliverable.uri_or_path, {
        name: deliverable.name
      })
      const response = await fetch(url, { credentials: 'include', cache: 'no-store' })
      if (!response.ok) throw new Error('优化文件未实际生成，请调整要求后重试')
      if (response.body && response.body.cancel) response.body.cancel().catch(() => {})
    },
    resolveOptimizationRoot(source) {
      const items = this.jobDeliverables || []
      const bySourceKey = new Map(items.map(item => [sourceKey(item), item]))
      const byStableKey = new Map(items.map(item => [stableArtifactKey(item), item]))
      const declaredRoot = String(
        (source && (source.optimization_root || source.optimizationRoot)) || ''
      ).trim()
      if (declaredRoot && byStableKey.has(declaredRoot)) {
        return byStableKey.get(declaredRoot)
      }
      let current = source
      const visited = new Set()
      while (current) {
        const currentKey = sourceKey(current)
        if (!currentKey || visited.has(currentKey)) break
        visited.add(currentKey)
        const parentKey = String(current.derived_from || '').trim()
        const parent = parentKey && bySourceKey.get(parentKey)
        if (!parent) break
        current = parent
      }
      return current || source
    },
    optimizationRootFor(item) {
      const explicit = String(
        (item && (item.optimization_root || item.optimizationRoot)) || ''
      ).trim()
      if (explicit) return explicit
      return stableArtifactKey(this.resolveOptimizationRoot(item))
    },
    optimizationVersionPlan(source) {
      const root = this.resolveOptimizationRoot(source)
      const rootKey = stableArtifactKey(root)
      const rootSourceKey = sourceKey(root)
      const descendants = (this.jobDeliverables || []).filter(item => {
        if (sourceKey(item) === rootSourceKey) return false
        return this.optimizationRootFor(item) === rootKey
      })
      const explicitVersions = descendants.map(item => {
        const metadataVersion = Number(
          item.optimization_version || item.optimizationVersion || 0
        )
        if (metadataVersion > 0) return metadataVersion
        const match = String(item.name || '').match(/_优化V(\d+)(?=\.[^.]+$)/i)
        return match ? Number(match[1]) : 0
      })
      const nextVersion =
        Math.max(descendants.length, 0, ...explicitVersions) + 1
      const rootName = String(root.name || root.uri_or_path || source.name || '产物')
        .split(/[\\/]/)
        .pop()
      const extHit = rootName.match(/(\.[A-Za-z0-9]+)$/)
      const extension = extHit ? extHit[1].toLowerCase() : '.html'
      const baseName = rootName
        .replace(/\.[^.]+$/, '')
        .replace(/(?:_优化(?:V\d+|_?\d{8}_\d{6})?)+$/i, '')
        .replace(/[\\/:*?"<>|]/g, '_')
        .slice(0, 100)
      return { root, rootKey, baseName, extension, nextVersion }
    },
    async artifactNameExists(name) {
      try {
        const response = await fetch(artifactLocalUrl(name, { name }), {
          credentials: 'include',
          cache: 'no-store'
        })
        if (response.body && response.body.cancel) response.body.cancel().catch(() => {})
        return response.ok
      } catch (_) {
        return false
      }
    },
    async nextOptimizationTarget(source) {
      const plan = this.optimizationVersionPlan(source)
      let version = plan.nextVersion
      for (let attempts = 0; attempts < 100; attempts += 1, version += 1) {
        const name = `${plan.baseName}_优化V${version}${plan.extension}`
        if (!(await this.artifactNameExists(name))) {
          return { ...plan, version, name }
        }
      }
      throw new Error('无法分配新的优化版本号，请清理重名文件后重试')
    },
    async saveCurrentOutputRules(location, rules) {
      const incoming = uniqueOutputRules(rules || this.currentUserOutputRules())
      if (!incoming.length) return { added: 0 }
      const { roomKey, sopUid } = location || this.selectedSopLocation()
      if (!roomKey || !sopUid) throw new Error('缺少脑图房间或 SOP 节点信息')
      const result = await saveSopOutputRules(roomKey, sopUid, incoming)
      this.artifactOptimizeSavedRules = uniqueOutputRules(
        (result && result.rules) || incoming
      )
      return { added: Number((result && result.added) || 0) }
    },
    async persistOptimizedDeliverable(deliverable, instruction) {
      return new Promise((resolve, reject) => {
        this.$emit('artifact-optimized', {
          jobId: this.selectedJob && this.selectedJob.id,
          source: this.artifactOptimizeSource,
          deliverable,
          instruction,
          resolve,
          reject
        })
      })
    },
    async generateOptimizedArtifact() {
      if (!this.canGenerateOptimizedArtifact) return
      this.artifactOptimizeGenerating = true
      this.artifactOptimizeError = ''
      this.artifactOptimizeController = new AbortController()
      try {
        const source = this.artifactOptimizeSource
        const sopLocation = this.selectedSopLocation()
        const newOutputRules = this.currentUserOutputRules()
        const sourcePath = String(source.uri_or_path || source.name || '').trim()
        const target = await this.nextOptimizationTarget(source)
        const effectiveInstruction = this.effectiveOptimizationInstruction()
        const prompt = [
          '你正在执行一次独立的 SOP 产物优化任务，不得重新运行 SOP，不得创建企微待办或发送任何通知。',
          `SOP：${this.jobTitle(this.selectedJob)}`,
          `源文件：${sourcePath}`,
          `必须使用的精确新文件名：${target.name}`,
          '请读取源文件，严格按下面的对话要求修改。绝对禁止覆盖、移动、删除源文件。',
          `必须保持源文件格式，并且只生成 /home/node/.openclaw/workspace/output/${target.name} 这一个文件。`,
          '不得自行修改文件名，不得附加时间戳，不得生成任何辅助文件。',
          '完成后只报告实际生成的新文件，并在末尾严格输出：',
          '## 产物清单',
          '- name: 实际文件名',
          '  path: /home/node/.openclaw/workspace/output/实际文件名',
          '',
          '优化对话：',
          effectiveInstruction
        ].join('\n')
        let reply = ''
        const result = await streamChat({
          backend: AI_BACKEND_OPENCLAW,
          model: 'openclaw/default',
          conversationId: `${this.optimizerConversationId('generate')}-${Date.now()}`,
          messages: [{ role: 'user', content: prompt }],
          signal: this.artifactOptimizeController.signal,
          onDelta: text => {
            reply = String(text || '')
          }
        })
        reply = String((result && result.content) || reply).trim()
        const generated = extractDeliverablesFromReply(reply, [], [], {
          id: this.selectedJob.sopId,
          title: this.selectedJob.sopTitle,
          uid: this.selectedJob.sopUid
        }).filter(item => sourceKey(item) !== sourceKey(source))
        if (generated.length !== 1) {
          throw new Error(
            generated.length
              ? '助理生成了多个文件，请明确只保留一个优化产物后重试'
              : '助理未返回有效的优化文件，请调整要求后重试'
          )
        }
        const actualName = String(
          generated[0].name || generated[0].uri_or_path || ''
        )
          .split(/[\\/]/)
          .pop()
        if (actualName !== target.name) {
          throw new Error(
            `助理未按指定名称生成文件（应为 ${target.name}），本次未写入台账，请重试`
          )
        }
        const deliverable = {
          ...generated[0],
          id: `opt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          derived_from: sourceKey(source),
          optimization_instruction: effectiveInstruction,
          optimization_version: target.version,
          optimization_root: target.rootKey,
          output_rules: uniqueOutputRules([
            ...this.artifactOptimizeSavedRules,
            ...newOutputRules
          ]),
          createdAt: new Date().toISOString(),
          at: new Date().toISOString().slice(0, 16).replace('T', ' ')
        }
        await this.verifyGeneratedDeliverable(deliverable)
        let savedRules = { added: 0 }
        let ruleSaveError = null
        try {
          savedRules = await this.saveCurrentOutputRules(
            sopLocation,
            newOutputRules
          )
        } catch (saveError) {
          ruleSaveError = saveError
        }
        await this.persistOptimizedDeliverable(deliverable, effectiveInstruction)
        if (!ruleSaveError) {
          this.$message.success(
            savedRules.added
              ? `优化产物已生成，并保存 ${savedRules.added} 条输入规则到脑图`
              : '优化产物已生成，并追加在原产物下方'
          )
        } else {
          this.$message.warning(
            `产物已生成，但输入规则保存失败：${
              (ruleSaveError && ruleSaveError.message) || '请检查脑图编辑权限'
            }`
          )
        }
        this.artifactOptimizeVisible = false
      } catch (error) {
        if (error && error.name === 'AbortError') {
          this.artifactOptimizeError = '已停止生成，未新增产物'
        } else {
          this.artifactOptimizeError =
            (error && error.message) || '生成优化产物失败，请稍后重试'
        }
      } finally {
        this.artifactOptimizeGenerating = false
        this.artifactOptimizeController = null
      }
    },
    canPreviewDeliverable(d) {
      const uri = String((d && d.uri_or_path) || '')
      const name = String((d && d.name) || '')
      if (this.isHttp(uri)) {
        return (
          /\.(html?|pdf|md|txt|json|xlsx?)(\?|#|$)/i.test(uri) ||
          /执行单|报告/i.test(name)
        )
      }
      if (this.isLocalAbsPath(uri)) {
        return /\.(html?|pdf|md|txt|json|xlsx?)$/i.test(uri)
      }
      return /\.(html?|pdf|md|txt|json|xlsx?)$/i.test(name)
    },
    openUrl(url) {
      if (!url) return
      window.open(url, '_blank', 'noopener')
    },
    async previewDeliverable(d) {
      const url = this.deliverableOpenUrl(d, { download: false })
      if (!url) return
      this.artifactPreviewTitle = (d && d.name) || '产物预览'
      this.artifactPreviewHtml = ''
      if (/\.xlsx?$/i.test(String((d && (d.name || d.uri_or_path)) || ''))) {
        try {
          const response = await fetch(url, {
            credentials: 'include',
            cache: 'no-store'
          })
          if (!response.ok) throw new Error('读取 Excel 失败')
          const workbook = XLSX.read(await response.arrayBuffer(), {
            type: 'array'
          })
          this.artifactPreviewHtml = workbook.SheetNames.map(sheetName => {
            const title = String(sheetName)
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
            return `<section class="sheetPreview"><h3>${title}</h3>${XLSX.utils.sheet_to_html(
              workbook.Sheets[sheetName]
            )}</section>`
          }).join('')
          this.artifactPreviewDownloadUrl = this.deliverableOpenUrl(d, {
            download: true
          })
          this.artifactPreviewVisible = true
        } catch (error) {
          this.$message.error((error && error.message) || 'Excel 预览失败')
        }
        return
      }
      this.artifactPreviewUrl = url
      this.artifactPreviewDownloadUrl = this.deliverableOpenUrl(d, {
        download: true
      })
      this.artifactPreviewVisible = true
    },
    downloadDeliverable(d) {
      const url = this.deliverableOpenUrl(d, { download: true })
      if (!url) return
      this.openUrl(url)
    },
    onArtifactPreviewClosed() {
      this.artifactPreviewUrl = ''
      this.artifactPreviewHtml = ''
      this.artifactPreviewDownloadUrl = ''
    }
  }
}
</script>

<style lang="less" scoped>
.sopTaskBoard {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 420px;
  background: #fff;
  border-radius: 12px;
  overflow: hidden;
}
.boardHead {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid #eef1f4;
}
.boardTitle {
  font-size: 14px;
  font-weight: 600;
  color: #1a2332;
}
.summary {
  min-width: 20px;
  height: 20px;
  padding: 0 7px;
  border-radius: 999px;
  background: #e8f7f2;
  color: #087854;
  font-size: 12px;
  font-weight: 600;
  line-height: 20px;
  text-align: center;
}
.boardBody {
  flex: 1;
  display: grid;
  grid-template-columns: 300px 1fr;
  min-height: 0;
}
.taskList {
  list-style: none;
  margin: 0;
  padding: 10px;
  overflow: auto;
  border-right: 1px solid #eef1f4;
  background: #f7f9f8;
}
.taskItem {
  padding: 12px;
  border-radius: 10px;
  cursor: pointer;
  margin-bottom: 8px;
  border: 1px solid transparent;
  background: transparent;
  transition: background 0.15s ease, border-color 0.15s ease;
  &:hover {
    background: rgba(255, 255, 255, 0.7);
  }
  &.active {
    background: #fff;
    border-color: #d7e5df;
    box-shadow: 0 1px 2px rgba(16, 52, 40, 0.04);
  }
  &.running .taskState {
    color: #2563eb;
  }
  &.done .taskState {
    color: #16a34a;
  }
  &.partial .taskState {
    color: #d97706;
  }
  &.error .taskState,
  &.cancelled .taskState {
    color: #dc2626;
  }
  &.waiting_human .taskState,
  &.waiting_data .taskState {
    color: #d97706;
  }
}
.taskItemMain {
  display: flex;
  gap: 8px;
  align-items: center;
  min-width: 0;
}
.taskState {
  font-size: 12px;
  font-weight: 600;
  flex-shrink: 0;
}
.taskName {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: #1a2332;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.artifactMark {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 999px;
  background: #e8f7f2;
  color: #087854;
  font-size: 11px;
  font-weight: 600;
  line-height: 16px;
}
.taskMeta {
  margin-top: 6px;
  font-size: 12px;
  color: #8b95a5;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.taskItemActions {
  margin-top: 4px;
  /deep/ .el-button--text {
    padding: 0 4px 0 0;
    color: #087854;
  }
}
.taskEmpty {
  color: #9ca3af;
  padding: 32px 8px;
  text-align: center;
  font-size: 13px;
}
.taskDetail {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  padding: 14px 16px 18px;
  &.empty {
    color: #9ca3af;
    align-items: center;
    justify-content: center;
  }
}
.liveHead {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
  strong {
    font-size: 16px;
    color: #1a2332;
  }
}
.liveState {
  font-size: 12px;
  font-weight: 600;
  &.running {
    color: #2563eb;
  }
  &.done {
    color: #16a34a;
  }
  &.partial {
    color: #d97706;
  }
  &.error,
  &.cancelled {
    color: #dc2626;
  }
  &.waiting_human,
  &.waiting_data {
    color: #d97706;
  }
}
.sectionTitle {
  font-size: 13px;
  font-weight: 600;
  color: #1a2332;
  margin-bottom: 10px;
}
.nodePanel {
  flex: 0 0 auto;
  margin-bottom: 14px;
  padding: 12px 14px 10px;
  border: 1px solid #eef1f4;
  border-radius: 12px;
  background: #fbfcfc;
}
.flowScroll {
  overflow-x: auto;
  overflow-y: hidden;
  padding: 2px 0 6px;
  scrollbar-width: thin;
}
.flowRail {
  display: flex;
  align-items: stretch;
  list-style: none;
  margin: 0;
  padding: 0 4px 2px;
  min-width: min-content;
}
.flowNode {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 148px;
  flex: 0 0 148px;
  cursor: pointer;
  user-select: none;
  &.selected .flowLabel {
    color: #087854;
    font-weight: 600;
  }
}
.flowLabel {
  width: 100%;
  flex: 1 1 auto;
  min-height: 48px;
  margin-bottom: 10px;
  padding: 0 6px;
  font-size: 12px;
  line-height: 1.4;
  text-align: center;
  color: #374151;
  word-break: break-word;
  overflow-wrap: anywhere;
  white-space: normal;
}
.flowTrack {
  position: relative;
  flex: 0 0 18px;
  width: 100%;
  height: 18px;
  margin-top: auto;
  display: flex;
  align-items: center;
  justify-content: center;
}
.flowLine {
  position: absolute;
  top: 50%;
  height: 2px;
  width: 50%;
  margin-top: -1px;
  background: #d7dde5;
  &.before {
    left: 0;
  }
  &.after {
    right: 0;
  }
  &.hidden {
    visibility: hidden;
  }
  &.done {
    background: #16a34a;
  }
}
.flowNode .dot {
  position: relative;
  z-index: 1;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #d7dde5;
  box-shadow: 0 0 0 3px #fbfcfc;
}
.flowNode.done .dot,
.flowNode.active .dot {
  background: #16a34a;
}
.flowNode.active .dot {
  box-shadow: 0 0 0 3px rgba(22, 163, 74, 0.18);
}
.flowNode.waiting .dot,
.flowNode.failed .dot,
.flowNode.stopped .dot,
.flowNode.is-break .dot {
  background: #dc2626;
  box-shadow: 0 0 0 3px rgba(220, 38, 38, 0.16);
}
.flowNode.is-break .flowLabel {
  color: #b91c1c;
  font-weight: 600;
}
.execPanel {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.streamMd {
  flex: 1;
  min-height: 180px;
  overflow: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;
  &::-webkit-scrollbar {
    display: none;
    width: 0;
    height: 0;
  }
  padding: 14px 16px;
  background: #f7f8f9;
  border-radius: 12px;
  font-size: 14px;
  line-height: 1.7;
  color: #1f2937;
  word-break: break-word;
  &.empty {
    display: flex;
    align-items: center;
  }
  /deep/ p {
    margin: 0 0 0.75em;
  }
  /deep/ p:last-child {
    margin-bottom: 0;
  }
  /deep/ h1,
  /deep/ h2,
  /deep/ h3,
  /deep/ h4 {
    margin: 0.9em 0 0.4em;
    font-size: 15px;
    line-height: 1.4;
  }
  /deep/ ul,
  /deep/ ol {
    margin: 0.3em 0 0.8em;
    padding-left: 1.3em;
  }
  /deep/ pre {
    background: #fff;
    padding: 12px;
    border-radius: 10px;
    overflow: auto;
    scrollbar-width: none;
    -ms-overflow-style: none;
  }
  /deep/ pre::-webkit-scrollbar {
    display: none;
    width: 0;
    height: 0;
  }
  /deep/ code {
    font-family: Consolas, 'Courier New', monospace;
    font-size: 13px;
  }
  /deep/ a {
    color: #087854;
  }
  /deep/ .streamPlaceholder {
    margin: 0;
    color: #9ca3af;
  }
}
.artifactBlock {
  flex-shrink: 0;
  margin-top: 10px;
  padding: 12px 14px;
  background: #f3faf7;
  border: 1px solid #dceee6;
  border-radius: 12px;
}
.artifactTitle {
  font-size: 13px;
  font-weight: 600;
  color: #087854;
  margin-bottom: 8px;
}
.artifactList {
  list-style: none;
  margin: 0;
  padding: 0;
  li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 7px 0;
    border-bottom: 1px solid #e2eee8;
    &:last-child {
      border-bottom: 0;
    }
  }
}
.artifactDerivedMark {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 5px;
  border-radius: 999px;
  background: #dff4eb;
  color: #087854;
  font-size: 11px;
  line-height: 16px;
  vertical-align: 1px;
}
.artifactName {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: #1f2937;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.artifactActions {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 2px;
  /deep/ .el-button--text {
    color: #087854;
    padding: 0 4px;
  }
}
.artifactPreviewEmpty {
  padding: 40px;
  text-align: center;
  color: #9ca3af;
}
.optimizeSource {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  background: #f3faf7;
  color: #64748b;
  font-size: 13px;
  strong {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #1f2937;
  }
}
.optimizeRulesStatus {
  margin: -2px 0 12px;
  padding: 8px 10px;
  border-radius: 7px;
  background: #f8fafc;
  color: #64748b;
  font-size: 12px;
  &.loaded {
    background: #ecf8f3;
    color: #087854;
  }
}
.optimizeMessages {
  height: 300px;
  margin-bottom: 12px;
  padding: 12px;
  overflow-y: auto;
  border: 1px solid #e5e9ed;
  border-radius: 10px;
  background: #f8faf9;
}
.optimizeEmpty {
  padding: 90px 30px;
  color: #94a3b8;
  text-align: center;
  line-height: 1.7;
}
.optimizeMessage {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  margin-bottom: 14px;
  &.user {
    align-items: flex-end;
    .optimizeBubble {
      background: #087854;
      color: #fff;
    }
  }
}
.optimizeRole {
  margin-bottom: 4px;
  color: #94a3b8;
  font-size: 11px;
}
.optimizeBubble {
  max-width: 86%;
  padding: 9px 11px;
  border-radius: 10px;
  background: #fff;
  color: #334155;
  font-size: 13px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.06);
}
.optimizeComposerActions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
.optimizeHint {
  margin-right: auto;
  color: #94a3b8;
  font-size: 12px;
}
.optimizeError {
  margin-top: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  background: #fff1f0;
  color: #c2413b;
  font-size: 12px;
  line-height: 1.5;
}
.optimizeFooter {
  display: flex;
  align-items: center;
  width: 100%;
}
.optimizeFooterSpacer {
  flex: 1;
}
/deep/ .artifactOptimizeDialog {
  .el-dialog__body {
    padding: 16px 20px 8px;
  }
  .el-dialog__footer {
    padding-top: 10px;
  }
}
/deep/ .artifactPreviewDialog {
  .el-dialog__body {
    padding: 0 12px 12px;
  }
}
.artifactPreviewFrame {
  width: 100%;
  height: 62vh;
  border: 1px solid #e8ecef;
  border-radius: 8px;
  background: #fff;
}
.artifactSpreadsheetPreview {
  height: 62vh;
  overflow: auto;
  padding: 12px;
  border: 1px solid #e8ecef;
  border-radius: 8px;
  background: #fff;
  /deep/ .sheetPreview {
    margin-bottom: 24px;
  }
  /deep/ .sheetPreview h3 {
    position: sticky;
    top: -12px;
    z-index: 2;
    margin: -12px -12px 10px;
    padding: 10px 12px;
    background: #f3faf7;
    color: #087854;
    font-size: 14px;
  }
  /deep/ table {
    width: max-content;
    min-width: 100%;
    border-collapse: collapse;
    color: #1f2937;
    font-size: 12px;
  }
  /deep/ td,
  /deep/ th {
    min-width: 90px;
    padding: 7px 9px;
    border: 1px solid #dce4e0;
    white-space: nowrap;
  }
  /deep/ tr:first-child td,
  /deep/ th {
    background: #f7f9f8;
    font-weight: 600;
  }
}
.nodeDetailBody {
  padding: 0 8px 16px;
  font-size: 13px;
  line-height: 1.7;
  p {
    margin: 0 0 8px;
  }
}
.nodeEvents ul {
  margin: 6px 0 0;
  padding-left: 18px;
  color: #555;
}

@media (max-width: 900px) {
  .boardBody {
    grid-template-columns: 1fr;
  }
  .taskList {
    max-height: 220px;
    border-right: 0;
    border-bottom: 1px solid #eef1f4;
  }
  .flowNode {
    width: 132px;
    flex-basis: 132px;
  }
}
</style>
