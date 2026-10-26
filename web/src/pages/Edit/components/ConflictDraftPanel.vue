<template>
  <section class="conflictDraftPanel" role="region" :aria-label="$t('editConflict.unsavedTitle')">
    <div class="draftStatus"><i class="el-icon-warning-outline" aria-hidden="true"></i><strong>{{ $t(presentation.kind === 'conflict' ? 'editConflict.state_conflict' : 'editConflict.unsavedTitle') }}</strong></div>
    <p class="draftExplanation">{{ messageText }}</p>

    <div class="draftSection">
      <div class="draftSectionHead">
        <span>{{ $t('editConflict.myDraft') }}</span>
        <el-button class="copyDraftButton" plain size="mini" @click="copyDraft">
          {{ copied ? $t('editConflict.copied') : $t('editConflict.copyDraft') }}
        </el-button>
      </div>
      <pre>{{ formatValues(draftValues, fields, draft) || '（空）' }}</pre>
    </div>

    <div class="draftActions">
      <slot name="retry"></slot>
      <el-button type="text" size="mini" @click="toggleLatest">
        {{ showingLatest ? $t('editConflict.hideLatest') : $t('editConflict.viewLatest') }}
      </el-button>
      <slot name="discard"></slot>
    </div>
    <div v-if="showingLatest" class="draftSection latestSection">
      <span class="draftSectionTitle">{{ $t('editConflict.latest') }}</span>
      <pre>{{ formatValues(latestValues, fields, latest) || $t('editConflict.latestUnavailable') }}</pre>
    </div>
    <p v-if="storageError" class="storageError">{{ $t('editConflict.storageFailed') }}</p>
    <p v-else-if="persisted" class="savedHint"><i class="el-icon-check" aria-hidden="true"></i> {{ $t('editConflict.savedLocally') }}</p>
  </section>
</template>

<script>
import {
  formatConflictText,
  isConflictRichText
} from '@/utils/conflictDraftDisplay'
import { classifyConflictDraft } from '@/utils/conflictDraftPolicy'

function dataOf(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return {}
  return snapshot.data && typeof snapshot.data === 'object'
    ? snapshot.data
    : snapshot
}

function valueText(value) {
  if (value == null || value === '') return '（空）'
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch (_) {
    return String(value)
  }
}

export default {
  name: 'ConflictDraftPanel',
  props: {
    draft: { type: Object, default: () => ({}) },
    latest: { type: Object, default: null },
    persisted: { type: Boolean, default: false },
    storageError: { type: String, default: '' },
    error: { type: Object, default: null },
    reason: { type: String, default: 'conflict' }
  },
  data() {
    return { showingLatest: false, copied: false }
  },
  computed: {
    presentation() {
      return classifyConflictDraft({ session: this.draft, error: this.error, reason: this.reason })
    },
    fields() {
      const fields = this.draft && this.draft.fields
      const names = Array.isArray(fields) && fields.length ? fields : Object.keys((this.draft && this.draft.draft) || {})
      // Mention IDs and rich-text flags are saved metadata, not extra text to
      // append to the user's recovered/copied content as an empty placeholder.
      return names.filter(field => field !== 'richText' && field !== 'textMentions')
    },
    draftValues() {
      return (this.draft && this.draft.draft) || {}
    },
    latestValues() {
      return dataOf(this.latest)
    },
    copyText() {
      return this.formatValues(this.draftValues, this.fields, this.draft)
    },
    messageText() {
      const error = this.error || (this.draft && this.draft.conflict && this.draft.conflict.error)
      if (error && error.code === 'PRECONDITION_REQUIRED') return this.$t('editConflict.missingBaseline')
      if (this.reason === 'operation_failed') return this.$t('editConflict.operationFailed')
      return error && error.code === 'REPLACE_CONFLICT'
        ? this.$t('editConflict.message')
        : this.$t('editConflict.saveFailed')
    }
  },
  methods: {
    formatValues(values, fields, source) {
      if (!values || !fields || !fields.length) return ''
      if (fields.includes('operation')) {
        const operation = values.operation
        if (!operation) return values.text == null ? '' : String(values.text)
        const payload = operation.payload || {}
        const label = this.$t(operation.type === 'node.delete' ? 'editConflict.deleteIntent' : 'editConflict.moveIntent')
        const target = payload.parentUid || payload.parent_uid || payload.parent
        return `${label}: ${payload.uid || ''}${target ? ` → ${target}` : ''}`
      }
      const richText = isConflictRichText(values, source)
      return fields
        .map(field => {
          const labels = { hyperlink: 'nodeHyperlink.link', hyperlinkTitle: 'nodeHyperlink.name' }
          const label = labels[field] ? this.$t(labels[field]) : ''
          const value = field === 'text'
            ? formatConflictText(values[field], richText)
            : values[field]
          return `${label ? label + ':\n' : ''}${valueText(value)}`
        })
        .join('\n\n')
    },
    async copyDraft() {
      const value = this.copyText
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(value)
        } else {
          const textarea = document.createElement('textarea')
          textarea.value = value
          textarea.setAttribute('readonly', '')
          textarea.style.position = 'fixed'
          textarea.style.opacity = '0'
          document.body.appendChild(textarea)
          textarea.select()
          const copied = document.execCommand('copy')
          document.body.removeChild(textarea)
          if (!copied) throw new Error('copy failed')
        }
        this.copied = true
        setTimeout(() => (this.copied = false), 1600)
      } catch (_) {
        this.$message.error(this.$t('editConflict.copyDraft'))
      }
    },
    toggleLatest() {
      this.showingLatest = !this.showingLatest
      if (this.showingLatest) this.$emit('show-latest')
    }
  }
}
</script>

<style lang="less" scoped>
.conflictDraftPanel {
  --draft-ink: #25362e;
  --draft-muted: #5c6e64;
  --draft-line: #dce5df;
  --draft-surface: #fff;
  --draft-soft: #f5f7f6;
  margin: 16px 0 0;
  padding: 0;
  color: var(--draft-ink);
  font-size: 13px;
  line-height: 1.6;

  .draftStatus { display: flex; align-items: center; gap: 8px; }
  .draftStatus > i { color: #a66b16; font-size: 18px; }
  .draftStatus strong { font-size: 14px; font-weight: 600; }
  .draftExplanation { margin: 8px 0 18px; color: var(--draft-muted); }
  .draftSection { margin-top: 16px; min-width: 0; }
  .draftSectionHead,
  .draftActions { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .draftSectionHead { margin-bottom: 8px; font-weight: 500; }
  .draftSectionTitle { display: block; margin-bottom: 8px; font-weight: 500; }
  .copyDraftButton { border-color: var(--draft-line); background: var(--draft-surface); color: var(--draft-ink); border-radius: 6px; }
  .copyDraftButton:hover, .copyDraftButton:focus { border-color: #087854; color: #087854; background: var(--draft-soft); }
  pre {
    max-height: 220px;
    overflow: auto;
    margin: 0;
    padding: 14px 16px;
    border: 1px solid var(--draft-line);
    border-radius: 8px;
    background: var(--draft-soft);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font: inherit;
    line-height: 1.7;
  }
  .draftActions { margin-top: 8px; }
  .draftActions ::v-deep .el-button--text { color: #087854; }
  .draftActions ::v-deep .discardButton { color: #b8433a; }
  .latestSection { padding-top: 16px; border-top: 1px solid var(--draft-line); }
  .storageError { margin: 14px 0 0; color: #b8433a; }
  .savedHint { display: flex; align-items: baseline; gap: 6px; margin: 16px 0 0; color: var(--draft-muted); font-size: 12px; }
  .savedHint i { color: #087854; }
}
body.isDark .conflictDraftPanel {
  --draft-ink: #e2ebe5;
  --draft-muted: #acbdb2;
  --draft-line: #3e5046;
  --draft-surface: #25332c;
  --draft-soft: #202c25;
  .draftStatus > i { color: #dfb66b; }
  .savedHint i { color: #7dcdab; }
  .draftActions ::v-deep .discardButton { color: #ed9e96; }
}
@media (max-width: 600px) {
  .conflictDraftPanel {
    .draftExplanation { margin-bottom: 14px; }
    pre { padding: 12px; max-height: 200px; }
    .draftActions { gap: 4px 12px; }
  }
}
</style>
