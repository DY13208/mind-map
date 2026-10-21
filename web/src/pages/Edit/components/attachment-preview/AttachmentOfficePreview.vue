<template>
  <section class="attachmentOfficeLayout" :class="{ 'is-spreadsheet': spreadsheet }">
    <div v-if="loading" class="attachmentViewerState" role="status"><i class="el-icon-loading"></i><strong>正在解析文档…</strong></div>
    <div v-else-if="error" class="attachmentViewerState" role="alert"><i class="el-icon-warning-outline"></i><strong>{{ error }}</strong><el-button size="small" @click="$emit('download')">下载原文件</el-button></div>
    <template v-else-if="spreadsheet">
      <nav class="attachmentSheetTabs" aria-label="工作表">
        <button v-for="sheet in sheets" :key="sheet.name" type="button" :class="{ active: sheet.name === activeSheet }" :aria-current="sheet.name === activeSheet ? 'page' : null" @click="selectSheet(sheet.name)">{{ sheet.name }}</button>
      </nav>
      <div ref="sheetViewport" class="attachmentSpreadsheetViewport" tabindex="0" role="region" :aria-label="activeSheet + ' 工作表'" @scroll.passive="onSheetScroll">
        <p v-if="!currentSheet.rows" class="attachmentEmptySheet">此工作表没有数据</p>
        <table class="attachmentSpreadsheet">
          <thead><tr><th>#</th><th v-for="column in currentSheet.columns" :key="column">{{ columnName(column - 1) }}</th></tr></thead>
          <tbody>
            <tr v-if="rowStart" class="sheetSpacer" aria-hidden="true"><td :colspan="currentSheet.columns + 1" :style="{ height: rowStart * 36 + 'px' }"></td></tr>
            <tr v-for="(row, index) in rows" :key="rowStart + index"><th>{{ rowStart + index + 1 }}</th><td v-for="column in currentSheet.columns" :key="column" :title="row[column - 1] || ''">{{ row[column - 1] || '' }}</td></tr>
            <tr v-if="remainingRows" class="sheetSpacer" aria-hidden="true"><td :colspan="currentSheet.columns + 1" :style="{ height: remainingRows * 36 + 'px' }"></td></tr>
          </tbody>
        </table>
      </div>
      <div class="attachmentSheetStatus" role="status">{{ currentSheet.rows }} 行 · {{ currentSheet.columns }} 列<template v-if="currentSheet.truncated"> · 已按预览上限截取</template><span v-if="rowsLoading"> · 正在加载…</span></div>
    </template>
    <template v-else>
      <aside v-if="outline.length > 1" class="attachmentOutline" aria-label="Word 大纲">
        <h3>大纲</h3><button v-for="item in outline" :key="item.index" type="button" @click="goToSection(item.index)">{{ item.title }}</button>
      </aside>
      <div ref="docxViewport" class="attachmentWordViewport" tabindex="0" aria-label="Word 文档内容" @scroll.passive="onWordScroll">
        <div ref="docxContent" class="attachmentWordDocument"></div>
        <div class="attachmentLoadSentinel" role="status">
          <template v-if="moreLoading"><i class="el-icon-loading"></i> 正在加载…</template>
          <button v-else-if="hasMoreWord" type="button" @click="appendWord">继续加载</button>
        </div>
      </div>
    </template>
  </section>
</template>
<script>
import { fetchNodeAttachmentContent } from '@/utils/nodeAttachmentApi'
import { isSpreadsheetAttachment, OFFICE_PREVIEW_MAX_BYTES, assertOfficeZipBudget } from '@/utils/nodeAttachmentPreview'
import { previewAssetUrl } from '@/utils/attachmentPreviewRuntime'
const abortError = () => new DOMException('cancelled', 'AbortError')
function elementText(element) {
  return String(element.text || '') + (element.children || []).map(elementText).join('')
}
export default {
  props: { source: { type: Object, required: true } },
  data: () => ({ loading: true, error: '', sheets: [], activeSheet: '', rows: [], rowStart: 0, rowsLoading: false, outline: [], hasMoreWord: false, moreLoading: false }),
  computed: {
    spreadsheet() { return isSpreadsheetAttachment(this.source.fileName, this.source.mimeType) },
    currentSheet() { return this.sheets.find(sheet => sheet.name === this.activeSheet) || { rows: 0, columns: 0 } },
    remainingRows() { return Math.max(0, this.currentSheet.rows - this.rowStart - this.rows.length) }
  },
  mounted() {
    this._requests = new Map()
    this._cache = new Map()
    this._requestId = 0
    this._sheetEpoch = 0
    this._rowEpoch = 0
    this.load()
  },
  beforeDestroy() {
    this._disposed = true
    if (this._controller) this._controller.abort()
    if (this._worker) this._worker.terminate()
    if (this._scrollFrame) cancelAnimationFrame(this._scrollFrame)
    for (const pending of this._requests.values()) { clearTimeout(pending.timer); pending.reject(abortError()) }
    this._requests.clear()
    this._cache.clear()
    this._doc = null
    this._blocks = null
  },
  methods: {
    workerCall(message, transfers = []) {
      return new Promise((resolve, reject) => {
        const id = ++this._requestId
        const timer = setTimeout(() => {
          this._requests.delete(id)
          reject(new Error('表格解析超时，请下载后查看'))
          if (this._worker) this._worker.terminate()
        }, 20000)
        this._requests.set(id, { resolve, reject, timer })
        this._worker.postMessage({ ...message, id }, transfers)
      })
    },
    async load() {
      this._controller = new AbortController()
      try {
        if (this.source.byteSize > OFFICE_PREVIEW_MAX_BYTES) throw new Error('文档较大，已停止自动解析，请下载后查看')
        if (/\.doc$/i.test(this.source.fileName)) throw new Error('此 Word 格式暂不支持在线排版，请下载后打开')
        const content = await fetchNodeAttachmentContent(this.source.roomKey, this.source.id, { signal: this._controller.signal, maxBytes: OFFICE_PREVIEW_MAX_BYTES })
        if (this._disposed) return
        if (this.spreadsheet) {
          this._worker = new Worker(previewAssetUrl('workbook.worker.js'))
          this._worker.onmessage = event => {
            const pending = this._requests.get(event.data.id)
            if (!pending) return
            clearTimeout(pending.timer); this._requests.delete(event.data.id)
            if (event.data.error) pending.reject(new Error(event.data.error))
            else pending.resolve(event.data)
          }
          this._worker.onerror = () => {
            for (const pending of this._requests.values()) { clearTimeout(pending.timer); pending.reject(new Error('表格预览服务加载失败，请下载后查看')) }
            this._requests.clear()
          }
          const result = await this.workerCall({ action: 'open', buffer: content.buffer, fileName: this.source.fileName, mimeType: this.source.mimeType }, [content.buffer])
          if (this._disposed) return
          this.sheets = result.sheets.map(Object.freeze)
          if (!this.sheets.length) throw new Error('此工作簿没有可读工作表')
          this.loading = false
          await this.$nextTick()
          await this.selectSheet(this.sheets[0].name)
        } else {
          const [docx, zipModule] = await Promise.all([import('docx-preview'), import('jszip')])
          if (this._disposed) return
          const zip = await (zipModule.default || zipModule).loadAsync(content.buffer)
          assertOfficeZipBudget(zip)
          if (this._disposed) return
          this._docx = docx
          this._doc = await docx.parseAsync(content.buffer, { useBase64URL: true, renderAltChunks: false })
          if (this._disposed) return
          const blocks = []
          for (const block of this._doc.documentPart.body.children || []) {
            if (block.type === 'table' && block.children && block.children.length > 40) {
              for (let offset = 0; offset < block.children.length; offset += 40) blocks.push({ ...block, children: block.children.slice(offset, offset + 40) })
            } else blocks.push(block)
          }
          this._blocks = blocks
          this._wordOffset = 0
          this.outline = blocks.map((block, index) => ({ index, title: elementText(block).trim(), style: block.styleName || '' }))
            .filter(item => /heading|标题/i.test(item.style) && item.title).slice(0, 150)
          this.hasMoreWord = blocks.length > 0
          this.loading = false
          await this.$nextTick()
          await this.appendWord()
          if (!this._disposed && this.$refs.docxViewport.scrollHeight <= this.$refs.docxViewport.clientHeight && this.hasMoreWord) await this.appendWord()
        }
      } catch (error) {
        if (!this._disposed && error.name !== 'AbortError') this.error = error.message || '文档预览失败'
      } finally { if (!this._disposed) this.loading = false }
    },
    async selectSheet(name) {
      this.activeSheet = name
      this.rows = []; this.rowStart = 0; this._cache.clear(); this._sheetEpoch++
      if (this.$refs.sheetViewport) this.$refs.sheetViewport.scrollTop = 0
      await this.loadRows(0)
    },
    async loadRows(start) {
      if (this._disposed || !this._worker) return
      const epoch = this._sheetEpoch
      const rowEpoch = ++this._rowEpoch
      const name = this.activeSheet
      this.rowsLoading = true
      const count = Math.min(70, Math.ceil(((this.$refs.sheetViewport && this.$refs.sheetViewport.clientHeight) || 600) / 36) + 20)
      const firstBatch = Math.floor(start / 100) * 100
      try {
        for (const offset of [...new Set([firstBatch, Math.floor((start + count - 1) / 100) * 100])]) {
          if (!this._cache.has(offset)) {
            const result = await this.workerCall({ action: 'rows', sheet: name, offset })
            if (this._disposed || epoch !== this._sheetEpoch || rowEpoch !== this._rowEpoch) return
            this._cache.set(offset, result.rows)
            if (this._cache.size > 8) this._cache.delete(this._cache.keys().next().value)
          }
        }
        if (this._disposed || epoch !== this._sheetEpoch || rowEpoch !== this._rowEpoch) return
        const rows = []
        for (let row = start; row < Math.min(this.currentSheet.rows, start + count); row++) {
          rows.push(Object.freeze((this._cache.get(Math.floor(row / 100) * 100) || [])[row % 100] || []))
        }
        this.rowStart = start
        this.rows = rows
      } catch (error) { if (!this._disposed && error.name !== 'AbortError') this.error = error.message }
      finally { if (!this._disposed && epoch === this._sheetEpoch && rowEpoch === this._rowEpoch) this.rowsLoading = false }
    },
    onSheetScroll() {
      if (this._scrollFrame) cancelAnimationFrame(this._scrollFrame)
      this._scrollFrame = requestAnimationFrame(() => {
        const el = this.$refs.sheetViewport
        if (el) this.loadRows(Math.max(0, Math.floor(el.scrollTop / 36) - 10))
      })
    },
    columnName(index) {
      let value = index + 1
      let name = ''
      while (value > 0) { value--; name = String.fromCharCode(65 + value % 26) + name; value = Math.floor(value / 26) }
      return name
    },
    async appendWord() {
      if (this.moreLoading || !this.hasMoreWord || this._disposed) return
      this.moreLoading = true
      try {
        const start = this._wordOffset
        const copy = Object.create(this._doc)
        copy.documentPart = Object.assign(Object.create(Object.getPrototypeOf(this._doc.documentPart)), this._doc.documentPart, {
          body: { ...this._doc.documentPart.body, children: this._blocks.slice(start, start + 30) }
        })
        const nodes = await this._docx.renderDocument(copy, {
          inWrapper: false, ignoreWidth: true, breakPages: true, useBase64URL: true,
          renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true, renderAltChunks: false
        })
        if (this._disposed) return
        const section = document.createElement('section')
        section.className = 'attachmentWordChunk'
        section.dataset.blockStart = start
        for (const node of nodes) {
          if (node.nodeName !== 'STYLE' || start === 0) section.appendChild(node)
        }
        this.$refs.docxContent.appendChild(section)
        this._wordOffset += 30
        this.hasMoreWord = this._wordOffset < this._blocks.length
      } catch (error) { if (!this._disposed) { this.error = 'Word 文档渲染失败，请下载后查看'; this.hasMoreWord = false } }
      finally { if (!this._disposed) this.moreLoading = false }
    },
    onWordScroll() {
      const el = this.$refs.docxViewport
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 400) this.appendWord()
    },
    async goToSection(index) {
      while (!this._disposed && !this.error && this._wordOffset <= index && this.hasMoreWord) {
        if (this.moreLoading) { await new Promise(resolve => setTimeout(resolve, 30)); continue }
        await this.appendWord()
      }
      if (this._disposed || !this.$refs.docxContent) return
      const start = Math.floor(index / 30) * 30
      const section = this.$refs.docxContent.querySelector('[data-block-start="' + start + '"]')
      if (section) section.scrollIntoView({ block: 'start', behavior: 'smooth' })
    }
  }
}
</script>
