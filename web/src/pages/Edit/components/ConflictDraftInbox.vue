<template>
  <div v-if="room && drafts.length" class="conflictDraftInbox">
    <el-button type="warning" round size="small" @click="openInbox">
      <i class="el-icon-warning-outline"></i>
      {{ $t('editConflict.inbox') }} · {{ drafts.length }}
    </el-button>
    <el-dialog
      :visible.sync="visible"
      :title="$t('editConflict.inboxTitle')"
      width="560px"
      append-to-body
    >
      <p v-if="!drafts.length">{{ $t('editConflict.empty') }}</p>
      <div v-for="item in drafts" :key="item.key" class="conflictDraftItem">
        <div class="itemHead">
          <div>
            <strong>{{ $t('editConflict.node') }} {{ item.uid }}</strong>
            <span class="itemGroup">{{ item.group }}</span>
          </div>
          <el-button type="text" size="mini" @click="toggleItem(item)">
            {{ selectedKey === item.key ? $t('editConflict.hideLatest') : $t('editConflict.myDraft') }}
          </el-button>
        </div>
        <ConflictDraftPanel
          v-if="selectedKey === item.key"
          :draft="item.session"
          :latest="latestFor(item)"
          :persisted="true"
          :reason="item.reason"
          @show-latest="refreshLatest(item)"
        >
          <el-button
            slot="discard"
            type="text"
            size="mini"
            class="discardButton"
            @click="discard(item)"
          >{{ $t('editConflict.discard') }}</el-button>
        </ConflictDraftPanel>
      </div>
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
      loadToken: 0
    }
  },
  computed: {
    room() {
      return roomFromLocation(this.$route)
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
      this.$message.warning(message || this.$t('editConflict.saveFailed'))
    },
    async onSessionFinished(session) {
      const id = String((session && session.id) || '')
      if (!id) return
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
      if (!this.selectedKey && this.drafts.length) {
        this.toggleItem(this.drafts[0])
      }
    },
    toggleItem(item) {
      if (this.selectedKey === item.key) {
        this.selectedKey = ''
        return
      }
      this.selectedKey = item.key
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
  border-bottom: 1px solid #ebeef5;
}

.itemHead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.itemGroup {
  margin-left: 8px;
  color: #909399;
  font-size: 12px;
}

.discardButton { color: #c45656; }
</style>
