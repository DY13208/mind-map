<template>
  <el-drawer
    :visible="visible"
    :size="drawerSize"
    :with-header="false"
    :modal-append-to-body="true"
    custom-class="kb-batch-drawer"
    @update:visible="v => $emit('update:visible', v)"
    @closed="onClosed"
  >
    <div class="kb-batch">
      <!-- 列表 -->
      <template v-if="!batchId">
        <header class="kb-batch-head">
          <div>
            <h3>批次任务</h3>
            <p class="kb-batch-sub">批次保存在后端。刷新或重新打开页面后，在这里继续查看进度和处理失败项。</p>
          </div>
          <div class="kb-batch-head-actions">
            <el-button size="mini" icon="el-icon-refresh-right" :loading="listLoading" @click="loadList(true)">刷新</el-button>
            <el-button size="mini" icon="el-icon-close" aria-label="关闭" @click="$emit('update:visible', false)" />
          </div>
        </header>
        <KbStateBlock :loading="listLoading && !batches.length" :error="listError" :empty="listLoaded && !batches.length" empty-title="还没有批次任务" empty-description="在上传面板勾选「作为批次任务上传」后，批次会出现在这里" empty-icon="el-icon-files" @retry="loadList(true)">
          <div class="kb-batch-list">
            <button v-for="b in batches" :key="b.id" type="button" class="kb-batch-row" @click="open(b.id)">
              <div class="kb-batch-row-top">
                <span class="kb-batch-name" :title="b.name">{{ b.name || '未命名批次' }}</span>
                <span class="kb-batch-tag" :class="'is-' + tone(b.state)">{{ stateLabel(b.state) }}</span>
              </div>
              <div class="kb-batch-bars">
                <div class="kb-batch-bar"><i :style="{ width: progress(b).receivedPct + '%' }" class="is-recv" /></div>
                <div class="kb-batch-bar">
                  <i :style="{ width: shareOf(b, b.done) }" class="is-done" />
                  <i :style="{ width: shareOf(b, b.partial) }" class="is-partial" />
                  <i :style="{ width: shareOf(b, b.failed) }" class="is-failed" />
                  <i :style="{ width: shareOf(b, b.cancelled) }" class="is-cancelled" />
                </div>
              </div>
              <div class="kb-batch-row-meta">
                <span>接收 {{ b.received }}/{{ b.total }}</span>
                <span>成功 {{ b.done }}</span>
                <span v-if="b.partial">部分 {{ b.partial }}</span>
                <span v-if="b.failed" class="is-bad">失败 {{ b.failed }}</span>
                <span v-if="b.cancelled">取消 {{ b.cancelled }}</span>
                <span v-if="b.waiting + b.processing">处理中 {{ b.waiting + b.processing }}</span>
                <span class="kb-batch-spacer" />
                <span class="kb-muted">{{ time(b.createdAt) }}</span>
              </div>
            </button>
          </div>
          <div v-if="listCursor" class="kb-batch-more">
            <el-button size="mini" :loading="listLoading" @click="loadList(false)">加载更多</el-button>
          </div>
        </KbStateBlock>
      </template>

      <!-- 详情 -->
      <template v-else>
        <header class="kb-batch-head">
          <div class="kb-batch-head-main">
            <el-button type="text" icon="el-icon-arrow-left" @click="back">全部批次</el-button>
            <h3 :title="status && status.name">{{ (status && status.name) || '批次详情' }}</h3>
            <p v-if="status" class="kb-batch-sub">
              <span class="kb-batch-tag" :class="'is-' + tone(status.state)">{{ stateLabel(status.state) }}</span>
              <span class="kb-mono">{{ status.id.slice(0, 8) }}</span> · 创建于 {{ time(status.createdAt) }} · 更新于 {{ time(status.updatedAt) }}
            </p>
          </div>
          <div class="kb-batch-head-actions">
            <el-button size="mini" icon="el-icon-refresh-right" :loading="statusLoading" @click="refreshAll">刷新</el-button>
            <el-button size="mini" icon="el-icon-close" aria-label="关闭" @click="$emit('update:visible', false)" />
          </div>
        </header>
        <KbStateBlock :loading="statusLoading && !status" :error="statusError" @retry="refreshAll">
          <template v-if="status">
            <p v-for="(n, i) in notices" :key="i" class="kb-batch-notice" :class="'is-' + n.tone">{{ n.text }}</p>

            <section class="kb-batch-progress">
              <div class="kb-batch-prog">
                <div class="kb-batch-prog-label">
                  <strong>上传接收</strong>
                  <span>{{ prog.received }} / {{ prog.total }}<template v-if="prog.notUploaded"> · 未上传 {{ prog.notUploaded }}</template></span>
                </div>
                <div class="kb-batch-bar is-lg"><i :style="{ width: prog.receivedPct + '%' }" class="is-recv" /></div>
              </div>
              <div class="kb-batch-prog">
                <div class="kb-batch-prog-label">
                  <strong>后台处理</strong>
                  <span>已结束 {{ prog.completed }} / {{ prog.total }}（含失败与取消） · 成功 {{ status.done }}</span>
                </div>
                <div class="kb-batch-bar is-lg is-stack">
                  <i :style="{ width: share(status.done) }" class="is-done" />
                  <i :style="{ width: share(status.partial) }" class="is-partial" />
                  <i :style="{ width: share(status.failed) }" class="is-failed" />
                  <i :style="{ width: share(status.cancelled) }" class="is-cancelled" />
                </div>
              </div>
            </section>

            <dl class="kb-batch-counts">
              <div v-for="c in counters" :key="c.key" :class="c.cls"><dt>{{ c.label }}</dt><dd>{{ c.value }}</dd></div>
            </dl>

            <div class="kb-batch-actions">
              <el-button v-if="actions.seal" size="small" type="primary" :loading="acting === 'seal'" :disabled="!!acting" @click="act('seal')">封口</el-button>
              <el-button v-if="actions.supplement" size="small" :disabled="!!acting" @click="$refs.supp.click()">补传文件</el-button>
              <el-button v-if="actions.pause" size="small" :loading="acting === 'pause'" :disabled="!!acting" @click="act('pause')">暂停</el-button>
              <el-button v-if="actions.resume" size="small" type="primary" :loading="acting === 'resume'" :disabled="!!acting" @click="act('resume')">继续</el-button>
              <el-button v-if="canRetry" size="small" :loading="acting === 'retry'" :disabled="!!acting" @click="act('retry')">重试解析失败项{{ failedScanned ? `（${retryableCount}）` : '' }}</el-button>
              <el-button v-if="actions.cancel" size="small" type="danger" plain :loading="acting === 'cancel'" :disabled="!!acting" @click="act('cancel')">取消批次</el-button>
              <input ref="supp" type="file" multiple class="kb-hidden-input" @change="onSupplement" />
            </div>
            <p class="kb-batch-hint">{{ actionHint }}</p>

            <section class="kb-batch-items">
              <div class="kb-batch-items-bar">
                <el-radio-group v-model="view" size="mini" @change="onView">
                  <el-radio-button label="all">全部条目</el-radio-button>
                  <el-radio-button label="failed">失败项{{ status.failed ? `（${status.failed}）` : '' }}</el-radio-button>
                </el-radio-group>
                <span class="kb-muted">{{ itemsNote }}</span>
              </div>
              <KbStateBlock :loading="itemsLoading && !rows.length" :error="itemsError" :empty="!itemsLoading && !itemsError && !rows.length" :empty-title="view === 'failed' ? '没有失败项' : '还没有条目'" @retry="reloadItems">
                <div class="kb-batch-table">
                  <div v-for="r in rows" :key="r.id" class="kb-batch-item">
                    <div class="kb-batch-item-main">
                      <div class="kb-batch-item-name" :title="r.name">{{ r.name || '（无文件名）' }}<span v-if="r.duplicate" class="kb-batch-dup">内容重复·引用已有文件</span></div>
                      <div v-if="r.error" class="kb-batch-item-err">{{ r.error }}</div>
                      <div v-else-if="r.uploadFailed" class="kb-batch-item-err">上传被拒绝，没有解析任务</div>
                    </div>
                    <span class="kb-batch-tag" :class="'is-' + r.tone">{{ r.label }}</span>
                    <el-button v-if="r.fileId" type="text" size="mini" @click="openFile(r)">查看解析</el-button>
                    <span v-else class="kb-batch-nofile">—</span>
                  </div>
                </div>
              </KbStateBlock>
              <div v-if="view === 'all'" class="kb-batch-pager">
                <el-button size="mini" icon="el-icon-arrow-left" :disabled="!pageStack.length || itemsLoading" @click="prevPage">上一页</el-button>
                <span class="kb-muted">第 {{ pageStack.length + 1 }} 页 · 每页 {{ pageSize }} 条</span>
                <el-button size="mini" :disabled="!nextCursor || itemsLoading" @click="nextPage">下一页<i class="el-icon-arrow-right el-icon--right" /></el-button>
              </div>
              <el-pagination v-else-if="failedRows.length > pageSize" small layout="prev, pager, next, total" :total="failedRows.length" :page-size="pageSize" :current-page.sync="failedPage" class="kb-batch-pager" />
            </section>
          </template>
        </KbStateBlock>
      </template>
    </div>
  </el-drawer>
</template>
<script>
import kbApi from '../services/kbApi'
import { createPoller } from '../services/kbPolling'
import { formatTime } from '../utils/format'
import KbStateBlock from './KbStateBlock.vue'
import {
  BATCH_STATE, batchStateLabel, batchProgress, batchActions, itemView, isBatchTerminal,
  mergeBatches, statusSignature, collectItems
} from '../utils/batchState'

const PAGE = 50
const CONFIRM = {
  seal: ['封口后后端不再接收这个批次的新文件，也不能再重传上传失败的条目。未上传的文件计入「未上传」，批次会以部分完成结束。', '封口批次', '封口'],
  cancel: ['取消只影响还没开始处理的文件；正在解析的文件会处理完，但不再结构化入库。已完成的文件不受影响。取消后不能恢复。', '取消批次', '取消批次']
}

export default {
  name: 'KbBatchDrawer',
  components: { KbStateBlock },
  props: {
    visible: Boolean,
    batchId: { type: String, default: '' },
    // 当前页面本地上传队列里仍在上传的批次，用于判断「未封口」提示
    localActive: { type: Array, default: () => [] }
  },
  data() {
    return {
      batches: [], listCursor: null, listLoading: false, listLoaded: false, listError: null,
      status: null, statusLoading: false, statusError: null, acting: '',
      view: 'all', pageSize: PAGE, rows: [], pageStack: [], pageCursor: null, nextCursor: null,
      itemsLoading: false, itemsError: null, failedRows: [], failedPage: 1, failedComplete: true, failedScanned: false,
      lastSig: '', lastFailed: -1, drawerSize: '720px'
    }
  },
  computed: {
    prog() { return batchProgress(this.status) },
    actions() { return batchActions(this.status) },
    retryableCount() { return this.failedRows.filter(r => r.retryable).length },
    // 扫描过失败项后，只有存在可被后端重新排队的条目才显示重试（上传失败、重复项会被后端跳过）
    canRetry() { return this.actions.retry && (!this.failedScanned || !this.failedComplete || this.retryableCount > 0) },
    counters() {
      const s = this.status
      return [
        { key: 'total', label: '计划', value: s.total },
        { key: 'received', label: '已接收', value: s.received },
        { key: 'notUploaded', label: '未上传', value: s.notUploaded, cls: s.notUploaded ? 'is-warn' : '' },
        { key: 'waiting', label: '等待处理', value: s.waiting },
        { key: 'processing', label: '解析中', value: s.processing },
        { key: 'done', label: '成功', value: s.done, cls: 'is-ok' },
        { key: 'partial', label: '部分完成', value: s.partial, cls: s.partial ? 'is-warn' : '' },
        { key: 'failed', label: '失败', value: s.failed, cls: s.failed ? 'is-bad' : '' },
        { key: 'cancelled', label: '已取消', value: s.cancelled }
      ]
    },
    notices() {
      const s = this.status
      const out = []
      if (!s.sealed && s.control !== 'cancelled' && !this.localActive.includes(s.id)) {
        out.push({ tone: 'warn', text: s.received < s.total
          ? `批次还没封口：计划 ${s.total} 个，后端只收到 ${s.received} 个。当前页面没有在向它上传。如需继续，可「补传文件」（同一文件会被识别为已上传）；不再补传就「封口」，批次才会结束。`
          : '批次还没封口。文件已全部收到，封口后批次在处理完成时结束。' })
      }
      if (s.state === 'paused') out.push({ tone: 'warn', text: '已暂停：正在解析的文件会处理完，之后不再领取新文件，直到继续。' })
      if (s.state === 'cancelling') out.push({ tone: 'warn', text: '取消中：尚未开始的文件已取消，正在处理的文件结束后批次进入终态。' })
      if (s.state === 'partial' && s.notUploaded) out.push({ tone: 'warn', text: `有 ${s.notUploaded} 个文件没有上传到后端，批次按部分完成结束。` })
      return out
    },
    actionHint() {
      const s = this.status
      if (s.control === 'cancelled') return '批次已取消，不能再暂停、继续或重试。'
      const parts = []
      if (this.actions.retry) {
        const scan = this.failedScanned ? this.failedRows : null
        if (scan) {
          const a = this.retryableCount
          const b = scan.filter(r => r.uploadFailed).length
          const c = scan.filter(r => r.duplicate).length
          const head = a ? `重试只重新排队解析失败的文件（复用原解析任务），当前 ${a} 个可重试` : '没有可重试的解析失败项'
          parts.push(`${head}${b ? `；${b} 个上传失败的条目没有解析任务，${s.sealed ? '批次已封口，后端不再接收重传' : '可在封口前补传同一文件'}` : ''}${c ? `；${c} 个重复项依赖其他批次的解析，不在此重试` : ''}。`)
        } else parts.push('重试只重新排队解析失败的文件（复用原解析任务）；上传失败的条目没有解析任务，需在封口前补传。')
      }
      if (!s.sealed) parts.push('封口表示不再接收新文件，计划数没有达到也可以封口。')
      return parts.join(' ')
    },
    itemsNote() {
      if (this.view === 'failed') return this.failedComplete ? `共 ${this.failedRows.length} 个失败项` : `已扫描前 ${this.failedRows.length} 个失败项（条目过多，未扫完）`
      return '后端按条目 id 分页，不是上传顺序'
    }
  },
  watch: {
    visible(v) { if (v) this.enter(); else this.stopAll() },
    batchId() { if (this.visible) this.enter() },
    failedPage() { if (this.view === 'failed') this.rows = this.failedSlice() }
  },
  created() {
    this.detailPoller = createPoller(() => this.pollDetail(), { min: 2000, max: 10000 })
    this.listPoller = createPoller(() => this.pollList(), { min: 3000, max: 15000 })
    this.onResize = () => { this.drawerSize = window.innerWidth < 820 ? '100%' : '720px' }
    this.onResize()
    window.addEventListener('resize', this.onResize)
  },
  mounted() { if (this.visible) this.enter() },
  beforeDestroy() {
    this.stopAll()
    window.removeEventListener('resize', this.onResize)
  },
  methods: {
    time: formatTime,
    stateLabel: batchStateLabel,
    tone(state) { return (BATCH_STATE[state] && BATCH_STATE[state].tone) || 'muted' },
    progress: batchProgress,
    shareOf(s, n) { const t = Number(s && s.total) || 0; return t ? `${(Number(n) || 0) / t * 100}%` : '0%' },
    share(n) { return this.shareOf(this.status, n) },
    stopAll() { this.detailPoller.stop(); this.listPoller.stop() },
    onClosed() { this.stopAll() },
    enter() {
      this.stopAll()
      if (this.batchId) this.openDetail()
      else this.loadList(true)
    },
    open(id) { this.$emit('update:batchId', id) },
    back() { this.$emit('update:batchId', '') },

    async loadList(reset) {
      if (this.listLoading) return
      this.listLoading = true
      try {
        const res = await kbApi.listBatches({ cursor: reset ? undefined : this.listCursor, limit: 25 })
        this.batches = mergeBatches(reset ? [] : this.batches, res.items)
        this.listCursor = res.nextCursor
        this.listError = null
        if (this.batches.some(b => !isBatchTerminal(b))) this.listPoller.start()
      } catch (e) {
        this.listError = e
      } finally {
        this.listLoading = false
        this.listLoaded = true
      }
    },
    // 只刷新未结束的批次，每轮最多 10 个
    async pollList() {
      if (this.batchId || !this.visible) return false
      const active = this.batches.filter(b => !isBatchTerminal(b)).slice(0, 10)
      if (!active.length) return false
      const fresh = await Promise.all(active.map(b => kbApi.getBatch(b.id).catch(() => null)))
      const changed = fresh.some((s, i) => s && statusSignature(s) !== statusSignature(active[i]))
      this.batches = mergeBatches(this.batches, fresh.filter(Boolean))
      return changed ? 'changed' : true
    },

    async openDetail() {
      this.status = null
      this.statusError = null
      this.view = 'all'
      this.resetItems()
      this.lastSig = ''
      this.lastFailed = -1
      await this.loadStatus()
      if (this.status) {
        await this.loadPage(null)
        if (this.status && this.status.failed > 0) this.scanFailed()
        if (!isBatchTerminal(this.status)) this.detailPoller.start()
      }
    },
    resetItems() {
      this.rows = []
      this.pageStack = []
      this.pageCursor = null
      this.nextCursor = null
      this.failedRows = []
      this.failedPage = 1
      this.failedScanned = false
      this.failedComplete = true
      this.itemsError = null
    },
    async loadStatus() {
      const id = this.batchId
      this.statusLoading = true
      try {
        const s = await kbApi.getBatch(id)
        if (id !== this.batchId) return null
        this.status = s
        this.statusError = null
        this.$emit('changed', s)
        return s
      } catch (e) {
        if (id === this.batchId) this.statusError = e
        return null
      } finally {
        this.statusLoading = false
      }
    },
    async pollDetail() {
      if (!this.batchId || !this.visible) return false
      const s = await this.loadStatus()
      if (!s) throw new Error('status failed')
      const sig = statusSignature(s)
      const changed = sig !== this.lastSig
      if (changed) {
        this.lastSig = sig
        if (this.view === 'all') await this.loadPage(this.pageCursor, true)
        if (s.failed !== this.lastFailed && (s.failed > 0 || this.failedScanned)) await this.scanFailed()
      }
      if (isBatchTerminal(s)) return false
      return changed ? 'changed' : true
    },
    // 上传面板封口或创建了批次：正在看的就是它时立即刷新，列表视图则合并最新状态
    refreshIf(id) {
      if (!this.visible) return
      if (this.batchId === id) this.refreshAll()
      else if (!this.batchId) this.loadList(true)
    },
    async refreshAll() {
      const s = await this.loadStatus()
      if (!s) return
      this.lastSig = statusSignature(s)
      await this.reloadItems()
      if (!isBatchTerminal(s)) this.detailPoller.start()
    },

    // 条目：后端游标分页，一次只渲染一页 50 条
    async loadPage(cursor, quiet) {
      const id = this.batchId
      if (!quiet) this.itemsLoading = true
      try {
        const res = await kbApi.listBatchItems(id, { cursor: cursor || undefined, limit: this.pageSize })
        if (id !== this.batchId || this.view !== 'all') return
        this.rows = res.items.map(itemView)
        this.pageCursor = cursor
        this.nextCursor = res.nextCursor
        this.itemsError = null
      } catch (e) {
        if (!quiet) this.itemsError = e
      } finally {
        this.itemsLoading = false
      }
    },
    nextPage() {
      if (!this.nextCursor) return
      this.pageStack.push(this.pageCursor)
      this.loadPage(this.nextCursor)
    },
    prevPage() {
      if (!this.pageStack.length) return
      this.loadPage(this.pageStack.pop())
    },
    // 失败项：后端条目没有状态过滤，按 200 条一页扫完（1000 个文件最多 5 次请求），本地每页 50 条
    async scanFailed() {
      const id = this.batchId
      this.itemsLoading = true
      try {
        const { rows, complete } = await collectItems(p => kbApi.listBatchItems(id, p), { pageSize: 200, maxPages: 10 })
        if (id !== this.batchId) return
        this.failedRows = rows.map(itemView).filter(r => r.state === 'failed')
        this.failedComplete = complete
        this.failedScanned = true
        this.lastFailed = this.status ? this.status.failed : -1
        const pages = Math.max(1, Math.ceil(this.failedRows.length / this.pageSize))
        if (this.failedPage > pages) this.failedPage = pages
        if (this.view === 'failed') this.rows = this.failedSlice()
        this.itemsError = null
      } catch (e) {
        this.itemsError = e
      } finally {
        this.itemsLoading = false
      }
    },
    failedSlice() {
      const p = this.failedPage
      return this.failedRows.slice((p - 1) * this.pageSize, p * this.pageSize)
    },
    onView(v) {
      this.rows = []
      this.itemsError = null
      if (v === 'failed') { this.failedPage = 1; this.scanFailed() } else { this.pageStack = []; this.loadPage(null) }
    },
    reloadItems() {
      return this.view === 'failed' ? this.scanFailed() : this.loadPage(this.pageCursor)
    },

    async act(action) {
      if (CONFIRM[action]) {
        const [text, title, ok] = CONFIRM[action]
        try { await this.$confirm(text, title, { type: 'warning', confirmButtonText: ok, cancelButtonText: '返回' }) } catch (_) { return }
      }
      const id = this.batchId
      this.acting = action
      try {
        const s = await kbApi.batchAction(id, action)
        if (id !== this.batchId) return
        this.status = s
        this.$emit('changed', s)
        if (action === 'seal' || action === 'cancel') this.$emit('closed', s.id)
        this.$message.success({ seal: '已封口', pause: '已暂停', resume: '已继续', cancel: '已提交取消', retry: '已重新排队失败项' }[action])
      } catch (e) {
        // 网络中断或超时：请求可能已被后端执行（封口/暂停/继续/取消都是幂等的），重新读取真实状态而不是自动重发
        const unknown = e.kind === 'network' || e.kind === 'timeout' || (e.status >= 502 && e.status <= 504)
        this.$message.error(unknown ? `${e.message}；结果未知，已重新读取批次状态` : (e.message || '操作失败'))
        await this.loadStatus()
        if (unknown && this.status && (action === 'seal' || action === 'cancel') && (this.status.sealed || this.status.control === 'cancelled')) this.$emit('closed', id)
      } finally {
        this.acting = ''
      }
      if (this.status) {
        this.lastSig = statusSignature(this.status)
        await this.reloadItems()
        if (this.view === 'all' && (this.status.failed > 0 || this.failedScanned)) await this.scanFailed()
        if (!isBatchTerminal(this.status)) this.detailPoller.start()
      }
    },
    onSupplement(e) {
      const files = Array.from(e.target.files || [])
      e.target.value = ''
      if (files.length && this.status) this.$emit('supplement', { batch: this.status, files })
    },
    openFile(r) { this.$emit('navigate', { tab: 'parse', query: { file: r.fileId } }) }
  }
}
</script>
<style scoped lang="less">
.kb-batch { padding: 18px 22px 28px; color: var(--ui-text); height: 100%; box-sizing: border-box; overflow: auto; background: var(--ui-bg); }
.kb-batch-head {
  display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 14px;
  h3 { margin: 2px 0 4px; font-size: 17px; font-weight: 700; word-break: break-all; }
}
.kb-batch-head-main { min-width: 0; ::v-deep .el-button--text { padding: 0; } }
.kb-batch-head-actions { display: flex; gap: 6px; flex: none; }
.kb-batch-sub { margin: 0; font-size: 12px; color: var(--ui-text-muted); line-height: 1.7; display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.kb-mono { font-family: Consolas, Menlo, monospace; }
.kb-muted { font-size: 12px; color: var(--ui-text-muted); }
.kb-hidden-input { display: none; }
.kb-batch-tag {
  display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; line-height: 18px; white-space: nowrap;
  background: var(--ui-surface-muted); color: var(--ui-text-secondary);
  &.is-active { background: var(--ui-primary-soft); color: var(--ui-primary); }
  &.is-ok { background: var(--ui-primary); color: var(--ui-on-primary); }
  &.is-warn { background: rgba(230, 162, 60, 0.16); color: #ad6800; }
  &.is-bad { background: var(--ui-danger-soft); color: var(--ui-danger); }
}
.kb-batch-list { display: flex; flex-direction: column; gap: 8px; }
.kb-batch-row {
  text-align: left; width: 100%; border: 1px solid var(--ui-border); border-radius: var(--ui-radius-md); padding: 10px 12px;
  background: var(--ui-surface); color: var(--ui-text); cursor: pointer; font: inherit;
  transition: border-color var(--ui-duration) var(--ui-ease), box-shadow var(--ui-duration) var(--ui-ease);
  &:hover, &:focus-visible { border-color: var(--ui-border-strong); box-shadow: var(--ui-shadow-hover); outline: none; }
}
.kb-batch-row-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.kb-batch-name { font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb-batch-row-meta { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; color: var(--ui-text-secondary); margin-top: 6px; .is-bad { color: var(--ui-danger); } }
.kb-batch-spacer { flex: 1; }
.kb-batch-bars { display: grid; gap: 3px; margin-top: 8px; }
.kb-batch-bar {
  height: 4px; border-radius: 2px; background: var(--ui-surface-muted); overflow: hidden; display: flex;
  &.is-lg { height: 8px; border-radius: 4px; }
  i { display: block; height: 100%; transition: width 400ms var(--ui-ease); }
  .is-recv { background: var(--ui-border-strong); }
  .is-done { background: var(--ui-primary); }
  .is-partial { background: #e6a23c; }
  .is-failed { background: var(--ui-danger); }
  .is-cancelled { background: var(--ui-text-muted); }
}
.kb-batch-more { margin-top: 10px; text-align: center; }
.kb-batch-notice {
  margin: 0 0 10px; padding: 8px 12px; border-radius: var(--ui-radius-md); font-size: 12px; line-height: 1.7;
  &.is-warn { background: rgba(230, 162, 60, 0.12); color: #8a5a00; }
}
.kb-batch-progress { display: grid; gap: 12px; padding: 12px 14px; background: var(--ui-surface); border: 1px solid var(--ui-border); border-radius: var(--ui-radius-md); }
.kb-batch-prog-label { display: flex; justify-content: space-between; gap: 10px; font-size: 12px; color: var(--ui-text-secondary); margin-bottom: 5px; strong { color: var(--ui-text); font-size: 13px; } }
.kb-batch-counts {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 8px; margin: 12px 0 0;
  > div { padding: 8px 10px; border-radius: var(--ui-radius-md); background: var(--ui-surface); border: 1px solid var(--ui-border); }
  dt { font-size: 12px; color: var(--ui-text-muted); }
  dd { margin: 2px 0 0; font-size: 18px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .is-ok dd { color: var(--ui-primary); }
  .is-warn dd { color: #ad6800; }
  .is-bad dd { color: var(--ui-danger); }
}
.kb-batch-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.kb-batch-hint { margin: 8px 0 0; font-size: 12px; color: var(--ui-text-muted); line-height: 1.7; }
.kb-batch-items { margin-top: 16px; }
.kb-batch-items-bar { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.kb-batch-table { border: 1px solid var(--ui-border); border-radius: var(--ui-radius-md); background: var(--ui-surface); }
.kb-batch-item {
  display: grid; grid-template-columns: minmax(0, 1fr) auto 64px; align-items: center; gap: 10px; padding: 7px 12px;
  border-top: 1px solid var(--ui-border); font-size: 13px;
  &:first-child { border-top: 0; }
}
.kb-batch-item-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb-batch-item-err { font-size: 12px; color: var(--ui-danger); margin-top: 2px; word-break: break-all; }
.kb-batch-dup { margin-left: 8px; font-size: 11px; color: var(--ui-text-muted); }
.kb-batch-nofile { text-align: center; color: var(--ui-text-muted); }
.kb-batch-pager { display: flex; align-items: center; justify-content: center; gap: 10px; margin-top: 10px; }
</style>
