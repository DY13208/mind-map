<template>
  <div v-if="room && drafts.length" class="conflictDraftInbox">
    <el-button class="draftInboxTrigger" round size="small" @mousedown.native.stop @click.stop="openInbox">
      <i class="el-icon-warning-outline"></i>
      {{ $t(actionableDrafts.length ? 'editConflict.inbox' : 'editConflict.syncRecords') }} · {{ actionableDrafts.length || diagnosticDrafts.length }}
    </el-button>
    <el-dialog
      :visible.sync="visible"
      :title="$t(actionableDrafts.length ? 'editConflict.inboxTitle' : 'editConflict.syncRecords')"
      width="600px"
      custom-class="conflictDraftDialog"
      append-to-body
      @mousedown.native.stop
      @click.native.stop
    >
      <p v-if="!drafts.length">{{ $t('editConflict.empty') }}</p>
      <p class="inboxExplanation">{{ $t('editConflict.inboxExplanation') }}</p>
      <div v-for="item in actionableDrafts" :key="item.key" class="conflictDraftItem">
        <div class="itemHead">
          <div class="itemIdentity">
            <strong :title="item.uid">{{ draftTitle(item) }}</strong>
            <span class="itemGroup">{{ draftGroupLabel(item.group) }}</span>
            <span class="itemState">{{ $t('editConflict.state_' + draftPolicy(item).kind) }}</span>
          </div>
          <el-button class="draftItemToggle" type="text" size="mini" :aria-label="$t('editConflict.myDraft')" :aria-expanded="String(selectedKey === item.key)" @click="toggleItem(item)">
            <i :class="selectedKey === item.key ? 'el-icon-arrow-up' : 'el-icon-arrow-down'" aria-hidden="true"></i>
          </el-button>
        </div>
        <ConflictDraftPanel
          v-if="selectedKey === item.key"
          :draft="item.session"
          :latest="latestFor(item)"
          :persisted="true"
          :reason="item.reason"
          :error="item.error"
          @show-latest="refreshLatest(item)"
        >
          <el-button v-if="draftPolicy(item).canRetry" slot="retry" size="mini" type="primary" :loading="retryingKey === item.key" :disabled="!!retryingKey && retryingKey !== item.key" @mousedown.native.stop @click.stop="retryDraft(item)">
            {{ $t('editConflict.retry') }}
          </el-button>
          <el-button
            slot="discard"
            type="text"
            size="mini"
            class="discardButton"
            @click="discard(item)"
          >{{ $t('editConflict.discard') }}</el-button>
        </ConflictDraftPanel>
      </div>
      <details v-if="diagnosticDrafts.length" class="syncRecords">
        <summary>{{ $t('editConflict.syncRecords') }} · {{ diagnosticDrafts.length }}</summary>
        <p>{{ $t('editConflict.syncRecordsHint') }}</p>
        <div v-for="item in diagnosticDrafts" :key="item.key" class="syncRecord">
          <span>{{ draftTitle(item) }} · {{ (item.error && item.error.code) || '—' }}</span>
          <el-button type="text" size="mini" @click="copyDiagnostic(item)">{{ $t('editConflict.copyDetails') }}</el-button>
        </div>
      </details>
    </el-dialog>
  </div>
</template>

<script>
import { roomFromLocation } from '@/utils/roomLocation'
import {
  currentEditPrincipal,
  getEditCooperate,
  persistEditSessionEventDraft,
  persistOutboxConflictDraft
} from '@/utils/conflictEdit'
import {
  listConflictDrafts,
  conflictDraftKey,
  removeConflictDraft
} from '@/utils/conflictDraftStore'
import ConflictDraftPanel from './ConflictDraftPanel.vue'
import { classifyConflictDraft } from '@/utils/conflictDraftPolicy'
import { formatConflictText, isConflictRichText } from '@/utils/conflictDraftDisplay'

export default {
  name: 'ConflictDraftInbox',
  components: { ConflictDraftPanel },
  props: {
    mindMap: { type: Object, default: null }
  },
  data() {
    return {
      drafts: [],
      selectedKey: '',
      latestByKey: {},
      persistentSessionIds: [],
      draftKeysBySession: {},
      visible: false,
      loadToken: 0,
      retryingKey: '',
      retrySessionId: ''
    }
  },
  computed: {
    room() {
      return roomFromLocation(this.$route)
    },
    actionableDrafts() {
      return this.drafts.filter(item => classifyConflictDraft(item).kind !== 'record')
    },
    diagnosticDrafts() {
      return this.drafts.filter(item => classifyConflictDraft(item).kind === 'record')
    }
  },
  created() {
    this.$bus.$on('conflict_draft_saved', this.loadDrafts)
    this.$bus.$on('collab_identity_changed', this.onIdentityChanged)
  },
  mounted() {
    this.bindMindMapEvents(this.mindMap)
    this.syncOutboxConflicts()
    this.loadDrafts()
  },
  watch: {
    room() {
      this.resetScopeView()
      this.loadDrafts()
    },
    mindMap(next, previous) {
      this.unbindMindMapEvents(previous)
      this.bindMindMapEvents(next)
      this.syncOutboxConflicts()
    }
  },
  beforeDestroy() {
    this.$bus.$off('conflict_draft_saved', this.loadDrafts)
    this.$bus.$off('collab_identity_changed', this.onIdentityChanged)
    this.unbindMindMapEvents(this.mindMap)
  },
  methods: {
    draftPolicy: classifyConflictDraft,
    draftTitle(item) {
      const session = item.session || {}
      const data = (item.latestSnapshot && item.latestSnapshot.data) || session.baseValues || {}
      const text = data.text || (session.draft && session.draft.text)
      return text ? formatConflictText(text, isConflictRichText({ text }, session)).slice(0, 80) : this.$t('editConflict.node') + ' ' + item.uid
    },
    async copyDiagnostic(item) {
      try {
        const text = JSON.stringify(item, null, 2)
        if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text)
        else {
          const field = document.createElement('textarea')
          field.value = text
          field.style.cssText = 'position:fixed;opacity:0'
          document.body.appendChild(field)
          try { field.select(); if (!document.execCommand('copy')) throw new Error('copy failed') }
          finally { field.remove() }
        }
        this.$message.success(this.$t('editConflict.copied'))
      } catch (_) { this.$message.error(this.$t('editConflict.copyFailed')) }
    },
    async retryDraft(item) {
      if (this.retryingKey || !classifyConflictDraft(item).canRetry) return
      const room = this.room
      const principal = currentEditPrincipal()
      const cooperate = getEditCooperate(this.mindMap)
      if (!cooperate || !cooperate.commitEditSession || item.room !== room || item.principal !== principal) return
      const status = cooperate.collabV2Adapter && cooperate.collabV2Adapter.getStatus && cooperate.collabV2Adapter.getStatus()
      if (!status || status.phase !== 'LIVE') {
        this.$message.warning(this.$t('editConflict.retryPending'))
        return
      }
      this.retryingKey = item.key
      this.retrySessionId = item.session.id
      try {
        const session = cooperate.getEditSession(item.session.id) || cooperate.restoreEditSession(item.session)
        if (!session) throw new Error('EDIT_SESSION_MISSING')
        // Reuse the original field-version baseline. Never rebase automatically.
        const result = await cooperate.commitEditSession(session.id, session.draft)
        if (!result || result.draftSaved !== true || result.queued || !(Number(result.version) > 0)) {
          this.$message.warning(this.$t('editConflict.retryPending'))
          return
        }
        if (room !== this.room || principal !== currentEditPrincipal() || cooperate !== getEditCooperate(this.mindMap)) return
        // Close only the editor whose exact draft received this ACK. This
        // clears its UI without issuing another write or rebasing its content.
        if (typeof cooperate.discardEditSession === 'function') cooperate.discardEditSession(session.id)
        await removeConflictDraft(item)
        await this.loadDrafts()
        this.$message.success(this.$t('editConflict.retrySaved'))
      } catch (error) {
        if (room !== this.room || principal !== currentEditPrincipal() || cooperate !== getEditCooperate(this.mindMap)) return
        const session = cooperate.getEditSession(item.session.id) || item.session
        await this.persistSessionEvent(session, error, 'save_failed')
        this.$message.error(this.$t('editConflict.retryFailed'))
      } finally { this.retryingKey = ''; this.retrySessionId = '' }
    },
    draftGroupLabel(group) {
      const labels = { text: 'style.text', note: 'nodeNote.title', hyperlink: 'nodeHyperlink.title', 'outbox-structure': 'editConflict.operationIntent' }
      return this.$t(labels[group] || 'editConflict.myDraft')
    },
    bindMindMapEvents(mindMap) {
      if (mindMap && typeof mindMap.on === 'function') {
        mindMap.on('edit_session_outbox_conflict', this.onOutboxConflict)
        mindMap.on('edit_session_conflict', this.onSessionConflict)
        mindMap.on('edit_session_save_failed', this.onSessionSaveFailed)
        mindMap.on('edit_session_draft_change', this.onSessionDraftChange)
        mindMap.on('edit_session_resolved', this.onSessionFinished)
        mindMap.on('edit_session_discarded', this.onSessionFinished)
        mindMap.on('collab_write_conflict', this.onCollabWriteConflict)
      }
    },
    unbindMindMapEvents(mindMap) {
      if (mindMap && typeof mindMap.off === 'function') {
        mindMap.off('edit_session_outbox_conflict', this.onOutboxConflict)
        mindMap.off('edit_session_conflict', this.onSessionConflict)
        mindMap.off('edit_session_save_failed', this.onSessionSaveFailed)
        mindMap.off('edit_session_draft_change', this.onSessionDraftChange)
        mindMap.off('edit_session_resolved', this.onSessionFinished)
        mindMap.off('edit_session_discarded', this.onSessionFinished)
        mindMap.off('collab_write_conflict', this.onCollabWriteConflict)
      }
    },
    trackPersistedSession(sessionId, keys) {
      const id = String(sessionId || '')
      if (!id) return
      if (!this.persistentSessionIds.includes(id)) this.persistentSessionIds.push(id)
      const current = this.draftKeysBySession[id] || []
      const combined = Array.from(new Set(current.concat(keys || [])))
      this.$set(this.draftKeysBySession, id, combined)
    },
    async persistSessionEvent(session, error, reason) {
      if (!session || !session.id || !session.uid) return
      if (session.roomKey && session.roomKey !== this.room) return
      const id = String(session.id)
      if (!this.persistentSessionIds.includes(id)) this.persistentSessionIds.push(id)
      try {
        const result = await persistEditSessionEventDraft({
          mindMap: this.mindMap,
          route: this.$route,
          session,
          error,
          reason
        })
        this.trackPersistedSession(id, result.record ? [result.key] : [])
        const cooperate = getEditCooperate(this.mindMap)
        const latest = cooperate && cooperate.getEditSession && cooperate.getEditSession(id)
        if (latest && Number(latest.draftRevision) > result.revision) {
          this.persistSessionEvent(latest, error, reason)
          return
        }
        if (!result.stale) {
          this.$bus.$emit('conflict_draft_saved')
          await this.loadDrafts()
        }
      } catch (_) {
        this.$message.error(this.$t('editConflict.storageFailed'))
      }
    },
    onSessionConflict(session, error) {
      this.persistSessionEvent(session, error, 'conflict')
    },
    onSessionSaveFailed(session, error) {
      this.persistSessionEvent(session, error, 'save_failed')
    },
    onSessionDraftChange(session) {
      if (!session || !this.persistentSessionIds.includes(String(session.id))) return
      const item = this.drafts.find(entry => entry.session && entry.session.id === session.id)
      const reason = (item && item.reason) || 'conflict'
      this.persistSessionEvent(session, (session.conflict && session.conflict.error) || {}, reason)
    },
    onCollabWriteConflict(error) {
      if (!this.room) return
      const message = String((error && error.message) || '')
      if (!error || !error.code || ['REPLACE_CONFLICT', 'STRUCTURE_CONFLICT'].includes(error.code)) this.$message.warning(message || this.$t('editConflict.message'))
      else this.$message.error(this.$t(error && error.code === 'PRECONDITION_REQUIRED' ? 'editConflict.syncInternalError' : 'editConflict.saveFailed'))
    },
    async onSessionFinished(session) {
      const id = String((session && session.id) || '')
      if (!id) return
      if (id === this.retrySessionId) return
      let keys = this.draftKeysBySession[id] || this.drafts
        .filter(item => item.session && item.session.id === id)
        .map(item => item.key)
      if (!keys.length && session.uid) {
        const fields = Array.isArray(session.fields) ? session.fields : []
        const group = fields.some(field => field === 'hyperlink' || field === 'hyperlinkTitle')
          ? 'hyperlink'
          : fields.includes('note')
            ? 'note'
            : fields.some(field => field === 'text' || field === 'richText')
              ? 'text'
              : String(session.kind || 'field')
        keys = [
          conflictDraftKey({
            principal: currentEditPrincipal(),
            room: session.roomKey || this.room,
            uid: session.uid,
            group,
            sessionId: id
          })
        ]
      }
      try {
        await Promise.all(keys.map(key => removeConflictDraft({ key, sessionId: id })))
        this.$delete(this.draftKeysBySession, id)
        this.persistentSessionIds = this.persistentSessionIds.filter(item => item !== id)
        await this.loadDrafts()
      } catch (_) {
        this.$message.error(this.$t('editConflict.storageFailed'))
      }
    },
    async onOutboxConflict(payload) {
      const room = String((payload && payload.roomKey) || this.room || '')
      if (!room || room !== this.room) return
      try {
        const result = await persistOutboxConflictDraft({
          mindMap: this.mindMap,
          route: this.$route,
          payload
        })
        const records = result.records || (result.record ? [result.record] : [])
        records.forEach(record => this.trackPersistedSession(record.sessionId, [record.key]))
        if (!result.stale) {
          this.$bus.$emit('conflict_draft_saved')
          await this.loadDrafts()
        }
      } catch (error) {
        this.$message.error(this.$t('editConflict.storageFailed'))
      }
    },
    async syncOutboxConflicts() {
      const cooperate = getEditCooperate(this.mindMap)
      if (!cooperate || typeof cooperate.listEditSessions !== 'function') return
      const sessions = cooperate.listEditSessions() || []
      for (const session of sessions) {
        if (
          !session ||
          session.state !== 'conflict' ||
          !String(session.kind || '').includes('outbox') ||
          (session.roomKey && session.roomKey !== this.room)
        ) {
          continue
        }
        const expected = {}
        Object.keys(session.baseVersions || {}).forEach(group => {
          expected[`__fv.${group}`] = Number(session.baseVersions[group]) || 0
        })
        try {
          const result = await persistOutboxConflictDraft({
            mindMap: this.mindMap,
            route: this.$route,
            payload: {
              id: session.id,
              opId: session.outboxOpId || session.id,
              roomKey: session.roomKey || this.room,
              uid: session.uid,
              patch: session.draft,
              expected,
              error: session.conflict && session.conflict.error,
              latestSnapshot: session.conflict && session.conflict.latestSnapshot,
              session
            }
          })
          const records = result.records || (result.record ? [result.record] : [])
          records.forEach(record => this.trackPersistedSession(record.sessionId, [record.key]))
        } catch (_) {
          this.$message.error(this.$t('editConflict.storageFailed'))
        }
      }
      await this.loadDrafts()
    },
    resetScopeView() {
      this.visible = false
      this.selectedKey = ''
      this.latestByKey = {}
    },
    onIdentityChanged() {
      this.resetScopeView()
      this.loadDrafts()
    },
    async loadDrafts() {
      const token = ++this.loadToken
      const room = this.room
      if (!room) {
        this.drafts = []
        this.selectedKey = ''
        return
      }
      try {
        const drafts = await listConflictDrafts(currentEditPrincipal(), room)
        if (token !== this.loadToken || room !== this.room) return
        this.drafts = drafts
        if (!drafts.length) this.visible = false
        const keysBySession = {}
        drafts.forEach(item => {
          const id = item.session && String(item.session.id || '')
          if (!id) return
          keysBySession[id] = (keysBySession[id] || []).concat(item.key)
        })
        this.draftKeysBySession = keysBySession
        this.persistentSessionIds = Object.keys(keysBySession)
        if (!drafts.some(item => item.key === this.selectedKey)) {
          this.selectedKey = ''
        }
      } catch (_) {
        // Keep the editing surface available when local storage is unavailable.
        this.drafts = []
      }
    },
    openInbox() {
      this.visible = true
      if (!this.selectedKey && this.actionableDrafts.length) {
        this.toggleItem(this.actionableDrafts[0])
      }
    },
    toggleItem(item) {
      if (this.selectedKey === item.key) {
        this.selectedKey = ''
        return
      }
      this.selectedKey = item.key
      if (item.session && item.session.kind === 'outbox-structure') return
      const cooperate = getEditCooperate(this.mindMap)
      const active =
        cooperate &&
        item.session &&
        typeof cooperate.getEditSession === 'function' &&
        cooperate.getEditSession(item.session.id)
      if (active) {
        this.$set(item, 'session', active)
      } else if (cooperate && typeof cooperate.restoreEditSession === 'function') {
        try {
          const restored = cooperate.restoreEditSession(item.session)
          if (restored) this.$set(item, 'session', restored)
        } catch (_) {
          // A saved draft remains viewable even if the in-memory session cannot restore.
        }
      }
    },
    latestFor(item) {
      return this.latestByKey[item.key] || item.latestSnapshot || null
    },
    refreshLatest(item) {
      const cooperate = getEditCooperate(this.mindMap)
      if (!cooperate || typeof cooperate.getEditSessionSnapshot !== 'function') return
      const latest = cooperate.getEditSessionSnapshot(item.uid)
      if (latest) this.$set(this.latestByKey, item.key, latest)
    },
    async discard(item) {
      try {
        await this.$confirm(
          this.$t('editConflict.discardConfirm'),
          this.$t('editConflict.title'),
          { type: 'warning' }
        )
        await removeConflictDraft(item)
        const cooperate = getEditCooperate(this.mindMap)
        if (cooperate && item.session && item.session.id) {
          if (typeof cooperate.discardEditSession === 'function') {
            cooperate.discardEditSession(item.session.id)
          } else if (typeof cooperate.cancelEditSession === 'function') {
            cooperate.cancelEditSession(item.session.id)
          }
        }
        this.selectedKey = ''
        await this.loadDrafts()
      } catch (error) {
        if (error !== 'cancel' && error !== 'close') {
          this.$message.error(this.$t('editConflict.storageFailed'))
        }
      }
    }
  }
}
</script>

<style lang="less" scoped>
.conflictDraftInbox {
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 1000;
}

.conflictDraftItem {
  padding: 8px 0 12px;
  border-bottom: 1px solid #e2e9e4;
  &:last-child { border-bottom: 0; }
  .itemIdentity { min-width: 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .itemIdentity strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 320px; font-size: 13px; font-weight: 500; }
  .itemHead > .el-button { flex-shrink: 0; }
}

.itemHead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.itemGroup {
  padding: 2px 7px;
  border-radius: 4px;
  background: #eef3f0;
  color: #5c6e64;
  font-size: 12px;
}

.draftItemToggle { width: 32px; height: 32px; border-radius: 6px; }
.inboxExplanation { margin: 4px 0 16px; color: #5c6e64; font-size: 13px; line-height: 1.6; }
.itemState { color: #72501d; font-size: 12px; }
.syncRecords { margin-top: 16px; border-top: 1px solid #e2e9e4; padding-top: 12px; font-size: 12px; color: #5c6e64;
  summary { cursor: pointer; padding: 6px 0; }
  p { line-height: 1.6; }
}
.syncRecord { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 6px 0;
  span { overflow-wrap: anywhere; min-width: 0; }
}
.discardButton { color: #b8433a; }
.draftInboxTrigger { color: #72501d; border-color: #ddcaa6; background: #fff; box-shadow: 0 3px 12px rgba(23, 38, 31, .08); }
</style>

<style lang="less">
.conflictDraftDialog {
  max-width: calc(100vw - 32px);
  border-radius: 12px;
  overflow: hidden;
  background: #fff;
  box-shadow: 0 20px 60px rgba(23, 38, 31, .16);
  .el-dialog__header { padding: 22px 24px 18px; border-bottom: 1px solid #e2e9e4; }
  .el-dialog__title { font-size: 16px; font-weight: 600; color: #25362e; }
  .el-dialog__headerbtn { top: 23px; right: 24px; }
  .el-dialog__body { padding: 12px 24px 24px; max-height: 65vh; overflow-y: auto; color: #25362e; }
  .el-button--text { color: #087854; }
  .el-button:focus-visible { outline: 2px solid #087854; outline-offset: 3px; }
  .discardButton { color: #b8433a; }
}
body.isDark .conflictDraftInbox .draftInboxTrigger { background: #25332c; border-color: #655432; color: #dfb66b; }
body.isDark .conflictDraftDialog {
  background: #25332c;
  .el-dialog__header { border-color: #3e5046; }
  .el-dialog__title, .el-dialog__body { color: #e2ebe5; }
  .conflictDraftItem { border-color: #3e5046; }
  .itemGroup { background: #34453b; color: #acbdb2; }
  .el-button--text { color: #7dcdab; }
  .discardButton { color: #ed9e96; }
  .inboxExplanation, .syncRecords { color: #acbdb2; border-color: #3e5046; }
  .itemState { color: #dfb66b; }
}
@media (max-width: 600px) {
  .conflictDraftInbox { right: 16px; bottom: max(16px, env(safe-area-inset-bottom)); }
  .conflictDraftDialog {
    margin-top: 8vh !important;
    .el-dialog__header { padding: 18px 16px 14px; }
    .el-dialog__headerbtn { top: 19px; right: 16px; }
    .el-dialog__body { padding: 8px 16px 20px; max-height: 72vh; }
    .itemIdentity strong { max-width: 170px; }
  }
}
</style>
