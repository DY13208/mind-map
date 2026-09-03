<template>
  <el-dialog
    class="mapRefDialog"
    data-testid="mapref-dialog"
    :class="{ isDark: isDark }"
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
    <div class="fileList">
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
        :class="{ active: selected && selected.room_key === item.room_key }"
        @click="selectMap(item)"
      >
        <div class="title">{{ item.title }}</div>
        <div class="meta">{{ item.room_key }}</div>
      </div>
    </div>
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
      <div v-if="bindMode === 'node'" class="nodeList">
        <div
          class="fileItem"
          :class="{ active: !selectedNode }"
          @click="selectedNode = null"
        >
          <div class="title">{{ $t('mapRef.wholeMap') }}</div>
        </div>
        <div
          v-for="hit in nodeHits"
          :key="hit.uid"
          class="fileItem"
          :class="{ active: selectedNode && selectedNode.uid === hit.uid }"
          @click="selectedNode = hit"
        >
          <div class="title">{{ hit.text || hit.uid }}</div>
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
      activeNodes: []
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
    handleNodeActive(_el, nodes) {
      this.activeNodes = nodes || []
    },
    open(node) {
      if (node) this.activeNodes = [node]
      this.dialogVisible = true
    },
    onOpen() {
      const first = this.activeNodes[0]
      const existing = first && normalizeMapRef(first.getData && first.getData('mapRef'))
      this.bindMode = existing && existing.nodeId ? 'node' : 'map'
      this.selectedNode = existing && existing.nodeId ? { uid: existing.nodeId } : null
      this.fileQuery = ''
      this.nodeQuery = ''
      this.nodeHits = []
      this.loadFiles().then(() => {
        if (existing) {
          this.selected =
            this.fileList.find(item => item.room_key === existing.mapId) || {
              room_key: existing.mapId,
              title: existing.mapId
            }
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
        this.fileList = (data.list || data.items || data.files || []).filter(
          item => item.room_key !== this.currentRoom
        )
      } catch (err) {
        this.fileList = []
      } finally {
        this.filesLoading = false
      }
    },
    selectMap(item) {
      this.selected = item
      this.selectedNode = null
      this.nodeHits = []
      this.nodeQuery = ''
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
        const data = await searchFile(this.selected.room_key, this.nodeQuery, 20)
        this.nodeHits = data.matches || []
      } catch (err) {
        this.nodeHits = []
      }
    },
    confirm() {
      if (!this.selected) return
      if (this.selected.room_key === this.currentRoom) {
        this.$message.warning(this.$t('mapRef.currentMap'))
        return
      }
      const mapRef = {
        mapId: this.selected.room_key,
        type: 'map'
      }
      if (this.bindMode === 'node' && this.selectedNode && this.selectedNode.uid) {
        mapRef.nodeId = this.selectedNode.uid
        mapRef.type = 'node'
      }
      const nodes = this.activeNodes.filter(Boolean)
      if (!nodes.length) {
        this.dialogVisible = false
        return
      }
      nodes.forEach(node => {
        this.$bus.$emit('execCommand', 'SET_NODE_MAP_REF', node, mapRef)
      })
      this.$message.success(this.$t('mapRef.saved'))
      this.dialogVisible = false
    }
  }
}
</script>

<style lang="less" scoped>
.mapRefDialog {
  .fileList,
  .nodeList {
    margin-top: 10px;
    max-height: 240px;
    overflow: auto;
    border: 1px solid #e6e8eb;
    border-radius: 8px;
  }
  .fileItem {
    padding: 8px 12px;
    cursor: pointer;
    border-bottom: 1px solid #f0f2f5;
    &:last-child {
      border-bottom: none;
    }
    &.active {
      background: #ecf5ff;
    }
    .title {
      font-size: 13px;
      color: #1f2328;
    }
    .meta {
      font-size: 12px;
      color: #9aa0a6;
    }
  }
  .empty {
    padding: 24px;
    text-align: center;
    color: #9aa0a6;
    font-size: 13px;
  }
  .nodeBind {
    margin-top: 12px;
  }
  .nodeSearch {
    margin-top: 8px;
  }
}
.isDark {
  .fileItem .title {
    color: #e5e7eb;
  }
  .fileItem.active {
    background: #1f3b5b;
  }
}
</style>
