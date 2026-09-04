<template>
  <article
    class="roomCard"
    tabindex="0"
    :aria-label="`打开 ${room.title}`"
    @keydown.enter.self="$emit('open', room)"
    @click="$emit('open', room)"
  >
    <div class="roomPreview">
      <i class="el-icon-share"></i
      ><button
        class="favorite"
        :aria-label="room.favorite ? '取消收藏' : '收藏'"
        :class="{ active: room.favorite }"
        @click.stop="$emit('favorite', room)"
      >
        <i :class="room.favorite ? 'el-icon-star-on' : 'el-icon-star-off'" />
      </button>
    </div>
    <div class="roomBody">
      <div class="titleRow">
        <h3 :title="room.title">{{ room.title }}</h3>
        <el-dropdown
          trigger="click"
          @command="$emit($event, room)"
          @click.native.stop
          ><span class="more"><i class="el-icon-more"/></span
          ><el-dropdown-menu slot="dropdown"
            ><el-dropdown-item command="open">打开</el-dropdown-item
            ><el-dropdown-item command="rename">重命名</el-dropdown-item
            ><el-dropdown-item command="move">移动</el-dropdown-item
            ><el-dropdown-item command="favorite">{{
              room.favorite ? '取消收藏' : '收藏'
            }}</el-dropdown-item
            ><el-dropdown-item command="share">分享</el-dropdown-item
            ><el-dropdown-item command="history">历史版本</el-dropdown-item
            ><el-dropdown-item v-if="allowDelete" command="delete" divided
              >删除</el-dropdown-item
            ></el-dropdown-menu
          ></el-dropdown
        >
      </div>
      <p><i class="el-icon-folder-opened"></i> {{ room.folderName }}</p>
      <p class="ownerLine">
        Owner {{ room.owner.name }}
        <el-tag size="mini" type="info">{{ room.roleLabel || room.role }}</el-tag>
      </p>
      <div class="roomMeta">
        <div class="avatarStack">
          <el-avatar :size="24">{{ room.owner.avatar }}</el-avatar
          ><el-avatar
            v-for="person in room.collaborators.slice(0, 2)"
            :key="person.id"
            :size="24"
            >{{ person.avatar }}</el-avatar
          >
        </div>
        <span>{{ dateText }}</span>
      </div>
    </div>
  </article>
</template>
<script>
export default {
  name: 'RoomCard',
  props: { room: Object, allowDelete: { type: Boolean, default: false } },
  computed: {
    dateText() {
      return new Date(this.room.updatedAt).toLocaleDateString('zh-CN')
    }
  }
}
</script>
<style lang="less" scoped>
.ownerLine {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.roomCard {
  background: white;
  border: 1px solid #e3e9e6;
  border-radius: 13px;
  overflow: hidden;
  cursor: pointer;
  transition: 0.16s ease;
  &:hover {
    transform: translateY(-2px);
    box-shadow: 0 10px 26px rgba(25, 70, 54, 0.08);
    border-color: #bad7cc;
  }
  .roomPreview {
    height: 118px;
    background: #edf5f1;
    display: grid;
    place-items: center;
    color: #55a789;
    font-size: 34px;
    position: relative;
  }
  .favorite {
    position: absolute;
    right: 11px;
    top: 11px;
    border: 0;
    background: white;
    width: 30px;
    height: 30px;
    border-radius: 8px;
    color: #93a19c;
    cursor: pointer;
    &.active {
      color: #e6a23c;
    }
  }
  .roomBody {
    padding: 15px;
  }
  .titleRow {
    display: flex;
    align-items: center;
    h3 {
      flex: 1;
      margin: 0;
      font-size: 15px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .more {
      padding: 7px;
      color: #7f8d88;
    }
  }
  p {
    margin: 8px 0 14px;
    color: #83918c;
    font-size: 12px;
  }
  .roomMeta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    color: #8e9a96;
    font-size: 12px;
  }
  .avatarStack {
    display: flex;
    /deep/ .el-avatar {
      margin-right: -5px;
      border: 2px solid white;
      background: #15936a;
      font-size: 10px;
    }
  }
}
</style>
