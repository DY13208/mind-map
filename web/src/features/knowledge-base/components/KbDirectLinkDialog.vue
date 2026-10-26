<template>
  <el-dialog title="免登录直链" :visible="visible" width="560px" append-to-body custom-class="kb-direct-link-dialog" @update:visible="$emit('update:visible', $event)" @open="open">
    <p class="kb-link-file">{{ file && (file.name || file.fileName) }}</p>
    <p class="kb-link-hint">任何拿到链接的人都可访问原文件。文件删除或你失去查看权限后，链接失效。</p>
    <div class="kb-link-create">
      <el-select v-model="expiresInDays" size="small" aria-label="链接有效期">
        <el-option label="1 天" :value="1" />
        <el-option label="7 天" :value="7" />
        <el-option label="30 天" :value="30" />
        <el-option label="永久有效" :value="0" />
      </el-select>
      <el-button type="primary" size="small" :loading="creating" @click="generate">生成直链</el-button>
    </div>
    <div v-if="createdUrl" class="kb-link-result">
      <el-input ref="linkInput" :value="createdUrl" readonly aria-label="免登录直链地址">
        <el-button slot="append" @click="copy">复制</el-button>
      </el-input>
      <p class="kb-link-hint">请复制保存此链接。</p>
    </div>
    <h4>我生成的链接</h4>
    <p v-if="error" role="alert">{{ error }} <el-button type="text" @click="load">重试</el-button></p>
    <div v-loading="loading">
      <p v-if="!items.length && !loading && !error" class="kb-link-hint">还没有生成链接</p>
      <div v-for="item in items" :key="item.id" class="kb-link-row">
        <div>
          <div>{{ time(item.createdAt) }} 创建</div>
          <small class="kb-link-hint">{{ item.revokedAt ? '已撤销' : expired(item) ? '已到期' : item.expiresAt ? time(item.expiresAt) + ' 到期' : '永久有效' }}</small>
        </div>
        <el-button type="text" size="small" :disabled="!!item.revokedAt || expired(item)" :loading="revoking === item.id" @click="revoke(item)">撤销</el-button>
      </div>
    </div>
    <span slot="footer"><el-button size="small" @click="$emit('update:visible', false)">关闭</el-button></span>
  </el-dialog>
</template>
<script>
import kbApi from '../services/kbApi'

export default {
  name: 'KbDirectLinkDialog',
  props: { visible: Boolean, file: { type: Object, default: null } },
  data() {
    return { expiresInDays: 7, creating: false, loading: false, revoking: '', createdId: '', createdUrl: '', items: [], error: '', loadSeq: 0 }
  },
  methods: {
    open() {
      this.createdId = ''
      this.createdUrl = ''
      this.items = []
      this.expiresInDays = 7
      this.load()
    },
    async load() {
      if (!this.file) return
      const id = this.file.id, seq = ++this.loadSeq
      this.loading = true
      this.error = ''
      try {
        const result = await kbApi.listDirectLinks(id)
        if (seq === this.loadSeq && this.file && id === this.file.id) this.items = result.items
      } catch (e) {
        if (seq === this.loadSeq) this.error = '链接列表加载失败'
      } finally {
        if (seq === this.loadSeq) this.loading = false
      }
    },
    async generate() {
      if (!this.file || this.creating) return
      const id = this.file.id
      this.creating = true
      try {
        const result = await kbApi.createDirectLink(id, { expiresInDays: this.expiresInDays })
        if (!this.visible || !this.file || this.file.id !== id) return
        this.createdId = result.id
        this.createdUrl = new URL(result.url, window.location.origin).href
        this.$message.success('直链已生成，请复制保存')
        await this.load()
      } catch (e) {
        this.$message.error(e.message || '生成失败')
      } finally { this.creating = false }
    },
    async revoke(item) {
      if (!this.file || this.revoking) return
      this.revoking = item.id
      try {
        await kbApi.revokeDirectLink(this.file.id, item.id)
        if (this.createdId === item.id) { this.createdId = ''; this.createdUrl = '' }
        this.$message.success('链接已撤销')
        await this.load()
      } catch (e) { this.$message.error(e.message || '撤销失败') }
      finally { this.revoking = '' }
    },
    async copy() {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(this.createdUrl)
        else {
          this.$refs.linkInput.select()
          if (!document.execCommand('copy')) throw new Error('copy failed')
        }
        this.$message.success('已复制')
      } catch (_) { this.$message.error('复制失败，请选中地址手动复制') }
    },
    expired(item) { return item.expiresAt && new Date(item.expiresAt).getTime() <= Date.now() },
    time(value) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '' }
  }
}
</script>
<style lang="less">
.kb-direct-link-dialog {
  max-width: calc(100vw - 32px);
  .kb-link-file { margin-top: 0; overflow-wrap: anywhere; font-weight: 600; }
  .kb-link-hint { color: var(--ui-text-muted, #666); font-size: 12px; line-height: 1.6; }
  .kb-link-create { display: flex; gap: 12px; margin: 16px 0; }
  .kb-link-create .el-select { flex: 1; min-width: 0; }
  .kb-link-row { display: flex; gap: 12px; align-items: center; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid var(--ui-border, #eee); }
}
</style>
