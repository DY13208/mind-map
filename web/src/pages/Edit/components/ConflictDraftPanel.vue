<template>
  <section class="conflictDraftPanel" role="alert">
    <strong>{{ $t('editConflict.title') }}</strong>
    <p>{{ messageText }}</p>

    <div class="draftSection">
      <div class="draftSectionHead">
        <span>{{ $t('editConflict.myDraft') }}</span>
        <el-button type="text" size="mini" @click="copyDraft">
          {{ copied ? $t('editConflict.copied') : $t('editConflict.copyDraft') }}
        </el-button>
      </div>
      <pre>{{ formatValues(draftValues, fields, draft) || '（空）' }}</pre>
    </div>

    <div class="draftActions">
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
    <p v-else-if="persisted" class="savedHint">{{ $t('editConflict.savedLocally') }}</p>
  </section>
</template>

<script>
import {
  formatConflictText,
  isConflictRichText
} from '@/utils/conflictDraftDisplay'

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
    reason: { type: String, default: 'conflict' }
  },
  data() {
    return { showingLatest: false, copied: false }
  },
  computed: {
    fields() {
      const fields = this.draft && this.draft.fields
      const names = Array.isArray(fields) && fields.length ? fields : Object.keys((this.draft && this.draft.draft) || {})
      return names.filter(field => field !== 'richText')
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
      return this.reason === 'save_failed'
        ? this.$t('editConflict.saveFailed')
        : this.$t('editConflict.message')
    }
  },
  methods: {
    formatValues(values, fields, source) {
      if (!values || !fields || !fields.length) return ''
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
  margin: 14px 0;
  padding: 12px 14px;
  border: 1px solid #e6a23c;
  border-radius: 8px;
  background: #fdf6ec;
  color: #5f4b2e;
  font-size: 13px;
  line-height: 1.5;

  > p { margin: 4px 0 8px; }
  .draftSection { margin-top: 10px; }
  .draftSectionHead,
  .draftActions { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .draftSectionTitle { display: block; margin-bottom: 4px; }
  pre {
    max-height: 180px;
    overflow: auto;
    margin: 4px 0;
    padding: 8px;
    border-radius: 5px;
    background: rgba(255, 255, 255, 0.72);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font: inherit;
  }
  .storageError { color: #c45656; }
  .savedHint { color: #5f8f55; }
}

body.isDark .conflictDraftPanel {
  background: #3a3122;
  border-color: #8f6b2f;
  color: #ead8b8;

  pre { background: rgba(0, 0, 0, 0.18); }
}
</style>
