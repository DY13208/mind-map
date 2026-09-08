<template
  ><article
    class="folderCard"
    role="button"
    tabindex="0"
    @keydown.enter.self="$emit('open', folder)"
    @click="$emit('open', folder)"
  >
    <div class="folderPreview"><span class="folderIcon"><i class="el-icon-folder-opened"/></span></div>
    <div class="folderBody"><span class="folderInfo"
      ><strong>{{ folder.name }}</strong
      ><small>{{ itemCountText }}</small><small>{{ dateText }} 更新</small></span>
    <el-dropdown
      v-if="editable"
      trigger="click"
      @command="$emit($event, folder)"
      @click.native.stop
      ><span class="more"><i class="el-icon-more"/></span
      ><el-dropdown-menu slot="dropdown"
        ><el-dropdown-item command="share">分享 / 权限</el-dropdown-item
        ><el-dropdown-item command="rename">重命名</el-dropdown-item
        ><el-dropdown-item command="delete" divided
          >删除</el-dropdown-item
        ></el-dropdown-menu
      ></el-dropdown
    ></div>
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
  min-height: 0;
  padding: 0;
  border-radius: var(--ui-radius-lg);
  display: flex;
  flex-direction: column;
  cursor: pointer;
  text-align: left;
  color: var(--ui-text);
  transition: border-color var(--ui-duration) var(--ui-ease), box-shadow var(--ui-duration) var(--ui-ease), transform var(--ui-duration) var(--ui-ease);
  &:hover {
    border-color: var(--ui-border-strong);
    box-shadow: var(--ui-shadow-hover);
    transform: translateY(-1px);
  }
  .folderPreview {
    height: 126px;
    display: grid;
    place-items: center;
    background: var(--ui-surface-muted);
    border-bottom: 1px solid var(--ui-border);
  }
  .folderIcon {
    width: 64px;
    height: 52px;
    background: var(--ui-primary-soft);
    color: var(--ui-primary);
    border-radius: var(--ui-radius-lg);
    display: grid;
    place-items: center;
    font-size: 27px;
  }
  .folderBody {
    min-height: 116px;
    padding: 16px;
    display: flex;
    align-items: flex-start;
    gap: 8px;
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
