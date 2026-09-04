<template
  ><el-table
    :data="rooms"
    class="roomTable"
    @row-click="row => $emit('open', row)"
    ><el-table-column label="名称" min-width="220"
      ><template slot-scope="scope"
        ><div class="roomName">
          <i class="el-icon-share" /><strong>{{ scope.row.title }}</strong>
        </div></template
      ></el-table-column
    ><el-table-column
      prop="folderName"
      label="所属文件夹"
      min-width="120"
    /><el-table-column
      prop="owner.name"
      label="Owner"
      width="110"
    /><el-table-column
      prop="role"
      label="我的角色"
      width="100"
    /><el-table-column label="协作者" width="125"
      ><template slot-scope="scope"
        ><div class="avatars">
          <el-avatar
            v-for="person in scope.row.collaborators.slice(0, 3)"
            :key="person.id"
            :size="24"
            >{{ person.avatar }}</el-avatar
          >
        </div></template
      ></el-table-column
    ><el-table-column label="更新时间" width="145"
      ><template slot-scope="scope">{{
        formatDate(scope.row.updatedAt)
      }}</template></el-table-column
    ><el-table-column width="65"
      ><template slot-scope="scope"
        ><el-button
          type="text"
          :icon="scope.row.favorite ? 'el-icon-star-on' : 'el-icon-star-off'"
          @click.stop="
            $emit('favorite', scope.row)
          "/></template></el-table-column
    ><el-table-column width="65"
      ><template slot-scope="scope"
        ><el-dropdown
          trigger="click"
          @command="$emit($event, scope.row)"
          @click.native.stop
          ><i class="el-icon-more" /><el-dropdown-menu slot="dropdown"
            ><el-dropdown-item command="open">打开</el-dropdown-item
            ><el-dropdown-item command="rename">重命名</el-dropdown-item
            ><el-dropdown-item command="move">移动</el-dropdown-item
            ><el-dropdown-item command="share">分享</el-dropdown-item
            ><el-dropdown-item command="history">历史版本</el-dropdown-item
            ><el-dropdown-item command="delete" divided
              >删除</el-dropdown-item
            ></el-dropdown-menu
          ></el-dropdown
        ></template
      ></el-table-column
    ></el-table
  ></template
>
<script>
export default {
  name: 'RoomList',
  props: { rooms: Array },
  methods: {
    formatDate(value) {
      return new Date(value).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      })
    }
  }
}
</script>
<style lang="less" scoped>
.roomTable {
  border: 1px solid #e3e9e6;
  border-radius: 12px;
  overflow: hidden;
  .roomName {
    display: flex;
    gap: 9px;
    align-items: center;
    color: #234238;
    i {
      color: #0b9366;
    }
  }
  .avatars {
    display: flex;
    /deep/ .el-avatar {
      margin-right: -5px;
      background: #168f68;
      border: 2px solid white;
      font-size: 10px;
    }
  }
}
</style>
