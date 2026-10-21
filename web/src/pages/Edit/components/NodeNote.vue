<template>
  <el-dialog
    class="nodeNoteDialog"
    :title="$t('nodeNote.title')"
    :visible.sync="dialogVisible"
    :close-on-click-modal="false"
    :before-close="beforeDialogClose"
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
    <div v-for="entry in conflictEntries" :key="entry.id" class="conflictEntry">
      <p v-if="partialSave">{{ $t('editConflict.partial') }} · {{ entry.uid }}</p>
      <ConflictDraftPanel
        :draft="entry.session"
        :latest="entry.latestSnapshot"
        :persisted="entry.persisted"
        :storage-error="entry.storageError"
        @show-latest="refreshLatest(entry)"
      >
        <el-button slot="discard" type="text" size="mini" @click="discardConflicts">
          {{ $t('editConflict.discard') }}
        </el-button>
      </ConflictDraftPanel>
    </div>
    <p v-if="saveError" class="saveError" role="alert">{{ saveError }}</p>
    <!-- <div class="tip">换行请使用：Enter+Shift</div> -->
    <span slot="footer" class="dialog-footer">
      <el-button v-if="conflictEntries.length" type="danger" plain :disabled="saving" @click="discardConflicts">{{
        $t('editConflict.discard')
      }}</el-button>
      <el-button v-else :disabled="saving" @click="cancel">{{ $t('dialog.cancel') }}</el-button>
      <el-button type="primary" :loading="saving" :disabled="saving || conflictEntries.length > 0" @click="confirm">{{
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
import ConflictDraftPanel from './ConflictDraftPanel.vue'
import {
  discardEditSession,
  currentEditPrincipal,
  getEditCooperate,
  getLiveNode,
  isCollaborativeRoom,
  isEditConflictError,
  persistConflictSessionDraft,
  persistEditConflict
} from '@/utils/conflictEdit'
import { conflictDraftKey, removeConflictDraft } from '@/utils/conflictDraftStore'
import { roomFromLocation } from '@/utils/roomLocation'

// 节点备注内容设置
export default {
  name: 'NodeNote',
  components: { ConflictDraftPanel },
  data() {
    return {
      dialogVisible: false,
      note: '',
      activeNodes: [],
      editor: null,
      isMobile: isMobile(),
      mindMap: null,
      targetUids: [],
      sessions: [],
      conflictEntries: [],
      saving: false,
      saveError: '',
      partialSave: false,
      composing: false,
      settingEditorValue: false
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
  beforeDestroy() {
    this.$bus.$off('node_active', this.handleNodeActive)
    this.$bus.$off('showNodeNote', this.handleShowNodeNote)
    if (this.editor && typeof this.editor.off === 'function') {
      this.editor.off('change', this.onEditorChange)
    }
    const root = this.$refs.noteEditor
    if (root) {
      root.removeEventListener('compositionstart', this.onCompositionStart, true)
      root.removeEventListener('compositionend', this.onCompositionEnd, true)
    }
  },
  created() {
    this.$bus.$on('node_active', this.handleNodeActive)
    this.$bus.$on('showNodeNote', this.handleShowNodeNote)
  },
  methods: {
    handleNodeActive(...args) {
      this.activeNodes = [...args[1]]
      if (!this.dialogVisible) this.updateNoteInfo()
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
      if (this.dialogVisible) return
      const targets = node ? [node] : this.activeNodes
      const uids = [...new Set(targets.map(item => item && item.getData && item.getData('uid')).filter(Boolean))]
      if (!uids.length) return
      this.mindMap = (targets[0] && targets[0].mindMap) || this.mindMap
      this.targetUids = uids.map(String)
      this.sessions = []
      this.conflictEntries = []
      this.partialSave = false
      this.saving = false
      this.saveError = ''
      const first = getLiveNode(this.mindMap, this.targetUids[0]) || targets[0]
      const cooperate = getEditCooperate(this.mindMap)
      const snapshot =
        isCollaborativeRoom(this.$route) &&
        cooperate &&
        cooperate.getEditSessionSnapshot &&
        cooperate.getEditSessionSnapshot(this.targetUids[0])
      this.note =
        (snapshot && snapshot.data && snapshot.data.note) ||
        (first && first.getData('note')) ||
        ''
      this.beginSessions()
      this.$bus.$emit('startTextEdit')
      this.dialogVisible = true
      this.$nextTick(() => {
        this.initEditor()
      })
    },

    beginSessions() {
      if (!isCollaborativeRoom(this.$route)) return
      const cooperate = getEditCooperate(this.mindMap)
      if (!cooperate || typeof cooperate.beginEditSession !== 'function') {
        this.saveError = this.$t('editConflict.precondition')
        return
      }
      const opened = []
      try {
        this.targetUids.forEach(uid => {
          const session = cooperate.beginEditSession({
            uid,
            fields: ['note'],
            kind: 'note',
            initialDraft: { note: this.note }
          })
          if (!session) throw new Error('编辑节点已不可用')
          opened.push({ uid, id: session.id, session, conflict: false, persisted: false, storageError: '' })
        })
        this.sessions = opened
      } catch (_) {
        opened.forEach(entry => discardEditSession(cooperate, entry.id))
        this.sessions = []
        this.saveError = this.$t('editConflict.precondition')
      }
    },

    initEditor() {
      if (!this.editor) {
        this.editor = new Editor({
          el: this.$refs.noteEditor,
          height: '500px',
          initialEditType: 'markdown',
          previewStyle: 'vertical'
        })
        this.editor.on('change', this.onEditorChange)
        const root = this.$refs.noteEditor
        root.addEventListener('compositionstart', this.onCompositionStart, true)
        root.addEventListener('compositionend', this.onCompositionEnd, true)
      }
      this.applyEditorTheme()
      this.settingEditorValue = true
      this.editor.setMarkdown(this.note)
      this.$nextTick(() => {
        this.settingEditorValue = false
      })
    },

    onEditorChange() {
      if (this.settingEditorValue || !this.editor) return
      this.note = this.editor.getMarkdown()
      this.updateSessionDraft({ note: this.note })
    },

    updateSessionDraft(patch) {
      const cooperate = getEditCooperate(this.mindMap)
      this.sessions.forEach(entry => {
        if (!cooperate || typeof cooperate.updateEditSessionDraft !== 'function') return
        try {
          entry.session = cooperate.updateEditSessionDraft(entry.id, patch) || entry.session
        } catch (_) {
          // Keep the visible editor draft if the session manager is unavailable.
        }
        if (entry.conflict) this.persistConflictEntry(entry)
      })
    },

    onCompositionStart() {
      this.composing = true
      const cooperate = getEditCooperate(this.mindMap)
      this.sessions.forEach(entry => {
        if (cooperate && cooperate.setEditSessionComposing) cooperate.setEditSessionComposing(entry.id, true)
      })
    },

    onCompositionEnd() {
      this.composing = false
      const cooperate = getEditCooperate(this.mindMap)
      this.sessions.forEach(entry => {
        if (cooperate && cooperate.setEditSessionComposing) cooperate.setEditSessionComposing(entry.id, false)
      })
      this.onEditorChange()
    },

    // toast-ui 的 theme 只能在创建时指定，这里切换官方暗色主题的类名以跟随深色模式
    applyEditorTheme() {
      const el = this.$refs.noteEditor
      if (el) el.classList.toggle('toastui-editor-dark', !!this.isDark)
    },

    async cancel() {
      if (this.conflictEntries.length) return this.discardConflicts()
      this.sessions.forEach(entry => discardEditSession(getEditCooperate(this.mindMap), entry.id))
      this.sessions = []
      this.dialogVisible = false
      this.updateNoteInfo()
    },

    beforeDialogClose(done) {
      this.requestClose(done)
    },

    async requestClose(done) {
      if (this.conflictEntries.length) {
        this.$message.warning(this.$t('editConflict.closeBlocked'))
        return
      }
      if (this.saving) {
        this.$message.warning(this.$t('editConflict.saveFailed'))
        return
      }
      this.sessions.forEach(entry => discardEditSession(getEditCooperate(this.mindMap), entry.id))
      this.sessions = []
      if (done) done()
      else this.dialogVisible = false
    },

    async confirm() {
      if (this.saving || this.conflictEntries.length || this.composing) return
      if (!this.editor) return
      this.note = this.editor.getMarkdown()
      this.saveError = ''
      if (isCollaborativeRoom(this.$route)) {
        if (!this.sessions.length) {
          this.saveError = this.$t('editConflict.precondition')
          return
        }
        const cooperate = getEditCooperate(this.mindMap)
        if (!cooperate || typeof cooperate.commitEditSession !== 'function') {
          this.saveError = this.$t('editConflict.precondition')
          return
        }
        this.saving = true
        try {
          const entries = this.sessions.slice()
          const results = await Promise.all(
            entries.map(async entry => {
              if (cooperate.updateEditSessionDraft) {
                entry.session = cooperate.updateEditSessionDraft(entry.id, { note: this.note }) || entry.session
              }
              try {
                await cooperate.commitEditSession(entry.id, { note: this.note })
                if (cooperate.resolveEditSession) cooperate.resolveEditSession(entry.id)
                return { entry, ok: true }
              } catch (error) {
                if (isEditConflictError(error)) {
                  entry.conflict = true
                  try {
                    const retained = await persistEditConflict({
                      mindMap: this.mindMap,
                      route: this.$route,
                      sessionId: entry.id,
                      error,
                      fallbackSession: entry.session
                    })
                    const currentSession = cooperate.getEditSession(entry.id) || retained.session
                    entry.session = currentSession
                    entry.latestSnapshot = retained.latestSnapshot
                    entry.record = { key: retained.key, sessionId: entry.id }
                    entry.persisted = retained.saved && currentSession.draftRevision === retained.revision
                    entry.storageError = ''
                    if (entry.persisted) this.$bus.$emit('conflict_draft_saved')
                  } catch (storageError) {
                    entry.session = cooperate.getEditSession(entry.id) || entry.session
                    entry.latestSnapshot = cooperate.getEditSessionSnapshot
                      ? cooperate.getEditSessionSnapshot(entry.uid) || entry.latestSnapshot
                      : entry.latestSnapshot
                    entry.storageError = storageError.message || 'draft storage failed'
                    entry.persisted = false
                  }
                } else {
                  entry.saveError = error
                }
                return { entry, ok: false, error }
              }
            })
          )
          const failed = results.filter(result => !result.ok).map(result => result.entry)
          if (!failed.length) {
            this.sessions = []
            this.dialogVisible = false
            this.updateNoteInfo()
            return
          }
          this.sessions = failed
          this.targetUids = failed.map(entry => entry.uid)
          this.conflictEntries = failed.filter(entry => entry.conflict)
          this.partialSave = results.some(result => result.ok) && this.conflictEntries.length > 0
          if (!this.conflictEntries.length) this.saveError = this.$t('editConflict.saveFailed')
        } finally {
          this.saving = false
        }
        return
      }

      this.saving = true
      try {
        const nodes = this.targetUids.map(uid => getLiveNode(this.mindMap, uid))
        if (nodes.some(node => !node || typeof node.setNote !== 'function')) {
          this.saveError = this.$t('editConflict.saveFailed')
          return
        }
        nodes.forEach(node => {
          node.setNote(this.note)
        })
        this.dialogVisible = false
        this.updateNoteInfo()
      } catch (_) {
        this.saveError = this.$t('editConflict.saveFailed')
      } finally {
        this.saving = false
      }
    },

    async persistConflictEntry(entry) {
      const expectedRevision = Number((entry.session && entry.session.draftRevision) || 0)
      const cooperate = getEditCooperate(this.mindMap)
      try {
        const persisted = await persistConflictSessionDraft({
          mindMap: this.mindMap,
          route: this.$route,
          sessionId: entry.id,
          latestSnapshot: entry.latestSnapshot,
          error: entry.session && entry.session.error
        })
        const currentSession = cooperate && cooperate.getEditSession
          ? cooperate.getEditSession(entry.id)
          : null
        if (currentSession && currentSession.draftRevision !== expectedRevision) return
        entry.session = currentSession || persisted.session
        entry.latestSnapshot = persisted.latestSnapshot || entry.latestSnapshot
        if (persisted.saved && persisted.revision === expectedRevision) {
          entry.persisted = true
          entry.storageError = ''
        }
      } catch (error) {
        const currentSession = cooperate && cooperate.getEditSession
          ? cooperate.getEditSession(entry.id)
          : null
        if (currentSession && currentSession.draftRevision !== expectedRevision) return
        entry.persisted = false
        entry.storageError = error.message || 'draft storage failed'
      }
    },

    refreshLatest(entry) {
      const cooperate = getEditCooperate(this.mindMap)
      if (cooperate && typeof cooperate.getEditSessionSnapshot === 'function') {
        entry.latestSnapshot = cooperate.getEditSessionSnapshot(entry.uid) || entry.latestSnapshot
      }
    },

    async discardConflicts() {
      try {
        await this.$confirm(
          this.$t('editConflict.discardConfirm'),
          this.$t('editConflict.title'),
          { type: 'warning' }
        )
      } catch (_) {
        return
      }
      const cooperate = getEditCooperate(this.mindMap)
      try {
        await Promise.all(
          this.conflictEntries.map(async entry => {
          const key = (entry.record && entry.record.key) ||
              conflictDraftKey({
                principal: currentEditPrincipal(),
                room: roomFromLocation(this.$route),
                uid: entry.uid,
                group: 'note',
                sessionId: entry.id
              })
            await removeConflictDraft({ key, sessionId: entry.id })
            discardEditSession(cooperate, entry.id)
          })
        )
        this.sessions.forEach(entry => {
          if (!entry.conflict) discardEditSession(cooperate, entry.id)
        })
        this.sessions = []
        this.conflictEntries = []
        this.dialogVisible = false
        this.updateNoteInfo()
      } catch (error) {
        this.$message.error(this.$t('editConflict.storageFailed'))
      }
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
