<template>
  <el-dialog :title="conflictResult && conflictResult.conflictKind === 'multiple_records' ? '找到多条报告记录，请选择本次补齐内容' : '资料存在冲突，请选择本次补齐内容'" :visible.sync="conflictVisible" width="680px" append-to-body :close-on-click-modal="false" @close="cancelConflict">
    <p>可选择一项或多项，每个不同值分别新增子节点。选择只作用于本次补齐，不覆盖已有内容或修改源文件。</p>
    <div v-for="candidate in conflictResult && conflictResult.conflictCandidates || []" :key="candidate.id" class="conflict-candidate">
      <el-checkbox v-model="selectedIds" :label="candidate.id">{{ candidate.text }}</el-checkbox>
      <div v-for="(source,index) in candidate.sources" :key="index" class="conflict-source">
        <div>{{ source.file }} · {{ source.page ? '第'+source.page+'页' : '页码缺失' }} · {{ source.date || '日期未确认' }}</div>
        <div v-for="(related,i) in source.related" :key="i">{{ related.field }}：{{ related.text }}</div>
        <details><summary>查看原文</summary><pre>{{ source.quote }}</pre></details>
      </div>
    </div>
    <span slot="footer"><el-button @click="conflictVisible=false">取消</el-button><el-button type="primary" :loading="selecting" :disabled="selecting || !selectionIds.length" @click="writeSelected">写入所选内容</el-button></span>
  </el-dialog>
</template>
<script>
import { mapState } from 'vuex'
import { runFlowExpandJob } from '@/utils/flowExpandRunner'
import { createFlowExpandQueue } from '@/utils/flowExpandQueue'
import {
  syncFlowExpandVisuals,
  clearAllFlowExpandVisuals
} from '@/utils/flowExpandVisual'
export default {
  name: 'NodeAutoExpand',
  props: { mindMap: { type: Object, default: null } },
  data() {
    return { queue: null, reported: new Set(), conflictVisible:false, conflictResult:null, conflictNode:null, selectedId:'', selectedIds:[], selecting:false, selectionController:null }
  },
  computed: { ...mapState({ localConfig: state => state.localConfig }), selectionIds() { return this.selectedIds } },
  created() {
    this.queue = createFlowExpandQueue({
      getConcurrency: () => this.localConfig.flowExpandConcurrency,
      onChange: snapshot => {
        syncFlowExpandVisuals(this.mindMap, [
          ...snapshot.running,
          ...snapshot.preview,
          ...snapshot.pending
        ])
        this.$bus.$emit('node_flow_expand_queue', {
          running: snapshot.runningCount,
          queued: snapshot.queuedCount,
          total: snapshot.runningCount + snapshot.queuedCount
        })
        for (const job of snapshot.preview) {
          if (
            job.totalWritten &&
            job.result.reason === 'conflict' &&
            !this.reported.has(job.id)
          ) {
            this.reported.add(job.id)
            this.$message?.warning(
              '补齐后发现其他资料存在冲突，请核对；已有内容未自动修改'
            )
          }
        }
      }
    })
    this.$bus.$on('node_flow_expand', this.onRequest)
  },
  beforeDestroy() {
    this.$bus.$off('node_flow_expand', this.onRequest)
    this.selectionController?.abort()
    this.queue?.cancelAll()
    clearAllFlowExpandVisuals(this.mindMap)
    this.$bus.$emit('node_flow_expand_queue', {
      running: 0,
      queued: 0,
      total: 0
    })
  },
  methods: {
    showConflict(result, node) {
      if (this.selecting) return
      this.conflictResult = result; this.conflictNode = node; this.selectedId = ''; this.selectedIds = []; this.conflictVisible = true
    },
    cancelConflict() { this.selectionController?.abort(); this.selectionController = null },
    async writeSelected() {
      const result = this.conflictResult, node = this.conflictNode
      const controller = new AbortController(); this.selectionController = controller; this.selecting = true
      try {
        const written = await runFlowExpandJob({ mindMap:this.mindMap, node, signal:controller.signal, localMode:'commit', localOnly:!!result.localContext, revision:result.revision, expectedContext:result.localContext, conflictSelection:{ ...result.selectionContext, ids:[...this.selectionIds] } })
        if (controller.signal.aborted) return
        if (written.reason === 'conflict' && written.conflictCandidates?.length) { this.selecting=false; this.showConflict(written,node); this.$message?.warning('候选资料已变化，请重新选择'); return }
        if (written.reason === 'local_revision_changed') { this.$message?.warning('资料已更新，请重新点击补齐'); this.conflictVisible=false; return }
        this.conflictVisible=false
        if (written.written) this.$message?.success('已写入 '+written.written+' 条所选内容')
        else this.$message?.info(written.status)
      } catch(error) { if (error.name !== 'AbortError') this.$message?.error(error.message) }
      finally { this.selecting=false; if (this.selectionController===controller) this.selectionController=null }
    },
    onRequest(node) {
      const target = node || this.mindMap.renderer?.activeNodeList?.[0]
      const result = this.queue.enqueue({
        mindMap: this.mindMap,
        node: target,
        onSuccess: res => {
          if (res.reason === 'conflict' && res.conflictCandidates?.length) { this.showConflict(res,target); return }
          if (res.written)
            this.$message?.success(
              '已补齐 ' +
                res.written +
                ' 条' +
                (res.incomplete ? '，其他资料继续后台核查' : '')
            )
          else
            this.$message?.info(
              res.reason === 'conflict' ? '资料存在冲突，未补入' : res.status
            )
        },
        onError: (_error, msg) => this.$message?.error(msg)
      })
      if (!result.ok) this.$message?.warning(result.message)
    }
  }
}
</script>

<style scoped>.conflict-candidate{padding:12px 0;border-bottom:1px solid #eee}.conflict-source{margin:8px 0 0 24px;font-size:12px;color:#606266}.conflict-source pre{white-space:pre-wrap;word-break:break-word}.conflict-candidate :deep(.el-radio__label){white-space:normal}</style>
