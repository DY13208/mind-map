<template>
  <el-dialog
    class="nodeHyperlinkDialog"
    :title="$t('nodeHyperlink.title')"
    :visible.sync="dialogVisible"
    width="520px"
    top="15vh"
    :close-on-click-modal="false"
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
    <div slot="footer" class="linkFooter">
      <el-button v-if="hasExistingLink" type="text" class="removeLink" @click="removeLink">
        {{ $t('nodeHyperlink.remove') }}
      </el-button>
      <div class="footerActions">
        <el-button size="small" round @click="cancel">{{ $t('dialog.cancel') }}</el-button>
        <el-button size="small" round type="primary" :disabled="!link.trim()" @click="confirm">
          {{ $t('dialog.confirm') }}
        </el-button>
      </div>
    </div>
  </el-dialog>
</template>

<script>
// Keep draft fields and target nodes stable until the dialog is saved or cancelled.
export default {
  data() {
    return {
      dialogVisible: false,
      link: '',
      linkTitle: '',
      activeNodes: [],
      targetNodes: [],
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
  methods: {
    handleNodeActive(...args) {
      this.activeNodes = [...(args[1] || [])]
    },
    normalizeLink(value) {
      const input = value.trim()
      if (!input || /\s/.test(input)) throw new Error('invalid')
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
      } catch (_) {
        this.error = this.$t(this.link.trim() ? 'nodeHyperlink.invalidLink' : 'nodeHyperlink.requiredLink')
        return false
      }
    },
    handleShowNodeLink(node) {
      if (this.dialogVisible) return
      this.targetNodes = node && typeof node.getData === 'function' ? [node] : [...this.activeNodes]
      if (!this.targetNodes.length) return
      const first = this.targetNodes[0]
      this.link = first.getData('hyperlink') || ''
      this.linkTitle = first.getData('hyperlinkTitle') || ''
      this.hasExistingLink = this.targetNodes.some(target => !!target.getData('hyperlink'))
      this.error = ''
      this.dialogVisible = true
    },
    focusLink() {
      this.$refs.linkInput.focus()
    },
    resetTargets() {
      if (!this.dialogVisible) this.targetNodes = []
    },
    onInputKeydown(event) {
      if (event.key === 'Escape') return
      event.stopPropagation()
      if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault()
        this.confirm()
      }
    },
    cancel() {
      this.dialogVisible = false
    },
    removeLink() {
      if (!this.dialogVisible) return
      this.targetNodes.forEach(node => node.setHyperlink('', ''))
      this.cancel()
    },
    confirm() {
      if (!this.dialogVisible || !this.validateLink()) return
      const link = this.normalizeLink(this.link)
      this.targetNodes.forEach(node => node.setHyperlink(link, this.linkTitle.trim()))
      this.cancel()
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
