<template>
  <div class="folderBreadcrumb">
    <div v-if="isMobileViewport && path.length" class="mobileFolderPath">
      <router-link :to="path.length > 1 ? folderLink(path[path.length - 2].id) : rootLink" aria-label="返回上一级"><i class="el-icon-arrow-left" /></router-link>
      <strong>{{ path[path.length - 1].name }}</strong>
      <el-dropdown trigger="click" @command="goToLevel"><button aria-label="选择目录层级"><i class="el-icon-more" /></button><el-dropdown-menu slot="dropdown"><el-dropdown-item command="">{{ rootLabel }}</el-dropdown-item><el-dropdown-item v-for="item in path" :key="item.id" :command="String(item.id)">{{ item.name }}</el-dropdown-item></el-dropdown-menu></el-dropdown>
    </div>
    <el-breadcrumb v-else separator="/"
    ><el-breadcrumb-item :to="rootLink">{{ rootLabel }}</el-breadcrumb-item
    ><el-breadcrumb-item
      v-for="(item, index) in path"
      :key="item.id"
      :to="index < path.length - 1 ? folderLink(item.id) : null"
      >{{ item.name }}</el-breadcrumb-item
    ></el-breadcrumb
    >
  </div>
</template>
<script>
import mobileViewport from '@/utils/mobileViewport'
export default {
  name: 'FolderBreadcrumb',
  mixins: [mobileViewport],
  props: {
    path: { type: Array, default: () => [] },
    teamId: { type: String, default: '' },
    rootLabel: { type: String, default: '脑图' },
    basePath: { type: String, default: '/files' }
  },
  computed: {
    rootLink() {
      return this.teamId
        ? { path: this.basePath, query: { team: this.teamId } }
        : { path: this.basePath }
    }
  },
  methods: {
    goToLevel(id) { const to = id ? this.folderLink(id) : this.rootLink; if (to.path !== this.$route.path) this.$router.push(to) },
    folderLink(id) {
      const route = { path: `${this.basePath}/folder/` + id }
      if (this.teamId) route.query = { team: this.teamId }
      return route
    }
  }
}
</script>
