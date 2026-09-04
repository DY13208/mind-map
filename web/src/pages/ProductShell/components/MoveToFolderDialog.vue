<template
  ><el-dialog :visible.sync="shown" title="移动到文件夹" width="460px"
    ><p class="current">当前：{{ room ? room.folderName : '-' }}</p>
    <el-radio-group v-model="target"
      ><div class="folderOption">
        <el-radio :label="null"
          ><i class="el-icon-folder-opened" /> 根目录</el-radio
        >
      </div>
      <div class="folderOption" v-for="folder in folders" :key="folder.id">
        <el-radio :label="folder.id"
          ><i class="el-icon-folder" /> {{ folder.name }}</el-radio
        >
      </div></el-radio-group
    ><span slot="footer"
      ><el-button @click="shown = false">取消</el-button
      ><el-button type="primary" @click="confirm">移动</el-button></span
    ></el-dialog
  ></template
>
<script>
export default {
  name: 'MoveToFolderDialog',
  props: { visible: Boolean, room: Object, folders: Array },
  data: () => ({ target: null }),
  computed: {
    shown: {
      get() {
        return this.visible
      },
      set(value) {
        this.$emit('update:visible', value)
      }
    }
  },
  watch: {
    visible(value) {
      if (value) this.target = this.room && this.room.folderId
    }
  },
  methods: {
    confirm() {
      this.$emit('confirm', this.target)
      this.shown = false
    }
  }
}
</script>
<style lang="less" scoped>
.current {
  color: #89958f;
  font-size: 13px;
}
.el-radio-group {
  display: block;
}
.folderOption {
  padding: 12px;
  border-bottom: 1px solid #eef1ef;
}
</style>
