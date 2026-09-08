<template>
  <el-dialog
    :custom-class="'mapRefDialogWrap' + (isDark ? ' isDarkMapRef' : '')"
    data-testid="mapref-dialog"
    :title="$t('mapRef.title')"
    :visible.sync="dialogVisible"
    width="560px"
    append-to-body
    @open="onOpen"
  >
    <el-input
      v-model.trim="fileQuery"
      size="small"
      clearable
      prefix-icon="el-icon-search"
      :placeholder="$t('mapRef.searchMaps')"
      @keydown.native.stop
    ></el-input>
    <div class="fileList" :class="{ isDark: isDark }">
      <div v-if="filesLoading" class="empty">{{ $t('other.loading') }}</div>
      <div v-else-if="!fileList.length" class="empty">
        {{
          fileQuery
            ? $t('mapRef.emptySearch', { q: fileQuery })
            : $t('mapRef.noFiles')
        }}
      </div>
      <div
        v-for="item in fileList"
        :key="item.room_key"
        class="fileItem"
        :class="{ active: isSelected(item) }"
        @click.stop="selectMap(item)"
        @dblclick.stop.prevent="confirmMap(item)"
      >
        <div class="fileItemMain">
          <i
            class="el-icon-check checkMark"
            v-if="isSelected(item)"
          ></i>
          <div class="fileItemText">
            <div class="title">{{ displayTitle(item.title, item.room_key) }}</div>
            <div class="meta">{{ item.room_key }}</div>
          </div>
        </div>
      </div>
    </div>
    <p v-if="selected" class="selectedHint">
      {{ $t('mapRef.selectedHint', { name: displayTitle(selected.title, selected.room_key) }) }}
      <span class="dblTip">{{ $t('mapRef.dblclickTip') }}</span>
    </p>
    <div v-if="selected" class="nodeBind">
      <el-radio-group v-model="bindMode" size="mini">
        <el-radio-button label="map">{{ $t('mapRef.bindMap') }}</el-radio-button>
        <el-radio-button label="node">{{ $t('mapRef.bindNode') }}</el-radio-button>
      </el-radio-group>
      <el-input
        v-if="bindMode === 'node'"
        v-model.trim="nodeQuery"
        size="small"
        class="nodeSearch"
        clearable
        :placeholder="$t('mapRef.searchNodes')"
        @keydown.native.stop
        @input="scheduleNodeSearch"
      ></el-input>
      <div v-if="bindMode === 'node'" class="nodeList" :class="{ isDark: isDark }">
        <div
          class="fileItem"
          :class="{ active: !selectedNode }"
          @click.stop="selectedNode = null"
          @dblclick.stop.prevent="confirm"
        >
          <div class="title">{{ $t('mapRef.wholeMap') }}</div>
        </div>
        <div
          v-for="hit in nodeHits"
          :key="hit.uid"
          class="fileItem"
          :class="{ active: selectedNode && selectedNode.uid === hit.uid }"
          @click.stop="selectedNode = hit"
          @dblclick.stop.prevent="pickNodeAndConfirm(hit)"
        >
          <div class="title">{{ displayTitle(hit.text, hit.uid) }}</div>
          <div class="meta">{{ hit.uid }}</div>
        </div>
      </div>
    </div>
    <span slot="footer">
      <el-button @click="dialogVisible = false">{{ $t('dialog.cancel') }}</el-button>
      <el-button type="primary" :disabled="!selected" @click="confirm">{{
        $t('dialog.confirm')
      }}</el-button>
    </span>
  </el-dialog>
</template>

<script>
import { mapState } from 'vuex'
import { listFiles, searchFile } from '@/utils/fileApi'
import { roomFromLocation } from '@/utils/roomLocation'
import { normalizeMapRef } from '@/utils/mapRefNav'

function stripHtml(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim()
}

function fileKey(item) {
  if (!item) return ''
  return String(item.room_key || item.roomKey || item.id || '').trim()
}

function normalizeFileItem(item) {
  const room_key = fileKey(item)
  return {
    ...item,
    room_key,
    roomKey: room_key,
    title: stripHtml(item && item.title) || room_key
  }
}

function subMapDisplayTitle(fileItem, bindNode) {
  if (bindNode && (bindNode.text || bindNode.uid)) {
    return stripHtml(bindNode.text || bindNode.uid)
  }
  if (fileItem && fileItem.title) return stripHtml(fileItem.title)
  const key = fileKey(fileItem)
  if (key) return key
  return '子脑图'
}

export default {
  name: 'MapRefDialog',
  data() {
    return {
      dialogVisible: false,
      filesLoading: false,
      fileQuery: '',
      fileList: [],
      selected: null,
      bindMode: 'map',
      nodeQuery: '',
      nodeHits: [],
      selectedNode: null,
      fileTimer: null,
      nodeTimer: null,
      activeNodes: [],
      targetNode: null,
      targetUid: ''
    }
  },
  computed: {
    ...mapState({
      isDark: state => state.localConfig.isDark
    }),
    currentRoom() {
      return roomFromLocation(this.$route)
    }
  },
  created() {
    this.$bus.$on('showMapRef', this.open)
    this.$bus.$on('node_active', this.handleNodeActive)
  },
  beforeDestroy() {
    this.$bus.$off('showMapRef', this.open)
    this.$bus.$off('node_active', this.handleNodeActive)
    if (this.fileTimer) clearTimeout(this.fileTimer)
    if (this.nodeTimer) clearTimeout(this.nodeTimer)
  },
  watch: {
    fileQuery() {
      if (this.fileTimer) clearTimeout(this.fileTimer)
      this.fileTimer = setTimeout(this.loadFiles, 200)
    }
  },
  methods: {
    displayTitle(title, fallback) {
      return stripHtml(title) || String(fallback || '')
    },
    isSelected(item) {
      const selectedKey = fileKey(this.selected)
      const itemKey = fileKey(item)
      return !!(selectedKey && itemKey && selectedKey === itemKey)
    },
    handleNodeActive(_el, nodes) {
      this.activeNodes = nodes || []
      // 打开弹窗后不要丢掉初始目标；仅在尚未锁定目标时跟随选中
      if (!this.dialogVisible && this.activeNodes[0]) {
        const n = this.activeNodes[0]
        this.targetNode = n
        this.targetUid = (n.getData && n.getData('uid')) || ''
      }
    },
    open(node) {
      if (node) {
        this.targetNode = node
        this.targetUid = (node.getData && node.getData('uid')) || ''
        this.activeNodes = [node]
      } else if (this.activeNodes && this.activeNodes[0]) {
        this.targetNode = this.activeNodes[0]
        this.targetUid =
          (this.targetNode.getData && this.targetNode.getData('uid')) || ''
      } else {
        this.targetNode = null
        this.targetUid = ''
      }
      this.selected = null
      this.dialogVisible = true
    },
    onOpen() {
      // 弹窗真正打开时再锁一次目标，防止右键菜单关闭后选中被清空
      if (!this.targetNode && this.activeNodes[0]) {
        this.targetNode = this.activeNodes[0]
        this.targetUid =
          (this.targetNode.getData && this.targetNode.getData('uid')) || ''
      }
      const first = this.targetNode || this.activeNodes[0]
      const existing =
        first && normalizeMapRef(first.getData && first.getData('mapRef'))
      this.bindMode = existing && existing.nodeId ? 'node' : 'map'
      this.selectedNode =
        existing && existing.nodeId ? { uid: existing.nodeId } : null
      this.fileQuery = ''
      this.nodeQuery = ''
      this.nodeHits = []
      this.selected = null
      this.loadFiles().then(() => {
        if (existing) {
          this.selected =
            this.fileList.find(item => fileKey(item) === existing.mapId) ||
            normalizeFileItem({
              room_key: existing.mapId,
              title: existing.mapId
            })
        }
      })
    },
    async loadFiles() {
      this.filesLoading = true
      try {
        const data = await listFiles({
          q: this.fileQuery,
          limit: 20,
          offset: 0
        })
        const current = String(this.currentRoom || '').trim()
        this.fileList = (data.list || data.items || data.files || [])
          .map(normalizeFileItem)
          .filter(item => item.room_key && item.room_key !== current)
      } catch (err) {
        this.fileList = []
      } finally {
        this.filesLoading = false
      }
    },
    selectMap(item) {
      this.selected = normalizeFileItem(item)
      this.selectedNode = null
      this.nodeHits = []
      this.nodeQuery = ''
    },
    confirmMap(item) {
      this.selectMap(item)
      this.$nextTick(() => this.confirm())
    },
    pickNodeAndConfirm(hit) {
      this.selectedNode = hit
      this.$nextTick(() => this.confirm())
    },
    scheduleNodeSearch() {
      if (this.nodeTimer) clearTimeout(this.nodeTimer)
      this.nodeTimer = setTimeout(this.searchNodes, 250)
    },
    async searchNodes() {
      if (!this.selected || !this.nodeQuery) {
        this.nodeHits = []
        return
      }
      try {
        const data = await searchFile(fileKey(this.selected), this.nodeQuery, 20)
        this.nodeHits = (data.matches || []).map(hit => ({
          ...hit,
          text: stripHtml(hit.text) || hit.uid
        }))
      } catch (err) {
        this.nodeHits = []
      }
    },
    confirm() {
      if (!this.selected || !fileKey(this.selected)) {
        this.$message.warning(this.$t('mapRef.needSelect'))
        return
      }
      const mapId = fileKey(this.selected)
      if (mapId === String(this.currentRoom || '').trim()) {
        this.$message.warning(this.$t('mapRef.currentMap'))
        return
      }
      const mapRef = {
        mapId,
        type: 'map'
      }
      if (
        this.bindMode === 'node' &&
        this.selectedNode &&
        this.selectedNode.uid
      ) {
        mapRef.nodeId = this.selectedNode.uid
        mapRef.type = 'node'
      }
      if (!this.targetNode && !this.targetUid && !this.activeNodes.length) {
        this.$message.warning(this.$t('mapRef.needNode'))
        return
      }
      const title = subMapDisplayTitle(
        this.selected,
        this.bindMode === 'node' ? this.selectedNode : null
      )
      const result = { ok: false, error: '' }
      this.$bus.$emit('applySubMapToNode', {
        node: this.targetNode,
        uid: this.targetUid,
        mapRef,
        title,
        result
      })
      if (!result.ok) {
        this.$message.error(
          this.$t('mapRef.applyFailed') +
            (result.error ? `（${result.error}）` : '')
        )
        return
      }
      this.$message.success(this.$t('mapRef.savedTip'))
      this.dialogVisible = false
    }
  }
}
</script>

<style lang="less">
/* append-to-body：用非 scoped，保证选中态在暗色下可见 */
.mapRefDialogWrap {
  .fileList,
  .nodeList {
    margin-top: 10px;
    max-height: 260px;
    overflow: auto;
    border: 1px solid #dcdfe6;
    border-radius: 8px;
    background: #fff;
  }

  .fileItem {
    padding: 10px 12px;
    cursor: pointer;
    border-bottom: 1px solid #eef0f3;
    border-left: 3px solid transparent;
    user-select: none;
    transition: background 0.12s ease, border-color 0.12s ease;

    &:last-child {
      border-bottom: none;
    }

    &:hover {
      background: #f5f7fa;
    }

    &.active {
      background: #ecf5ff;
      border-left-color: #409eff;
    }

    .fileItemMain {
      display: flex;
      align-items: flex-start;
      gap: 8px;
    }

    .checkMark {
      color: #409eff;
      font-weight: 700;
      margin-top: 2px;
      flex: 0 0 auto;
    }

    .title {
      font-size: 14px;
      line-height: 1.4;
      color: #303133;
      font-weight: 500;
    }

    .meta {
      margin-top: 2px;
      font-size: 12px;
      color: #909399;
    }
  }

  .empty {
    padding: 24px;
    text-align: center;
    color: #909399;
    font-size: 13px;
  }

  .selectedHint {
    margin: 10px 0 0;
    font-size: 13px;
    color: #409eff;

    .dblTip {
      margin-left: 8px;
      color: #909399;
      font-size: 12px;
    }
  }

  .nodeBind {
    margin-top: 12px;
  }

  .nodeSearch {
    margin-top: 8px;
  }
}

/* 暗色：挂在 dialog wrap + 列表上 */
.mapRefDialogWrap.isDarkMapRef {
  .fileList,
  .nodeList,
  .fileList.isDark,
  .nodeList.isDark {
    background: #1d1e1f;
    border-color: #4c4d4f;

    .fileItem {
      border-bottom-color: #3a3b3c;

      &:hover {
        background: #2a2b2c;
      }

      &.active {
        background: #1a3a5c;
        border-left-color: #66b1ff;
      }

      .title {
        color: #e5eaf3;
      }

      .meta {
        color: #a3a6ad;
      }

      .checkMark {
        color: #66b1ff;
      }
    }

    .empty {
      color: #a3a6ad;
    }
  }

  .selectedHint {
    color: #66b1ff;

    .dblTip {
      color: #a3a6ad;
    }
  }
}
</style>
