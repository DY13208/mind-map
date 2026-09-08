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
        v-for="role in roleOptions"
        :key="role.value"
        :label="role.label"
        :value="role.value"
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
    <el-dropdown v-if="showCreate || showCreateFolder" trigger="click" @command="create">
      <el-button type="primary" icon="el-icon-plus">新建 <i class="el-icon-arrow-down el-icon--right" /></el-button>
      <el-dropdown-menu slot="dropdown">
        <el-dropdown-item v-if="showCreate" command="room" icon="el-icon-document-add">新建脑图</el-dropdown-item>
        <el-dropdown-item v-if="showCreateFolder" command="folder" icon="el-icon-folder-add">新建文件夹</el-dropdown-item>
      </el-dropdown-menu>
    </el-dropdown>
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
  },
  data: () => ({
    roleOptions: [
      { value: 'Owner', label: '所有者' },
      { value: 'Editor', label: '可编辑' },
      { value: 'Viewer', label: '可查看' }
    ]
  }),
  methods: {
    create(command) {
      this.$emit(command === 'folder' ? 'create-folder' : 'create-room')
    }
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
  padding: 0 0 18px;
  border-bottom: 1px solid var(--ui-border);
  .toolbarSearch {
    flex: 1;
    min-width: 220px;
  }
  /deep/ .el-button--primary {
    background: var(--ui-primary);
    border-color: var(--ui-primary);
  }
}
</style>
