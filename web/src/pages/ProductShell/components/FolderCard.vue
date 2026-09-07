<template
  ><article
    class="folderCard"
    role="button"
    tabindex="0"
    @keydown.enter.self="$emit('open', folder)"
    @click="$emit('open', folder)"
  >
    <span class="folderIcon"><i class="el-icon-folder"/></span
    ><span class="folderInfo"
      ><strong>{{ folder.name }}</strong
      ><small>{{ itemCountText }}</small><small>{{ dateText }} 更新</small></span
    ><el-dropdown
      v-if="editable"
      trigger="click"
      @command="$emit($event, folder)"
      @click.native.stop
      ><span class="more"><i class="el-icon-more"/></span
      ><el-dropdown-menu slot="dropdown"
        ><el-dropdown-item command="rename">重命名</el-dropdown-item
        ><el-dropdown-item command="delete" divided
          >删除</el-dropdown-item
        ></el-dropdown-menu
      ></el-dropdown
    >
  </article></template
>
<script>
export default {
  name: 'FolderCard',
  props: { folder: Object, editable: { type: Boolean, default: true } },
  computed: {
    itemCountText() {
      const count = Number(this.folder.itemCount != null ? this.folder.itemCount : this.folder.roomCount) || 0
      return count ? `${count} 个项目` : '空文件夹'
    },
    dateText() {
      return new Date(this.folder.updatedAt).toLocaleDateString('zh-CN')
    }
  }
}
</script>
<style lang="less" scoped>
.folderCard {
  width: 100%;
  border: 1px solid #e3e9e6;
  background: white;
  min-height: 210px;
  padding: 20px;
  border-radius: var(--ui-radius-lg);
  display: grid;
  grid-template-columns: 48px 1fr auto;
  align-content: end;
  gap: 12px;
  cursor: pointer;
  text-align: left;
  color: var(--ui-text);
  transition: border-color var(--ui-duration) var(--ui-ease), box-shadow var(--ui-duration) var(--ui-ease), transform var(--ui-duration) var(--ui-ease);
  &:hover {
    border-color: var(--ui-border-strong);
    box-shadow: var(--ui-shadow-hover);
    transform: translateY(-1px);
  }
  .folderIcon {
    width: 48px;
    height: 48px;
    background: var(--ui-primary-soft);
    color: var(--ui-primary);
    border-radius: var(--ui-radius-lg);
    display: grid;
    place-items: center;
    font-size: 20px;
  }
  .folderInfo {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }
  small {
    color: var(--ui-text-secondary);
    margin-top: 5px;
    font-size: 12px;
  }
  .more {
    padding: 8px;
    color: #73817c;
  }
}
</style>
