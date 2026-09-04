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
      ><small>{{ folder.roomCount }} 个脑图 · {{ dateText }}</small></span
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
  padding: 16px;
  border-radius: 11px;
  display: flex;
  align-items: center;
  gap: 12px;
  cursor: pointer;
  text-align: left;
  color: #243c33;
  &:hover {
    border-color: #b7d7ca;
    box-shadow: 0 6px 20px rgba(28, 76, 59, 0.06);
  }
  .folderIcon {
    width: 38px;
    height: 38px;
    background: #eef6f2;
    color: #149067;
    border-radius: 9px;
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
    color: #8b9893;
    margin-top: 5px;
  }
  .more {
    padding: 8px;
    color: #73817c;
  }
}
</style>
