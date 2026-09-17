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
              >
                <span class="artifactName" :title="d.name">{{ d.name }}</span>
                <span class="artifactActions">
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
import { extractDeliverablesFromReply } from '@/utils/sopRun'
import { artifactLocalUrl } from '@/utils/fileApi'

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

export default {
  name: 'SopTaskBoard',
  props: {
    jobs: { type: Array, default: () => [] },
    selectedId: { type: String, default: '' },
    embedded: { type: Boolean, default: false },
    title: { type: String, default: 'SOP 任务' }
  },
  data() {
    return {
      nodeDrawerVisible: false,
      detailNode: null,
      artifactPreviewVisible: false,
      artifactPreviewTitle: '产物预览',
      artifactPreviewUrl: '',
      artifactPreviewDownloadUrl: ''
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
      return this.deliverablesForJob(this.selectedJob)
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
          at: item.at || ''
        })
      }
      const runDels =
        (job.result && job.result.deliverables) || job.deliverables || []
      runDels.forEach(push)
      extractDeliverablesFromReply(streamTextOf(job), [], [], {
        id: job.sopId,
        title: job.sopTitle,
        uid: job.sopUid,
        sopId: job.sopId,
        sopTitle: job.sopTitle,
        sopUid: job.sopUid
      }).forEach(push)
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
        /\.(html?|xlsx?|docx?|pdf|md|csv)$/i.test(name || uri)
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
        /\.(html?|xlsx?|docx?|pdf|md|csv)$/i.test(name || uri)
      )
    },
    canPreviewDeliverable(d) {
      const uri = String((d && d.uri_or_path) || '')
      const name = String((d && d.name) || '')
      if (this.isHttp(uri)) {
        return (
          /\.(html?|pdf|md|txt)(\?|#|$)/i.test(uri) || /执行单|报告/i.test(name)
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
      if (!url) return
      this.artifactPreviewTitle = (d && d.name) || '产物预览'
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
