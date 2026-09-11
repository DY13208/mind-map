<template
  ><el-breadcrumb separator="/"
    ><el-breadcrumb-item :to="{ path: '/files' }">我的脑图</el-breadcrumb-item
    ><el-breadcrumb-item
      v-for="(item, index) in path"
      :key="item.id"
      :to="index < path.length - 1 ? { path: '/files/folder/' + item.id } : null"
      >{{ item.name }}</el-breadcrumb-item
    ></el-breadcrumb
  ></template
>
<script>
export default {
  name: 'FolderBreadcrumb',
  props: { path: { type: Array, default: () => [] } }
}
</script>
