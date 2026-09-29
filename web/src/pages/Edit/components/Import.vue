<template>
  <div>
    <el-dialog
      class="nodeImportDialog"
      :title="$t('import.title')"
      :visible.sync="dialogVisible"
      width="480px"
    >
      <p class="importDescription">{{ $t('import.description') }}</p>
      <el-upload
        ref="upload"
        class="importUpload"
        action="x"
        drag
        :accept="supportFileStr"
        :file-list="fileList"
        :show-file-list="false"
        :auto-upload="false"
        :multiple="false"
        :on-change="onChange"
        :limit="1"
        :on-exceed="onExceed"
      >
        <div class="uploadPrompt">
          <span class="uploadIcon el-icon-upload" aria-hidden="true"></span>
          <strong>{{ $t('import.selectFile') }}</strong>
          <span>{{ $t('import.dropHint') }}</span>
        </div>
      </el-upload>
      <div class="formatRow">
        <span>{{ $t('import.supportedFormats') }}</span>
        <span class="formatTag" v-for="format in ['SMM', 'JSON', 'XMIND', 'MD']" :key="format">{{ format }}</span>
      </div>
      <div v-if="fileList.length" class="selectedFile">
        <span class="selectedFileIcon iconfont iconwenjian1" aria-hidden="true"></span>
        <div class="selectedFileName">
          <span>{{ $t('import.selectedFile') }}</span>
          <strong :title="fileList[0].name">{{ fileList[0].name }}</strong>
        </div>
        <button
          type="button"
          class="removeFile"
          :aria-label="$t('import.removeFile')"
          :title="$t('import.removeFile')"
          @click="clearSelectedFile"
        ><span class="el-icon-close" aria-hidden="true"></span></button>
      </div>
      <span slot="footer" class="dialog-footer">
        <el-button @click="cancel">{{ $t('dialog.cancel') }}</el-button>
        <el-button type="primary" :disabled="!fileList.length" @click="confirm">{{
          $t('import.startImport')
        }}</el-button>
      </span>
    </el-dialog>
    <el-dialog
      class="xmindCanvasSelectDialog"
      :title="$t('import.xmindCanvasSelectDialogTitle')"
      :visible.sync="xmindCanvasSelectDialogVisible"
      width="300px"
      :show-close="false"
    >
      <el-radio-group v-model="selectCanvas" class="canvasList">
        <el-radio
          v-for="(item, index) in canvasList"
          :key="index"
          :label="index"
          >{{ item.title }}</el-radio
        >
      </el-radio-group>
      <span slot="footer" class="dialog-footer">
        <el-button type="primary" @click="confirmSelect">{{
          $t('dialog.confirm')
        }}</el-button>
      </span>
    </el-dialog>
  </div>
</template>

<script>
import xmind from 'simple-mind-map/src/parse/xmind.js'
import markdown from 'simple-mind-map/src/parse/markdown.js'
import { mapMutations } from 'vuex'
import { parseJsonOffMainThread, yieldToUi } from '@/utils/importTree'
import { hideLoading } from '@/utils/loading'

// 导入
export default {
  data() {
    return {
      dialogVisible: false,
      fileList: [],
      selectPromiseResolve: null,
      xmindCanvasSelectDialogVisible: false,
      selectCanvas: '',
      canvasList: [],
      mdStr: ''
    }
  },
  computed: {
    supportFileStr() {
      return '.smm,.json,.xmind,.md'
    }
  },
  watch: {
    dialogVisible(val, oldVal) {
      if (!val && oldVal) {
        this.clearSelectedFile()
      }
    }
  },
  created() {
    this.$bus.$on('showImport', this.handleShowImport)
    this.$bus.$on('handle_file_url', this.handleFileURL)
    this.$bus.$on('importFile', this.handleImportFile)
  },
  beforeDestroy() {
    this.$bus.$off('showImport', this.handleShowImport)
    this.$bus.$off('handle_file_url', this.handleFileURL)
    this.$bus.$off('importFile', this.handleImportFile)
  },
  methods: {
    ...mapMutations(['setActiveSidebar']),

    handleShowImport() {
      this.dialogVisible = true
    },

    getRegexp() {
      return /\.(smm|json|xmind|md)$/
    },

    // 检查url中是否操作需要打开的文件
    async handleFileURL() {
      try {
        const fileURL = this.$route.query.fileURL
        if (!fileURL) return
        const macth = this.getRegexp().exec(fileURL)
        if (!macth) {
          return
        }
        const type = macth[1]
        const res = await fetch(fileURL)
        const file = await res.blob()
        const data = {
          raw: file
        }
        if (type === 'smm' || type === 'json') {
          this.handleSmm(data)
        } else if (type === 'xmind') {
          this.handleXmind(data)
        } else if (type === 'md') {
          this.handleMd(data)
        }
      } catch (error) {
        console.log(error)
      }
    },

    // 文件选择
    onChange(file) {
      if (!this.getRegexp().test(file.name)) {
        this.$message.error(
          this.$t('import.pleaseSelect') +
            this.supportFileStr +
            this.$t('import.file')
        )
        this.clearSelectedFile()
      } else {
        this.fileList = [file]
      }
    },

    clearSelectedFile() {
      this.fileList = []
      if (this.$refs.upload) this.$refs.upload.clearFiles()
    },

    // 数量超出限制
    onExceed() {
      this.$message.error(this.$t('import.maxFileNum'))
    },

    // 取消
    cancel() {
      this.dialogVisible = false
    },

    applyImportedData(data) {
      return new Promise((resolve, reject) => {
        const cleanup = () => {
          this.$bus.$off('setDataComplete', onDone)
          this.$bus.$off('setDataFailed', onFail)
        }
        const onDone = () => {
          cleanup()
          resolve()
        }
        const onFail = payload => {
          cleanup()
          const err = new Error(
            (payload && payload.message) || payload || 'IMPORT_APPLY_FAILED'
          )
          err.code =
            (payload && payload.code) ||
            (/DataCloneError|OUTBOX_NON_CLONEABLE_PAYLOAD|IMPORT_OUTBOX_SERIALIZE_FAILED|could not be cloned/.test(
              String((payload && payload.message) || payload || '')
            )
              ? 'IMPORT_OUTBOX_SERIALIZE_FAILED'
              : /COLLAB_V2_UNEXPECTED_FULL_TREE_MUTATION|UNEXPECTED_FULL_TREE_MUTATION/.test(
                  String((payload && payload.message) || payload || '')
                )
                ? 'FULL_TREE_MUTATION_FORBIDDEN'
                : 'IMPORT_APPLY_FAILED')
          err.stage = (payload && payload.stage) || err.code
          err.alreadyNotified = !!(payload && payload.notified)
          reject(err)
        }
        this.$bus.$once('setDataComplete', onDone)
        this.$bus.$once('setDataFailed', onFail)
        this.$bus.$emit('setData', data)
      })
    },

    // 确定
    confirm() {
      if (this.fileList.length <= 0) {
        return this.$message.error(this.$t('import.notSelectTip'))
      }
      this.$store.commit('setIsHandleLocalFile', false)
      let file = this.fileList[0]
      if (/\.(smm|json)$/.test(file.name)) {
        this.handleSmm(file)
      } else if (/\.xmind$/.test(file.name)) {
        this.handleXmind(file)
      } else if (/\.md$/.test(file.name)) {
        this.handleMd(file)
      }
      this.cancel()
      this.setActiveSidebar(null)
    },

    // 处理.smm文件
    handleSmm(file) {
      let fileReader = new FileReader()
      fileReader.readAsText(file.raw)
      fileReader.onload = async evt => {
        try {
          this.$bus.$emit('showLoading', this.$t('edit.importingTip'))
          await yieldToUi()
          let data = await parseJsonOffMainThread(evt.target.result)
          if (typeof data !== 'object') {
            throw new Error(this.$t('import.fileContentError'))
          }
          await this.applyImportedData(data)
          this.$message.success(this.$t('import.importSuccess'))
        } catch (error) {
          console.log(error)
          hideLoading()
          if (!error.alreadyNotified) {
            this.$message.error(this.importErrorText(error, 'IMPORT_PARSE_FAILED'))
          }
        }
      }
    },

    // 处理.xmind文件
    async handleXmind(file) {
      this.$bus.$emit('showLoading', this.$t('edit.importingTip'))
      await this.$nextTick()
      await yieldToUi()
      try {
        let data = await xmind.parseXmindFile(file.raw, content => {
          this.showSelectXmindCanvasDialog(content)
          return new Promise(resolve => {
            this.selectPromiseResolve = resolve
          })
        })
        await this.applyImportedData(data)
        this.$message.success(this.$t('import.importSuccess'))
      } catch (error) {
        console.log(error)
        hideLoading()
        if (!error.alreadyNotified) {
          this.$message.error(this.importErrorText(error, 'IMPORT_PARSE_FAILED'))
        }
      }
    },

    // 显示xmind文件的多个画布选择弹窗
    showSelectXmindCanvasDialog(content) {
      this.canvasList = content
      this.selectCanvas = 0
      this.xmindCanvasSelectDialogVisible = true
    },

    // 确认导入指定的画布
    confirmSelect() {
      this.selectPromiseResolve(this.canvasList[this.selectCanvas])
      this.xmindCanvasSelectDialogVisible = false
      this.canvasList = []
      this.selectCanvas = 0
    },

    // 处理markdown文件
    async handleMd(file) {
      let fileReader = new FileReader()
      fileReader.readAsText(file.raw)
      fileReader.onload = async evt => {
        try {
          this.$bus.$emit('showLoading', this.$t('edit.importingTip'))
          await yieldToUi()
          let data = markdown.transformMarkdownTo(evt.target.result)
          await this.applyImportedData(data)
          this.$message.success(this.$t('import.importSuccess'))
        } catch (error) {
          console.log(error)
          hideLoading()
          if (!error.alreadyNotified) {
            this.$message.error(this.importErrorText(error, 'IMPORT_PARSE_FAILED'))
          }
        }
      }
    },

    importErrorText(error, fallbackStage) {
      const code = String((error && error.code) || '')
      const msg = String((error && error.message) || '')
      if (
        code === 'OUTBOX_NON_CLONEABLE_PAYLOAD' ||
        code === 'IMPORT_OUTBOX_SERIALIZE_FAILED' ||
        /DataCloneError|OUTBOX_NON_CLONEABLE_PAYLOAD|could not be cloned/.test(msg)
      ) {
        return 'IMPORT_OUTBOX_SERIALIZE_FAILED'
      }
      if (
        code === 'FULL_TREE_MUTATION_FORBIDDEN' ||
        code === 'UNEXPECTED_FULL_TREE_MUTATION' ||
        /COLLAB_V2_UNEXPECTED_FULL_TREE_MUTATION/.test(msg)
      ) {
        return this.$t('edit.importPersistFailed')
      }
      if (code === 'IMPORT_APPLY_FAILED' || fallbackStage === 'IMPORT_APPLY_FAILED') {
        return this.$t('edit.importPersistFailed')
      }
      return msg || this.$t('import.fileParsingFailed')
    },

    // 导入指定文件
    handleImportFile(file) {
      this.onChange({
        raw: file,
        name: file.name
      })
      if (this.fileList.length <= 0) return
      this.confirm()
    }
  }
}
</script>

<style lang="less" scoped>
.nodeImportDialog {
  /deep/ .el-dialog {
    max-width: calc(100vw - 32px);
    border-radius: 12px;
    overflow: hidden;
  }

  /deep/ .el-dialog__header {
    padding: 24px 24px 0;
  }

  /deep/ .el-dialog__title {
    font-size: 18px;
    font-weight: 600;
    color: #1f2937;
  }

  /deep/ .el-dialog__body {
    padding: 8px 24px 16px;
  }

  /deep/ .el-dialog__footer {
    padding: 0 24px 24px;
  }

  .importDescription {
    margin: 0 0 20px;
    color: #64748b;
    font-size: 13px;
    line-height: 1.5;
  }

  .importUpload {
    width: 100%;

    /deep/ .el-upload,
    /deep/ .el-upload-dragger {
      width: 100%;
    }

    /deep/ .el-upload-dragger {
      height: 160px;
      border: 1px dashed #b8c8dc;
      border-radius: 9px;
      background: #f8fbff;
      transition: background 0.2s, border-color 0.2s;

      &:hover,
      &.is-dragover {
        border-color: #409eff;
        background: #f1f7ff;
      }
    }

    /deep/ .el-upload:focus .el-upload-dragger {
      outline: 2px solid #409eff;
      outline-offset: 2px;
    }

    .uploadPrompt {
      height: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 7px;
      color: #64748b;
      font-size: 12px;

      .uploadIcon {
        margin: 0 0 3px;
        color: #409eff;
        font-size: 32px;
        line-height: 1;
      }

      strong {
        color: #2563eb;
        font-size: 14px;
        font-weight: 600;
      }
    }
  }

  .formatRow {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 12px;
    color: #64748b;
    font-size: 12px;

    > span:first-child {
      margin-right: 4px;
    }
  }

  .formatTag {
    padding: 3px 7px;
    border: 1px solid #e2e8f0;
    border-radius: 4px;
    background: #f8fafc;
    color: #475569;
    font-size: 11px;
    line-height: 1.2;
  }

  .selectedFile {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 18px;
    padding: 10px 12px;
    border: 1px solid #dbeafe;
    border-radius: 8px;
    background: #f8fbff;
  }

  .selectedFileIcon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: 6px;
    background: #e8f2ff;
    color: #409eff;
    font-size: 16px;
    flex: none;
  }

  .selectedFileName {
    display: flex;
    flex: 1;
    min-width: 0;
    flex-direction: column;
    gap: 3px;

    span {
      color: #64748b;
      font-size: 11px;
    }

    strong {
      overflow: hidden;
      color: #1f2937;
      font-size: 13px;
      font-weight: 500;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }

  .removeFile {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: #64748b;
    cursor: pointer;
    flex: none;

    &:hover {
      background: #e8f2ff;
      color: #2563eb;
    }

    &:focus-visible {
      outline: 2px solid #409eff;
      outline-offset: 2px;
    }
  }
}

.canvasList {
  display: flex;
  flex-direction: column;

  /deep/ .el-radio {
    margin-bottom: 12px;

    &:last-of-type {
      margin-bottom: 0;
    }
  }
}
</style>
