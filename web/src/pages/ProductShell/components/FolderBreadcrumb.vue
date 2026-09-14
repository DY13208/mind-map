<template
  ><el-breadcrumb separator="/"
    ><el-breadcrumb-item :to="rootLink">{{ rootLabel }}</el-breadcrumb-item
    ><el-breadcrumb-item
      v-for="(item, index) in path"
      :key="item.id"
      :to="index < path.length - 1 ? folderLink(item.id) : null"
      >{{ item.name }}</el-breadcrumb-item
    ></el-breadcrumb
  ></template
>
<script>
export default {
  name: 'FolderBreadcrumb',
  props: {
    path: { type: Array, default: () => [] },
    teamId: { type: String, default: '' },
    rootLabel: { type: String, default: '我的脑图' }
  },
  computed: {
    rootLink() {
      return this.teamId
        ? { path: '/files', query: { team: this.teamId } }
        : { path: '/files' }
    }
  },
  methods: {
    folderLink(id) {
      const route = { path: '/files/folder/' + id }
      if (this.teamId) route.query = { team: this.teamId }
      return route
    }
  }
}
</script>
