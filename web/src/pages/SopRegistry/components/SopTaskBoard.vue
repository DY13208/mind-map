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

        <!-- 上：执行过程（完成/等待/停止均保留） -->
        <section class="execPanel">
          <div class="sectionTitle">执行过程</div>
          <div class="toolLine" v-if="latestToolHint">{{ latestToolHint }}</div>
          <pre class="streamText">{{
            selectedJob.streamText ||
              selectedJob.progressText ||
              '（等待输出…）'
          }}</pre>
        </section>

        <!-- 下：节点流 -->
        <section class="nodePanel">
          <div class="sectionTitle">
            节点流
            <span class="hint">双击节点查看详情</span>
          </div>
          <ul class="nodeFlow" v-if="nodeSteps.length">
            <li
              v-for="step in nodeSteps"
              :key="step.uid"
              class="nodeStep"
              :class="[step.status, { selected: detailNode && detailNode.uid === step.uid }]"
              :style="{ paddingLeft: 12 + (step.depth || 0) * 14 + 'px' }"
              @dblclick="openNodeDetail(step)"
            >
              <span class="dot" aria-hidden="true"></span>
              <span class="nodeTitle">{{ step.title }}</span>
              <span class="nodeState">{{ stepStatusLabel(step.status) }}</span>
            </li>
          </ul>
          <div v-else class="nodeEmpty">暂无节点步骤（运行后根据 SOP 子树生成）</div>
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
  overflow: auto;
  padding: 12px 14px 20px;
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
.execPanel {
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid #f0f0f0;
}
.toolLine {
  font-size: 12px;
  color: #666;
  margin-bottom: 6px;
}
.streamText {
  margin: 0;
  max-height: 240px;
  overflow: auto;
  padding: 10px 12px;
  background: #f6f7f8;
  border-radius: 10px;
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.nodeFlow {
  list-style: none;
  margin: 0;
  padding: 0;
}
.nodeStep {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
  user-select: none;
  &:hover {
    background: #f5f5f5;
  }
  &.selected {
    background: #eef2ff;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #d1d5db;
    flex-shrink: 0;
  }
  &.active .dot {
    background: #2563eb;
    box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.2);
  }
  &.done .dot {
    background: #16a34a;
  }
  &.waiting .dot {
    background: #d97706;
  }
  &.failed .dot,
  &.stopped .dot {
    background: #dc2626;
  }
  .nodeTitle {
    flex: 1;
    font-size: 13px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .nodeState {
    font-size: 12px;
    color: #888;
    flex-shrink: 0;
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
