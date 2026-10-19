<template>
  <div class="kb-json">
    <div class="kb-json-bar">
      <span>{{ title }}</span>
      <el-button type="text" size="mini" icon="el-icon-document-copy" @click="copy">复制</el-button>
    </div>
    <pre class="kb-json-body">{{ text }}</pre>
  </div>
</template>
<script>
export default {
  name: 'KbJsonView',
  props: { value: { default: null }, title: { type: String, default: 'JSON' } },
  computed: {
    text() {
      try { return JSON.stringify(this.value, null, 2) } catch (_) { return String(this.value) }
    }
  },
  methods: {
    async copy() {
      try {
        await navigator.clipboard.writeText(this.text)
        this.$message.success('已复制')
      } catch (_) {
        this.$message.error('复制失败')
      }
    }
  }
}
</script>
<style scoped lang="less">
.kb-json {
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-md);
  background: var(--ui-surface-muted);
  overflow: hidden;
}
.kb-json-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 2px 10px;
  font-size: 12px;
  color: var(--ui-text-secondary);
  border-bottom: 1px solid var(--ui-border);
}
.kb-json-body {
  margin: 0;
  padding: 10px 12px;
  max-height: 420px;
  overflow: auto;
  font-size: 12px;
  line-height: 1.55;
  color: var(--ui-text);
  font-family: Consolas, Menlo, monospace;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
