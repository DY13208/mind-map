<template>
  <el-dialog
    ref="dialog"
    :visible.sync="visible"
    :title="title"
    :width="dialogWidth"
    append-to-body
    :custom-class="dialogClass"
    :close-on-click-modal="false"
    @closed="onClosed"
  >
    <section
      v-loading="loading"
      class="attachmentPreviewBody"
      :aria-busy="loading ? 'true' : 'false'"
      :style="{ height: `${dialogHeight}px` }"
    >
      <div v-if="error" class="previewState previewError" role="alert">
        {{ error }}
      </div>
      <div v-else-if="kind === 'image'" class="imagePreviewWrap">
        <img :src="blobUrl" :alt="title" class="imagePreview" />
      </div>
      <iframe
        v-else-if="kind === 'pdf'"
        :src="blobUrl"
        :title="title"
        class="documentPreviewFrame"
      ></iframe>
      <div
        v-else-if="kind === 'markdown'"
        ref="markdownViewer"
        class="markdownPreview customScrollbar"
      ></div>
      <section v-else-if="kind === 'office'" class="officePreviewCanvas">
        <template v-if="workbookSheets.length">
          <header class="workbookHeader">
            <div>
              <span class="canvasEyebrow">工作簿预览</span>
              <strong>{{ activeWorkbookSheet.name }}</strong>
            </div>
            <span class="workbookMeta">
              {{ activeWorkbookSheet.rows.length }} 行 · {{ activeWorkbookSheet.columnCount }} 列
              <template v-if="activeWorkbookSheet.truncated"> · 已显示前 500 行</template>
            </span>
          </header>
          <nav class="workbookTabs" aria-label="工作表">
            <button
              v-for="sheet in workbookSheets"
              :key="sheet.name"
              type="button"
              class="workbookTab"
              :class="{ active: sheet.name === activeSheetName }"
              :aria-current="sheet.name === activeSheetName ? 'page' : null"
              @click="activeSheetName = sheet.name"
            >
              {{ sheet.name }}
            </button>
          </nav>
          <div
            class="spreadsheetViewport customScrollbar"
            tabindex="0"
            role="region"
            :aria-label="`${activeWorkbookSheet.name} 工作表内容`"
          >
            <table class="spreadsheetTable">
              <thead>
                <tr>
                  <th class="sheetCorner" scope="col">#</th>
                  <th
                    v-for="column in activeWorkbookSheet.columnCount"
                    :key="column"
                    scope="col"
                  >
                    {{ spreadsheetColumnName(column - 1) }}
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(row, rowIndex) in activeWorkbookSheet.rows" :key="rowIndex">
                  <th scope="row">{{ rowIndex + 1 }}</th>
                  <td v-for="column in activeWorkbookSheet.columnCount" :key="column">
                    {{ row[column - 1] || '' }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
        <div v-else-if="isDocxFile" ref="docxViewer" class="docxPreview customScrollbar"></div>
        <div v-else class="documentPreviewCanvas">
          <header class="documentCanvasHeader">
            <span class="canvasEyebrow">文档内容</span>
            <span>服务端已提取的可读文本</span>
          </header>
          <pre class="textPreview customScrollbar">{{ previewText }}</pre>
        </div>
      </section>
      <pre
        v-else-if="kind === 'text' || kind === 'json'"
        class="textPreview customScrollbar"
      >{{ previewText }}</pre>
      <div v-else-if="kind === 'external'" class="externalPreviewWrap">
        <iframe
          :src="externalUrl"
          :title="title"
          class="documentPreviewFrame"
          sandbox="allow-same-origin allow-popups allow-forms allow-downloads"
          referrerpolicy="no-referrer"
        ></iframe>
        <p class="externalPreviewHint">
          若内容为空或被站点限制嵌入，请使用“外部打开”。
        </p>
      </div>
      <div v-else class="previewState">暂不支持该文件类型的站内预览。</div>
    </section>
    <span slot="footer" class="dialog-footer">
      <el-button
        size="small"
        :aria-label="isMaximized ? '还原预览窗口' : '最大化预览窗口'"
        @click="toggleMaximize"
      >
        {{ isMaximized ? '还原' : '最大化' }}
      </el-button>
      <el-button
        v-if="externalUrl"
        size="small"
        @click="openExternal"
      >
        外部打开
      </el-button>
      <el-button
        v-if="attachmentId"
        type="primary"
        size="small"
        :loading="downloading"
        @click="download"
      >
        下载
      </el-button>
      <el-button size="small" @click="visible = false">关闭</el-button>
    </span>
    <button
      class="dialogResizeHandle"
      type="button"
      aria-label="拖动调整预览窗口大小；也可使用最大化按钮"
      title="拖动调整大小"
      @mousedown.stop.prevent="startResize"
    ></button>
  </el-dialog>
</template>

<script>
import Viewer from '@toast-ui/editor/dist/toastui-editor-viewer'
import '@toast-ui/editor/dist/toastui-editor-viewer.css'
import { roomFromLocation } from '@/utils/roomLocation'
import {
  fetchNodeAttachmentContent,
  getNodeAttachment
} from '@/utils/nodeAttachmentApi'
import {
  attachmentPreviewKind,
  formatAttachmentText,
  formatOfficePreviewText,
  safeMarkdownSource
} from '@/utils/nodeAttachmentPreview'

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf'
}

function previewMimeType(fileName, kind) {
  const name = String(fileName || '').toLowerCase()
  const ext = Object.keys(MIME_BY_EXT).find(item => name.endsWith(item))
  if (ext) return MIME_BY_EXT[ext]
  if (kind === 'image') return 'image/*'
  if (kind === 'pdf') return 'application/pdf'
  return 'application/octet-stream'
}

export default {
  name: 'NodeAttachmentPreview',
  data() {
    return {
      visible: false,
      loading: false,
      downloading: false,
      title: '附件预览',
      attachmentId: '',
      attachment: null,
      kind: 'unsupported',
      previewText: '',
      blobUrl: '',
      sourceBlob: null,
      externalUrl: '',
      error: '',
      requestId: 0,
      controller: null,
      markdownViewer: null,
      markdownViewerContainer: null,
      workbookSheets: [],
      activeSheetName: '',
      dialogWidth: '860px',
      dialogHeight: 500,
      isMaximized: false,
      previousDialogSize: null,
      resizeSession: null
    }
  },
  computed: {
    dialogClass() {
      return this.isMaximized
        ? 'nodeAttachmentPreviewDialog is-maximized'
        : 'nodeAttachmentPreviewDialog'
    },
    activeWorkbookSheet() {
      return (
        this.workbookSheets.find(sheet => sheet.name === this.activeSheetName) ||
        this.workbookSheets[0] ||
        { name: '', rows: [], columnCount: 0, truncated: false }
      )
    },
    isDocxFile() {
      return /\.docx$/i.test(
        String((this.attachment && this.attachment.fileName) || this.title || '')
      )
    }
  },
  created() {
    this.$bus.$on('node_attachmentClick', this.onAttachmentClick)
    window.addEventListener('resize', this.onWindowResize)
  },
  beforeDestroy() {
    this.$bus.$off('node_attachmentClick', this.onAttachmentClick)
    window.removeEventListener('resize', this.onWindowResize)
    this.cancelActiveRequest()
    this.releaseBlobUrl()
    this.destroyMarkdownViewer()
    this.stopResize()
  },
  methods: {
    onAttachmentClick(node) {
      const data = node && node.getData ? node.getData() || {} : {}
      if (data.attachmentId) {
        this.openStoredAttachment(data)
      } else if (data.attachmentUrl) {
        this.openExternalAttachment(data)
      }
    },
    resetPreview() {
      this.requestId += 1
      this.cancelActiveRequest()
      this.releaseBlobUrl()
      this.destroyMarkdownViewer()
      this.loading = false
      this.downloading = false
      this.attachmentId = ''
      this.attachment = null
      this.kind = 'unsupported'
      this.previewText = ''
      this.sourceBlob = null
      this.externalUrl = ''
      this.error = ''
      this.workbookSheets = []
      this.activeSheetName = ''
    },
    cancelActiveRequest() {
      if (this.controller) this.controller.abort()
      this.controller = null
    },
    releaseBlobUrl() {
      if (this.blobUrl) URL.revokeObjectURL(this.blobUrl)
      this.blobUrl = ''
    },
    destroyMarkdownViewer() {
      if (
        this.markdownViewer &&
        typeof this.markdownViewer.destroy === 'function'
      ) {
        this.markdownViewer.destroy()
      }
      this.markdownViewer = null
      this.markdownViewerContainer = null
    },
    async openStoredAttachment(data) {
      const roomKey = roomFromLocation(this.$route)
      this.resetPreview()
      this.visible = true
      this.title = String(data.attachmentName || '附件预览')
      if (!roomKey) {
        this.error = '请先进入协作房间后再预览附件'
        return
      }
      const requestId = this.requestId
      this.loading = true
      try {
        const result = await getNodeAttachment(roomKey, data.attachmentId)
        if (requestId !== this.requestId) return
        const attachment = (result && result.attachment) || {}
        this.attachmentId = attachment.id || data.attachmentId
        this.attachment = attachment
        this.title = String(attachment.fileName || data.attachmentName || '附件预览')
        this.kind = attachmentPreviewKind(attachment.fileName, attachment.mimeType)
        if (this.kind === 'office') {
          if (/\.docx$/i.test(attachment.fileName || '')) {
            this.controller = typeof AbortController !== 'undefined' ? new AbortController() : null
            const content = await fetchNodeAttachmentContent(roomKey, this.attachmentId, {
              signal: this.controller && this.controller.signal
            })
            if (requestId !== this.requestId) return
            this.sourceBlob = new Blob([content.buffer], {
              type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            })
            await this.renderDocxPreview(this.sourceBlob, requestId)
            return
          }
          this.previewText = formatOfficePreviewText(
            attachment.extractedText,
            attachment.fileName
          )
          if (!this.previewText.trim()) {
            this.error = attachment.errorMessage || '该文件未生成可读内容预览，请下载后查看'
            return
          }
          if (/\.xlsx$/i.test(attachment.fileName || '')) {
            this.controller = typeof AbortController !== 'undefined' ? new AbortController() : null
            const content = await fetchNodeAttachmentContent(roomKey, this.attachmentId, {
              signal: this.controller && this.controller.signal
            })
            if (requestId !== this.requestId) return
            this.sourceBlob = new Blob([content.buffer], {
              type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            })
            await this.loadWorkbookCanvas(content.buffer)
          }
          return
        }
        if (this.kind === 'unsupported') {
          this.error = '暂不支持该文件类型的站内预览，请下载后查看'
          return
        }
        this.controller = typeof AbortController !== 'undefined' ? new AbortController() : null
        const content = await fetchNodeAttachmentContent(roomKey, this.attachmentId, {
          signal: this.controller && this.controller.signal
        })
        if (requestId !== this.requestId) return
        this.sourceBlob = new Blob([content.buffer], {
          type: previewMimeType(attachment.fileName, this.kind)
        })
        if (this.kind === 'image' || this.kind === 'pdf') {
          this.blobUrl = URL.createObjectURL(this.sourceBlob)
        } else {
          this.previewText = formatAttachmentText(content.buffer, this.kind)
          if (this.kind === 'markdown') this.renderMarkdown()
        }
      } catch (err) {
        if (err && err.name === 'AbortError') return
        if (requestId === this.requestId) {
          this.error = (err && err.message) || '附件预览加载失败'
        }
      } finally {
        if (requestId === this.requestId) {
          this.loading = false
          this.controller = null
        }
      }
    },
    openExternalAttachment(data) {
      this.resetPreview()
      this.title = String(data.attachmentName || '附件预览')
      this.kind = 'external'
      this.externalUrl = String(data.attachmentUrl)
      this.visible = true
    },
    renderMarkdown() {
      this.$nextTick(() => {
        if (this.kind !== 'markdown' || !this.$refs.markdownViewer) return
        const container = this.$refs.markdownViewer
        // Markdown 的 v-if 节点会在切换图片、表格等附件时重建。不能继续
        // 向已脱离页面的旧 Viewer 写内容，否则弹窗会看起来是空白的。
        if (
          this.markdownViewer &&
          this.markdownViewerContainer !== container
        ) {
          this.destroyMarkdownViewer()
        }
        if (!this.markdownViewer) {
          this.markdownViewer = new Viewer({ el: container })
          this.markdownViewerContainer = container
        }
        this.markdownViewer.setMarkdown(safeMarkdownSource(this.previewText))
      })
    },
    async renderDocxPreview(blob, requestId) {
      await this.$nextTick()
      const container = this.$refs.docxViewer
      if (!container || requestId !== this.requestId) return
      try {
        const module = await import('docx-preview')
        if (requestId !== this.requestId) return
        container.textContent = ''
        await module.renderAsync(blob, container, null, {
          inWrapper: true,
          breakPages: true,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
          renderComments: false,
          experimental: true
        })
      } catch (err) {
        if (requestId !== this.requestId) return
        this.error = 'DOCX 原样预览加载失败，请下载后使用本地 Office 打开'
      }
    },
    async loadWorkbookCanvas(buffer) {
      try {
        const module = await import('xlsx')
        const XLSX = module.default || module
        const workbook = XLSX.read(buffer, { type: 'array', raw: false })
        const sheets = workbook.SheetNames.slice(0, 10).map(name => {
          const values = XLSX.utils.sheet_to_json(workbook.Sheets[name], {
            header: 1,
            raw: false,
            defval: '',
            blankrows: false
          })
          const rows = values
            .map(row => {
              const cells = Array.isArray(row) ? row.map(value => String(value || '')) : []
              let last = cells.length - 1
              while (last >= 0 && !cells[last].trim()) last -= 1
              return cells.slice(0, last + 1)
            })
            .filter(row => row.some(cell => cell.trim()))
          const columnCount = Math.min(
            40,
            rows.reduce((max, row) => Math.max(max, row.length), 0)
          )
          return {
            name,
            rows: rows.slice(0, 500).map(row => row.slice(0, columnCount)),
            columnCount,
            truncated: rows.length > 500
          }
        }).filter(sheet => sheet.rows.length)
        this.workbookSheets = sheets
        this.activeSheetName = (sheets[0] && sheets[0].name) || ''
      } catch (err) {
        // Keep the already extracted text readable when a workbook is malformed.
        this.workbookSheets = []
      }
    },
    spreadsheetColumnName(index) {
      let value = Number(index) + 1
      let name = ''
      while (value > 0) {
        const remainder = (value - 1) % 26
        name = String.fromCharCode(65 + remainder) + name
        value = Math.floor((value - 1) / 26)
      }
      return name
    },
    dialogElement() {
      return (
        this.$refs.dialog &&
        this.$refs.dialog.$el &&
        this.$refs.dialog.$el.querySelector('.el-dialog')
      )
    },
    startResize(event) {
      if (this.isMaximized || window.innerWidth <= 768) return
      const dialog = this.dialogElement()
      if (!dialog) return
      const rect = dialog.getBoundingClientRect()
      this.resizeSession = {
        startX: event.clientX,
        startY: event.clientY,
        width: rect.width,
        height: this.dialogHeight
      }
      document.addEventListener('mousemove', this.resizeDialog)
      document.addEventListener('mouseup', this.stopResize)
      dialog.classList.add('is-resizing')
      document.body.classList.add('nodeAttachmentResizing')
    },
    resizeDialog(event) {
      if (!this.resizeSession) return
      const maxWidth = Math.max(640, window.innerWidth - 32)
      const maxHeight = Math.max(420, window.innerHeight - 156)
      const width = Math.min(
        maxWidth,
        Math.max(640, this.resizeSession.width + event.clientX - this.resizeSession.startX)
      )
      const height = Math.min(
        maxHeight,
        Math.max(420, this.resizeSession.height + event.clientY - this.resizeSession.startY)
      )
      this.dialogWidth = `${Math.round(width)}px`
      this.dialogHeight = Math.round(height)
    },
    stopResize() {
      this.resizeSession = null
      document.removeEventListener('mousemove', this.resizeDialog)
      document.removeEventListener('mouseup', this.stopResize)
      const dialog = this.dialogElement()
      if (dialog) dialog.classList.remove('is-resizing')
      document.body.classList.remove('nodeAttachmentResizing')
    },
    toggleMaximize() {
      if (!this.isMaximized) {
        this.previousDialogSize = {
          width: this.dialogWidth,
          height: this.dialogHeight
        }
        this.dialogWidth = `${Math.max(320, window.innerWidth - 32)}px`
        this.isMaximized = true
        return
      }
      const size = this.previousDialogSize || { width: '860px', height: 500 }
      this.dialogWidth = size.width
      this.dialogHeight = size.height
      this.isMaximized = false
    },
    onWindowResize() {
      if (!this.isMaximized) return
      this.dialogWidth = `${Math.max(320, window.innerWidth - 32)}px`
    },
    async download() {
      if (!this.attachmentId || this.downloading) return
      this.downloading = true
      try {
        let blob = this.sourceBlob
        if (!blob) {
          const roomKey = roomFromLocation(this.$route)
          if (!roomKey) throw new Error('无法确认当前协作房间')
          const content = await fetchNodeAttachmentContent(roomKey, this.attachmentId)
          blob = new Blob([content.buffer], {
            type: previewMimeType(this.title, this.kind)
          })
        }
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = this.title || 'attachment'
        link.style.display = 'none'
        document.body.appendChild(link)
        link.click()
        document.body.removeChild(link)
        setTimeout(() => URL.revokeObjectURL(url), 0)
      } catch (err) {
        this.$message.error((err && err.message) || '附件下载失败')
      } finally {
        this.downloading = false
      }
    },
    openExternal() {
      if (this.externalUrl) window.open(this.externalUrl, '_blank', 'noopener')
    },
    onClosed() {
      this.resetPreview()
    }
  }
}
</script>

<style lang="less" scoped>
.attachmentPreviewBody {
  min-height: 320px;
  max-height: calc(100vh - 156px);
  overflow: hidden;
  border: 1px solid #e8edf4;
  border-radius: 6px;
  background: #f8fafc;
}

.previewState {
  min-height: 320px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  color: #667085;
  line-height: 1.6;
  text-align: center;
}

.previewError {
  color: #c45656;
}

.imagePreviewWrap {
  box-sizing: border-box;
  height: 100%;
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 16px;
  background: #fff;
}

.imagePreview {
  display: block;
  max-width: 100%;
  max-height: calc(100% - 32px);
  object-fit: contain;
}

.documentPreviewFrame {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: #fff;
}

.textPreview {
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  min-height: 0;
  margin: 0;
  padding: 18px;
  overflow: auto;
  background: #fff;
  color: #303133;
  font-family: Consolas, 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.65;
  tab-size: 2;
  white-space: pre-wrap;
  word-break: break-word;
}

.officePreviewCanvas {
  height: 100%;
  background: #fff;
}

.workbookHeader,
.documentCanvasHeader {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 16px;
  min-height: 64px;
  padding: 14px 18px;
  border-bottom: 1px solid #e8edf4;
  color: #667085;
  font-size: 13px;
}

.workbookHeader strong {
  display: block;
  margin-top: 3px;
  color: #1d2939;
  font-size: 16px;
  font-weight: 600;
}

.canvasEyebrow {
  display: block;
  color: #98a2b3;
  font-size: 12px;
  line-height: 1.3;
}

.workbookMeta {
  flex: 0 0 auto;
  color: #667085;
  font-variant-numeric: tabular-nums;
}

.workbookTabs {
  display: flex;
  gap: 4px;
  min-height: 42px;
  padding: 7px 12px 0;
  overflow-x: auto;
  border-bottom: 1px solid #e8edf4;
  background: #f8fafc;
}

.workbookTab {
  max-width: 180px;
  height: 34px;
  padding: 0 13px;
  overflow: hidden;
  border: 1px solid transparent;
  border-radius: 5px 5px 0 0;
  background: transparent;
  color: #667085;
  font-size: 13px;
  line-height: 32px;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

.workbookTab:hover,
.workbookTab:focus {
  color: #1677ff;
  outline: none;
}

.workbookTab:focus-visible {
  outline: 2px solid #409eff;
  outline-offset: -2px;
}

.workbookTab.active {
  border-color: #d8e8ff;
  border-bottom-color: #fff;
  background: #fff;
  color: #1677ff;
  font-weight: 600;
}

.spreadsheetViewport {
  height: calc(100% - 108px);
  overflow: auto;
  background: #fff;
}

.spreadsheetTable {
  width: max-content;
  min-width: 100%;
  border-spacing: 0;
  border-collapse: separate;
  color: #344054;
  font-size: 13px;
  line-height: 1.55;
}

.spreadsheetTable th,
.spreadsheetTable td {
  box-sizing: border-box;
  min-width: 120px;
  max-width: 360px;
  padding: 8px 10px;
  overflow: hidden;
  border-right: 1px solid #edf1f6;
  border-bottom: 1px solid #edf1f6;
  text-align: left;
  text-overflow: ellipsis;
  vertical-align: top;
  white-space: pre-wrap;
  word-break: break-word;
}

.spreadsheetTable thead th {
  position: sticky;
  top: 0;
  z-index: 2;
  min-width: 120px;
  padding: 7px 10px;
  background: #f6f8fb;
  color: #667085;
  font-size: 12px;
  font-weight: 600;
  text-align: center;
}

.spreadsheetTable tbody th,
.sheetCorner {
  position: sticky;
  left: 0;
  z-index: 1;
  min-width: 46px !important;
  width: 46px;
  padding: 7px 8px !important;
  background: #f8fafc;
  color: #98a2b3;
  font-size: 12px;
  font-weight: 500;
  text-align: center !important;
}

.spreadsheetTable .sheetCorner {
  z-index: 3;
}

.spreadsheetTable tbody tr:hover td,
.spreadsheetTable tbody tr:hover th {
  background: #f7fbff;
}

.documentPreviewCanvas .textPreview {
  height: calc(100% - 64px);
}

.docxPreview {
  box-sizing: border-box;
  height: 100%;
  padding: 24px;
  overflow: auto;
  background: #eef1f5;
}

/deep/ .docxPreview .docx-wrapper {
  min-width: min-content;
  padding: 0;
  background: transparent;
}

/deep/ .docxPreview .docx {
  margin: 0 auto 24px;
  box-shadow: 0 2px 10px rgba(16, 24, 40, 0.16);
}

.markdownPreview {
  box-sizing: border-box;
  height: 100%;
  min-height: 0;
  padding: 18px;
  overflow: auto;
  background: #fff;
}

.externalPreviewWrap {
  background: #fff;
}

.externalPreviewHint {
  margin: 0;
  padding: 10px 16px;
  color: #909399;
  font-size: 13px;
  line-height: 1.5;
}

.dialogResizeHandle {
  position: absolute;
  right: 4px;
  bottom: 4px;
  z-index: 2;
  width: 40px;
  height: 40px;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: nwse-resize;
  touch-action: none;
}

.dialogResizeHandle::after {
  position: absolute;
  right: 6px;
  bottom: 6px;
  width: 12px;
  height: 12px;
  border-right: 2px solid #98a2b3;
  border-bottom: 2px solid #98a2b3;
  content: '';
}

.dialogResizeHandle:focus-visible {
  outline: 2px solid #409eff;
  outline-offset: -3px;
}

/deep/ .nodeAttachmentPreviewDialog {
  position: relative;
  min-width: 640px;
  max-width: calc(100vw - 32px);
  transition: width 160ms ease-out;
}

/deep/ .nodeAttachmentPreviewDialog.is-resizing {
  transition: none;
}

/deep/ .nodeAttachmentPreviewDialog.is-maximized {
  box-sizing: border-box;
  height: calc(100vh - 32px);
  margin-top: 16px !important;
  margin-bottom: 16px !important;
  display: flex;
  flex-direction: column;
}

/deep/ .nodeAttachmentPreviewDialog.is-maximized .el-dialog__body {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
}

/deep/ .nodeAttachmentPreviewDialog.is-maximized .attachmentPreviewBody {
  height: auto !important;
  max-height: none;
  min-height: 0;
  flex: 1;
}

/deep/ .nodeAttachmentPreviewDialog .el-dialog__body {
  padding-bottom: 10px;
}

@media (max-width: 768px) {
  /deep/ .nodeAttachmentPreviewDialog {
    width: calc(100vw - 24px) !important;
    margin-top: 8vh !important;
  }

  .attachmentPreviewBody {
    min-height: 240px;
    max-height: 72vh;
  }

  .documentPreviewFrame {
    height: 60vh;
  }

  .workbookHeader,
  .documentCanvasHeader {
    align-items: flex-start;
    flex-direction: column;
    gap: 4px;
  }

  .spreadsheetViewport {
    height: calc(100% - 108px);
  }

  /deep/ .nodeAttachmentPreviewDialog {
    min-width: 0;
  }

  .dialogResizeHandle {
    display: none;
  }

  .docxPreview {
    padding: 12px;
  }
}
</style>
