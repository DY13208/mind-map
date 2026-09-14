<template>
  <div class="sopTaskBoard" :class="{ embedded: embedded }">
    <div class="boardHead">
      <div class="headLeft">
        <strong>{{ title }}</strong>
        <span class="summary">{{ summaryText }}</span>
      </div>
      <div class="headActions">
        <el-radio-group v-model="filter" size="mini">
          <el-radio-button label="all">全部</el-radio-button>
          <el-radio-button label="active">进行中</el-radio-button>
          <el-radio-button label="waiting">等待</el-radio-button>
          <el-radio-button label="done">结束</el-radio-button>
        </el-radio-group>
        <el-button
          size="mini"
          type="danger"
          plain
          :disabled="!activeCount"
          @click="$emit('cancel-all')"
        >
          全部取消
        </el-button>
      </div>
    </div>

    <div class="boardBody">
      <ul class="taskList">
        <li
          v-for="job in filteredJobs"
          :key="job.id"
          class="taskItem"
          :class="{ active: selectedId === job.id, [job.state]: true }"
          @click="$emit('select', job.id)"
        >
          <div class="taskItemMain">
            <span class="taskState">{{ stateLabel(job) }}</span>
            <span class="taskName"
              >{{ job.sopId || 'SOP' }}：{{ job.sopTitle }}</span
            >
          </div>
          <div class="taskMeta">
            <span>{{ job.backendLabel || backendLabel(job.backend) }}</span>
            <span>{{ shortStatus(job) }}</span>
          </div>
          <div class="taskItemActions" @click.stop>
            <el-button
              v-if="job.state === 'waiting_human'"
              type="text"
              size="mini"
              @click="$emit('resume', job.id)"
              >检查并继续</el-button
            >
            <el-button
              v-if="job.state === 'waiting_data'"
              type="text"
              size="mini"
              @click="$emit('fill-data', job.id)"
              >去补数</el-button
            >
            <el-button
              v-if="isCancellable(job)"
              type="text"
              size="mini"
              @click="$emit('cancel', job.id)"
              >取消</el-button
            >
          </div>
        </li>
        <li v-if="!filteredJobs.length" class="taskEmpty">暂无任务</li>
      </ul>

      <div class="taskDetail" v-if="selectedJob">
        <div class="liveHead">
          <strong>{{ selectedJob.sopTitle }}</strong>
          <span class="liveStatus">{{ shortStatus(selectedJob) }}</span>
        </div>

        <!-- 上：节点流 -->
        <section class="nodePanel">
          <div class="sectionTitle">
            节点流
            <span class="hint">双击节点查看详情</span>
          </div>
          <div class="flowScroll" v-if="nodeSteps.length">
            <ol class="flowRail">
              <li
                v-for="(step, index) in nodeSteps"
                :key="step.uid"
                class="flowNode"
                :class="[step.status, { selected: detailNode && detailNode.uid === step.uid }]"
                :title="step.title"
                @dblclick="openNodeDetail(step)"
              >
                <span class="flowLabel">{{ step.title }}</span>
                <span class="flowTrack">
                  <span
                    class="flowLine before"
                    :class="index === 0 ? 'hidden' : step.status"
                  ></span>
                  <span class="dot" aria-hidden="true"></span>
                  <span
                    class="flowLine after"
                    :class="index === nodeSteps.length - 1 ? 'hidden' : step.status"
                  ></span>
                </span>
              </li>
            </ol>
          </div>
          <div v-else class="nodeEmpty">暂无节点步骤（运行后根据 SOP 子树生成）</div>
        </section>

        <!-- 下：执行日志 -->
        <section class="execPanel">
          <div class="sectionTitle">执行过程</div>
          <div class="toolLine" v-if="latestToolHint">{{ latestToolHint }}</div>
          <div class="streamMd" v-html="renderedStream"></div>
        </section>
      </div>
      <div class="taskDetail empty" v-else>
        <p>选择左侧任务查看执行过程与节点流</p>
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
        <p v-if="detailNode.detail"><strong>说明</strong>：{{ detailNode.detail }}</p>
        <p v-if="detailNode.uid"><strong>uid</strong>：{{ detailNode.uid }}</p>
        <div v-if="detailNode.events && detailNode.events.length" class="nodeEvents">
          <strong>该步事件</strong>
          <ul>
            <li v-for="(ev, i) in detailNode.events" :key="i">
              {{ ev.label || JSON.stringify(ev) }}
            </li>
          </ul>
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<script>
import MarkdownIt from 'markdown-it'

const streamMd = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true
})

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
      filter: 'all',
      nodeDrawerVisible: false,
      detailNode: null
    }
  },
  computed: {
    filteredJobs() {
      const list = this.jobs || []
      if (this.filter === 'all') return list
      if (this.filter === 'active') {
        return list.filter(j => j.state === 'running' || j.state === 'queued')
      }
      if (this.filter === 'waiting') {
        return list.filter(
          j => j.state === 'waiting_human' || j.state === 'waiting_data'
        )
      }
      return list.filter(
        j =>
          j.state === 'done' ||
          j.state === 'error' ||
          j.state === 'cancelled'
      )
    },
    selectedJob() {
      return (this.jobs || []).find(j => j.id === this.selectedId) || null
    },
    nodeSteps() {
      const job = this.selectedJob
      return (job && job.nodeProgress) || []
    },
    activeCount() {
      return (this.jobs || []).filter(j =>
        ['running', 'queued', 'waiting_human', 'waiting_data'].includes(j.state)
      ).length
    },
    summaryText() {
      const n = (this.jobs || []).length
      return n ? `${n} 个任务 · 进行中 ${this.activeCount}` : '暂无任务'
    },
    latestToolHint() {
      const log = (this.selectedJob && this.selectedJob.eventLog) || []
      if (!log.length) return ''
      const last = log[log.length - 1]
      return last && last.label ? `最近：${last.label}` : ''
    },
    renderedStream() {
      const text = String(
        (this.selectedJob &&
          (this.selectedJob.streamText || this.selectedJob.progressText)) ||
          ''
      ).trim()
      if (!text) return '<p class="streamPlaceholder">（等待输出…）</p>'
      return streamMd.render(text)
    }
  },
  methods: {
    backendLabel(backend) {
      if (backend === 'xiaoce') return '小策'
      if (backend === 'openclaw') return '助理'
      return 'WorkBuddy'
    },
    stateLabel(job) {
      const map = {
        queued: '排队',
        running: '运行',
        waiting_human: '等人',
        waiting_data: '补数',
        done: '完成',
        error: '失败',
        cancelled: '停止'
      }
      return map[job.state] || job.state
    },
    shortStatus(job) {
      return String((job && (job.status || job.error)) || '').slice(0, 48)
    },
    isCancellable(job) {
      return [
        'running',
        'queued',
        'waiting_human',
        'waiting_data'
      ].includes(job.state)
    },
    stepStatusLabel(status) {
      const map = {
        pending: '未开始',
        active: '进行中',
        done: '已完成',
        waiting: '等待人工',
        skipped: '跳过',
        failed: '失败',
        stopped: '已停止'
      }
      return map[status] || status || '未开始'
    },
    openNodeDetail(step) {
      this.detailNode = step
      this.nodeDrawerVisible = true
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
}
.boardHead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-bottom: 1px solid #eee;
  flex-wrap: wrap;
}
.headLeft {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.summary {
  color: #888;
  font-size: 12px;
}
.headActions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.boardBody {
  flex: 1;
  display: grid;
  grid-template-columns: 280px 1fr;
  min-height: 0;
}
.taskList {
  list-style: none;
  margin: 0;
  padding: 8px;
  overflow: auto;
  border-right: 1px solid #eee;
  background: #fafafa;
}
.taskItem {
  padding: 10px;
  border-radius: 8px;
  cursor: pointer;
  margin-bottom: 6px;
  border: 1px solid transparent;
  &.active {
    background: #fff;
    border-color: #d0d7de;
  }
  &.running .taskState {
    color: #2563eb;
  }
  &.done .taskState {
    color: #16a34a;
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
  align-items: baseline;
}
.taskState {
  font-size: 12px;
  font-weight: 600;
  flex-shrink: 0;
}
.taskName {
  font-size: 13px;
}
.taskMeta {
  margin-top: 4px;
  font-size: 12px;
  color: #888;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.taskEmpty {
  color: #999;
  padding: 24px 8px;
  text-align: center;
  font-size: 13px;
}
.taskDetail {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  padding: 12px 14px 16px;
  &.empty {
    color: #999;
    align-items: center;
    justify-content: center;
  }
}
.liveHead {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 10px;
}
.liveStatus {
  color: #666;
  font-size: 12px;
}
.sectionTitle {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
  .hint {
    font-weight: 400;
    color: #999;
    font-size: 12px;
  }
}
.nodePanel {
  flex: 0 0 auto;
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid #eef0f2;
}
.flowScroll {
  overflow-x: auto;
  overflow-y: hidden;
  padding: 4px 2px 8px;
}
.flowRail {
  display: flex;
  align-items: flex-end;
  list-style: none;
  margin: 0;
  padding: 0 8px 4px;
  min-width: min-content;
}
.flowNode {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 108px;
  flex: 0 0 108px;
  cursor: pointer;
  user-select: none;
  &.selected .flowLabel {
    color: #1d4ed8;
    font-weight: 600;
  }
}
.flowLabel {
  height: 36px;
  margin-bottom: 8px;
  padding: 0 4px;
  font-size: 12px;
  line-height: 1.35;
  text-align: center;
  color: #374151;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.flowTrack {
  position: relative;
  width: 100%;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.flowLine {
  position: absolute;
  top: 7px;
  height: 2px;
  width: 50%;
  background: #d1d5db;
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
  &.active {
    background: #2563eb;
  }
  &.waiting {
    background: #d97706;
  }
  &.failed,
  &.stopped {
    background: #dc2626;
  }
}
.flowNode .dot {
  position: relative;
  z-index: 1;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #d1d5db;
  box-shadow: 0 0 0 3px #fff;
}
.flowNode.done .dot {
  background: #16a34a;
}
.flowNode.active .dot {
  background: #2563eb;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.18);
}
.flowNode.waiting .dot {
  background: #d97706;
}
.flowNode.failed .dot,
.flowNode.stopped .dot {
  background: #dc2626;
}
.execPanel {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.toolLine {
  font-size: 12px;
  color: #666;
  margin-bottom: 6px;
  flex-shrink: 0;
}
.streamMd {
  flex: 1;
  min-height: 280px;
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
.nodeEmpty {
  color: #999;
  font-size: 13px;
  padding: 12px 0;
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
    max-height: 200px;
    border-right: 0;
    border-bottom: 1px solid #eee;
  }
}
</style>
