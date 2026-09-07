<template
  ><el-dialog
    :visible.sync="shown"
    title="版本详情"
    width="min(480px, calc(100vw - 24px))"
    append-to-body
    ><el-descriptions v-if="version" :column="1" border
      ><el-descriptions-item label="versionId">{{
        version.versionId
      }}</el-descriptions-item
      ><el-descriptions-item label="revision">{{
        version.revision
      }}</el-descriptions-item
      ><el-descriptions-item label="名称">{{
        version.name
      }}</el-descriptions-item
      ><el-descriptions-item label="类型">{{
        version.type
      }}</el-descriptions-item
      ><el-descriptions-item label="操作人">{{
        version.createdBy || version.operator
      }}</el-descriptions-item
      ><el-descriptions-item label="时间">{{
        format(version.createdAt)
      }}</el-descriptions-item
      ><el-descriptions-item label="说明">{{
        version.description || '—'
      }}</el-descriptions-item
      ><el-descriptions-item label="摘要">{{
        version.summary || '—'
      }}</el-descriptions-item></el-descriptions
    ><el-alert
      class="apiNote"
      type="info"
      :closable="false"
      title="TODO_HISTORY_PREVIEW：完整脑图预览尚未接入独立只读预览，不会写入当前 LIVE Editor。"
    /><span slot="footer"
      ><el-button @click="shown = false">关闭</el-button></span
    ></el-dialog
  ></template
>
<script>
export default {
  name: 'VersionDetailDialog',
  props: { visible: Boolean, version: Object },
  computed: {
    shown: {
      get() {
        return this.visible
      },
      set(value) {
        this.$emit('update:visible', value)
      }
    }
  },
  methods: {
    format(value) {
      return new Date(value).toLocaleString('zh-CN')
    }
  }
}
</script>
<style scoped>
.apiNote {
  margin-top: 18px;
}
</style>
