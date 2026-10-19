<template>
  <el-select
    :value="value"
    filterable
    remote
    clearable
    size="small"
    :remote-method="search"
    :loading="loading"
    :placeholder="placeholder"
    popper-class="kb-popper"
    class="kb-file-picker"
    :no-data-text="error ? (error.kind === 'not_ready' ? '文件列表接口等待后端实现' : error.message) : '无匹配文件'"
    @focus="() => !options.length && search('')"
    @change="onChange"
  >
    <el-option v-for="f in merged" :key="f.id" :label="f.name || f.fileName" :value="f.id" />
  </el-select>
</template>
<script>
import kbApi from '../services/kbApi'
export default {
  name: 'KbFilePicker',
  props: { value: { type: String, default: '' }, current: { type: Object, default: null }, placeholder: { type: String, default: '选择文件' } },
  data() {
    return { options: [], loading: false, error: null }
  },
  computed: {
    merged() {
      const list = this.options.slice()
      if (this.current && !list.some(f => f.id === this.current.id)) list.unshift(this.current)
      return list
    }
  },
  methods: {
    async search(q) {
      this.loading = true
      this.error = null
      try {
        this.options = (await kbApi.listFiles({ q: q || undefined, limit: 30 })).items
      } catch (e) {
        this.error = e
        this.options = []
      } finally {
        this.loading = false
      }
    },
    onChange(id) {
      this.$emit('input', id || '')
      this.$emit('change', this.merged.find(f => f.id === id) || null)
    }
  }
}
</script>
<style scoped lang="less">
.kb-file-picker { width: 320px; }
</style>
