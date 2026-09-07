<template>
  <div class="fileToolbar">
    <FileSearch
      class="toolbarSearch"
      :value="search"
      @input="$emit('update:search', $event)"
    />
    <FileSort
      :value="sort"
      :hide-opened-sort="hideOpenedSort"
      @input="$emit('update:sort', $event)"
    />
    <el-select
      class="roleFilter"
      :value="roleFilter"
      placeholder="筛选角色"
      @input="$emit('update:roleFilter', $event)"
    >
      <el-option label="全部角色" value="" />
      <el-option
        v-for="role in ['Owner', 'Editor', 'Viewer']"
        :key="role"
        :label="role"
        :value="role"
      />
    </el-select>
    <el-button-group
      ><el-button
        :type="view === 'card' ? 'primary' : ''"
        icon="el-icon-menu"
        title="卡片视图"
        @click="$emit('update:view', 'card')"/><el-button
        :type="view === 'list' ? 'primary' : ''"
        icon="el-icon-s-unfold"
        title="列表视图"
        @click="$emit('update:view', 'list')"
    /></el-button-group>
    <el-button
      v-if="showCreateFolder"
      icon="el-icon-folder-add"
      @click="$emit('create-folder')"
      >新建文件夹</el-button
    >
    <el-button
      v-if="showCreate"
      type="primary"
      icon="el-icon-plus"
      @click="$emit('create-room')"
      >新建脑图</el-button
    >
  </div>
</template>
<script>
import FileSearch from './FileSearch.vue'
import FileSort from './FileSort.vue'
export default {
  name: 'FileToolbar',
  components: { FileSearch, FileSort },
  props: {
    search: String,
    roleFilter: { type: String, default: '' },
    sort: String,
    view: String,
    showCreate: { type: Boolean, default: true },
    showCreateFolder: { type: Boolean, default: true },
    hideOpenedSort: { type: Boolean, default: false }
  }
}
</script>
<style lang="less" scoped>
.fileToolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  .el-select {
    width: 128px;
  }
  .el-button + .el-button {
    margin-left: 0;
  }
  background: white;
  padding: 14px;
  border: 1px solid #e4eae7;
  border-radius: 12px;
  .toolbarSearch {
    flex: 1;
    min-width: 220px;
  }
  /deep/ .el-button--primary {
    background: #0b8f64;
    border-color: #0b8f64;
  }
}
</style>
