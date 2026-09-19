<template>
  <div class="fileToolbar">
    <div class="toolbarTitle">脑图</div>
    <div class="toolbarActions">
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
    <el-dropdown trigger="click" @command="onRole">
      <button
        type="button"
        class="iconGhost"
        :class="{ active: !!roleFilter }"
        :title="roleTitle"
        :aria-label="roleTitle"
      >
        <i class="el-icon-user" aria-hidden="true" />
      </button>
      <el-dropdown-menu slot="dropdown">
        <el-dropdown-item
          command="__all__"
          :class="{ isActive: !roleFilter }"
        >
          <i
            class="checkIcon"
            :class="!roleFilter ? 'el-icon-check' : ''"
            aria-hidden="true"
          />
          全部角色
        </el-dropdown-item>
        <el-dropdown-item
          v-for="role in roleOptions"
          :key="role.value"
          :command="role.value"
          :class="{ isActive: roleFilter === role.value }"
        >
          <i
            class="checkIcon"
            :class="roleFilter === role.value ? 'el-icon-check' : ''"
            aria-hidden="true"
          />
          {{ role.label }}
        </el-dropdown-item>
      </el-dropdown-menu>
    </el-dropdown>

    <div class="viewSwitch" role="group" aria-label="视图切换">
      <button
        type="button"
        class="iconGhost"
        :class="{ active: view === 'card' }"
        title="卡片视图"
        aria-label="卡片视图"
        @click="$emit('update:view', 'card')"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <rect x="3" y="3" width="8" height="8" rx="1.5" fill="currentColor" />
          <rect x="13" y="3" width="8" height="8" rx="1.5" fill="currentColor" />
          <rect x="3" y="13" width="8" height="8" rx="1.5" fill="currentColor" />
          <rect x="13" y="13" width="8" height="8" rx="1.5" fill="currentColor" />
        </svg>
      </button>
      <button
        type="button"
        class="iconGhost"
        :class="{ active: view === 'list' }"
        title="列表视图"
        aria-label="列表视图"
        @click="$emit('update:view', 'list')"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <rect x="3" y="5" width="18" height="2.5" rx="1" fill="currentColor" />
          <rect x="3" y="10.75" width="18" height="2.5" rx="1" fill="currentColor" />
          <rect x="3" y="16.5" width="18" height="2.5" rx="1" fill="currentColor" />
        </svg>
      </button>
    </div>

    <button
      v-if="showBatch"
      type="button"
      class="iconGhost"
      :class="{ active: selectMode }"
      :title="selectMode ? '退出多选' : '多选'"
      :aria-label="selectMode ? '退出多选' : '多选'"
      @click="$emit('toggle-select-mode')"
    >
      <i class="el-icon-finished" aria-hidden="true" />
    </button>

    <el-dropdown
      v-if="showCreate || showCreateFolder"
      trigger="click"
      @command="create"
    >
      <button
        type="button"
        class="iconGhost createBtn"
        title="新建"
        aria-label="新建"
      >
        <i class="el-icon-plus" aria-hidden="true" />
      </button>
      <el-dropdown-menu slot="dropdown">
        <el-dropdown-item
          v-if="showCreate"
          command="room"
          icon="el-icon-document-add"
          >新建脑图</el-dropdown-item
        >
        <el-dropdown-item
          v-if="showImport"
          command="import"
          icon="el-icon-upload2"
          >导入脑图</el-dropdown-item
        >
        <el-dropdown-item
          v-if="showCreateFolder"
          command="folder"
          icon="el-icon-folder-add"
          >新建文件夹</el-dropdown-item
        >
      </el-dropdown-menu>
    </el-dropdown>
    </div>
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
    showImport: { type: Boolean, default: true },
    showBatch: { type: Boolean, default: false },
    selectMode: { type: Boolean, default: false },
    hideOpenedSort: { type: Boolean, default: false }
  },
  data: () => ({
    roleOptions: [
      { value: 'Owner', label: '所有者' },
      { value: 'Editor', label: '可编辑' },
      { value: 'Viewer', label: '可查看' }
    ]
  }),
  computed: {
    roleTitle() {
      if (!this.roleFilter) return '筛选角色'
      const hit = this.roleOptions.find(item => item.value === this.roleFilter)
      return hit ? `角色：${hit.label}` : '筛选角色'
    }
  },
  methods: {
    create(command) {
      if (command === 'folder') this.$emit('create-folder')
      else if (command === 'import') this.$emit('import')
      else this.$emit('create-room')
    },
    onRole(command) {
      this.$emit(
        'update:roleFilter',
        command === '__all__' || command == null ? '' : String(command)
      )
    }
  }
}
</script>
<style lang="less" scoped>
.fileToolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  box-sizing: border-box;
  padding: 0 0 14px;
  border-bottom: 1px solid var(--ui-border);

  .toolbarTitle {
    flex: 0 0 auto;
    margin: 0;
    font-size: 22px;
    font-weight: 650;
    letter-spacing: -0.3px;
    color: var(--ui-text);
    line-height: 1.2;
  }

  .toolbarActions {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
    min-width: 0;
  }

  .toolbarSearch {
    margin-right: 4px;
  }

  .viewSwitch {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    margin-left: 2px;
  }

  .iconGhost {
    width: 36px;
    height: 36px;
    display: inline-grid;
    place-items: center;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--ui-text-secondary);
    cursor: pointer;
    font-size: 18px;
    padding: 0;
    line-height: 1;
    transition: background 0.15s ease, color 0.15s ease;

    &:hover,
    &:focus-visible {
      background: var(--ui-surface-muted);
      color: var(--ui-primary);
      outline: none;
    }

    &.active {
      background: var(--ui-primary-soft);
      color: var(--ui-primary);
    }

    svg {
      display: block;
    }
  }

  .createBtn {
    color: var(--ui-primary);
    background: var(--ui-primary-soft);

    &:hover,
    &:focus-visible {
      background: var(--ui-primary);
      color: #fff;
    }
  }

  .checkIcon {
    display: inline-block;
    width: 14px;
    margin-right: 6px;
    font-size: 12px;
    color: var(--ui-primary);
  }
}
</style>
<style lang="less">
.fileToolbar .el-dropdown-menu__item.isActive {
  color: var(--ui-primary);
  font-weight: 600;
  background: var(--ui-primary-soft);
}
</style>
