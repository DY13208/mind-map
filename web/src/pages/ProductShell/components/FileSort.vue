<template
  ><el-select :value="value" @input="$emit('input', $event)"
    ><el-option
      v-for="item in options"
      :key="item.value"
      :label="item.label"
      :value="item.value"/></el-select
></template>
<script>
export default {
  name: 'FileSort',
  props: {
    value: { type: String, default: 'updatedAt' },
    hideOpenedSort: { type: Boolean, default: false }
  },
  computed: {
    options() {
      const all = [
        { label: '最近更新', value: 'updatedAt' },
        { label: '最近打开', value: 'lastOpenedAt' },
        { label: '名称', value: 'title' },
        { label: '创建时间', value: 'createdAt' }
      ]
      return this.hideOpenedSort
        ? all.filter(item => item.value !== 'lastOpenedAt')
        : all
    }
  }
}
</script>
