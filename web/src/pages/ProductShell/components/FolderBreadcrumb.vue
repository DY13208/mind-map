<template
  ><el-breadcrumb separator="/"
    ><el-breadcrumb-item :to="{ path: '/files' }">我的脑图</el-breadcrumb-item
    ><el-breadcrumb-item v-if="folder">{{
      folder.name
    }}</el-breadcrumb-item></el-breadcrumb
  ></template
>
<script>
export default { name: 'FolderBreadcrumb', props: { folder: Object } }
</script>
