<template>
  <el-dialog
    class="homeImportDialog"
    title="导入脑图"
    :visible.sync="visibleProxy"
    width="480px"
    :close-on-click-modal="!importing"
    :close-on-press-escape="!importing"
    @closed="reset"
  >
    <div class="intro">
      支持 <code>.smm</code> / <code>.json</code> / <code>.xmind</code> /
      <code>.md</code>。多画布 XMind 可批量导入到新建文件夹。
    </div>

    <el-upload
      ref="upload"
      class="uploader"
      drag
      action="x"
      :auto-upload="false"
      :multiple="false"
      :limit="1"
      :accept="accept"
      :disabled="importing"
      :file-list="fileList"
      :on-change="onChange"
      :on-remove="onRemove"
      :on-exceed="onExceed"
    >
      <i class="el-icon-upload" />
      <div class="el-upload__text">将文件拖到此处，或<em>点击选择</em></div>
    </el-upload>

    <div v-if="sheets.length" class="sheetBlock">
      <div class="sheetHead">
        <span>检测到 {{ sheets.length }} 个画布</span>
        <el-radio-group v-model="mode" size="mini" :disabled="importing || sheets.length < 2">
          <el-radio-button label="single">导入为单张脑图</el-radio-button>
          <el-radio-button label="folder" :disabled="sheets.length < 2 || !!teamId">
            批量导入到文件夹
          </el-radio-button>
        </el-radio-group>
      </div>
      <p v-if="teamId && sheets.length > 1" class="hint">
        团队空间暂不支持批量进文件夹，请选择单个画布导入，或切回个人空间。
      </p>
      <template v-if="mode === 'single'">
        <el-radio-group v-model="singleIndex" class="sheetRadios" :disabled="importing">
          <el-radio
            v-for="sheet in sheets"
            :key="'s-' + sheet.index"
            :label="sheet.index"
            >{{ sheet.title }}</el-radio
          >
        </el-radio-group>
      </template>
      <template v-else>
        <div class="sheetChecks">
          <el-checkbox
            :indeterminate="batchIndeterminate"
            :value="batchAllChecked"
            :disabled="importing"
            @change="toggleBatchAll"
            >全选</el-checkbox
          >
          <el-checkbox-group v-model="batchIndexes" :disabled="importing">
            <el-checkbox
              v-for="sheet in sheets"
              :key="'b-' + sheet.index"
              :label="sheet.index"
              >{{ sheet.title }}</el-checkbox
            >
          </el-checkbox-group>
        </div>
        <el-input
          v-model="folderName"
          class="folderName"
          maxlength="60"
          show-word-limit
          placeholder="文件夹名称"
          :disabled="importing"
        />
      </template>
    </div>

    <el-input
      v-if="mode === 'single' && fileRaw"
      v-model="roomTitle"
      class="roomTitle"
      maxlength="60"
      show-word-limit
      placeholder="脑图名称（可改）"
      :disabled="importing"
    />

    <div v-if="importing || progressMessage" class="progress">
      <el-progress :percentage="progressPercent" :stroke-width="8" />
      <p>{{ progressMessage }}</p>
    </div>

    <span slot="footer">
      <el-button :disabled="importing" @click="visibleProxy = false">取消</el-button>
      <el-button type="primary" :loading="importing" :disabled="!canSubmit" @click="submit">
        {{ mode === 'folder' ? '批量导入' : '导入' }}
      </el-button>
    </span>
  </el-dialog>
</template>

<script>
import {
  isSupportedImportName,
  listXmindSheets,
  importAsSingleRoom,
  importXmindCanvasesToFolder,
  importFileKind
} from '@/utils/homeImport'
import { userMessageFromError } from '@/services/apiError'

export default {
  name: 'HomeImportDialog',
  props: {
    visible: { type: Boolean, default: false },
    folderId: { type: [String, Number], default: null },
    teamId: { type: [String, Number], default: null }
  },
  data() {
    return {
      accept: '.smm,.json,.xmind,.md',
      fileList: [],
      fileRaw: null,
      sheets: [],
      mode: 'single',
      singleIndex: 0,
      batchIndexes: [],
      folderName: '',
      roomTitle: '',
      importing: false,
      progressMessage: '',
      progressPercent: 0
    }
  },
  computed: {
    visibleProxy: {
      get() {
        return this.visible
      },
      set(v) {
        this.$emit('update:visible', v)
      }
    },
    batchAllChecked() {
      return (
        this.sheets.length > 0 && this.batchIndexes.length === this.sheets.length
      )
    },
    batchIndeterminate() {
      return (
        this.batchIndexes.length > 0 &&
        this.batchIndexes.length < this.sheets.length
      )
    },
    canSubmit() {
      if (!this.fileRaw || this.importing) return false
      if (this.mode === 'folder') {
        return (
          this.batchIndexes.length > 0 &&
          String(this.folderName || '').trim().length > 0
        )
      }
      return String(this.roomTitle || '').trim().length > 0
    }
  },
  methods: {
    reset() {
      if (this.importing) return
      this.fileList = []
      this.fileRaw = null
      this.sheets = []
      this.mode = 'single'
      this.singleIndex = 0
      this.batchIndexes = []
      this.folderName = ''
      this.roomTitle = ''
      this.progressMessage = ''
      this.progressPercent = 0
    },
    onExceed() {
      this.$message.warning('一次只能选择一个文件')
    },
    onRemove() {
      this.reset()
    },
    async onChange(file) {
      this.fileList = file ? [file] : []
      const raw = file && file.raw
      if (!raw) return
      if (!isSupportedImportName(raw.name)) {
        this.$message.error('请选择 .smm / .json / .xmind / .md 文件')
        this.reset()
        return
      }
      this.fileRaw = raw
      this.roomTitle = String(raw.name || '')
        .replace(/\.[^.]+$/, '')
        .slice(0, 60)
      this.folderName = this.roomTitle
      this.sheets = []
      this.mode = 'single'
      this.singleIndex = 0
      this.batchIndexes = []

      if (importFileKind(raw.name) === 'xmind') {
        try {
          const sheets = await listXmindSheets(raw)
          this.sheets = sheets
          this.batchIndexes = sheets.map(s => s.index)
          this.singleIndex = sheets[0] ? sheets[0].index : 0
          if (sheets.length > 1 && !this.teamId) {
            this.mode = 'folder'
          }
          if (sheets.length === 1) {
            this.roomTitle = sheets[0].title || this.roomTitle
          }
        } catch (err) {
          this.$message.error(userMessageFromError(err) || '读取 XMind 画布失败')
          this.reset()
        }
      }
    },
    toggleBatchAll(checked) {
      this.batchIndexes = checked ? this.sheets.map(s => s.index) : []
    },
    async submit() {
      if (!this.canSubmit || !this.fileRaw) return
      this.importing = true
      this.progressPercent = 0
      this.progressMessage = '开始导入…'
      const onProgress = ({ message, percent }) => {
        this.progressMessage = message || ''
        this.progressPercent = Math.max(0, Math.min(100, Number(percent) || 0))
      }
      try {
        if (this.mode === 'folder') {
          const result = await importXmindCanvasesToFolder({
            file: this.fileRaw,
            folderName: this.folderName.trim(),
            sheetIndexes: this.batchIndexes.slice(),
            teamId: this.teamId || null,
            onProgress
          })
          this.$emit('imported', {
            mode: 'folder',
            ...result
          })
          const failTip = result.failed && result.failed.length
            ? `，失败 ${result.failed.length} 个`
            : ''
          this.$message.success(
            `已导入 ${result.created.length} 个画布到「${result.folderName}」${failTip}`
          )
          this.visibleProxy = false
          return
        }
        const result = await importAsSingleRoom({
          file: this.fileRaw,
          folderId: this.folderId,
          teamId: this.teamId || null,
          title: this.roomTitle.trim(),
          sheetIndex: this.sheets.length ? this.singleIndex : 0,
          onProgress
        })
        this.$emit('imported', { mode: 'single', ...result })
        this.$message.success(`「${result.title}」导入成功`)
        this.visibleProxy = false
      } catch (err) {
        this.$message.error(userMessageFromError(err) || '导入失败')
      } finally {
        this.importing = false
      }
    }
  }
}
</script>

<style lang="less" scoped>
.homeImportDialog {
  .intro {
    color: #5f736c;
    font-size: 13px;
    line-height: 1.5;
    margin-bottom: 14px;
    code {
      background: #eef5f1;
      padding: 1px 6px;
      border-radius: 4px;
      font-size: 12px;
    }
  }
  .uploader {
    width: 100%;
    /deep/ .el-upload,
    /deep/ .el-upload-dragger {
      width: 100%;
    }
  }
  .sheetBlock {
    margin-top: 16px;
    padding-top: 14px;
    border-top: 1px solid #e6eeea;
  }
  .sheetHead {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-bottom: 12px;
    color: #344b42;
    font-weight: 600;
  }
  .hint {
    margin: 0 0 10px;
    color: #9a6b2f;
    font-size: 12px;
  }
  .sheetRadios,
  .sheetChecks {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 180px;
    overflow: auto;
    margin-bottom: 12px;
  }
  .folderName,
  .roomTitle {
    margin-top: 4px;
  }
  .progress {
    margin-top: 16px;
    p {
      margin: 8px 0 0;
      color: #5f736c;
      font-size: 13px;
    }
  }
}
</style>
