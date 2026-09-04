<template
  ><el-drawer
    :visible.sync="shown"
    :title="`历史版本 · ${room ? room.title : ''}`"
    size="430px"
    ><div class="historyBody" v-loading="loading">
      <div v-if="error">
        <el-alert :title="error" type="error" :closable="false" /><el-button
          @click="load"
          >重试</el-button
        >
      </div>
      <div v-if="canCreate" class="createRow">
        <el-button size="small" type="primary" plain @click="createManual"
          >创建手动版本</el-button
        >
      </div>
      <div v-for="item in versions" :key="item.versionId" class="versionItem">
        <div class="versionHead">
          <strong>{{ item.name || item.versionId }}</strong
          ><el-tag
            size="mini"
            :type="item.type === 'AUTO' ? 'info' : 'success'"
            >{{ item.type === 'AUTO' ? '自动' : '手动' }}</el-tag
          >
        </div>
        <p v-if="item.description">{{ item.description }}</p>
        <p v-if="item.summary">{{ item.summary }}</p>
        <span
          >{{ item.createdBy }} · {{ format(item.createdAt) }} · revision
          {{ item.revision }}</span
        >
        <div class="versionActions">
          <el-button size="mini" @click="view(item)">查看</el-button
          ><el-button
            v-if="canRestore"
            size="mini"
            type="primary"
            plain
            @click="restore(item)"
            >恢复</el-button
          >
        </div>
      </div>
      <EmptyState
        v-if="!loading && !error && !versions.length"
        title="暂无历史版本"
        description="编辑脑图或创建手动版本后会显示在这里"
      />
    </div>
    <VersionDetailDialog
      :visible.sync="detailVisible"
      :version="selected"/></el-drawer
></template>
<script>
import { userMessageFromError } from '@/services/apiError'
import historyService from '@/services/historyService'
import EmptyState from './EmptyState.vue'
import VersionDetailDialog from './VersionDetailDialog.vue'
export default {
  name: 'HistoryPanel',
  components: { EmptyState, VersionDetailDialog },
  props: { visible: Boolean, room: Object },
  data: () => ({
    loading: false,
    error: '',
    versions: [],
    currentRevision: 0,
    selected: null,
    detailVisible: false
  }),
  computed: {
    shown: {
      get() {
        return this.visible
      },
      set(value) {
        this.$emit('update:visible', value)
      }
    },
    roomKey() {
      return (this.room && (this.room.roomKey || this.room.id)) || ''
    },
    canCreate() {
      return !!(this.room && this.room.canEdit)
    },
    canRestore() {
      return !!(this.room && this.room.canManage)
    }
  },
  watch: {
    visible(value) {
      if (value) this.load()
    }
  },
  methods: {
    async load() {
      this.loading = true
      this.error = ''
      this.versions = []
      try {
        const result = await historyService.listVersions(this.roomKey)
        this.versions = result.list || result
        this.currentRevision = Number(
          result.currentRevision || (this.room && this.room.revision) || 0
        )
      } catch (error) {
        this.error = userMessageFromError(error)
      } finally {
        this.loading = false
      }
    },
    format(value) {
      return new Date(value).toLocaleString('zh-CN')
    },
    async createManual() {
      const result = await this.$prompt('请输入版本名称', '创建手动版本', {
        inputValue: '手动版本',
        inputValidator: value =>
          (!!value && !!value.trim()) || '请输入版本名称'
      }).catch(() => null)
      if (!result) return
      try {
        await historyService.createVersion(this.roomKey, {
          name: result.value.trim(),
          description: ''
        })
        this.$message.success('已创建手动版本')
        await this.load()
      } catch (error) {
        this.$message.error(userMessageFromError(error))
      }
    },
    async view(item) {
      try {
        this.selected = await historyService.getVersion(
          this.roomKey,
          item.versionId
        )
        this.detailVisible = true
      } catch (error) {
        this.$message.error(userMessageFromError(error))
      }
    },
    restore(item) {
      this.$confirm(
        `确认恢复到 ${item.name || item.versionId}（revision ${
          item.revision
        }）？当前编辑器内容将由协同服务替换，请勿在本地直接覆盖。`,
        '恢复版本'
      )
        .then(async () => {
          await historyService.restoreVersion(
            this.roomKey,
            item.versionId,
            this.currentRevision || (this.room && this.room.revision)
          )
          this.$message.success('已提交恢复，协同将更新当前脑图')
          this.shown = false
          this.$emit('restored')
          await this.load()
        })
        .catch(error => {
          if (error instanceof Error)
            this.$message.error(userMessageFromError(error))
        })
    }
  }
}
</script>
<style lang="less" scoped>
.historyBody {
  padding: 0 22px 30px;
}
.createRow {
  padding: 8px 0 4px;
}
.versionItem {
  border-bottom: 1px solid #e9eeeb;
  padding: 17px 0;
  p,
  span {
    display: block;
    color: #73847d;
    font-size: 12px;
    margin: 6px 0 0;
  }
  .versionHead {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .versionActions {
    margin-top: 10px;
  }
}
</style>
