<template
  ><article
    class="folderCard"
    :class="{ selected, selectable }"
    role="button"
    tabindex="0"
    @keydown.enter.self="$emit('open', folder)"
    @click="$emit('open', folder)"
  >
    <label
      v-if="selectable"
      class="selectBox"
      @click.stop
    >
      <el-checkbox
        :value="selected"
        :disabled="!canSelect"
        @change="$emit('toggle-select', folder)"
      />
    </label>
    <div class="folderPreview">
      <span class="folderIcon"><i class="el-icon-folder-opened"/></span>
    </div>
    <div class="folderBody">
      <span class="folderInfo"
        ><strong :title="folder.name">{{ folder.name }}</strong
        ><small>{{ itemCountText }}</small
        ><small>创建者 {{ creatorName }}</small
        ><small>{{ dateText }} 更新</small></span
      >
      <el-dropdown
        trigger="click"
        @command="$emit($event, folder)"
        @click.native.stop
        ><span class="more"><i class="el-icon-more"/></span
        ><el-dropdown-menu slot="dropdown"
          ><el-dropdown-item v-if="allowShare" command="share">分享 / 权限</el-dropdown-item
          ><el-dropdown-item v-if="editable" command="rename">重命名</el-dropdown-item
          ><el-dropdown-item v-if="allowMoveToTeam" command="move-to-team">移至团队空间</el-dropdown-item
          ><el-dropdown-item v-if="editable" command="delete" divided
            >删除</el-dropdown-item
          ></el-dropdown-menu
        ></el-dropdown
      >
    </div>
  </article></template
>
<script>
export default {
  name: 'FolderCard',
  props: {
    folder: Object,
    editable: { type: Boolean, default: true },
    allowShare: { type: Boolean, default: true },
    allowMoveToTeam: { type: Boolean, default: false },
    selectable: { type: Boolean, default: false },
    selected: { type: Boolean, default: false },
    canSelect: { type: Boolean, default: true }
  },
  computed: {
    itemCountText() {
      const count =
        Number(
          this.folder.itemCount != null
            ? this.folder.itemCount
            : this.folder.roomCount
        ) || 0
      return count ? `${count} 个项目` : '空文件夹'
    },
    dateText() {
      return new Date(this.folder.updatedAt).toLocaleDateString('zh-CN')
    },
    creatorName() {
      const owner = (this.folder && (this.folder.owner || this.folder.createdBy)) || {}
      if (typeof owner === 'string') return owner || '—'
      return owner.name || owner.userId || owner.id || '—'
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
  overflow: hidden;
  position: relative;
  display: flex;
  flex-direction: column;
  cursor: pointer;
  text-align: left;
  color: var(--ui-text);
  transition: border-color var(--ui-duration) var(--ui-ease),
    box-shadow var(--ui-duration) var(--ui-ease),
    transform var(--ui-duration) var(--ui-ease);
  &.selected {
    border-color: var(--ui-primary);
    box-shadow: 0 0 0 1px var(--ui-primary-soft);
  }
  .selectBox {
    position: absolute;
    left: 4px;
    top: 4px;
    z-index: 2;
    margin: 0;
    padding: 0;
    line-height: 0;
    background: transparent;
    border: 0;
    box-shadow: none;
    cursor: pointer;
    /deep/ .el-checkbox {
      margin: 0;
    }
    /deep/ .el-checkbox__inner {
      width: 15px;
      height: 15px;
      background-color: transparent;
      border: 1.5px solid #5f746c;
      border-radius: 3px;
      box-shadow: none;
    }
    /deep/ .el-checkbox__inner::after {
      left: 4px;
      top: 1px;
    }
    /deep/ .el-checkbox__input.is-checked .el-checkbox__inner,
    /deep/ .el-checkbox__input.is-indeterminate .el-checkbox__inner {
      background-color: var(--ui-primary);
      border-color: var(--ui-primary);
    }
  }
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
    > strong {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }
  small {
    color: var(--ui-text-secondary);
    margin-top: 5px;
    font-size: 12px;
  }
  .more {
    flex: 0 0 auto;
    padding: 8px;
    color: #73817c;
  }
}
</style>
