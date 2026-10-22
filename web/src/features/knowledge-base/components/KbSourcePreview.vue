<template>
  <div class="kb-preview">
    <div v-if="!file" class="kb-preview-hint">请选择文件</div>
    <template v-else-if="kind === 'pdf'">
      <iframe :key="pdfSrc" :src="pdfSrc" class="kb-preview-frame" title="PDF 原文预览" />
    </template>
    <div v-else-if="kind === 'image'" class="kb-preview-image">
      <div class="kb-image-wrap">
        <img :src="rawUrl" alt="原图预览" @error="imgError = true" />
        <div v-if="box" class="kb-bbox" :style="box" />
      </div>
      <div v-if="imgError" class="kb-preview-hint">原图加载失败（原文接口可能尚未就绪）</div>
    </div>
    <div v-else-if="kind === 'sheet'" class="kb-preview-sheet">
      <div v-if="sheetLoading" v-loading="true" class="kb-preview-loading" element-loading-background="transparent" />
      <div v-else-if="sheetError" class="kb-preview-hint">{{ sheetError }}</div>
      <template v-else>
        <el-radio-group v-if="sheetNames.length > 1" v-model="sheetName" size="mini" class="kb-sheet-tabs">
          <el-radio-button v-for="n in sheetNames" :key="n" :label="n">{{ n }}</el-radio-button>
        </el-radio-group>
        <div ref="sheetBox" class="kb-sheet-box">
          <table class="kb-sheet">
            <tbody>
              <tr v-for="(r, ri) in rows" :key="ri" :data-row="ri + 1" :class="{ hl: hlRow === ri + 1 }">
                <th>{{ ri + 1 }}</th>
                <td v-for="(c, ci) in r" :key="ci">{{ c }}</td>
              </tr>
            </tbody>
          </table>
          <div v-if="truncated" class="kb-preview-hint">仅预览前 {{ maxRows }} 行</div>
        </div>
      </template>
    </div>
    <div v-else-if="kind === 'text'" class="kb-preview-text">
      <div v-if="textLoading" v-loading="true" class="kb-preview-loading" />
      <div v-else-if="textError" class="kb-preview-hint" role="alert">
        {{ textError }} <el-button size="mini" @click="loadMarkdown">重试</el-button>
        <a :href="rawUrl" target="_blank" rel="noopener">下载原文件</a>
      </div>
      <div v-else-if="plainText === ''" class="kb-preview-hint">文件内容为空</div>
      <pre v-else class="kb-text-content" tabindex="0" aria-label="TXT 原文预览">{{ plainText }}</pre>
    </div>
    <div v-else-if="kind === 'markdown'" class="kb-preview-markdown">
      <div v-if="textLoading" v-loading="true" class="kb-preview-loading" />
      <div v-else-if="textError" class="kb-preview-hint" role="alert">
        {{ textError }} <el-button size="mini" @click="loadMarkdown">重试</el-button>
      </div>
      <template v-else-if="markdown">
        <div class="kb-markdown-toolbar">
          <el-radio-group v-model="textMode" size="mini">
            <el-radio-button label="preview">预览</el-radio-button>
            <el-radio-button label="source">源码</el-radio-button>
          </el-radio-group>
          <span v-if="loc.lineStart">{{ lineLabel }}</span>
        </div>
        <div ref="markdownBox" class="kb-markdown-box" tabindex="0" aria-label="Markdown 原文预览">
          <div v-if="textMode === 'preview'" class="kb-markdown-body" v-html="markdown.html" />
          <div v-else class="kb-markdown-source">
            <div v-for="(line, i) in sourceLines" :key="i" :data-source-start="i + 1" :data-source-end="i + 1"><span class="kb-line-number">{{ i + 1 }}</span><code>{{ line || ' ' }}</code></div>
          </div>
        </div>
      </template>
    </div>
    <div v-else class="kb-preview-hint">
      该文件类型暂不支持在线预览，<a :href="rawUrl" target="_blank" rel="noopener">下载原文件</a>
    </div>
  </div>
</template>
<script>
import { markdownDocument } from '../utils/markdown'
import { decodeAttachmentText } from '@/utils/nodeAttachmentPreview'
import kbApi from '../services/kbApi'
import { fileKind, blockLocation, locationLabel } from '../utils/format'
export default {
  name: 'KbSourcePreview',
  props: { file: { type: Object, default: null }, block: { type: Object, default: null }, maxRows: { type: Number, default: 500 } },
  data() {
    return { markdown: null, plainText: '', textMode: 'preview', textLoading: false, textError: '', textRequest: 0, imgError: false, workbook: null, sheetName: '', sheetLoading: false, sheetError: '', truncated: false }
  },
  computed: {
    sourceLines() { return this.markdown ? this.markdown.text.split('\n') : [] },
    lineLabel() { return locationLabel(this.loc) },
    kind() { return fileKind(this.file) },
    rawUrl() { return this.file ? kbApi.rawUrl(this.file.id) : '' },
    loc() { return blockLocation(this.block) },
    pdfSrc() { return this.rawUrl + (this.loc.page ? `#page=${this.loc.page}` : '') },
    box() {
      // bbox 视为 0-1 相对坐标；大于 1 时无法换算，不画框
      const b = this.loc.bbox
      if (!b || b.some(v => v > 1 || v < 0)) return null
      return { left: b[0] * 100 + '%', top: b[1] * 100 + '%', width: (b[2] - b[0]) * 100 + '%', height: (b[3] - b[1]) * 100 + '%' }
    },
    sheetNames() { return this.workbook ? this.workbook.SheetNames : [] },
    rows() {
      if (!this.workbook || !this.sheetName || !this.xlsx) return []
      const all = this.xlsx.utils.sheet_to_json(this.workbook.Sheets[this.sheetName], { header: 1, defval: '' })
      this.setTruncated(all.length > this.maxRows)
      return all.slice(0, this.maxRows)
    },
    hlRow() { return this.loc.sheet && this.loc.sheet !== this.sheetName ? null : this.loc.row }
  },
  watch: {
    file: { immediate: true, handler(next, previous) {
      if (!next || !previous || next.id !== previous.id || next.sha256 !== previous.sha256) this.reset()
    } },
    textMode() { this.$nextTick(this.scrollToMarkdown) },
    block() {
      this.$nextTick(this.scrollToMarkdown)
      if (this.kind === 'sheet' && this.loc.sheet && this.sheetNames.includes(this.loc.sheet)) this.sheetName = this.loc.sheet
      this.$nextTick(this.scrollToRow)
    }
  },
  beforeDestroy() { this.textRequest++ },
  methods: {
    setTruncated(v) { if (this.truncated !== v) this.$nextTick(() => { this.truncated = v }) },
    reset() {
      this.textRequest++
      this.markdown = null
      this.plainText = ''
      this.textError = ''
      this.textLoading = false
      this.$emit('markdown-source', null)
      if (this.file && ['markdown', 'text'].includes(this.kind)) this.loadMarkdown()
      this.imgError = false
      this.workbook = null
      this.sheetError = ''
      if (this.file && this.kind === 'sheet') this.loadSheet()
    },
    async loadMarkdown() {
      const request = ++this.textRequest
      const isPlainText = this.kind === 'text'
      this.textLoading = true
      this.textError = ''
      try {
        const buf = await kbApi.getRaw(this.file.id)
        if (request !== this.textRequest) return
        if (isPlainText) {
          this.plainText = decodeAttachmentText(buf)
        } else {
          this.markdown = markdownDocument(new TextDecoder('utf-8').decode(buf))
          this.$emit('markdown-source', this.markdown)
          this.$nextTick(this.scrollToMarkdown)
        }
      } catch (e) {
        if (request === this.textRequest) this.textError = `${isPlainText ? 'TXT' : 'Markdown'} 原文加载失败，请重试或下载原文件`
      } finally {
        if (request === this.textRequest) this.textLoading = false
      }
    },
    scrollToMarkdown() {
      const box = this.$refs.markdownBox
      if (!box) return
      let first = null
      box.querySelectorAll('[data-source-start]').forEach(el => {
        const start = Number(el.dataset.sourceStart)
        const end = Number(el.dataset.sourceEnd)
        const match = this.loc.lineStart != null && start <= this.loc.lineEnd && end >= this.loc.lineStart
        el.classList.toggle('kb-source-highlight', match)
        if (match && (!first || end - start < Number(first.dataset.sourceEnd) - Number(first.dataset.sourceStart))) first = el
      })
      if (first) box.scrollTop += first.getBoundingClientRect().top - box.getBoundingClientRect().top - 16
    },
    async loadSheet() {
      this.sheetLoading = true
      try {
        const [XLSX, buf] = await Promise.all([import(/* webpackChunkName: "file-kb" */ 'xlsx'), kbApi.getRaw(this.file.id)])
        this.xlsx = XLSX
        this.workbook = Object.freeze(XLSX.read(new Uint8Array(buf), { type: "array" }))
        this.sheetName = this.workbook.SheetNames[0] || ''
      } catch (e) {
        this.sheetError = e && e.__kb ? (e.kind === 'not_ready' ? '原文接口等待后端实现，暂无法预览' : e.message) : '表格解析失败'
      } finally {
        this.sheetLoading = false
      }
    },
    scrollToRow() {
      const box = this.$refs.sheetBox
      if (!box || !this.hlRow) return
      const tr = box.querySelector(`tr[data-row="${this.hlRow}"]`)
      if (tr) box.scrollTop = tr.offsetTop - 40
    }
  }
}
</script>
<style scoped lang="less">
.kb-preview {
  height: 100%;
  min-height: 420px;
  display: flex;
  flex-direction: column;
  background: var(--ui-preview-bg);
  border-radius: var(--ui-radius-md);
  overflow: hidden;
}
.kb-preview-frame {
  flex: 1;
  width: 100%;
  border: 0;
  background: var(--ui-surface);
}
.kb-preview-hint {
  padding: 24px;
  text-align: center;
  font-size: 13px;
  color: var(--ui-text-muted);
  a { color: var(--ui-primary); }
}
.kb-preview-loading { min-height: 200px; }
.kb-preview-text { display: flex; flex-direction: column; min-height: 0; }
.kb-text-content { margin: 0; padding: 16px; max-height: 640px; min-height: 340px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; box-sizing: border-box; font: 14px/1.8 ui-monospace, monospace; color: var(--ui-text); background: var(--ui-surface); tab-size: 4; }
.kb-preview-image {
  flex: 1;
  overflow: auto;
  padding: 12px;
}
.kb-image-wrap {
  position: relative;
  display: inline-block;
  img { display: block; max-width: 100%; }
}
.kb-bbox {
  position: absolute;
  border: 2px solid var(--ui-primary);
  background: var(--ui-card-spotlight);
  pointer-events: none;
}
.kb-preview-sheet {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.kb-sheet-tabs { padding: 8px; }
.kb-sheet-box {
  flex: 1;
  overflow: auto;
  max-height: 640px;
}
.kb-sheet {
  border-collapse: collapse;
  font-size: 12px;
  color: var(--ui-text);
  background: var(--ui-surface);
  th, td {
    border: 1px solid var(--ui-border);
    padding: 4px 8px;
    white-space: nowrap;
  }
  th {
    position: sticky;
    left: 0;
    background: var(--ui-surface-muted);
    color: var(--ui-text-muted);
    font-weight: 600;
  }
  tr.hl td { background: var(--ui-primary-soft); }
}
</style>

<style scoped lang="less">
.kb-preview-markdown { display: flex; flex-direction: column; min-height: 0; }
.kb-markdown-toolbar { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-bottom: 1px solid var(--ui-border); font-size: 13px; color: var(--ui-text); }
.kb-markdown-box { overflow: auto; max-height: 640px; min-height: 340px; padding: 16px; background: var(--ui-surface); color: var(--ui-text); }
.kb-markdown-body { font-size: 14px; line-height: 1.7; overflow-wrap: anywhere;
  ::v-deep { h1, h2, h3 { line-height: 1.4; } pre { overflow: auto; padding: 12px; background: var(--ui-surface-muted); } table { display: block; overflow: auto; border-collapse: collapse; } th, td { border: 1px solid var(--ui-border); padding: 6px 10px; } img { max-width: 100%; } a { color: var(--ui-primary); } .kb-source-highlight { background: var(--ui-primary-soft); outline: 1px solid var(--ui-primary); } }
}
.kb-markdown-source { font-size: 13px; line-height: 1.7;
  > div { display: flex; }
  code { white-space: pre-wrap; overflow-wrap: anywhere; min-width: 0; }
  .kb-source-highlight { background: var(--ui-primary-soft); outline: 1px solid var(--ui-primary); }
}
.kb-line-number { flex: 0 0 4em; text-align: right; padding-right: 16px; color: var(--ui-text-muted); user-select: none; }
</style>
