<template
  ><el-input
    :value="value"
    @input="$emit('input', $event)"
    clearable
    prefix-icon="el-icon-search"
    placeholder="搜索脑图、所有者或文件夹"
/></template>
<script>
export default {
  name: 'FileSearch',
  props: { value: { type: String, default: '' } }
}
</script>
