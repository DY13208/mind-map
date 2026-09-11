<template
  ><el-dialog :visible.sync="shown" title="移动到文件夹" width="460px"
    ><p class="current">当前：{{ room ? room.folderName : '-' }}</p>
    <el-radio-group v-model="target"
      ><div class="folderOption">
        <el-radio :label="null"
          ><i class="el-icon-folder-opened" /> 根目录</el-radio
        >
      </div>
      <div class="folderOption" v-for="folder in folderOptions" :key="folder.id">
        <el-radio :label="folder.id"
          ><i class="el-icon-folder" /> {{ folder.label }}</el-radio
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
    folderOptions() {
      const byParent = this.folders.reduce((map, folder) => {
        const key = folder.parentId || ''
        if (!map[key]) map[key] = []
        map[key].push(folder)
        return map
      }, {})
      const result = []
      const visit = (parentId, depth, visited) => {
        const children = byParent[parentId || ''] || []
        children.forEach(folder => {
          if (visited.has(folder.id)) return
          result.push({
            ...folder,
            label: `${'　'.repeat(depth)}${depth ? '└ ' : ''}${folder.name}`
          })
          const nextVisited = new Set(visited)
          nextVisited.add(folder.id)
          visit(folder.id, depth + 1, nextVisited)
        })
      }
      visit(null, 0, new Set())
      return result
    },
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
