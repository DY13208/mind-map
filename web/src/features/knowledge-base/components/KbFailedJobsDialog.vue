<template>
  <el-dialog :visible="visible" title="处理失败的文件" width="640px" append-to-body custom-class="kb-failed-dialog" @close="$emit('close')">
    <p class="kb-failed-lead">
      以下文件的解析或结构化没有完成。可以重新解析；确认不需要处理的可以忽略，忽略后不再提示，文件本身不受影响。
    </p>
    <ul v-if="items.length" class="kb-failed-list">
      <li v-for="job in items" :key="job.id" class="kb-failed-item">
        <div class="kb-failed-head">
          <i class="el-icon-document kb-failed-file-icon" aria-hidden="true" />
          <button type="button" class="kb-failed-name" :title="job.fileName" @click="$emit('open-file', job)">{{ job.fileName }}</button>
          <span class="kb-failed-actions">
            <template v-if="job.canRetry">
              <el-button size="mini" type="primary" plain :loading="busy[job.id] === 'retry'" :disabled="!!busy[job.id]" @click="retry(job)">重新解析</el-button>
              <el-button size="mini" :loading="busy[job.id] === 'dismiss'" :disabled="!!busy[job.id]" @click="dismiss(job)">忽略</el-button>
            </template>
            <span v-else class="kb-failed-readonly">只读，需编辑权限处理</span>
          </span>
        </div>
        <div class="kb-failed-meta">
          <span>{{ stageLabel(job.kind) }}失败</span>
          <span>已尝试 {{ job.attempts }}/{{ job.maxAttempts }} 次</span>
          <span>{{ formatTime(job.failedAt) }}</span>
        </div>
        <p class="kb-failed-reason">{{ reason(job) }}</p>
        <details v-if="job.lastError" class="kb-failed-raw">
          <summary>错误详情</summary>
          <code>{{ job.lastError }}</code>
        </details>
      </li>
    </ul>
    <div v-else class="kb-failed-empty">
      <i class="el-icon-circle-check" aria-hidden="true" />没有需要处理的失败任务
    </div>
    <p v-if="total > items.length" class="kb-failed-more">仅显示最近 {{ items.length }} 条，共 {{ total }} 条</p>
    <span slot="footer">
      <el-button size="small" @click="$emit('close')">关闭</el-button>
      <el-button v-if="retryable.length > 1" size="small" type="primary" :loading="bulk" @click="retryAll">全部重新解析（{{ retryable.length }}）</el-button>
    </span>
  </el-dialog>
</template>
<script>
import kbApi from '../services/kbApi'
import { describeJobError } from '../services/kbErrors'
import { formatTime } from '../utils/format'
export default {
  name: 'KbFailedJobsDialog',
  props: {
    visible: { type: Boolean, default: false },
    items: { type: Array, default: () => [] },
    total: { type: Number, default: 0 }
  },
  data: () => ({ busy: {}, bulk: false }),
  computed: {
    retryable() { return this.items.filter(j => j.canRetry) }
  },
  methods: {
    formatTime,
    stageLabel(kind) { return kind === 'structure' ? '结构化' : '解析' },
    reason(job) { return describeJobError(job.lastError) },
    async run(job, action) {
      this.$set(this.busy, job.id, action)
      try {
        if (action === 'retry') await kbApi.reparseFile(job.fileId)
        else await kbApi.dismissJob(job.id)
        return true
      } catch (e) {
        // 已在重新解析中：等同于成功，列表刷新后会消失
        if (action === 'retry' && e.code === 'job_in_progress') return true
        this.$message.error(`「${job.fileName}」${e.message}`)
        return false
      } finally {
        this.$delete(this.busy, job.id)
      }
    },
    async retry(job) {
      if (await this.run(job, 'retry')) {
        this.$message.success(`已重新提交「${job.fileName}」，解析完成后状态会自动更新`)
        this.$emit('changed')
      }
    },
    async dismiss(job) {
      if (await this.run(job, 'dismiss')) {
        this.$message.success(`已忽略「${job.fileName}」`)
        this.$emit('changed')
      }
    },
    async retryAll() {
      this.bulk = true
      try {
        const jobs = this.retryable.slice()
        const results = await Promise.all(jobs.map(j => this.run(j, 'retry')))
        const ok = results.filter(Boolean).length
        if (ok) this.$message.success(`已重新提交 ${ok} 个文件`)
        this.$emit('changed')
      } finally {
        this.bulk = false
      }
    }
  }
}
</script>
<style lang="less">
/* 对话框挂载在 body 下，scoped 样式无法作用于 el-dialog 外壳 */
.kb-failed-dialog {
  border-radius: var(--ui-radius-lg, 12px);
  .el-dialog__body { padding: 4px 20px 8px; color: var(--ui-text); }
}
.kb-failed-lead {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--ui-text-secondary);
}
.kb-failed-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 56vh;
  overflow-y: auto;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-md, 8px);
}
.kb-failed-item {
  padding: 12px 14px;
  & + & { border-top: 1px solid var(--ui-border); }
}
.kb-failed-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.kb-failed-file-icon { color: var(--ui-danger); font-size: 16px; }
.kb-failed-name {
  flex: 1;
  min-width: 0;
  padding: 0;
  border: 0;
  background: none;
  text-align: left;
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  color: var(--ui-text);
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  &:hover, &:focus-visible { color: var(--ui-primary); text-decoration: underline; }
}
.kb-failed-actions { display: flex; flex-shrink: 0; gap: 6px; .el-button + .el-button { margin-left: 0; } }
.kb-failed-readonly { font-size: 12px; color: var(--ui-text-muted); }
.kb-failed-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin: 6px 0 0 24px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.kb-failed-reason {
  margin: 6px 0 0 24px;
  font-size: 13px;
  color: var(--ui-text);
}
.kb-failed-raw {
  margin: 6px 0 0 24px;
  font-size: 12px;
  summary { cursor: pointer; color: var(--ui-text-secondary); }
  code {
    display: block;
    margin-top: 6px;
    padding: 8px 10px;
    border-radius: 6px;
    background: var(--ui-surface-muted);
    color: var(--ui-text-secondary);
    font-family: ui-monospace, Consolas, monospace;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
  }
}
.kb-failed-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 32px 0;
  color: var(--ui-text-secondary);
  i { color: var(--ui-primary); font-size: 18px; }
}
.kb-failed-more { margin: 8px 0 0; font-size: 12px; color: var(--ui-text-muted); }
</style>
