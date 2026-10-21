<template>
  <div class="kb-upload">
    <div
      class="kb-drop"
      :class="{ dragging }"
      role="button"
      tabindex="0"
      @click="pick"
      @keydown.enter="pick"
      @dragover.prevent="dragging = true"
      @dragleave.prevent="dragging = false"
      @drop.prevent="onDrop"
    >
      <i class="el-icon-upload2 kb-drop-icon" aria-hidden="true" />
      <div><strong>点击或拖拽文件、文件夹到此处批量上传</strong></div>
      <div class="kb-drop-sub">支持 {{ extText }}，单个文件不超过 {{ maxText }}{{ limitSource === 'fallback' ? '（后端缺省值）' : '' }}</div>
      <div class="kb-drop-sub">
        <el-button type="text" size="mini" :disabled="folderBusy" @click.stop="pickFolder">选择文件夹</el-button>
        <span>（保留子目录结构，建在「{{ folderLabel }}」下；跳过隐藏和系统文件）</span>
      </div>
      <input ref="input" type="file" multiple class="kb-hidden-input" @change="onPick" />
      <input ref="folder" type="file" multiple webkitdirectory directory class="kb-hidden-input" @change="onPickFolder" />
    </div>
    <div v-if="folderJob" class="kb-folder-job">
      <div class="kb-folder-job-main">
        <strong>文件夹上传</strong>
        <span class="kb-muted">{{ folderJobText }}</span>
        <span class="kb-spacer" />
        <el-button v-if="folderJob.phase === 'folders'" type="text" size="mini" :disabled="folderJob.cancelled" @click="folderJob.cancelled = true">{{ folderJob.cancelled ? '正在取消' : '取消' }}</el-button>
        <el-button v-if="folderJob.phase === 'done'" type="text" size="mini" @click="folderJob = null">关闭</el-button>
      </div>
      <el-progress v-if="folderJob.phase === 'folders' && folderJob.dirsTotal" :percentage="Math.floor(folderJob.dirsDone * 100 / folderJob.dirsTotal)" :stroke-width="4" :show-text="false" />
      <div v-if="folderJob.problems.length" class="kb-folder-job-list kb-thin-scroll">
        <div v-for="(p, i) in folderJob.problems.slice(0, 50)" :key="i" class="kb-queue-note"><span class="kb-folder-job-path">{{ p.path }}</span>：{{ p.message }}</div>
        <div v-if="folderJob.problems.length > 50" class="kb-muted">另有 {{ folderJob.problems.length - 50 }} 项未列出</div>
      </div>
    </div>
    <div class="kb-batch-mode">
      <el-checkbox v-model="useBatch" :disabled="!batchAvailable || creatingBatch">作为批次任务上传</el-checkbox>
      <span class="kb-muted">{{ batchModeHint }}</span>
      <span class="kb-spacer" />
      <el-button type="text" size="mini" icon="el-icon-files" :disabled="batch.supported === false" @click="$emit('open-batches')">批次任务</el-button>
    </div>
    <div v-for="b in localBatches" :key="b.id" class="kb-local-batch">
      <div class="kb-local-batch-main">
        <strong :title="b.name">{{ b.name }}</strong>
        <span class="kb-muted">本页已提交 {{ b.sum.uploaded }} / 计划 {{ b.total }}<template v-if="b.sum.failed"> · 上传失败 {{ b.sum.failed }}</template><template v-if="b.sum.local"> · 预检未通过 {{ b.sum.local }}</template><template v-if="b.sum.cancelled"> · 已取消 {{ b.sum.cancelled }}</template></span>
        <span class="kb-local-batch-state" :class="'is-' + localBatchTone(b)">{{ localBatchText(b) }}</span>
      </div>
      <div class="kb-local-batch-actions">
        <el-button v-if="!b.sealed && b.decision !== 'wait'" type="text" size="mini" :loading="b.sealing" @click="sealBatch(b)">{{ b.sealError ? '重新封口' : '封口' }}</el-button>
        <el-button type="text" size="mini" @click="$emit('open-batch', b.id)">查看批次</el-button>
      </div>
      <div v-if="b.sealError" class="kb-queue-error">封口失败：{{ b.sealError }}</div>
    </div>
    <div v-if="sum.total" class="kb-queue">
      <div class="kb-queue-summary">
        <span class="kb-muted">本地上传队列（仅在本页面，刷新或离开后清空）</span>
        <span>共 {{ sum.total }}</span>
        <span class="is-ok">成功 {{ sum.success }}<template v-if="sum.duplicate">（含重复 {{ sum.duplicate }}）</template></span>
        <span class="is-bad">失败 {{ sum.failed }}</span>
        <span>上传中 {{ sum.uploading }}</span>
        <span>排队 {{ sum.queued }}</span>
        <span v-if="sum.cancelled">已取消 {{ sum.cancelled }}</span>
        <span class="kb-muted">后台解析：完成 {{ sum.parsed }} · 进行中 {{ sum.parsing }}<template v-if="sum.parseFailed"> · 失败 {{ sum.parseFailed }}</template></span>
      </div>
      <el-progress :percentage="sum.percent" :stroke-width="6" :format="() => `${sum.percent}% · ${bytes(sum.loadedBytes)} / ${bytes(sum.totalBytes)}`" />
      <div class="kb-queue-tools">
        <span class="kb-muted">并发</span>
        <el-select :value="concurrency" size="mini" class="kb-queue-conc" popper-class="kb-popper" @change="setConcurrency">
          <el-option v-for="n in maxConcurrency" :key="n" :label="n" :value="n" />
        </el-select>
        <el-radio-group v-model="filter" size="mini">
          <el-radio-button label="all">全部</el-radio-button>
          <el-radio-button label="active">进行中</el-radio-button>
          <el-radio-button label="failed">失败</el-radio-button>
          <el-radio-button label="uploaded">已上传</el-radio-button>
        </el-radio-group>
        <span class="kb-spacer" />
        <el-button type="text" size="mini" :disabled="!sum.failed" @click="retryFailed">重试全部失败</el-button>
        <el-button type="text" size="mini" :disabled="!sum.queued && !sum.uploading" @click="cancelAll">取消未完成</el-button>
        <el-button type="text" size="mini" :disabled="!sum.success && !sum.cancelled" @click="clearDone">清除已完成</el-button>
      </div>
      <p v-if="sum.success" class="kb-queue-tip">文件已上传，后台正在解析。已提交到后端的文件不受离开或刷新影响，回来后文件列表显示后端真实状态。</p>
      <p v-if="sum.queued || sum.uploading || sum.failed" class="kb-queue-warn">「未提交」的文件只在本页面内存中，刷新、关闭或离开文件知识库后不会继续上传，也不会出现在文件列表。</p>
      <div class="kb-queue-list kb-thin-scroll">
        <div v-for="item in pageRows" :key="item.key" class="kb-queue-item">
          <i class="el-icon-document" aria-hidden="true" />
          <div class="kb-queue-main">
            <div class="kb-queue-name" :title="item.name">{{ item.name }}<span class="kb-muted"> · {{ bytes(item.size) }}</span></div>
            <el-progress v-if="item.state === 'uploading' || item.state === 'queued'" :percentage="pct(item)" :stroke-width="4" :show-text="false" />
            <div v-if="item.error" :class="item.state === 'failed' ? 'kb-queue-error' : 'kb-queue-note'">{{ item.error }}</div>
            <div v-if="item.recovered" class="kb-queue-note">上次请求结果未知；后端按内容识别为已有文件「{{ item.result && item.result.name }}」，没有重复创建文件或解析任务</div>
            <div v-if="item.duplicate" class="kb-queue-note">已存在相同内容的文件「{{ item.result && item.result.name }}」，未重复保存{{ item.result && item.result.folderId !== (item.folderId || null) ? '（原文件在其他文件夹）' : '' }}</div>
            <div v-if="item.warning" class="kb-queue-note">{{ item.warning }}</div>
            <div v-if="item.backend && item.backend.status === 'failed' && item.backend.error" class="kb-queue-error">解析失败：{{ item.backend.error }}</div>
            <div v-if="item.state === 'failed' && !item.local && !canRetry(item)" class="kb-queue-note">所属批次已封口或已取消，后端不再接收这个批次的上传，不能重传</div>
          </div>
          <span class="kb-queue-state" :class="'is-' + phase(item)">{{ label(item) }}</span>
          <el-button v-if="item.state === 'failed' && !item.local && canRetry(item)" type="text" icon="el-icon-refresh-right" aria-label="重试" title="重试" @click="retry(item)" />
          <el-button v-if="item.state === 'queued' || item.state === 'uploading'" type="text" icon="el-icon-close" aria-label="取消" title="取消" @click="cancel(item)" />
        </div>
        <div v-if="!pageRows.length" class="kb-muted kb-queue-empty">没有符合条件的文件</div>
      </div>
      <el-pagination
        v-if="paged.total > pageSize"
        small
        layout="prev, pager, next, total"
        :total="paged.total"
        :page-size="pageSize"
        :current-page.sync="page"
        class="kb-queue-pager"
      />
    </div>
  </div>
</template>
<script>
import kbApi from '../services/kbApi'
import { registerUploadBusy } from '../services/kbSignals'
import { createPoller } from '../services/kbPolling'
import {
  createUploadQueue, summarize, pageOf, pollIds, precheckFile, itemPhase, PHASE_LABELS, formatBytes, fileIdentity,
  DEFAULT_CONCURRENCY, MAX_CONCURRENCY, DEFAULT_MAX_FILE_BYTES, ALLOWED_EXTS, PAGE_SIZE
} from '../utils/uploadQueue'
import { planBatches, clientKeyFor, sealDecision, localBatchSummary, defaultBatchName } from '../utils/batchState'
import {
  entriesFromInput, hasDirectoryEntry, collectDropped, planFolderUpload, ensureFolders, assignFolders, MAX_FOLDERS, MAX_SCAN_ENTRIES
} from '../utils/folderUpload'

export default {
  name: 'KbUploadPanel',
  props: {
    folderId: { type: String, default: '' },
    folderLabel: { type: String, default: '当前文件夹' },
    defaultConcurrency: { type: Number, default: DEFAULT_CONCURRENCY }
  },
  beforeCreate() {
    // paged 的 watcher 在 created 前求值；列表仍保持非响应式，由 tick 驱动刷新。
    this.items = []
  },
  data() {
    return {
      dragging: false, concurrency: DEFAULT_CONCURRENCY, maxConcurrency: MAX_CONCURRENCY,
      filter: 'all', page: 1, pageSize: PAGE_SIZE, tick: 0,
      maxFileBytes: DEFAULT_MAX_FILE_BYTES, allowed: ALLOWED_EXTS, limitSource: 'fallback',
      batch: { supported: null, reason: '' }, useBatch: false, creatingBatch: false,
      // 本页面创建或补传的批次；批次本身的状态以 GET /batches/:id 为准
      localBatches: [],
      // 当前这次文件夹上传：读取目录 → 逐层建文件夹 → 文件进入上传队列（之后的进度看队列）
      folderJob: null
    }
  },
  computed: {
    sum() { void this.tick; return summarize(this.items) },
    paged() { void this.tick; return pageOf(this.items, { page: this.page, pageSize: this.pageSize, filter: this.filter }) },
    pageRows() { return this.paged.rows },
    maxText() { return formatBytes(this.maxFileBytes) },
    extText() { return this.allowed.map(e => e.toUpperCase()).join('、') },
    folderBusy() { return !!this.folderJob && (this.folderJob.phase === 'scanning' || this.folderJob.phase === 'folders') },
    folderJobText() {
      const j = this.folderJob
      if (!j) return ''
      if (j.phase === 'scanning') return '正在读取本地文件夹…'
      if (j.phase === 'folders') return `正在创建文件夹 ${j.dirsDone} / ${j.dirsTotal}`
      const parts = [`文件夹：新建 ${j.created} · 沿用已有 ${j.reused}` + (j.failedDirs ? ` · 失败 ${j.failedDirs}` : '')]
      parts.push(`文件：加入上传队列 ${j.queued}` + (j.ignored ? ` · 跳过隐藏/系统文件 ${j.ignored}` : '') + (j.invalid ? ` · 未通过大小/类型检查 ${j.invalid}` : '') + (j.blocked ? ` · 因文件夹失败未上传 ${j.blocked}` : ''))
      if (j.cancelled) parts.push('已取消')
      return parts.join('；')
    },
    batchAvailable() { return this.batch.supported === true && !this.batch.restricted },
    batchModeHint() {
      if (this.batch.supported == null) return '正在检查批次接口'
      if (!this.batch.supported) return `批次接口暂不可用：${this.batch.reason || '后端未提供'}`
      if (this.batch.restricted) return this.batch.reason || '当前凭据不能管理批次'
      if (this.creatingBatch) return '正在创建批次'
      return this.useBatch ? '每次选择的文件建一个批次（超过 1000 个自动拆分），进度保存在后端，刷新后可在「批次任务」继续查看' : '不建批次，逐个上传'
    }
  },
  watch: {
    filter() { this.page = 1 },
    'paged.pages'(n) { if (this.page > n) this.page = n }
  },
  created() {
    this.concurrency = Math.min(MAX_CONCURRENCY, Math.max(1, this.defaultConcurrency))
    this.lastTick = 0
    // 队列项刻意不做 Vue 响应式（1000 个文件 × 高频进度事件），由 tick 节流触发重新渲染
    this.queue = createUploadQueue({
      items: this.items,
      concurrency: this.concurrency,
      run: (item, { signal, onProgress }) => kbApi.uploadFile(item.file, {
        folderId: item.folderId, signal, onProgress: (_, loaded, total) => onProgress(loaded, total),
        batchId: item.batchId || undefined, clientKey: item.clientKey || undefined
      }),
      retryable: item => this.canRetry(item),
      onChange: () => this.refresh(),
      onSettled: item => this.settled(item)
    })
    this.pollCursor = 0
    this.poller = createPoller(() => this.pollStatus(), { min: 3000, max: 20000 })
    this.onUnload = e => {
      if (!this.isBusy()) return undefined
      e.preventDefault()
      e.returnValue = '仍有文件尚未提交到后端，离开页面会中止这些上传（已提交的文件会继续在后台解析）'
      return e.returnValue
    }
    window.addEventListener('beforeunload', this.onUnload)
    this.unregisterBusy = registerUploadBusy(() => this.items.filter(i => i.state === 'queued' || i.state === 'uploading').length)
    this.loadLimits()
  },
  beforeDestroy() {
    this.destroyed = true
    window.removeEventListener('beforeunload', this.onUnload)
    this.unregisterBusy()
    this.poller.stop()
    this.queue.dispose()
    clearTimeout(this.emitTimer)
    clearTimeout(this.tickTimer)
  },
  methods: {
    bytes: formatBytes,
    isBusy() { return this.items.some(i => i.state === 'queued' || i.state === 'uploading') },
    phase: itemPhase,
    pct(item) { return item.size ? Math.min(100, Math.floor((item.loaded / item.size) * 100)) : 0 },
    label(item) {
      const p = itemPhase(item)
      if (p === 'uploading') return `上传中 ${this.pct(item)}%`
      return PHASE_LABELS[p] || p
    },
    // 进度事件很密，最多每 200ms 触发一次重新渲染
    refresh() {
      if (this.destroyed) return
      const now = Date.now()
      if (now - this.lastTick >= 200) { this.lastTick = now; this.tick++; return }
      if (!this.tickTimer) this.tickTimer = setTimeout(() => { this.tickTimer = null; if (this.destroyed) return; this.lastTick = Date.now(); this.tick++ }, 200)
    },
    async loadLimits() {
      const [limits, batch] = await Promise.all([kbApi.getUploadLimits(), kbApi.detectBatchSupport().catch(() => ({ supported: false }))])
      if (this.destroyed) return
      this.batch = batch
      this.useBatch = batch.supported === true && !batch.restricted
      if (limits && limits.maxFileBytes) {
        this.maxFileBytes = limits.maxFileBytes
        this.limitSource = 'backend'
      }
      if (limits && limits.allowedExtensions && limits.allowedExtensions.length) this.allowed = limits.allowedExtensions.map(e => e.toLowerCase())
    },
    pick() { this.$refs.input.click() },
    pickFolder() { this.$refs.folder.click() },
    onPick(e) {
      this.add(Array.from(e.target.files || []))
      e.target.value = ''
    },
    onPickFolder(e) {
      const files = Array.from(e.target.files || [])
      e.target.value = ''
      if (files.length) this.uploadFolder({ entries: entriesFromInput(files) })
    },
    onDrop(e) {
      this.dragging = false
      const dt = e.dataTransfer
      // 目录必须在 drop 事件内同步取 entry；含目录时整体按文件夹上传（顶层散文件放到目标文件夹本身）
      if (hasDirectoryEntry(dt)) {
        if (this.folderBusy) return this.$message.warning('上一个文件夹还在创建目录，请稍候')
        return this.uploadFolder({ scan: collectDropped(dt) })
      }
      this.add(Array.from((dt && dt.files) || []))
    },
    async uploadFolder({ entries = null, scan = null }) {
      if (this.folderBusy) return this.$message.warning('上一个文件夹还在创建目录，请稍候')
      const baseId = this.folderId
      this.folderJob = { phase: 'scanning', dirsTotal: 0, dirsDone: 0, created: 0, reused: 0, failedDirs: 0, queued: 0, ignored: 0, invalid: 0, blocked: 0, problems: [], cancelled: false }
      const job = this.folderJob
      let emptyDirs = []
      try {
        if (scan) {
          const r = await scan
          entries = r.entries
          emptyDirs = r.emptyDirs
          job.ignored += r.ignored.length
          r.errors.forEach(p => job.problems.push(p))
          if (r.truncated) job.problems.push({ path: '（文件夹）', message: `条目超过 ${MAX_SCAN_ENTRIES} 个，只处理了前面的部分` })
        }
      } catch (e) {
        job.phase = 'done'
        job.problems.push({ path: '（文件夹）', message: '浏览器没有允许读取这个文件夹' })
        return
      }
      if (this.destroyed) return
      const plan = planFolderUpload(entries || [], {
        emptyDirs, precheck: f => precheckFile(f, { maxFileBytes: this.maxFileBytes, allowed: this.allowed })
      })
      job.ignored += plan.ignored.length
      job.invalid = plan.invalid.length
      plan.invalid.forEach(p => job.problems.push(p))
      if (plan.dirs.length > MAX_FOLDERS) {
        job.phase = 'done'
        job.problems.unshift({ path: '（文件夹）', message: `包含 ${plan.dirs.length} 个文件夹，超过单次上限 ${MAX_FOLDERS}，请分开上传，没有创建任何文件夹` })
        return
      }
      job.phase = 'folders'
      job.dirsTotal = plan.dirs.length
      const made = await ensureFolders(plan.dirs, {
        baseId,
        create: body => kbApi.createFolder({ ...body, reuse: true }),
        onStep: () => { job.dirsDone++ },
        isCancelled: () => job.cancelled || this.destroyed
      })
      if (this.destroyed) return
      job.created = made.created
      job.reused = made.reused
      job.failedDirs = Array.from(made.failed.values()).filter(m => m !== '已取消').length
      made.failed.forEach((message, path) => { if (message !== '已取消') job.problems.push({ path: path + '/', message }) })
      if (made.created) this.$emit('folders-changed', baseId)
      const { ready, blocked } = assignFolders(plan.files, made.ids, made.failed)
      job.phase = 'done'
      if (job.cancelled) return
      job.blocked = blocked.length
      blocked.forEach(p => job.problems.push(p))
      job.queued = ready.length
      if (ready.length) await this.addPlanned(ready.map(f => ({ file: f.file, folderId: f.folderId, name: f.path })))
    },
    add(files) {
      const folderId = this.folderId
      return this.addPlanned(files.map(file => ({ file, folderId })))
    },
    // list: [{ file, folderId, name? }]；同一批次可以跨多个目标文件夹
    async addPlanned(list) {
      if (!list.length) return
      if (!this.useBatch || !this.batchAvailable) return this.enqueueList(list, '')
      // 同一次选择里重复的文件只算一次，计划数 = 去重后的文件数（含本地预检不通过的，它们计入「未上传」）
      const seen = new Set()
      const unique = list.filter(x => { const k = fileIdentity(x.file, x.folderId); if (seen.has(k)) return false; seen.add(k); return true })
      this.creatingBatch = true
      try {
        let offset = 0
        for (const n of planBatches(unique.length)) {
          const chunk = unique.slice(offset, offset + n)
          offset += n
          let created
          try {
            created = await kbApi.createBatch({ name: defaultBatchName(n), expectedCount: n })
          } catch (e) {
            if (this.destroyed) return
            const unknown = e.kind === 'network' || e.kind === 'timeout'
            this.$message.error(`批次创建失败：${e.message}。这 ${n} 个文件改为普通上传，不纳入批次${unknown ? '；请求结果未知，后端可能留下一个空批次，可在「批次任务」里取消' : ''}`)
            this.enqueueList(chunk, '')
            continue
          }
          if (this.destroyed) return
          this.localBatches.push({ id: created.id, name: created.name, total: created.total, sealed: false, sealing: false, sealError: '', decision: 'wait', sum: localBatchSummary([]) })
          this.enqueueList(chunk, created.id)
          this.$emit('batch-changed', created)
        }
      } finally {
        this.creatingBatch = false
      }
    },
    enqueue(files, batchId, folderId, { quiet = false, names = null } = {}) {
      const opts = { maxFileBytes: this.maxFileBytes, allowed: this.allowed }
      const { skipped, revived } = this.queue.add(files, {
        folderId, batchId, clientKey: f => clientKeyFor(f, folderId), precheck: f => precheckFile(f, opts),
        nameOf: names ? f => names.get(f) : null
      })
      if (!quiet) this.notifyQueued(skipped.length, revived.length)
      if (batchId && !quiet) this.checkSeal(batchId)
      return { skipped: skipped.length, revived: revived.length }
    },
    // 按目标文件夹分组入队；所有分组入队后再判断批次封口
    enqueueList(list, batchId) {
      const groups = new Map()
      list.forEach(x => {
        const k = x.folderId || ''
        if (!groups.has(k)) groups.set(k, [])
        groups.get(k).push(x)
      })
      let skipped = 0
      let revived = 0
      groups.forEach((xs, folderId) => {
        const names = new Map(xs.filter(x => x.name).map(x => [x.file, x.name]))
        const r = this.enqueue(xs.map(x => x.file), batchId, folderId, { quiet: true, names: names.size ? names : null })
        skipped += r.skipped
        revived += r.revived
      })
      this.notifyQueued(skipped, revived)
      if (batchId) this.checkSeal(batchId)
    },
    notifyQueued(skipped, revived) {
      const notes = []
      if (skipped) notes.push(`${skipped} 个文件已在队列中，已跳过`)
      if (revived) notes.push(`${revived} 个之前失败或取消的文件已重新排队`)
      if (notes.length) this.$message.info(notes.join('；'))
    },
    // 向已有的未封口批次补传（例如刷新后本地队列已清空）。同一文件得到同一个 client_key，后端按已上传处理
    addToBatch(files, status) {
      if (!files.length || !status) return
      if (status.sealed || status.control === 'cancelled') {
        this.$message.error('批次已封口或已取消，后端不再接收上传')
        return
      }
      let b = this.localBatches.find(x => x.id === status.id)
      if (!b) {
        b = { id: status.id, name: status.name || '批次', total: status.total, sealed: false, sealing: false, sealError: '', decision: 'wait', sum: localBatchSummary([]) }
        this.localBatches.push(b)
      }
      this.enqueue(files, status.id, this.folderId)
    },
    batchItems(id) { return this.items.filter(i => i.batchId === id) },
    isClosed(id) { const b = this.localBatches.find(x => x.id === id); return !!(b && b.sealed) },
    canRetry(item) { return !item.batchId || !this.isClosed(item.batchId) },
    // 本页的上传全部结束后自动封口；有可重试的上传失败项时交给用户决定（封口后后端不再接收这些文件）
    checkSeal(id) {
      const b = this.localBatches.find(x => x.id === id)
      if (!b) return
      if (b.sealed || b.sealing) return
      const items = this.batchItems(id)
      b.sum = localBatchSummary(items)
      b.decision = sealDecision(items)
      if (b.decision === 'seal' && !b.sealError) this.sealBatch(b)
    },
    async sealBatch(b) {
      if (b.sealed || b.sealing) return
      const pending = this.batchItems(b.id).filter(i => i.state === 'queued' || i.state === 'uploading').length
      if (pending) {
        this.$message.warning(`还有 ${pending} 个文件在上传，等它们结束后再封口`)
        return
      }
      b.sealing = true
      try {
        const s = await kbApi.batchAction(b.id, 'seal')
        if (this.destroyed) return
        b.sealed = true
        b.sealError = ''
        this.$emit('batch-changed', s)
      } catch (e) {
        if (this.destroyed) return
        // 封口是幂等的；失败时不自动重发，由用户点「重新封口」或在批次任务里封口
        b.sealError = e.kind === 'network' || e.kind === 'timeout' ? `${e.message}（结果未知，可再次封口，重复封口无副作用）` : e.message
      } finally {
        b.sealing = false
        this.tick++
      }
    },
    // 批次在别处（批次任务抽屉）被封口或取消：本地不再为它上传
    onBatchClosed(id) {
      const b = this.localBatches.find(x => x.id === id)
      if (b) { b.sealed = true; b.sealError = '' }
      this.queue.cancelAll(i => i.batchId === id)
    },
    localBatchText(b) {
      if (b.sealing) return '正在封口'
      if (b.sealed) return '已封口 · 后台处理以批次任务为准'
      if (b.sealError) return '封口失败'
      if (b.decision === 'wait') return '上传中，结束后自动封口'
      if (b.decision === 'ask') return '有上传失败的文件：重试或封口'
      return '待封口'
    },
    localBatchTone(b) {
      if (b.sealError || b.decision === 'ask') return 'warn'
      return b.sealed ? 'ok' : 'active'
    },
    setConcurrency(n) { this.concurrency = this.queue.setConcurrency(n) },
    // 重试/取消排队项不会触发 onSettled，手动刷新各批次的封口判断
    recheckBatches() { this.localBatches.forEach(b => this.checkSeal(b.id)) },
    retry(item) { this.queue.retry(item.key); this.recheckBatches() },
    retryFailed() { this.queue.retryFailed(); this.recheckBatches() },
    cancel(item) { this.queue.cancel(item.key); this.recheckBatches() },
    cancelAll() { this.queue.cancelAll(); this.recheckBatches() },
    clearDone() { this.queue.clearFinished() },
    settled(item) {
      if (item.batchId) this.checkSeal(item.batchId)
      if (item.state === 'uploaded') {
        this.poller.start()
        // 文件列表刷新做节流，避免 1000 个文件触发 1000 次列表请求
        clearTimeout(this.emitTimer)
        this.emitTimer = setTimeout(() => this.$emit('uploaded'), 800)
      }
      if (!this.isBusy()) this.$emit('finished', summarize(this.items))
    },
    // 解析状态只来自后端：GET /files?ids=（每次最多 50 个）
    async pollStatus() {
      const { batches, nextCursor } = pollIds(this.items, this.pageRows.map(r => r.key), this.pollCursor)
      this.pollCursor = nextCursor
      if (!batches.length) return this.isBusy()
      let changed = false
      for (const ids of batches) {
        const { items } = await kbApi.listFiles({ ids, limit: ids.length })
        if (this.destroyed) return false
        const byId = {}
        items.forEach(f => { byId[f.id] = f })
        this.items.forEach(i => {
          const f = i.result && byId[i.result.id]
          if (!f) return
          if (!i.backend || i.backend.status !== f.status) changed = true
          i.backend = { status: f.status, statusDetail: f.statusDetail, error: f.error, parseVersion: f.parseVersion }
        })
      }
      this.tick++
      return changed ? 'changed' : true
    }
  }
}
</script>
<style scoped lang="less">
.kb-drop {
  border: 1.5px dashed var(--ui-border-strong);
  border-radius: var(--ui-radius-lg);
  padding: 22px 16px;
  text-align: center;
  color: var(--ui-text);
  background: var(--ui-surface);
  cursor: pointer;
  transition: border-color var(--ui-duration) var(--ui-ease), background var(--ui-duration) var(--ui-ease);
  &:hover, &.dragging, &:focus-visible {
    border-color: var(--ui-primary);
    background: var(--ui-primary-soft);
    outline: none;
  }
}
.kb-drop-icon {
  font-size: 30px;
  font-weight: 700;
  color: var(--ui-primary);
  margin-bottom: 6px;
}
.kb-drop-sub {
  margin-top: 4px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.kb-hidden-input { display: none; }
.kb-muted { font-size: 12px; color: var(--ui-text-muted); }
.kb-spacer { flex: 1; }
.kb-queue { margin-top: 12px; }
.kb-queue-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  font-size: 13px;
  color: var(--ui-text-secondary);
  margin-bottom: 6px;
  .is-ok { color: var(--ui-success, #2e7d32); }
  .is-bad { color: var(--ui-danger); }
}
.kb-queue-tools {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin: 8px 0 4px;
}
.kb-queue-conc { width: 64px; }
.kb-queue-warn {
  margin: 4px 0;
  font-size: 12px;
  color: var(--ui-warning, #ad6800);
}
.kb-queue-tip {
  margin: 4px 0;
  font-size: 12px;
  color: var(--ui-success, #2e7d32);
}
.kb-queue-list {
  max-height: 320px;
  overflow: auto;
}
.kb-thin-scroll {
  scrollbar-width: thin;
  scrollbar-color: var(--ui-border-strong) transparent;
  &::-webkit-scrollbar { width: 6px; height: 6px; }
  &::-webkit-scrollbar-thumb { background: var(--ui-border-strong); border-radius: 3px; }
  &::-webkit-scrollbar-track { background: transparent; }
}
.kb-queue-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 0;
  border-bottom: 1px solid var(--ui-border);
  > i { font-weight: 700; color: var(--ui-text-secondary); }
}
.kb-queue-main {
  flex: 1;
  min-width: 0;
}
.kb-queue-name {
  font-size: 13px;
  color: var(--ui-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-bottom: 4px;
}
.kb-queue-error {
  font-size: 12px;
  color: var(--ui-danger);
  margin-top: 2px;
}
.kb-queue-note {
  font-size: 12px;
  color: var(--ui-warning, #ad6800);
  margin-top: 2px;
}
.kb-queue-state {
  font-size: 12px;
  color: var(--ui-text-muted);
  min-width: 96px;
  text-align: right;
  &.is-done { color: var(--ui-success, #2e7d32); }
  &.is-failed, &.is-parse_failed { color: var(--ui-danger); }
  &.is-uploading, &.is-parsing, &.is-structuring { color: var(--ui-primary); }
}
.kb-queue-empty { padding: 12px 0; text-align: center; }
.kb-batch-mode {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}
.kb-local-batch {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 4px 12px;
  margin-top: 8px;
  padding: 8px 12px;
  border: 1px solid var(--ui-border);
  border-left: 3px solid var(--ui-primary);
  border-radius: var(--ui-radius-md);
  background: var(--ui-surface);
  font-size: 13px;
  strong { font-weight: 600; margin-right: 8px; }
  .kb-queue-error { flex-basis: 100%; }
}
.kb-local-batch-main { min-width: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; }
.kb-local-batch-actions { display: flex; gap: 8px; }
.kb-local-batch-state {
  font-size: 12px;
  &.is-ok { color: var(--ui-success, #2e7d32); }
  &.is-warn { color: var(--ui-warning, #ad6800); }
  &.is-active { color: var(--ui-primary); }
}
.kb-queue-pager { margin-top: 6px; }
.kb-folder-job {
  margin-top: 10px;
  padding: 8px 12px;
  border: 1px solid var(--ui-border);
  border-left: 3px solid var(--ui-primary);
  border-radius: var(--ui-radius-md);
  background: var(--ui-surface);
  font-size: 13px;
  strong { font-weight: 600; }
}
.kb-folder-job-main { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; }
.kb-folder-job-list { max-height: 160px; overflow: auto; margin-top: 6px; }
.kb-folder-job-path { word-break: break-all; }
</style>
