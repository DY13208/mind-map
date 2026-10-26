<template>
  <el-dialog
    class="nodeHyperlinkDialog"
    append-to-body
    :title="$t('nodeHyperlink.title')"
    :visible.sync="dialogVisible"
    :close-on-click-modal="false"
    :before-close="beforeDialogClose"
    width="520px"
    top="15vh"
    @opened="focusLink"
    @closed="resetTargets"
  >
    <p class="linkIntro">{{ $t('nodeHyperlink.description') }}</p>
    <form class="linkForm" @submit.prevent="confirm" @keydown="onInputKeydown" @keyup.stop>
      <label for="node-hyperlink-url">{{ $t('nodeHyperlink.link') }}</label>
      <el-input
        id="node-hyperlink-url"
        ref="linkInput"
        v-model="link"
        :placeholder="$t('nodeHyperlink.linkPlaceholder')"
        :class="{ invalid: error }"
        :aria-invalid="error ? 'true' : 'false'"
        aria-describedby="node-hyperlink-hint"
        prefix-icon="el-icon-link"
        autocomplete="off"
        @input="error = ''"
        @blur="validateLink"
      />
      <p id="node-hyperlink-hint" class="fieldHint" :class="{ error }" aria-live="polite">
        {{ error || $t('nodeHyperlink.linkHint') }}
      </p>
      <label for="node-hyperlink-name">
        {{ $t('nodeHyperlink.name') }}
        <span class="optional">{{ $t('nodeHyperlink.optional') }}</span>
      </label>
      <el-input
        id="node-hyperlink-name"
        v-model="linkTitle"
        :placeholder="$t('nodeHyperlink.namePlaceholder')"
        autocomplete="off"
      />
      <div class="linkPreview" v-if="resolvedLink" aria-live="polite">
        <i class="el-icon-top-right" aria-hidden="true"></i>
        <div>
          <div class="previewTitle">{{ linkTitle.trim() || resolvedLink.hostname }}</div>
          <div class="previewAddress" :title="resolvedLink.href">{{ resolvedLink.href }}</div>
        </div>
      </div>
      <p class="fieldHint openHint">{{ $t('nodeHyperlink.openHint') }}</p>
    </form>
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
    <div slot="footer" class="linkFooter">
      <el-button v-if="hasExistingLink && !conflictEntries.length" type="text" class="removeLink" :disabled="saving" @click="removeLink">
        {{ $t('nodeHyperlink.remove') }}
      </el-button>
      <div class="footerActions">
        <el-button v-if="conflictEntries.length" size="small" round type="danger" plain @click="discardConflicts">{{ $t('editConflict.discard') }}</el-button>
        <el-button v-else size="small" round :disabled="saving" @click="cancel">{{ $t('dialog.cancel') }}</el-button>
        <el-button size="small" round type="primary" :loading="saving" :disabled="saving || conflictEntries.length > 0 || !link.trim()" @click="confirm">
          {{ $t('dialog.confirm') }}
        </el-button>
      </div>
    </div>
  </el-dialog>
</template>

<script>
import ConflictDraftPanel from './ConflictDraftPanel.vue'
import {
  currentEditPrincipal,
  discardEditSession,
  getEditCooperate,
  getLiveNode,
  isCollaborativeRoom,
  isEditConflictError,
  persistConflictSessionDraft,
  persistEditConflict
} from '@/utils/conflictEdit'
import { conflictDraftKey, removeConflictDraft } from '@/utils/conflictDraftStore'
import { roomFromLocation } from '@/utils/roomLocation'
import {
  isLocalFileReference,
  localFileDisplayName
} from 'simple-mind-map/src/utils/localFileLink'

// Keep draft fields and target nodes stable until the dialog is saved or cancelled.
export default {
  components: { ConflictDraftPanel },
  data() {
    return {
      dialogVisible: false,
      link: '',
      linkTitle: '',
      activeNodes: [],
      targetUids: [],
      mindMap: null,
      sessions: [],
      conflictEntries: [],
      saving: false,
      saveError: '',
      partialSave: false,
      hasExistingLink: false,
      error: ''
    }
  },
  computed: {
    resolvedLink() {
      try {
        return new URL(this.normalizeLink(this.link), window.location.href)
      } catch (_) {
        return null
      }
    }
  },
  created() {
    this.$bus.$on('node_active', this.handleNodeActive)
    this.$bus.$on('showNodeLink', this.handleShowNodeLink)
  },
  beforeDestroy() {
    this.$bus.$off('node_active', this.handleNodeActive)
    this.$bus.$off('showNodeLink', this.handleShowNodeLink)
  },
  watch: {
    link(value) {
      this.updateSessionDraft({ hyperlink: value })
    },
    linkTitle(value) {
      this.updateSessionDraft({ hyperlinkTitle: value })
    }
  },
  methods: {
    handleNodeActive(...args) {
      this.activeNodes = [...(args[1] || [])]
    },
    normalizeLink(value) {
      const input = value.trim()
      if (!input || /\s/.test(input)) throw new Error('invalid')
      if (isLocalFileReference(input)) throw new Error('local-file')
      const relative = /^(\/(?!\/)|\.\.?\/|[?#])/.test(input)
      const explicitHttp = /^https?:\/\//i.test(input)
      // Allow host:port while rejecting schemes the existing link opener cannot open.
      if (!relative && !explicitHttp && /^[a-z][a-z\d+.-]*:/i.test(input) && !/^[^/:]+:\d+(?:[/?#]|$)/.test(input)) {
        throw new Error('invalid')
      }
      const normalized = relative || explicitHttp ? input : input.startsWith('//') ? 'https:' + input : 'https://' + input
      const parsed = new URL(normalized, window.location.href)
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid')
      if (!relative && !explicitHttp && !parsed.hostname.includes('.') && parsed.hostname !== 'localhost' && !parsed.hostname.includes(':')) {
        throw new Error('invalid')
      }
      return normalized
    },
    validateLink() {
      try {
        this.normalizeLink(this.link)
        this.error = ''
        return true
      } catch (err) {
        if (err && err.message === 'local-file') {
          this.error = this.$t('nodeHyperlink.localFileAsAttachment')
          return false
        }
        this.error = this.$t(this.link.trim() ? 'nodeHyperlink.invalidLink' : 'nodeHyperlink.requiredLink')
        return false
      }
    },
    redirectLocalFileToAttachment() {
      const input = (this.link || '').trim()
      if (!isLocalFileReference(input)) return false
      const name = localFileDisplayName(input) || '本地文件'
      const nodes = this.targetUids
        .map(uid => getLiveNode(this.mindMap, uid))
        .filter(Boolean)
      this.$message.warning(
        this.$t('nodeHyperlink.localFileRedirect', { name })
      )
      this.sessions.forEach(entry =>
        discardEditSession(getEditCooperate(this.mindMap), entry.id)
      )
      this.sessions = []
      this.dialogVisible = false
      this.$nextTick(() => {
        this.$bus.$emit('selectAttachment', nodes)
      })
      return true
    },
    handleShowNodeLink(node) {
      if (this.dialogVisible) return
      const targets = Array.isArray(node) ? node : node && typeof node.getData === 'function' ? [node] : [...this.activeNodes]
      const uids = [...new Set(targets.map(item => item && item.getData && item.getData('uid')).filter(Boolean))]
      if (!uids.length) return
      this.mindMap = (targets[0] && targets[0].mindMap) || this.mindMap
      this.targetUids = uids.map(String)
      const first = getLiveNode(this.mindMap, this.targetUids[0]) || targets[0]
      const cooperate = getEditCooperate(this.mindMap)
      const snapshot =
        isCollaborativeRoom(this.$route) &&
        cooperate &&
        cooperate.getEditSessionSnapshot &&
        cooperate.getEditSessionSnapshot(this.targetUids[0])
      const data = (snapshot && snapshot.data) || (first && first.getData()) || {}
      this.link = data.hyperlink || ''
      this.linkTitle = data.hyperlinkTitle || ''
      this.hasExistingLink = targets.some(target => !!target.getData('hyperlink'))
      this.sessions = []
      this.conflictEntries = []
      this.partialSave = false
      this.saving = false
      this.saveError = ''
      this.error = ''
      this.beginSessions()
      this.dialogVisible = true
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
            fields: ['hyperlink', 'hyperlinkTitle'],
            kind: 'hyperlink',
            initialDraft: { hyperlink: this.link, hyperlinkTitle: this.linkTitle }
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
    focusLink() {
      this.$refs.linkInput.focus()
    },
    resetTargets() {
      if (!this.dialogVisible) {
        this.targetUids = []
        this.sessions = []
      }
    },
    onInputKeydown(event) {
      if (event.key === 'Escape') return
      event.stopPropagation()
      if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault()
        this.confirm()
      }
    },
    async cancel() {
      if (this.conflictEntries.length) return this.discardConflicts()
      this.sessions.forEach(entry => discardEditSession(getEditCooperate(this.mindMap), entry.id))
      this.sessions = []
      this.dialogVisible = false
    },
    beforeDialogClose(done) {
      this.requestClose(done)
    },
    requestClose(done) {
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
    async removeLink() {
      await this.saveLink('', '')
    },
    async confirm() {
      if (!this.dialogVisible || this.saving || this.conflictEntries.length) return
      if (this.redirectLocalFileToAttachment()) return
      if (!this.validateLink()) return
      await this.saveLink(this.normalizeLink(this.link), this.linkTitle.trim())
    },
    async saveLink(link, linkTitle) {
      this.saveError = ''
      const patch = { hyperlink: link, hyperlinkTitle: linkTitle }
      if (isCollaborativeRoom(this.$route)) {
        const cooperate = getEditCooperate(this.mindMap)
        if (!this.sessions.length || !cooperate || typeof cooperate.commitEditSession !== 'function') {
          this.saveError = this.$t('editConflict.precondition')
          return
        }
        this.saving = true
        try {
          const results = await Promise.all(this.sessions.map(async entry => {
            if (cooperate.updateEditSessionDraft) {
              entry.session = cooperate.updateEditSessionDraft(entry.id, patch) || entry.session
            }
            try {
              await cooperate.commitEditSession(entry.id, patch)
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
                  entry.persisted = false
                  entry.storageError = storageError.message || 'draft storage failed'
                }
              } else {
                entry.saveError = error
              }
              return { entry, ok: false, error }
            }
          }))
          const failed = results.filter(result => !result.ok).map(result => result.entry)
          if (!failed.length) {
            this.sessions = []
            this.dialogVisible = false
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
        if (nodes.some(node => !node || typeof node.setHyperlink !== 'function')) {
          this.saveError = this.$t('editConflict.saveFailed')
          return
        }
        nodes.forEach(node => node.setHyperlink(link, linkTitle))
        this.dialogVisible = false
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
        const result = await persistConflictSessionDraft({
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
        entry.session = currentSession || result.session
        entry.latestSnapshot = result.latestSnapshot || entry.latestSnapshot
        if (result.saved && result.revision === expectedRevision) {
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
        await Promise.all(this.conflictEntries.map(async entry => {
          const key = (entry.record && entry.record.key) || conflictDraftKey({
            principal: currentEditPrincipal(),
            room: roomFromLocation(this.$route),
            uid: entry.uid,
            group: 'hyperlink',
            sessionId: entry.id
          })
          await removeConflictDraft({ key, sessionId: entry.id })
          discardEditSession(cooperate, entry.id)
        }))
        this.sessions.forEach(entry => {
          if (!entry.conflict) discardEditSession(cooperate, entry.id)
        })
        this.sessions = []
        this.conflictEntries = []
        this.dialogVisible = false
      } catch (_) {
        this.$message.error(this.$t('editConflict.storageFailed'))
      }
    }
  }
}
</script>

<style lang="less">
.nodeHyperlinkDialog {
  .el-dialog {
    max-width: calc(100% - 32px);
    border-radius: 16px;
    overflow: hidden;
  }
  .el-dialog__header { padding: 22px 24px 0; }
  .el-dialog__title { font-size: 17px; font-weight: 600; }
  .el-dialog__headerbtn { top: 23px; right: 24px; }
  .el-dialog__body { padding: 10px 24px 4px; }
  .el-dialog__footer { padding: 16px 24px 22px; }
  .linkIntro, .fieldHint { color: #7b8492; font-size: 12px; line-height: 1.6; }
  .linkIntro { margin: 0 0 22px; }
  .linkForm label { display: block; color: #454d59; font-size: 13px; font-weight: 500; margin-bottom: 8px; }
  .optional { margin-left: 6px; color: #9098a5; font-size: 12px; font-weight: normal; }
  .el-input__inner { height: 38px; line-height: 38px; border-radius: 10px; }
  .el-input__icon { line-height: 38px; }
  .fieldHint { margin: 6px 0 20px; }
  .fieldHint.error, .removeLink { color: #f56c6c; }
  .invalid .el-input__inner { border-color: #f56c6c; }
  .linkPreview {
    display: flex; align-items: center; gap: 12px;
    background: #f5f7fa; border: 1px solid #edf0f4; border-radius: 10px;
    padding: 12px; margin-top: 16px;
    > i { color: #409eff; font-size: 18px; }
    > div { min-width: 0; }
  }
  .previewTitle { font-size: 13px; color: #454d59; margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .previewAddress { font-size: 12px; color: #7b8492; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .openHint { margin: 12px 0 0; }
  .linkFooter { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .footerActions { margin-left: auto; display: flex; gap: 8px; .el-button { margin: 0; min-width: 72px; } }
}
body.isDark .nodeHyperlinkDialog {
  .linkForm label, .previewTitle { color: #e1e5eb; }
  .linkIntro, .fieldHint, .previewAddress, .optional { color: #a6aeba; }
  .fieldHint.error { color: #f56c6c; }
  .linkPreview { background: #30343b; border-color: #454b54; }
}
</style>
