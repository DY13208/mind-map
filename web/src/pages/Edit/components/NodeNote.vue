<template>
  <el-dialog
    class="nodeNoteDialog"
    :title="$t('nodeNote.title')"
    :visible.sync="dialogVisible"
    :width="isMobile ? '90%' : '50%'"
    :top="isMobile ? '20px' : '15vh'"
  >
    <!-- <el-input
      type="textarea"
      :autosize="{ minRows: 3, maxRows: 5 }"
      placeholder="请输入内容"
      v-model="note"
    >
    </el-input> -->
    <div class="noteEditor" ref="noteEditor" @keyup.stop @keydown.stop></div>
    <!-- <div class="tip">换行请使用：Enter+Shift</div> -->
    <span slot="footer" class="dialog-footer">
      <el-button @click="cancel">{{ $t('dialog.cancel') }}</el-button>
      <el-button type="primary" @click="confirm">{{
        $t('dialog.confirm')
      }}</el-button>
    </span>
  </el-dialog>
</template>

<script>
import Editor from '@toast-ui/editor'
import '@toast-ui/editor/dist/toastui-editor.css' // Editor's Style
import '@toast-ui/editor/dist/theme/toastui-editor-dark.css'
import { mapState } from 'vuex'
import { isMobile } from 'simple-mind-map/src/utils/index'

// 节点备注内容设置
export default {
  name: 'NodeNote',
  data() {
    return {
      dialogVisible: false,
      note: '',
      activeNodes: [],
      editor: null,
      isMobile: isMobile(),
      appointNode: null
    }
  },
  computed: {
    ...mapState({
      isDark: state => state.localConfig.isDark
    })
  },
  watch: {
    isDark() {
      this.applyEditorTheme()
    },
    dialogVisible(val, oldVal) {
      if (!val && oldVal) {
        this.$bus.$emit('endTextEdit')
      }
    }
  },
  created() {
    this.$bus.$on('node_active', this.handleNodeActive)
    this.$bus.$on('showNodeNote', this.handleShowNodeNote)
  },
  beforeDestroy() {
    this.$bus.$off('node_active', this.handleNodeActive)
    this.$bus.$off('showNodeNote', this.handleShowNodeNote)
  },
  methods: {
    handleNodeActive(...args) {
      this.activeNodes = [...args[1]]
      this.updateNoteInfo()
    },

    updateNoteInfo() {
      if (this.activeNodes.length > 0) {
        let firstNode = this.activeNodes[0]
        this.note = firstNode.getData('note') || ''
      } else {
        this.note = ''
      }
    },

    handleShowNodeNote(node) {
      this.$bus.$emit('startTextEdit')
      if (node) {
        this.appointNode = node
        this.note = node.getData('note') || ''
      }
      this.dialogVisible = true
      this.$nextTick(() => {
        this.initEditor()
      })
    },

    initEditor() {
      if (!this.editor) {
        this.editor = new Editor({
          el: this.$refs.noteEditor,
          height: '500px',
          initialEditType: 'markdown',
          previewStyle: 'vertical'
        })
      }
      this.applyEditorTheme()
      this.editor.setMarkdown(this.note)
    },

    // toast-ui 的 theme 只能在创建时指定，这里切换官方暗色主题的类名以跟随深色模式
    applyEditorTheme() {
      const el = this.$refs.noteEditor
      if (el) el.classList.toggle('toastui-editor-dark', !!this.isDark)
    },

    cancel() {
      this.dialogVisible = false
      if (this.appointNode) {
        this.appointNode = null
        this.updateNoteInfo()
      }
    },

    confirm() {
      this.note = this.editor.getMarkdown()
      if (this.appointNode) {
        this.appointNode.setNote(this.note)
      } else {
        this.activeNodes.forEach(node => {
          node.setNote(this.note)
        })
      }

      this.cancel()
    }
  }
}
</script>

<style lang="less" scoped>
.nodeNoteDialog {
  .tip {
    margin-top: 5px;
    color: #dcdfe6;
  }
}
</style>

<style lang="less">
/* 深色模式：在 toast-ui 官方暗色主题上统一到应用配色 */
.toastui-editor-dark.toastui-editor-defaultUI {
  border-color: #3a3f45;
  background-color: #1f2226;
  color: hsla(0, 0%, 100%, 0.85);

  .toastui-editor-defaultUI-toolbar {
    background-color: #262a2e;
    border-bottom-color: #3a3f45;
  }
  .toastui-editor-main-container,
  .toastui-editor-md-container,
  .toastui-editor-ww-container,
  .toastui-editor-md-preview {
    background-color: #1f2226;
  }
  .toastui-editor-md-splitter { background-color: #3a3f45; }
  .toastui-editor-mode-switch {
    background-color: #262a2e;
    border-top-color: #3a3f45;
    .tab-item {
      background-color: #1f2226;
      border-color: #3a3f45;
      color: hsla(0, 0%, 100%, 0.55);
      &.active { background-color: #262a2e; color: hsla(0, 0%, 100%, 0.9); }
    }
  }
  .toastui-editor-contents .toastui-editor-md-preview-highlight::after {
    background-color: hsla(0, 0%, 100%, 0.06);
  }
}
</style>
