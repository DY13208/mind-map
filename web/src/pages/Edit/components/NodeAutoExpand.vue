<template>
  <div
    v-if="jobs.length"
    class="flow-expand-status"
    :class="{ isDark: isDark }"
  >
    <div class="panel-head">
      <span class="title">{{ $t('flowExpand.panelTitle') }}</span>
      <span class="summary">
        {{
          $t('flowExpand.summary', {
            running: runningCount,
            queued: queuedCount,
            concurrency
          })
        }}
      </span>
    </div>
    <div
      v-for="job in jobs"
      :key="job.id"
      class="job-row"
      :class="job.state"
      @click="focusJob(job)"
    >
      <span class="dot" aria-hidden="true"></span>
      <span class="badge" :class="job.state">
        {{ stateLabel(job) }}
      </span>
      <span class="label">{{ job.nodeLabel }}</span>
      <span class="meta">{{ job.status }}</span>
      <button
        v-if="job.state === 'queued'"
        type="button"
        class="cancel-btn"
        @click.stop="cancelJob(job.id)"
      >
        {{ $t('flowExpand.cancelQueue') }}
      </button>
    </div>
  </div>
</template>

<script>
import { mapState } from 'vuex'
import { createFlowExpandQueue } from '@/utils/flowExpandQueue'
import {
  syncFlowExpandVisuals,
  clearAllFlowExpandVisuals,
  focusFlowExpandNode
} from '@/utils/flowExpandVisual'

export default {
  name: 'NodeAutoExpand',
  props: {
    mindMap: {
      type: Object,
      default: null
    }
  },
  data() {
    return {
      jobs: [],
      queuedCount: 0,
      runningCount: 0,
      concurrency: 2,
      queue: null
    }
  },
  computed: {
    ...mapState({
      isDark: state => state.localConfig.isDark,
      localConfig: state => state.localConfig
    })
  },
  created() {
    this.queue = createFlowExpandQueue({
      getConcurrency: () => this.localConfig.flowExpandConcurrency,
      onChange: snapshot => {
        this.jobs = [...snapshot.running, ...snapshot.pending]
        this.queuedCount = snapshot.queuedCount
        this.runningCount = snapshot.runningCount
        this.concurrency = snapshot.concurrency
        syncFlowExpandVisuals(this.mindMap, this.jobs)
        this.$bus.$emit('node_flow_expand_queue', {
          running: snapshot.runningCount,
          queued: snapshot.queuedCount,
          total: snapshot.total
        })
      }
    })
    this.$bus.$on('node_flow_expand', this.onFlowExpandRequest)
  },
  beforeDestroy() {
    this.$bus.$off('node_flow_expand', this.onFlowExpandRequest)
    if (this.queue) this.queue.cancelAll()
    clearAllFlowExpandVisuals(this.mindMap)
    this.$bus.$emit('node_flow_expand_queue', {
      running: 0,
      queued: 0,
      total: 0
    })
  },
  methods: {
    stateLabel(job) {
      if (!job) return ''
      if (job.state === 'done') return this.$t('flowExpand.done')
      if (job.state === 'running') {
        return this.$t('flowExpand.runningSlot', {
          slot: job.slotIndex || 1
        })
      }
      return this.$t('flowExpand.queuedSlot', {
        index: job.queueIndex || 1
      })
    },

    focusJob(job) {
      if (!job || !job.nodeUid) return
      focusFlowExpandNode(this.mindMap, job.nodeUid)
    },

    onFlowExpandRequest(node) {
      const target =
        node ||
        (this.mindMap.renderer &&
          this.mindMap.renderer.activeNodeList &&
          this.mindMap.renderer.activeNodeList[0]) ||
        null
      const result = this.queue.enqueue({
        mindMap: this.mindMap,
        node: target,
        onStart: job => {
          focusFlowExpandNode(this.mindMap, job.nodeUid)
        },
        onSuccess: res => {
          if (this.$message) {
            this.$message.success(
              `「${res.nodeLabel}」已实例化，代办人：${res.assigneeName}`
            )
          }
        },
        onError: (_err, msg) => {
          if (this.$message) this.$message.error(msg)
        }
      })
      if (!result.ok && this.$message) {
        this.$message.warning(result.message)
      } else if (
        result.ok &&
        result.job &&
        result.job.state === 'queued' &&
        this.runningCount >= this.concurrency
      ) {
        if (this.$message) {
          this.$message.info(this.$t('flowExpand.enqueued'))
        }
      }
    },

    cancelJob(jobId) {
      this.queue.cancel(jobId)
    }
  }
}
</script>

<style lang="less" scoped>
.flow-expand-status {
  position: fixed;
  top: 72px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 5000;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: min(560px, calc(100vw - 32px));
  padding: 10px 14px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.98);
  color: #333;
  font-size: 13px;
  line-height: 1.4;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.12);
  border: 1px solid rgba(18, 104, 255, 0.2);
  pointer-events: auto;

  &.isDark {
    background: rgba(40, 40, 40, 0.98);
    color: #ddd;
    border-color: rgba(126, 176, 255, 0.25);
  }

  .panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding-bottom: 4px;
    border-bottom: 1px solid rgba(18, 104, 255, 0.12);
    margin-bottom: 2px;
  }

  .title {
    font-weight: 600;
    color: #1268ff;
  }

  .summary {
    font-size: 12px;
    color: #909399;
    white-space: nowrap;
  }

  .job-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    padding: 4px 2px;
    border-radius: 6px;
    cursor: pointer;

    &:hover {
      background: rgba(18, 104, 255, 0.06);
    }

    &.queued .dot {
      background: #e6a23c;
      animation: none;
    }

    &.done .dot {
      background: #67c23a;
      animation: none;
    }

    &.error .dot {
      background: #f56c6c;
      animation: none;
    }
  }

  .badge {
    flex-shrink: 0;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 11px;
    line-height: 18px;
    font-weight: 600;

    &.running {
      background: rgba(18, 104, 255, 0.12);
      color: #1268ff;
    }

    &.queued {
      background: rgba(230, 162, 60, 0.15);
      color: #c77d00;
    }

    &.done {
      background: rgba(103, 194, 58, 0.15);
      color: #67c23a;
    }
  }

  .label {
    flex: 0 1 38%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
  }

  .meta {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #666;
    font-size: 12px;
  }

  .cancel-btn {
    flex-shrink: 0;
    border: none;
    background: transparent;
    color: #1268ff;
    cursor: pointer;
    font-size: 12px;
    padding: 0;
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #1268ff;
    animation: pulse 1s ease-in-out infinite;
    flex-shrink: 0;
  }
}

.flow-expand-status.isDark {
  .summary {
    color: #aaa;
  }

  .meta {
    color: #aaa;
  }

  .cancel-btn {
    color: #7eb0ff;
  }

  .job-row:hover {
    background: rgba(126, 176, 255, 0.08);
  }
}

@keyframes pulse {
  0%,
  100% {
    opacity: 0.35;
    transform: scale(0.85);
  }
  50% {
    opacity: 1;
    transform: scale(1);
  }
}
</style>
