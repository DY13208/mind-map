<template>
  <div class="kb-folder-tree">
    <div class="kb-tree-head">
      <span>文件夹</span>
      <span class="kb-tree-actions">
        <el-tooltip content="新建文件夹" :visible-arrow="false" placement="top">
          <el-button type="text" icon="el-icon-folder-add" class="kb-icon-btn" aria-label="新建文件夹" @click="createFolder" />
        </el-tooltip>
        <el-tooltip content="刷新" :visible-arrow="false" placement="top">
          <el-button type="text" icon="el-icon-refresh-right" class="kb-icon-btn" aria-label="刷新" @click="load" />
        </el-tooltip>
      </span>
    </div>
    <div class="kb-tree-root" :class="{ active: !value }" @click="select('')">
      <i class="el-icon-files" aria-hidden="true" />全部文件
    </div>
    <div v-if="error" class="kb-tree-hint">
      {{ error.kind === 'not_ready' ? '文件夹接口等待后端实现' : error.message }}
      <el-button type="text" class="kb-link" @click="load">重试</el-button>
    </div>
    <el-tree
      v-if="treeKey && !error"
      ref="tree"
      :key="treeKey"
      lazy
      :load="loadNode"
      node-key="id"
      :props="treeProps"
      :expand-on-click-node="false"
      highlight-current
      empty-text="暂无文件夹：点右上角新建，或在上传面板选择文件夹上传"
      @node-click="onNodeClick"
    >
      <span slot-scope="{ node, data }" class="kb-tree-node" :class="{ 'is-more': data.__more }">
        <template v-if="data.__more">
          <i :class="data.loading ? 'el-icon-loading' : 'el-icon-more-outline'" aria-hidden="true" />
          <span class="kb-tree-label">{{ data.loading ? '加载中…' : '加载更多' }}</span>
        </template>
        <template v-else>
          <i class="el-icon-folder" aria-hidden="true" />
          <span class="kb-tree-label" :title="data.name">{{ data.name }}</span>
          <el-dropdown trigger="click" size="small" @command="c => onCommand(c, data, node)" @click.native.stop>
            <i class="el-icon-more kb-tree-more" aria-label="更多" />
            <el-dropdown-menu slot="dropdown" :visible-arrow="false">
              <el-dropdown-item command="acl" icon="el-icon-lock">权限设置</el-dropdown-item>
              <el-dropdown-item command="rename" icon="el-icon-edit">重命名</el-dropdown-item>
              <el-dropdown-item command="delete" icon="el-icon-delete">删除</el-dropdown-item>
            </el-dropdown-menu>
          </el-dropdown>
        </template>
      </span>
    </el-tree>
  </div>
</template>
<script>
import kbApi from '../services/kbApi'
// 懒加载：展开节点时才按 parent_id 请求直接子级；子级过多时分页，末尾出现「加载更多」伪节点
const PAGE = 100
let moreSeq = 0
export default {
  name: 'KbFolderTree',
  props: { value: { type: String, default: '' } },
  data() {
    return {
      treeKey: 1,
      error: null,
      treeProps: {
        label: 'name',
        children: 'children',
        isLeaf: d => !!d.__more || d.hasChildren === false || d.childCount === 0
      }
    }
  },
  methods: {
    load() {
      this.error = null
      this.treeKey += 1
    },
    async fetch(parentId, cursor) {
      const { items, nextCursor } = await kbApi.listFolders({ parentId, limit: PAGE, cursor })
      const list = items.map(f => ({ ...f }))
      if (nextCursor) list.push({ id: '__more_' + ++moreSeq, __more: true, parentId: parentId || '', cursor: nextCursor, loading: false })
      return list
    },
    async loadNode(node, resolve) {
      const parentId = node.level === 0 ? '' : node.data.id
      try {
        resolve(await this.fetch(parentId))
      } catch (e) {
        if (node.level === 0) this.error = e
        else this.$message.error(e.message)
        resolve([])
      }
    },
    async loadMore(data, node) {
      if (data.loading) return
      data.loading = true
      try {
        const list = await this.fetch(data.parentId, data.cursor)
        const tree = this.$refs.tree
        const parentNode = node.parent
        list.forEach(item => tree.append(item, parentNode.level === 0 ? null : parentNode))
        tree.remove(data)
      } catch (e) {
        data.loading = false
        this.$message.error(e.message)
      }
    },
    pathOf(node) {
      const path = []
      let n = node
      while (n && n.level > 0) {
        path.unshift({ id: n.data.id, name: n.data.name })
        n = n.parent
      }
      return path
    },
    onNodeClick(data, node) {
      if (data.__more) return this.loadMore(data, node)
      this.$emit('input', data.id)
      this.$emit('path', this.pathOf(node))
    },
    select(id) {
      if (!id) {
        this.$emit('input', '')
        this.$emit('path', [])
        if (this.$refs.tree) this.$refs.tree.setCurrentKey(null)
        return
      }
      const node = this.$refs.tree && this.$refs.tree.getNode(id)
      if (node) this.onNodeClick(node.data, node)
    },
    refreshNode(id) {
      const tree = this.$refs.tree
      const node = id && tree ? tree.getNode(id) : null
      if (!node) return this.load()
      node.loaded = false
      node.childNodes.splice(0)
      node.expand()
    },
    async createFolder() {
      try {
        const { value } = await this.$prompt('文件夹名称', '新建文件夹', { inputPattern: /\S/, inputErrorMessage: '请输入名称', confirmButtonText: '创建', cancelButtonText: '取消' })
        await kbApi.createFolder({ name: value.trim(), parentId: this.value || undefined })
        this.$message.success('已创建')
        this.refreshNode(this.value)
      } catch (e) {
        if (e && e.__kb) this.$message.error(e.message)
      }
    },
    async onCommand(cmd, folder, node) {
      if (cmd === 'acl') return this.$emit('acl', { type: 'folder', id: folder.id, name: folder.name })
      try {
        if (cmd === 'rename') {
          const { value } = await this.$prompt('新名称', '重命名文件夹', { inputValue: folder.name, inputPattern: /\S/, inputErrorMessage: '请输入名称', confirmButtonText: '保存', cancelButtonText: '取消' })
          await kbApi.renameFolder(folder.id, value.trim())
          this.$set(folder, 'name', value.trim())
        } else if (cmd === 'delete') {
          await this.$confirm(`确定删除文件夹「${folder.name}」？`, '删除文件夹', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' })
          await kbApi.deleteFolder(folder.id)
          if (this.value === folder.id) this.select('')
          this.$refs.tree.remove(node)
        }
        this.$message.success('操作成功')
      } catch (e) {
        if (e && e.__kb) this.$message.error(e.message)
      }
    }
  }
}
</script>
<style scoped lang="less">
.kb-folder-tree {
  font-size: 13px;
  color: var(--ui-text);
}
.kb-tree-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: 600;
  color: var(--ui-text-secondary);
  padding: 0 4px 6px;
}
.kb-icon-btn {
  padding: 4px;
  font-size: 16px;
  font-weight: 700;
  color: var(--ui-text-secondary);
  &:hover { color: var(--ui-primary); }
}
.kb-tree-root {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 8px;
  border-radius: var(--ui-radius-sm);
  cursor: pointer;
  font-weight: 600;
  &:hover { background: var(--ui-hover-overlay); }
  &.active { background: var(--ui-primary-soft); color: var(--ui-primary); }
}
.kb-link { color: var(--ui-primary); font-weight: 600; padding: 0 2px; &:hover, &:focus { color: var(--ui-primary-hover); } }
.kb-tree-node.is-more { color: var(--ui-primary); font-weight: 600; }
.kb-tree-hint {
  padding: 10px 8px;
  color: var(--ui-text-muted);
  line-height: 1.6;
}
.kb-tree-node {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding-right: 6px;
  i { font-weight: 700; }
}
.kb-tree-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kb-tree-more {
  color: var(--ui-text-muted);
  visibility: hidden;
}
.kb-tree-node:hover .kb-tree-more { visibility: visible; }
::v-deep .el-tree {
  background: transparent;
  color: var(--ui-text);
  .el-tree-node__content { border-radius: var(--ui-radius-sm); height: 32px; }
  .el-tree-node__content:hover { background: var(--ui-hover-overlay); }
  &.el-tree--highlight-current .el-tree-node.is-current > .el-tree-node__content {
    background: var(--ui-primary-soft);
    color: var(--ui-primary);
  }
}
</style>
