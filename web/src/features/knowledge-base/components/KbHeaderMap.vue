<template>
  <div v-if="fileId" class="kb-card kb-header-map">
    <div class="kb-pane-title">
      表头与字段映射
      <template v-if="sheet">
        <el-tag v-if="sheet.detection.confirmed" size="mini" type="success">已人工确认</el-tag>
        <template v-else>
          <span v-if="sheet.detection.confidence != null" class="kb-muted">后端自动检测置信度 {{ percent(sheet.detection.confidence) }}</span>
          <el-tag v-if="sheet.detection.needsConfirmation" size="mini" type="warning">待确认</el-tag>
        </template>
        <el-tag v-if="sheet.dirty" size="mini" type="info">已修改未保存</el-tag>
      </template>
    </div>
    <KbStateBlock :loading="loading" :error="error" :empty="!sheets.length" empty-title="没有可识别的工作表" @retry="load">
      <div v-if="tracking" class="kb-map-track" :class="'is-' + tracking.phase">
        <i :class="tracking.phase === 'running' ? 'el-icon-loading' : tracking.phase === 'ok' ? 'el-icon-circle-check' : 'el-icon-warning-outline'" aria-hidden="true" />
        <span>{{ tracking.text }}</span>
        <el-button v-if="tracking.phase !== 'running'" type="text" size="mini" @click="tracking = null">知道了</el-button>
      </div>
      <template v-if="sheet">
        <div class="kb-map-sheet">
          <span class="kb-muted">工作表</span>
          <el-select v-model="sheetIndex" size="small" popper-class="kb-popper">
            <el-option v-for="(item, i) in sheets" :key="item.name" :label="sheetLabel(item, i)" :value="i" />
          </el-select>
          <el-checkbox v-model="sheet.include">本次提交此工作表</el-checkbox>
          <span v-if="!sheet.include" class="kb-muted">{{ sheet.detection.confirmed ? '未提交的工作表保留当前已确认的表头和字段名' : '未提交的工作表由后端自动检测表头' }}</span>
        </div>
        <p v-if="sheet.detection.needsConfirmation && !sheet.detection.confirmed" class="kb-map-warn">自动识别结果需要核对。请选择解析方式，确认表头、数据起始行与字段映射后再入库。</p>
        <p class="kb-muted kb-map-reason">
          <template v-if="sheet.detection.reason">判断依据：{{ sheet.detection.reason }}</template>
          <template v-else-if="!sheet.detection.confirmed">后端未提供检测原因。</template>
          <template v-if="sheet.detection.regionCount > 1"> 后端在此工作表检测到 {{ sheet.detection.regionCount }} 个表格区域。</template>
        </p>
        <div v-if="sheet.mode !== 'form' && sheet.detection.regionCount > 1" class="kb-map-warn">
          同一工作表多个表格的独立映射暂不支持：结构化接口目前每个工作表只接受一套表头（没有 table_index），提交后数据起始行之后的所有行都会按这一套表头入库。
          <el-select size="mini" disabled placeholder="按表格区域分别映射（暂不支持）" popper-class="kb-popper" class="kb-map-table-select" />
        </div>

        <div class="kb-map-config">
          <label>
            <span>解析方式</span>
            <el-select :value="sheet.mode" size="small" popper-class="kb-popper" @change="changeMode">
              <el-option label="明细表（每行一条记录）" value="table" />
              <el-option label="纵向表单（整表一条记录）" value="form" />
              <el-option label="辅助表（只保留原文）" value="skip" />
            </el-select>
          </label>
          <label v-if="sheet.mode !== 'skip'">
            <span>表头行</span>
            <el-input v-model="headerInput" size="small" placeholder="如 2 或 2,3" class="kb-map-input" @change="applyHeaderInput" @keyup.enter.native="applyHeaderInput" />
          </label>
          <label v-if="sheet.mode !== 'skip'">
            <span>数据起始行</span>
            <el-input-number :value="sheet.dataStartRow" size="small" :min="1" :max="maxRowLimit" controls-position="right" @change="applyDataStart" />
          </label>
          <label>
            <span>跳到第</span>
            <el-input-number v-model="jumpRow" size="small" :min="1" :max="maxRowLimit" controls-position="right" />
            <span>行</span>
            <el-button size="small" @click="jump">定位</el-button>
          </label>
        </div>
        <p v-if="sheet.mode === 'skip'" class="kb-map-warn">此工作表作为辅助字典或说明保留原文，不生成字段和记录。请保持勾选「本次提交此工作表」并核对后提交，让后端保存此设置。</p>
        <template v-if="sheet.mode === 'form'">
          <p class="kb-map-warn">适用于供应商资料等逐项填写的表单。字段名和填写值来自指定列；分类继承上方分组，电话结合联系人命名，空值和说明保留。核对完整预览后，整张工作表生成一条记录。</p>
          <div class="kb-map-config">
            <label v-for="item in formColumnLabels" :key="item.key">
              <span>{{ item.label }}</span>
              <el-select :value="sheet.form[item.key]" size="small" popper-class="kb-popper" @change="v => changeFormColumn(item.key, v)">
                <el-option v-if="item.optional" label="不使用" :value="-1" />
                <el-option v-for="c in sourceColumns" :key="c" :label="letter(c) + ' 列'" :value="c" />
              </el-select>
            </label>
          </div>
        </template>
        <div class="kb-map-source kb-muted">
          <template v-if="currentRaw">
            已只读读取原文件中的此工作表：{{ currentRaw.truncated ? `共 ${currentRaw.fullRows} 行，本地只读取前 ${knownRows} 行（更多行需后端分页预览）` : `共 ${knownRows} 行` }}。原始文件不会被修改。
          </template>
          <template v-else>
            当前只有后端预览的前 {{ knownRows }} 行。
            <el-button v-if="rawState !== 'too_large'" type="text" size="mini" :loading="rawState === 'loading'" @click="ensureRaw()">读取原文件（只读）以浏览和选择任意行</el-button>
            <span v-if="rawState === 'error' || rawState === 'too_large'" class="kb-map-err">{{ rawError }}</span>
          </template>
          点击行号设为/取消表头（可多选），说明行会保留成原文，不会变成字段。
        </div>

        <div class="kb-map-scroll kb-thin-scroll">
          <table class="kb-map-grid">
            <thead>
              <tr>
                <th class="kb-map-rowno">行</th>
                <th class="kb-map-role" />
                <th v-for="c in gridCols" :key="c">{{ letter(c) }}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <tr v-for="line in pageRows" :key="line.number" :class="'is-' + role(line.number)">
                <th class="kb-map-rowno">
                  <button type="button" :title="'把第 ' + line.number + ' 行设为/取消表头'" @click="toggleHeader(line.number)">{{ line.number }}</button>
                </th>
                <td class="kb-map-role">{{ roleLabel(line.number) }}</td>
                <td v-for="c in gridCols" :key="c" :title="text(line.values[c])">{{ text(line.values[c]) }}</td>
                <td class="kb-map-action">
                  <button type="button" @click="applyDataStart(line.number)">数据从这行开始</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <el-pagination
          v-if="knownRows > pageSize"
          small
          layout="prev, pager, next, total"
          :total="knownRows"
          :page-size="pageSize"
          :current-page.sync="sheetPage"
          class="kb-map-pager"
        />

        <div v-if="notes.length" class="kb-map-notes">
          <div class="kb-map-sub">说明行（保留为原文，不作为字段）</div>
          <div v-for="n in notes" :key="n.row" class="kb-map-note"><span>第 {{ n.row }} 行</span>{{ n.text }}</div>
        </div>

        <template v-if="sheet.mode !== 'skip'">
        <div class="kb-map-sub">字段名（{{ fields.length }} 个）<span class="kb-muted">{{ sheet.mode === 'form' ? '字段从表单项目生成；左侧为字段名所在单元格' : '「自动」随表头行重新计算；手工改过的名字按列保留，不会被覆盖' }}</span></div>
        <div v-if="sheet.pendingRows.length" class="kb-map-warn">表头行 {{ sheet.pendingRows.join('、') }} 尚未读取，字段名未重新计算。</div>
        <div class="kb-map-fields">
          <label v-for="f in fields" :key="f.index" :class="'is-' + f.source">
            <span class="kb-map-letter">{{ fieldLocation(f) }}</span>
            <el-input :value="f.source === 'auto' ? f.auto : rawUser(f.index)" size="small" :placeholder="f.auto" @input="v => rename(f.index, v)" />
            <el-tag size="mini" :type="f.source === 'auto' ? 'info' : 'warning'">{{ sourceLabel(f.source) }}</el-tag>
            <el-button v-if="f.source !== 'auto'" type="text" size="mini" :title="'恢复为：' + f.auto" @click="resetName(f.index)">恢复自动</el-button>
          </label>
        </div>

        <div class="kb-map-sub">入库预览<span class="kb-muted">（行号为 Excel 中的行号）</span></div>
        <div class="kb-map-scroll kb-thin-scroll kb-map-preview">
          <table class="kb-map-grid">
            <thead>
              <tr>
                <th class="kb-map-rowno">Excel 行</th>
                <th v-for="f in fields" :key="f.index">{{ f.name || '（空）' }}<small> {{ fieldLocation(f) }}</small></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in sample.rows" :key="r.row">
                <th class="kb-map-rowno">{{ r.row }}</th>
                <td v-for="(v, i) in r.values" :key="i" :title="v">{{ v }}</td>
              </tr>
              <tr v-if="!sample.rows.length">
                <td :colspan="fields.length + 1" class="kb-muted">{{ sample.incomplete ? '数据行尚未读取，请读取原文件查看样例' : '没有可预览的数据行' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="sample.incomplete && sample.rows.length" class="kb-muted">样例只覆盖已读取的行。</p>
        </template>

        <div v-if="problems.length" class="kb-map-problems">
          <div class="kb-map-sub">提交前需要处理</div>
          <div v-for="p in problems" :key="p.name" class="kb-map-problem">
            <button type="button" class="kb-map-link" @click="focusSheet(p.name)">{{ p.name || '全部' }}</button>
            <span>{{ p.errors.join('；') }}</span>
          </div>
        </div>

        <div class="kb-map-bar">
          <el-checkbox :value="sheet.reviewed || (sheet.detection.confirmed && !sheet.dirty)" :disabled="(sheet.detection.confirmed && !sheet.dirty) || (sheet.mode === 'form' && !sheet.formComplete)" @change="v => review(v)">已核对「{{ sheet.name }}」的{{ sheet.mode === 'skip' ? '辅助表设置' : '表头与字段' }}</el-checkbox>
          <span class="kb-muted">表头行 {{ headerText }} · 数据从第 {{ sheet.dataStartRow || '—' }} 行 · 提交 {{ includedCount }} 个工作表</span>
          <el-button size="small" type="primary" :loading="saving" :disabled="!!(tracking && tracking.phase === 'running')" @click="save">按此映射重新结构化</el-button>
        </div>
      </template>
    </KbStateBlock>
  </div>
</template>
<script>
import kbApi from '../services/kbApi'
import { createPoller } from '../services/kbPolling'
import { ACTIVE_STATUSES } from '../constants/status'
import { markStructureChanged } from '../services/kbSignals'
import KbStateBlock from './KbStateBlock.vue'
import {
  createSheetState, effectiveFields, setHeaderRows, toggleHeaderRow, setDataStartRow, setFieldName, resetFieldName,
  markReviewed, validateAll, buildStructurePayload, dataSample, noteRows, rowRole, parseRowList, formatRowList,
  inferSavedOverrides, recomputeFields, rowsFromAoa, mergesFromSheetJs, colLetter, cellText, setMappingMode, setFormColumn
} from '../utils/headerMapping'

const ROLE_LABELS = { header: '表头', data: '数据', note: '说明' }
const SOURCE_LABELS = { auto: '自动', user: '手工', saved: '已保存' }
const GRID_COLS = 60
// 浏览器本地解析的保护上限：后端单文件上限是 100 MiB，但整本 xlsx 在浏览器解析的内存是文件大小的数倍到数十倍
const LOCAL_PARSE_MAX_BYTES = 20 * 1024 * 1024
const LOCAL_MAX_ROWS = 20000
const formatMb = n => `${(Number(n) / 1048576).toFixed(1)} MB`

export default {
  name: 'KbHeaderMap',
  components: { KbStateBlock },
  props: { fileId: { type: String, default: '' }, fileSize: { type: Number, default: 0 }, active: { type: Boolean, default: false } },
  data() {
    return {
      sheets: [], sheetIndex: 0, loading: false, error: null, saving: false,
      rawState: 'none', rawError: '', version: 0,
      pageSize: 20, pages: {}, jumpRow: 1, headerInput: '', showProblems: false, tracking: null
    }
  },
  computed: {
    sheet() { return this.sheets[this.sheetIndex] || null },
    getRow() {
      void this.version
      return this.sheet ? this.rowGetter(this.sheet.name) : () => null
    },
    knownRows() { void this.version; return this.sheet ? this.maxKnownRow(this.sheet.name) : 0 },
    currentRaw() { void this.version; return this.sheet && this.store.raw ? this.store.raw[this.sheet.name] || null : null },
    maxRowLimit() { return this.currentRaw && !this.currentRaw.truncated ? Math.max(1, this.knownRows + 1) : 1000000 },
    sheetPage: {
      get() { return (this.sheet && this.pages[this.sheet.name]) || 1 },
      set(v) { if (this.sheet) this.$set(this.pages, this.sheet.name, v) }
    },
    pageRows() {
      if (!this.sheet) return []
      const out = []
      const start = (this.sheetPage - 1) * this.pageSize + 1
      for (let n = start; n < start + this.pageSize && n <= this.knownRows; n++) {
        const r = this.getRow(n)
        out.push(r || { number: n, values: [] })
      }
      return out
    },
    fields() { return this.sheet ? effectiveFields(this.sheet) : [] },
    formColumnLabels() {
      return [{ key: 'fieldColumn', label: '字段名列' }, { key: 'valueColumn', label: '填写值列' },
        { key: 'groupColumn', label: '分类列', optional: true }, { key: 'requiredColumn', label: '必填标记列', optional: true },
        { key: 'noteColumn', label: '说明列', optional: true }]
    },
    sourceColumns() {
      return Array.from({ length: Math.min(500, (this.sheet && this.sheet.columnCount) || 2) }, (_, i) => i)
    },
    gridCols() {
      const width = Math.max(this.sheet && this.sheet.mode === 'form' ? 0 : this.fields.length, ...this.pageRows.map(r => (r.values || []).length), 1)
      return Array.from({ length: Math.min(width, GRID_COLS) }, (_, i) => i)
    },
    sample() {
      if (!this.sheet) return { rows: [], incomplete: false }
      return dataSample(this.sheet, this.getRow, { limit: 5, maxRow: this.currentRaw && !this.currentRaw.truncated ? this.knownRows : null })
    },
    notes() { return this.sheet ? noteRows(this.sheet, this.getRow) : [] },
    headerText() { return this.sheet && this.sheet.headerRows.length ? this.sheet.headerRows.join('、') : '—' },
    includedCount() { return this.sheets.filter(s => s.include).length },
    validation() {
      void this.version
      return validateAll(this.sheets, { maxKnownRow: s => (this.rawReady(s.name) && !this.store.raw[s.name].truncated ? null : this.maxKnownRow(s.name)) })
    },
    problems() {
      if (!this.showProblems) return []
      const list = this.validation.sheets.filter(s => s.errors.length)
      return this.validation.global.length ? [{ name: '', errors: this.validation.global }].concat(list) : list
    }
  },
  watch: {
    fileId: { immediate: true, handler() { this.load() } },
    active(v, prev) { if (prev && !v && !this.tracking) this.load() },
    sheet: { immediate: true, handler(s) { this.headerInput = s ? formatRowList(s.headerRows) : '' } }
  },
  created() {
    this.store = { preview: {}, raw: null, buffer: null }
    this.poller = createPoller(() => this.trackTick(), { min: 3000 })
  },
  beforeDestroy() {
    this.poller.stop()
    this.store = { preview: {}, raw: null, buffer: null } // 释放原文件字节
  },
  methods: {
    percent(n) { return n == null ? '—' : `${Math.round(Number(n) * 100)}%` },
    letter: colLetter,
    text: cellText,
    sourceLabel(s) { return SOURCE_LABELS[s] || s },
    fieldLocation(f) { return this.sheet.mode === 'form' ? ((this.sheet.formEntries[f.index] || {}).fieldCell || '—') : f.letter },
    async changeMode(mode) {
      const s = this.sheet
      if (!s) return
      if (mode === 'form' && !(await this.ensureRaw(s.name))) return
      setMappingMode(s, mode, this.rowGetter(s.name), this.merges(s.name))
      this.bump()
    },
    async changeFormColumn(key, value) {
      const s = this.sheet
      if (!s || !(await this.ensureRaw(s.name))) return
      setFormColumn(s, key, value, this.rowGetter(s.name), this.merges(s.name))
      this.bump()
    },
    role(n) { return this.sheet ? rowRole(this.sheet, n) : 'note' },
    roleLabel(n) { return ROLE_LABELS[this.role(n)] },
    rawUser(index) {
      const f = this.sheet.fields.find(x => x.index === index)
      return f && f.user != null ? f.user : ''
    },
    sheetLabel(s, i) {
      const v = this.validation.sheets[i]
      const mark = !s.include ? '（不提交）' : v && v.errors.length ? '（待处理）' : '（可提交）'
      return s.name + mark
    },
    rowGetter(name) {
      const raw = this.store.raw && this.store.raw[name]
      if (raw) return n => raw.rows[n - 1] || (n <= raw.rows.length ? { number: n, values: [] } : null)
      const map = this.store.preview[name]
      return n => (map && map.get(n)) || null
    },
    merges(name) {
      const raw = this.store.raw && this.store.raw[name]
      const s = this.sheets.find(s => s.name === name)
      return raw ? raw.merges : (s && s.merges) || []
    },
    maxKnownRow(name) {
      const raw = this.store.raw && this.store.raw[name]
      if (raw) return raw.rows.length
      const map = this.store.preview[name]
      return map && map.size ? Math.max(...map.keys()) : 0
    },
    bump() { this.version++ },
    async load() {
      this.sheets = []
      this.error = null
      this.store = { preview: {}, raw: null, buffer: null }
      this.rawState = 'none'
      this.rawError = ''
      this.pages = {}
      this.showProblems = false
      if (!this.fileId) return
      this.loading = true
      try {
        const res = await kbApi.previewLayout(this.fileId)
        const list = res.sheets || []
        list.forEach(s => {
          this.store.preview[s.name] = new Map((s.preview || []).map(r => [Number(r.row), { number: Number(r.row), values: r.values || [] }]))
        })
        this.sheets = list.map(createSheetState)
        this.sheetIndex = 0
        this.bump()
      } catch (e) {
        this.error = e
      } finally {
        this.loading = false
      }
    },
    // 文件过大不能本地解析时的退路：表头行都在后端预览里，就用预览值推断上次保存的人工列名。
    // 预览不含合并单元格信息，可能把合并表头列多标成「已保存」；这只会原样保留当前名字，用户可点「恢复自动」。
    inferFromPreview(s) {
      if (this.rawState !== 'too_large' || !s.detection.confirmed || s.savedInferred) return false
      const ok = inferSavedOverrides(s, this.rowGetter(s.name), [])
      if (ok) this.bump()
      return ok
    },
    rawReady(name) { return !!(this.store.raw && this.store.raw[name]) },
    // 只读：下载原文件到浏览器内存，只解析需要的那一张工作表，且最多 LOCAL_MAX_ROWS 行，绝不回写。
    // 超过 LOCAL_PARSE_MAX_BYTES 的文件不在浏览器解析（xlsx 解压 + 解析的内存约为文件大小的数倍到数十倍），等待后端分页预览接口。
    async ensureRaw(name) {
      const sheetName = name || (this.sheet && this.sheet.name)
      if (!sheetName) return false
      if (this.rawReady(sheetName)) return true
      if (this.fileSize > LOCAL_PARSE_MAX_BYTES) {
        this.rawState = 'too_large'
        this.rawError = `文件 ${formatMb(this.fileSize)} 超过浏览器本地解析上限 ${formatMb(LOCAL_PARSE_MAX_BYTES)}，为避免页面内存溢出不在本地读取；只能使用后端预览的前 ${this.maxKnownRow(sheetName)} 行，任意行预览需等待后端分页预览接口`
        return false
      }
      const fileId = this.fileId
      try {
        this.rawState = 'loading'
        this.rawError = ''
        if (!this.store.buffer) {
          if (!this.bufferPromise) {
            this.bufferPromise = Promise.all([import(/* webpackChunkName: "file-kb" */ 'xlsx'), kbApi.getRaw(fileId)])
              .finally(() => { this.bufferPromise = null })
          }
          const [XLSX, buf] = await this.bufferPromise
          if (fileId !== this.fileId) return false
          this.xlsx = XLSX
          this.store.buffer = buf
        }
        if (this.rawReady(sheetName)) { this.rawState = 'ready'; return true }
        const XLSX = this.xlsx
        const wb = XLSX.read(new Uint8Array(this.store.buffer), { type: 'array', cellDates: true, sheets: [sheetName], sheetRows: LOCAL_MAX_ROWS })
        const ws = wb.Sheets[sheetName]
        let aoa = []
        let fullRows = 0
        if (ws && ws['!ref']) {
          const ref = XLSX.utils.decode_range(ws['!ref'])
          fullRows = ws['!fullref'] ? XLSX.utils.decode_range(ws['!fullref']).e.r + 1 : ref.e.r + 1
          // 强制从 A1 开始，aoa[0] 就是 Excel 第 1 行，避免有效区域不从 A1 开始时行号偏移
          aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true, range: { s: { r: 0, c: 0 }, e: ref.e } })
        }
        const rows = Object.freeze(rowsFromAoa(aoa, 1))
        const truncated = fullRows > rows.length
        this.store.raw = { ...(this.store.raw || {}), [sheetName]: Object.freeze({ rows, merges: mergesFromSheetJs(ws && ws['!merges']), truncated, fullRows }) }
        this.rawState = 'ready'
        const s = this.sheets.find(x => x.name === sheetName)
        if (s) {
          s.rowCount = fullRows
          const get = this.rowGetter(sheetName)
          const merges = this.store.raw[sheetName].merges
          if (s.mode === 'form') recomputeFields(s, get, merges)
          if (s.mode === 'form' && truncated) s.formComplete = false
          if (s.detection.confirmed) inferSavedOverrides(s, get, merges)
          if (s.mode !== 'form' && (s.autoSource === 'recomputed' || s.pendingRows.length)) recomputeFields(s, get, merges)
        }
        this.bump()
        return true
      } catch (e) {
        this.rawState = 'error'
        this.rawError = e && e.__kb ? e.message : '原文件读取或解析失败（可能是文件过大或浏览器内存不足）'
        return false
      }
    },
    // 已确认版本：先用原表推断哪些列名是上次的人工改名，再改表头，避免改名丢失
    async prepare(s, rows) {
      const beyond = (rows || []).some(n => n > this.maxKnownRow(s.name))
      if ((s.detection.confirmed && !s.savedInferred) || beyond) {
        const ok = (await this.ensureRaw(s.name)) || this.inferFromPreview(s)
        if (!ok && s.detection.confirmed && !s.savedInferred) {
          this.$message.error('读取原文件失败，无法确认上次保存的人工字段名，暂不修改表头')
          return false
        }
      }
      return true
    },
    async applyHeaderInput() {
      const s = this.sheet
      if (!s) return
      const rows = parseRowList(this.headerInput)
      if (!rows) { this.$message.error('表头行格式不正确，例如：2 或 2,3 或 2-3'); return }
      if (rows.join(',') === s.headerRows.join(',')) return
      if (!(await this.prepare(s, rows))) { this.headerInput = formatRowList(s.headerRows); return }
      setHeaderRows(s, rows, this.rowGetter(s.name), this.merges(s.name))
      this.headerInput = formatRowList(s.headerRows)
      this.bump()
    },
    async toggleHeader(n) {
      const s = this.sheet
      if (s && s.mode === 'skip') return
      if (!s || !(await this.prepare(s, [n]))) return
      toggleHeaderRow(s, n, this.rowGetter(s.name), this.merges(s.name))
      this.headerInput = formatRowList(s.headerRows)
      this.bump()
    },
    async applyDataStart(n) {
      const s = this.sheet
      if (s && s.mode === 'skip') return
      if (!s || n == null) return
      if (n > this.maxKnownRow(s.name) && !this.rawReady(s.name)) await this.ensureRaw(s.name)
      setDataStartRow(s, n)
      if (s.mode === 'form') recomputeFields(s, this.rowGetter(s.name), this.merges(s.name))
      this.bump()
    },
    async jump() {
      const s = this.sheet
      if (!s) return
      const n = Number(this.jumpRow) || 1
      if (n > this.maxKnownRow(s.name) && !this.rawReady(s.name)) await this.ensureRaw(s.name)
      const max = this.maxKnownRow(s.name)
      if (n > max) this.$message.warning(`工作表只有 ${max} 行`)
      this.sheetPage = Math.max(1, Math.ceil(Math.min(n, max || 1) / this.pageSize))
    },
    rename(index, v) { setFieldName(this.sheet, index, v); this.bump() },
    resetName(index) { resetFieldName(this.sheet, index); this.bump() },
    review(v) { markReviewed(this.sheet, v); this.bump() },
    focusSheet(name) {
      const i = this.sheets.findIndex(s => s.name === name)
      if (i >= 0) this.sheetIndex = i
    },
    async save() {
      this.showProblems = true
      for (const s of this.sheets.filter(s => s.include && s.mode === 'form' && !s.formComplete)) {
        if (!(await this.ensureRaw(s.name))) { this.focusSheet(s.name); return }
      }
      // 已确认的工作表：提交前必须先从原表识别上次保存的人工改名，否则会被后端按表头重算而丢失
      const needInfer = this.sheets.filter(s => s.include && s.detection.confirmed && !s.savedInferred)
      for (const s of needInfer) {
        const ok = (await this.ensureRaw(s.name)) || this.inferFromPreview(s)
        if (!ok) {
          this.focusSheet(s.name)
          this.$message.error(`「${s.name}」：${this.rawState === 'too_large' ? this.rawError : '读取原文件失败'}，无法核对上次保存的人工字段名，已停止提交`)
          return
        }
      }
      this.bump()
      const v = this.validation
      if (!v.ok) {
        const first = v.sheets.find(s => s.errors.length)
        if (first) this.focusSheet(first.name)
        this.$message.error(v.global[0] || `「${first.name}」：${first.errors[0]}`)
        return
      }
      this.saving = true
      try {
        const body = buildStructurePayload(this.sheets)
        const res = await kbApi.restructureFile(this.fileId, body)
        this.tracking = { phase: 'running', runId: res && res.runId, jobId: res && res.jobId, text: `已提交结构化任务${res && res.jobId ? `（任务 ${res.jobId}）` : ''}，等待后端完成…` }
        this.sheets.forEach(s => { s.dirty = false })
        this.$emit('submitted', res)
        this.poller.start()
      } catch (e) {
        this.$message.error(e.message)
      } finally {
        this.saving = false
      }
    },
    // 用真实接口刷新：文件状态、解析版本、字段数、记录数
    async trackTick() {
      if (!this.tracking || this.tracking.phase !== 'running') return false
      const file = await kbApi.getFile(this.fileId)
      if (ACTIVE_STATUSES.includes(file.status)) return true
      const [fields, records] = await Promise.all([
        kbApi.listFields({ fileId: this.fileId }).catch(() => null),
        kbApi.listRecords({ fileId: this.fileId, limit: 1 }).catch(() => null)
      ])
      const applied = this.tracking.runId && file.currentRunId === this.tracking.runId
      const counts = `解析版本 ${file.parseVersion != null ? file.parseVersion : '—'} · 字段 ${fields ? fields.items.length : '—'} · 记录 ${records && records.total != null ? records.total : '—'}`
      this.tracking = applied
        ? { phase: 'ok', text: `结构化完成，本次映射已成为当前版本。${counts}` }
        : { phase: 'warn', text: `结构化已结束，但本次映射没有成为当前版本（文件状态：${file.status}${file.error ? `，${file.error}` : ''}）。当前：${counts}` }
      markStructureChanged(this.fileId)
      this.$emit('done', { file, fields: fields && fields.items, total: records && records.total })
      await this.load()
      return false
    }
  }
}
</script>
<style scoped lang="less">
.kb-header-map { margin: 12px 0; }
.kb-pane-title { display: flex; align-items: center; gap: 8px; font-weight: 600; margin-bottom: 8px; }
.kb-muted { font-size: 12px; color: var(--ui-text-muted); font-weight: 400; }
.kb-map-warn {
  margin: 0 0 8px;
  padding: 8px 10px;
  border-radius: var(--ui-radius-md);
  background: var(--ui-warning-soft, #fff7e8);
  color: var(--ui-warning, #ad6800);
  font-size: 13px;
}
.kb-map-table-select { margin-left: 8px; width: 220px; }
.kb-map-reason { margin: 0 0 8px; }
.kb-map-err { color: var(--ui-danger); margin: 0 6px; }
.kb-map-sheet, .kb-map-config { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 16px; margin-bottom: 8px; }
.kb-map-config label { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--ui-text-secondary); }
.kb-map-input { width: 120px; }
.kb-map-source { margin-bottom: 8px; }
.kb-map-track {
  display: flex; align-items: center; gap: 8px; margin-bottom: 8px; padding: 8px 10px; font-size: 13px;
  border-radius: var(--ui-radius-md); background: var(--ui-surface-muted, var(--ui-primary-soft)); color: var(--ui-text);
  &.is-ok { color: var(--ui-success, #2e7d32); }
  &.is-warn { background: var(--ui-warning-soft, #fff7e8); color: var(--ui-warning, #ad6800); }
}
.kb-map-scroll { overflow: auto; max-height: 300px; border: 1px solid var(--ui-border); border-radius: var(--ui-radius-md); }
.kb-map-preview { max-height: 220px; }
.kb-thin-scroll {
  scrollbar-width: thin;
  scrollbar-color: var(--ui-border-strong) transparent;
  &::-webkit-scrollbar { width: 6px; height: 6px; }
  &::-webkit-scrollbar-thumb { background: var(--ui-border-strong); border-radius: 3px; }
  &::-webkit-scrollbar-track { background: transparent; }
}
.kb-map-grid { border-collapse: collapse; font-size: 12px; white-space: nowrap; color: var(--ui-text); }
.kb-map-grid th, .kb-map-grid td { border-bottom: 1px solid var(--ui-border); padding: 4px 8px; max-width: 180px; overflow: hidden; text-overflow: ellipsis; text-align: left; }
.kb-map-grid thead th { position: sticky; top: 0; background: var(--ui-surface); color: var(--ui-text-secondary); font-weight: 600; z-index: 1; }
.kb-map-grid small { color: var(--ui-text-muted); font-weight: 400; }
.kb-map-rowno { color: var(--ui-text-muted); }
.kb-map-role { color: var(--ui-text-muted); }
.kb-map-grid th button, .kb-map-action button, .kb-map-link {
  border: 0; background: transparent; color: var(--ui-text-muted); cursor: pointer; font: inherit; padding: 0;
  &:hover { color: var(--ui-primary); }
}
.kb-map-grid tr.is-header { background: var(--ui-brand-soft, var(--ui-primary-soft)); }
.kb-map-grid tr.is-note { color: var(--ui-text-muted); }
.kb-map-pager { margin-top: 6px; }
.kb-map-sub { margin: 12px 0 6px; font-size: 13px; font-weight: 600; color: var(--ui-text); .kb-muted { margin-left: 6px; } }
.kb-map-notes { font-size: 12px; color: var(--ui-text-secondary); }
.kb-map-note { padding: 2px 0; span { color: var(--ui-text-muted); margin-right: 8px; } }
.kb-map-fields { display: flex; flex-wrap: wrap; gap: 8px; }
.kb-map-fields label { display: flex; align-items: center; gap: 4px; width: 260px; font-size: 12px; }
.kb-map-letter { min-width: 22px; flex-shrink: 0; color: var(--ui-text-muted); }
.kb-map-problems { margin-top: 10px; padding: 8px 10px; border-radius: var(--ui-radius-md); background: var(--ui-danger-soft, rgba(245, 108, 108, 0.1)); font-size: 12px; color: var(--ui-danger); }
.kb-map-problem { padding: 2px 0; .kb-map-link { color: var(--ui-danger); font-weight: 600; margin-right: 8px; text-decoration: underline; } }
.kb-map-bar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-top: 10px; }
</style>
