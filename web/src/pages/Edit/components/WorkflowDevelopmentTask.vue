<template>
  <el-dialog
    title="开发任务"
    :visible.sync="visible"
    width="min(480px, 92vw)"
    append-to-body
    @close="cancel"
  >
    <div aria-live="polite">
      <p v-if="busy">{{ busyLabel }}</p>
      <p v-if="error" role="alert">{{ error }}</p>
      <template v-if="task">
        <p><strong>{{ statuses[task.status] }}</strong> {{ runningDetail }}</p>
        <p v-if="task.status === 'developing' && progressUpdatedAt" class="task-progress-time">
          最后更新 {{ formatProgressTime(progressUpdatedAt) }}
        </p>
        <p v-if="task.failure">{{ task.failure }}</p>
        <ul v-if="task.missing.length">
          <li v-for="field in task.missing" :key="field">{{ field }}</li>
        </ul>
        <p v-if="draftApplied">草稿已写回。请重新生成开发任务，使用更新后的规则。</p>
        <p v-else-if="task.status === 'needs_input' && !draft">请补充规则后再次生成开发任务。</p>
        <p>规则版本 <code :title="task.version">{{ task.version.slice(0, 12) }}</code></p>
        <a v-if="pullRequest" :href="pullRequest" target="_blank" rel="noopener noreferrer">打开 PR</a>
        <p v-if="mergeLabel"><strong>{{ mergeLabel }}</strong></p>
        <ul v-if="task.merge_review && task.merge_review.findings">
          <li v-for="(finding, index) in task.merge_review.findings" :key="index">{{ finding }}</li>
        </ul>
        <p v-if="deploymentLabel">
          <strong>{{ deploymentLabel }}</strong>
          <code v-if="task.deployment.commit">{{ task.deployment.commit.slice(0, 7) }}</code>
        </p>
        <a v-if="previewUrl" :href="previewUrl" target="_blank" rel="noopener noreferrer">打开本机预览 API</a>
        <details v-if="recentProgress.length" class="task-progress" open>
          <summary>执行记录</summary>
          <ol>
            <li v-for="(entry, index) in recentProgress" :key="entry.at + '-' + index">
              <time :datetime="entry.at">{{ formatProgressTime(entry.at) }}</time>
              <span>{{ progressLabel(entry) }}</span>
            </li>
          </ol>
        </details>
      </template>
      <p v-else-if="!busy && !error">这个节点暂无开发任务。</p>
    </div>
    <div v-if="draft && draft.fields.length">
      <p>请核对并编辑草稿，确认后写回当前节点。</p>
      <el-form label-position="top">
        <el-form-item v-for="entry in draft.fields" :key="entry.field">
          <template slot="label">
            {{ entry.field }} · {{ entry.review ? '待确认' : '根据原文整理' }}
          </template>
          <el-input
            v-model="entry.text"
            :aria-label="entry.field"
            type="textarea"
            :autosize="{ minRows: 2, maxRows: 4 }"
            :maxlength="500"
            :disabled="busy"
            placeholder="请填写实际规则"
          />
        </el-form-item>
      </el-form>
    </div>
    <template slot="footer">
      <el-button
        v-if="canGenerateDraft"
        :disabled="busy"
        data-testid="generate-workflow-supplement"
        @click="request('draft')"
      >生成补充草稿</el-button>
      <el-button
        v-if="draft && draft.fields.length && !$store.state.isReadonly"
        :disabled="busy || !draftReady"
        type="primary"
        @click="request('apply')"
      >确认写回</el-button>
      <el-button
        v-if="canMerge"
        :disabled="busy"
        type="primary"
        @click="request('merge')"
      >{{ task.merge_review ? '重新审查并合入' : 'AI 审查并合入' }}</el-button>
      <el-button
        v-if="task && (task.status === 'failed' || deploymentRetry) && !$store.state.isReadonly"
        :disabled="busy"
        type="primary"
        @click="request('retry')"
      >{{ deploymentRetry ? (task.deployment.state === 'closed' ? '重新生成任务' : '重试部署') : '重试' }}</el-button>
      <el-button :disabled="busy" @click="request()">刷新</el-button>
    </template>
  </el-dialog>
</template>

<script>
import { productRequest } from '@/services/productHttp'
import { roomFromLocation } from '@/utils/roomLocation'
import { htmlEscape } from 'simple-mind-map/src/utils'

const endpoint = '/api/workflow-development-tasks'
const ruleFields = ['适用范围', '数据来源', '缺数据处理']
const deploymentStates = {
  preview_building: '正在构建和验证预览',
  preview_ready: '预览已就绪，等待 PR 合入',
  preview_failed: '预览启动或检查失败',
  deploying: '正在更新 HRMS',
  rolling_back: '正在回滚 HRMS',
  deployed: '已部署到 HRMS',
  closed: 'PR 已关闭，预览已停止',
  superseded: '主分支已更新，已跳过此提交',
  deploy_failed: '部署检查失败',
  rolled_back: '部署失败，已恢复上一版',
  rollback_failed: '回滚检查失败，请查看 Worker 日志'
}
const mergeStates = {
  reviewing: 'AI 正在审查并验证测试',
  revising: 'AI 正在按评审意见修正',
  verified: 'AI 审查和测试通过',
  blocked: '审查阻止合入',
  failed: '审查或合入失败',
  waiting_checks: '等待 GitHub 检查或分支要求',
  checks_failed: 'GitHub 检查未通过',
  changed: '提交已更新，等待重新审查',
  merging: '正在合入',
  merged: 'PR 已合入'
}

export default {
  props: { mindMap: { type: Object, required: true } },
  data() {
    return {
      visible: false, busy: false, busyLabel: '', error: '', task: null,
      draft: null, draftApplied: false,
      statuses: {
        queued: '排队中', developing: '开发中', needs_input: '待补充',
        failed: '失败', pr_created: 'PR 已创建'
      },
      stages: {
        checkout: '正在读取仓库', agent: '正在准备开发 Agent',
        test: '正在运行测试', push: '正在推送分支', pr: '正在创建草稿 PR'
      }
    }
  },
  computed: {
    mergeLabel() {
      if (!this.task || this.task.status !== 'pr_created') return ''
      if (this.task.deployment?.state === 'deployed') return 'PR 已合入'
      const state = this.task.merge_review?.state
      if (state) return mergeStates[state]
      if (this.task.merge_requested_at || this.task.merge_auto) return '等待预览就绪后审查并合入'
      return ''
    },
    canMerge() {
      if (!this.task?.merge_available || !this.pullRequest || this.$store.state.isReadonly) return false
      if (this.task.deployment && !['preview_building', 'preview_ready', 'preview_failed'].includes(this.task.deployment.state)) return false
      if (this.task.merge_review) return ['blocked', 'failed', 'checks_failed'].includes(this.task.merge_review.state)
      return !this.task.merge_requested_at && !this.task.merge_auto
    },
    deploymentLabel() {
      return deploymentStates[this.task?.deployment?.state]
    },
    deploymentRetry() {
      return ['preview_failed', 'deploy_failed', 'rolled_back', 'closed'].includes(this.task?.deployment?.state)
    },
    previewUrl() {
      const url = this.task?.deployment?.previewUrl
      return this.task?.deployment?.state === 'preview_ready' && /^http:\/\/127\.0\.0\.1:\d{1,5}\/docs$/.test(url) ? url : ''
    },
    recentProgress() {
      return Array.isArray(this.task?.progress) ? this.task.progress.slice(-6) : []
    },
    progressUpdatedAt() {
      const last = this.recentProgress[this.recentProgress.length - 1]
      if (this.task?.stage === 'agent' && last) return last.at
      return this.task?.updated_at
    },
    runningDetail() {
      if (this.task?.status !== 'developing') return ''
      const last = this.recentProgress[this.recentProgress.length - 1]
      const label = this.task.stage === 'agent' && last ? this.progressLabel(last) : this.stages[this.task.stage]
      const seconds = Math.floor((Date.now() - Date.parse(this.progressUpdatedAt)) / 1000)
      return seconds > 0 ? label + ' · ' + this.elapsed(seconds) : label
    },
    draftReady() {
      return this.draft && this.draft.fields.length > 0 && this.draft.fields.every(({ text }) => {
        const value = text.trim()
        return /[\p{L}\p{N}]/u.test(value) && !/^(待补充|待确认|待定|未知|TODO|TBD)[。！.!？?]?$/i.test(value)
      })
    },
    canGenerateDraft() {
      return this.task && this.task.status === 'needs_input' && !this.draftApplied &&
        !this.$store.state.isReadonly && this.task.missing.some(field => ruleFields.includes(field))
    },
    pullRequest() {
      const url = this.task && this.task.pr_url
      return url && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(url) ? url : ''
    }
  },
  created() {
    this.$bus.$on('openWorkflowDevelopmentTask', this.open)
  },
  beforeDestroy() {
    this.$bus.$off('openWorkflowDevelopmentTask', this.open)
    this.cancel()
  },
  methods: {
    elapsed(seconds) {
      return seconds < 60 ? seconds + ' 秒' : Math.floor(seconds / 60) + ' 分 ' + seconds % 60 + ' 秒'
    },
    formatProgressTime(value) {
      return new Date(value).toLocaleTimeString('zh-CN', { hour12: false })
    },
    progressLabel(entry) {
      const round = '第 ' + entry.round + ' 轮'
      switch (entry.event) {
        case 'model_wait': return round + '，等待模型响应'
        case 'search_done': return round + '，代码搜索命中 ' + entry.count + ' 处'
        case 'context_read': return round + '，读取了 ' + entry.count + ' 个代码片段'
        case 'patch_check': return round + '，正在校验补丁'
        case 'patch_retry': return round + '，补丁未通过校验，准备重新生成'
        case 'response_retry': return round + '，响应格式无效，准备重试'
        case 'model_retry': return round + '，模型请求暂时失败，准备重试'
        case 'patch_applied': return '补丁校验通过，修改了 ' + entry.count + ' 个文件'
        case 'test_passed': return '测试通过，耗时 ' + this.elapsed(Math.ceil(entry.durationMs / 1000))
        default: return '任务进度已更新'
      }
    },
    open({ roomId, nodeId, create }) {
      this.cancel()
      this.source = { roomId, nodeId }
      this.task = null
      this.draft = null
      this.draftApplied = false
      this.visible = true
      this.request(create ? 'create' : '')
    },
    cancel() {
      clearTimeout(this.poll)
      if (this.pending) this.pending.abort()
      this.pending = null
      this.busy = false
    },
    async flushRule(signal) {
      const cooperate = this.mindMap.cooperate
      if (cooperate && typeof cooperate.flushPendingForReload === 'function') {
        const result = await cooperate.flushPendingForReload({ timeoutMs: 4000 })
        if (result && (!result.ok || result.timeout)) throw new Error('规则尚未同步，请保存后重试')
      }
      const adapter = cooperate && cooperate.collabV2Adapter
      if (!adapter || signal.aborted) return
      adapter.retryPending().catch(() => {})
      const deadline = Date.now() + 4000
      while (!signal.aborted) {
        const state = adapter.getStatus()
        if (!state.pendingCount && !state.outboxPending && !state.outboxSending) return
        if (Date.now() >= deadline || state.currentError) throw new Error('规则尚未保存到服务端，请稍后重试')
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    },
    draftTarget() {
      if (this.$store.state.isReadonly || roomFromLocation(this.$route) !== this.source.roomId) {
        throw new Error('请在规则所在脑图的编辑模式下写回')
      }
      const renderer = this.mindMap.renderer
      const node = renderer && renderer.findNodeByUid(this.source.nodeId)
      if (!node) throw new Error('规则节点已不可用，请重新打开')
      return node
    },
    async writeDraft(signal) {
      const node = this.draftTarget()
      const rich = this.mindMap.renderer.hasRichTextPlugin()
      const { version, fields } = this.draft
      const children = fields.map(entry => {
        const text = entry.field + '：' + entry.text.trim()
        return {
          data: {
            uid: 'workflow-supplement-' + version.slice(0, 24) + '-' + ruleFields.indexOf(entry.field),
            text: rich ? '<p>' + htmlEscape(text).replace(/\n/g, '<br>') + '</p>' : text,
            inserting: true
          },
          children: []
        }
      })
      this.mindMap.execCommand('INSERT_MULTI_CHILD_NODE', [node], children)
      this.draft = null
      await this.flushRule(signal)
      if (signal.aborted) return
      const { item } = await productRequest(endpoint + '/draft', {
        method: 'POST', body: JSON.stringify(this.source), signal
      })
      if (signal.aborted) return
      if (item.fields.some(entry => fields.some(saved => saved.field === entry.field))) {
        throw new Error('部分字段尚未保存到服务端，请刷新脑图后核对')
      }
      this.draftApplied = true
    },
    async request(action = '') {
      this.cancel()
      const pending = new AbortController()
      this.pending = pending
      this.error = ''
      this.busy = !!action || !this.task
      this.busyLabel = action === 'draft' ? '正在生成补充草稿…'
        : action === 'apply' ? '正在写回脑图…'
          : action === 'merge' ? '正在发起 AI 审查…'
            : action === 'retry' ? '正在重新生成任务…' : '正在读取开发任务…'
      try {
        const draftAction = action === 'draft' || action === 'apply'
        if (action === 'apply') {
          if (!this.draftReady) return
          const target = this.draftTarget()
          const cooperate = this.mindMap.cooperate
          if (cooperate && typeof cooperate.ensurePlacementParent === 'function') {
            await cooperate.ensurePlacementParent(target)
          }
        }
        if (action === 'create' || draftAction) await this.flushRule(pending.signal)
        if (pending.signal.aborted) return
        const payload = { ...this.source }
        if (this.task && action !== 'create' && !draftAction) payload.taskId = this.task.id
        if (action === 'apply') payload.version = this.draft.version
        const result = await productRequest(
          draftAction ? endpoint + '/draft'
            : action === 'retry' || action === 'merge' ? endpoint + '/' + action
              : action ? endpoint : endpoint + '?' + new URLSearchParams(payload),
          {
            method: action ? 'POST' : 'GET',
            body: action ? JSON.stringify(payload) : undefined,
            signal: pending.signal
          }
        )
        if (pending.signal.aborted) return
        if (action === 'apply') {
          await this.writeDraft(pending.signal)
        } else if (action === 'draft') {
          this.draft = result.item
          if (!this.draft.fields.length) this.error = '当前规则字段已齐全，请重新生成开发任务'
        } else {
          this.task = result.item
        }
      } catch (error) {
        if (!pending.signal.aborted) this.error = error.message || '无法读取开发任务'
      } finally {
        if (!pending.signal.aborted) {
          this.busy = false
          if (this.task && (['queued', 'developing'].includes(this.task.status) ||
            this.task.status === 'pr_created' && (!this.task.deployment ||
              ['preview_building', 'preview_ready', 'preview_failed', 'deploying', 'rolling_back'].includes(this.task.deployment.state)))) {
            this.poll = setTimeout(() => this.request(), this.task.status === 'pr_created' ? 8000 : 3000)
          }
        }
      }
    }
  }
}
</script>

<style scoped>
.task-progress-time {
  color: #606266;
  font-size: 12px;
}
.task-progress {
  margin-top: 12px;
}
.task-progress summary {
  cursor: pointer;
}
.task-progress ol {
  padding-left: 0;
  list-style: none;
}
.task-progress li {
  display: flex;
  gap: 8px;
  margin: 4px 0;
}
.task-progress time {
  flex-shrink: 0;
  color: #606266;
  font-variant-numeric: tabular-nums;
}
</style>
