<template>
  <div class="mapFileTree" :class="{ isDark: isDark }">
    <div class="treeHead">
      <span class="headLabel">脑图</span>
      <button v-if="isTouchEditor" type="button" aria-label="关闭脑图目录" @click="$emit('close')"><i class="el-icon-close" /></button>
    </div>
    <el-input v-if="isTouchEditor" v-model="mobileSearch" clearable prefix-icon="el-icon-search" placeholder="搜索文件夹或脑图" aria-label="搜索文件夹或脑图" />
    <div v-if="loading" class="treeState">正在加载…</div>
    <button v-else-if="error" type="button" class="treeState retry" @click="load">
      {{ error }}，点击重试
    </button>
    <div v-else-if="!nodes.length" class="treeState">还没有脑图</div>
    <div v-else class="treeBody">
      <div
        v-for="row in renderedRows"
        :key="row.node.id"
        class="treeRow"
        :class="{ current: row.node.current, folder: row.node.type === 'folder' }"
        :style="{ paddingLeft: row.depth * 16 + 8 + 'px' }"
        @click="onRowClick(row)"
      >
        <span
          v-if="row.depth > 0"
          class="treeLine"
          :style="{ left: (row.depth - 1) * 16 + 16 + 'px' }"
        ></span>
        <span
          class="chevron"
          :class="{ open: row.node.type === 'folder' && row.open, fileMark: row.node.type !== 'folder' }"
        >
          <svg v-if="row.node.type === 'folder'" width="6" height="8" viewBox="0 0 6 8" fill="none">
            <path
              d="M1 1L5 4L1 7"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          <span v-else>◇</span>
        </span>
        <span class="glyph" :class="row.node.type === 'folder' ? 'folderGlyph' : 'fileGlyph'">
          <svg v-if="row.node.type === 'folder'" width="16" height="14" viewBox="0 0 16 14" fill="currentColor">
            <path d="M1.5 1C0.67 1 0 1.67 0 2.5V11.5C0 12.33 0.67 13 1.5 13H14.5C15.33 13 16 12.33 16 11.5V4.5C16 3.67 15.33 3 14.5 3H8L6.5 1H1.5Z" />
          </svg>
          <svg v-else width="14" height="16" viewBox="0 0 14 16" fill="currentColor">
            <path d="M1.5 0C0.67 0 0 0.67 0 1.5V14.5C0 15.33 0.67 16 1.5 16H12.5C13.33 16 14 15.33 14 14.5V4.5L9.5 0H1.5Z" />
            <path d="M9 0V4.5H14" fill="currentColor" fill-opacity="0.45" />
          </svg>
        </span>
        <span class="nodeName">{{ row.node.name }}</span>
        <span class="hoverDot"></span>
      </div>
      <button v-if="isTouchEditor && visibleRows.length > mobileLimit" type="button" class="treeLoadMore" @click="mobileLimit += 150">加载更多目录项</button>
    </div>
  </div>
</template>

<script>
import folderService from '@/services/folderService'
import editorViewport from '@/utils/editorViewport'
import { listAllAccessibleFiles } from '@/utils/fileApi'
import { normalizeRoomDto } from '@/services/roomDto'

function byName(a, b) {
  return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN')
}

function buildMapTree(folders, rooms, currentKey) {
  const folderList = Array.isArray(folders) ? folders : []
  const known = new Set(folderList.map(folder => String(folder.id)))
  const foldersByParent = new Map()
  folderList.forEach(folder => {
    const parentId = folder.parentId && known.has(String(folder.parentId))
      ? String(folder.parentId)
      : ''
    if (!foldersByParent.has(parentId)) foldersByParent.set(parentId, [])
    foldersByParent.get(parentId).push(folder)
  })
  const roomsByFolder = new Map()
  ;(Array.isArray(rooms) ? rooms : []).forEach(room => {
    if (!room || !room.roomKey) return
    const folderId = room.folderId && known.has(String(room.folderId))
      ? String(room.folderId)
      : ''
    if (!roomsByFolder.has(folderId)) roomsByFolder.set(folderId, [])
    roomsByFolder.get(folderId).push(room)
  })

  const roomNode = room => ({
    id: 'room:' + room.roomKey,
    name: room.title || '未命名',
    type: 'file',
    roomKey: room.roomKey,
    current: room.roomKey === currentKey
  })
  const folderNode = folder => {
    const id = String(folder.id)
    const children = (foldersByParent.get(id) || [])
      .slice()
      .sort(byName)
      .map(folderNode)
      .concat(
        (roomsByFolder.get(id) || [])
          .slice()
          .sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'zh-CN'))
          .map(roomNode)
      )
    return {
      id: 'folder:' + id,
      name: folder.name || '未命名文件夹',
      type: 'folder',
      children
    }
  }

  const roots = (foldersByParent.get('') || []).slice().sort(byName).map(folderNode)
  const loose = (roomsByFolder.get('') || [])
    .slice()
    .sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'zh-CN'))
    .map(roomNode)
  if (roots.length && loose.length) {
    roots.push({
      id: 'folder:ungrouped',
      name: '未分组',
      type: 'folder',
      children: loose
    })
  } else {
    roots.push(...loose)
  }
  return roots
}

function ancestorIds(nodes, currentKey, acc = []) {
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i]
    if (node.type === 'file' && node.roomKey === currentKey) return true
    if (node.children && ancestorIds(node.children, currentKey, acc)) {
      acc.push(node.id)
      return true
    }
  }
  return false
}

export default {
  name: 'MapFileTree',
  mixins: [editorViewport],
  props: {
    currentRoomKey: { type: String, default: '' },
    isDark: { type: Boolean, default: false }
  },
  data() {
    return {
      loading: false,
      mobileSearch: '',
      mobileLimit: 150,
      error: '',
      nodes: [],
      openIds: []
    }
  },
  computed: {
    renderedRows() { return this.isTouchEditor ? this.visibleRows.slice(0, this.mobileLimit) : this.visibleRows },
    visibleRows() {
      const rows = []
      const query = this.isTouchEditor ? this.mobileSearch.trim().toLowerCase() : ''
      const matches = node => String(node.name).toLowerCase().includes(query) || (node.children || []).some(matches)
      const walk = (nodes, depth) => {
        nodes.forEach(node => {
          if (query && !matches(node)) return
          const open = this.openIds.indexOf(node.id) !== -1
          rows.push({ node, depth, open })
          if (node.type === 'folder' && (open || query) && node.children && node.children.length) {
            walk(node.children, depth + 1)
          }
        })
      }
      walk(this.nodes, 0)
      return rows
    }
  },
  watch: { mobileSearch() { this.mobileLimit = 150 } },
  created() {
    this.load()
  },
  methods: {
    async load() {
      this.loading = true
      this.error = ''
      try {
        const [folders, files] = await Promise.all([
          folderService.listFolders(),
          listAllAccessibleFiles()
        ])
        const rooms = ((files && files.list) || []).map(item => normalizeRoomDto(item))
        const current = this.currentRoomKey
        this.nodes = buildMapTree(folders, rooms, current)
        const openIds = []
        ancestorIds(this.nodes, current, openIds)
        this.openIds = openIds
      } catch (error) {
        this.nodes = []
        this.error = (error && error.message) || '脑图目录加载失败'
      } finally {
        this.loading = false
      }
    },
    onRowClick(row) {
      const node = row.node
      if (node.type === 'folder') {
        const ids = this.openIds.slice()
        const index = ids.indexOf(node.id)
        if (index === -1) ids.push(node.id)
        else ids.splice(index, 1)
        this.openIds = ids
        return
      }
      this.$emit('open', node)
    }
  }
}
</script>

<style lang="less" scoped>
.mapFileTree {
  --tree-bg: #f7f8fa;
  --tree-border: rgba(16, 24, 40, 0.08);
  --tree-muted: #98a2b3;
  --tree-text: #667085;
  --tree-title: #1d2939;
  --tree-hover: #eef2f6;
  --tree-current: #ecf5ff;
  --tree-line: rgba(16, 24, 40, 0.12);
  --tree-mark: #7a8ca0;
  width: 280px;
  max-height: 460px;
  display: flex;
  flex-direction: column;
  background: var(--tree-bg);
  border: 1px solid var(--tree-border);
  border-radius: 12px;
  padding: 12px;
  box-shadow: 0 8px 24px rgba(16, 24, 40, 0.08);
  font-family: ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace;
  color: var(--tree-text);

  &.isDark {
    --tree-bg: #262a2e;
    --tree-border: rgba(255, 255, 255, 0.1);
    --tree-muted: rgba(255, 255, 255, 0.45);
    --tree-text: rgba(255, 255, 255, 0.72);
    --tree-title: rgba(255, 255, 255, 0.92);
    --tree-hover: rgba(255, 255, 255, 0.06);
    --tree-current: rgba(64, 158, 255, 0.18);
    --tree-line: rgba(255, 255, 255, 0.12);
    --tree-mark: rgba(255, 255, 255, 0.4);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  }
}

.treeHead {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-bottom: 10px;
  margin-bottom: 6px;
  border-bottom: 1px solid var(--tree-border);
  flex: none;
}

.headLabel {
  font-size: 12px;
  color: var(--tree-muted);
}

.treeState {
  padding: 16px 8px;
  font-size: 12px;
  color: var(--tree-text);
  background: transparent;
  border: 0;
  text-align: left;
}

.retry {
  cursor: pointer;
}

.treeBody {
  overflow: auto;
  min-height: 0;
}

.treeRow {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 28px;
  padding-top: 4px;
  padding-bottom: 4px;
  padding-right: 8px;
  border-radius: 6px;
  cursor: pointer;
  color: var(--tree-text);
  user-select: none;
}

.treeRow:hover {
  background: var(--tree-hover);
  color: var(--tree-title);
}

.treeRow.current {
  background: var(--tree-current);
  color: var(--tree-title);
}

.treeLine {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--tree-line);
}

.treeRow:hover .treeLine {
  background: rgba(64, 158, 255, 0.45);
}

.chevron {
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--tree-muted);
  transition: transform 0.2s ease;
  flex: none;
}

.chevron.open {
  transform: rotate(90deg);
  color: #409eff;
}

.fileMark {
  font-size: 12px;
  color: var(--tree-mark);
}

.glyph {
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
}

.folderGlyph {
  color: #c9922a;
}

.fileGlyph {
  color: #3d8b7a;
  opacity: 0.85;
}

.treeRow:hover .glyph {
  transform: scale(1.08);
}

.nodeName {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

.treeRow.folder .nodeName {
  color: var(--tree-title);
}

.hoverDot {
  width: 6px;
  height: 6px;
  margin-left: auto;
  border-radius: 50%;
  background: #409eff;
  opacity: 0;
  transform: scale(0);
  transition: opacity 0.2s ease, transform 0.2s ease;
  flex: none;
}

.treeRow:hover .hoverDot,
.treeRow.current .hoverDot {
  opacity: 1;
  transform: scale(1);
}
</style>

<style lang="less">
.mapFileTreePopper.el-popover {
  padding: 0;
  border: none;
  background: transparent;
  box-shadow: none;
  min-width: 0;
}
</style>
