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
      <div v-for="item in versions" :key="item.id" class="versionItem">
        <div class="versionHead">
          <strong>{{ item.version }}</strong
          ><el-tag
            size="mini"
            :type="item.type === 'auto' ? 'info' : 'success'"
            >{{ item.type === 'auto' ? '自动' : '手动' }}</el-tag
          >
        </div>
        <p>{{ item.note }}</p>
        <span
          >{{ item.operator }} · {{ format(item.createdAt) }} · revision
          {{ item.revision }}</span
        >
        <div class="versionActions">
          <el-button size="mini" @click="view(item)">查看</el-button
          ><el-button size="mini" type="primary" plain @click="restore(item)"
            >恢复</el-button
          >
        </div>
      </div>
      <EmptyState
        v-if="!loading && !error && !versions.length"
        title="暂无历史版本"
        description="版本记录将在真实 API 接入后显示"
      />
    </div>
    <VersionDetailDialog
      :visible.sync="detailVisible"
      :version="selected"/></el-drawer
></template>
<script>
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
        this.versions = await historyService.listVersions(this.room.id)
      } catch (error) {
        this.error = error.message || '版本加载失败'
      } finally {
        this.loading = false
      }
    },
    format(value) {
      return new Date(value).toLocaleString('zh-CN')
    },
    async view(item) {
      try {
        this.selected = await historyService.getVersion(this.room.id, item.id)
        this.detailVisible = true
      } catch (error) {
        this.$message.error(error.message)
      }
    },
    restore(item) {
      this.$confirm(
        `确认恢复到 ${item.version}？当前为 Mock，不会修改真实脑图。`,
        '恢复版本'
      )
        .then(async () => {
          await historyService.restoreVersion(this.room.id, item.id)
          this.$message.success('已完成恢复演示（Mock）')
        })
        .catch(error => {
          if (error instanceof Error) this.$message.error(error.message)
        })
    }
  }
}
</script>
<style lang="less" scoped>
.historyBody {
  padding: 0 22px 30px;
}
.versionItem {
  border-bottom: 1px solid #e9eeeb;
  padding: 17px 0;
  .versionHead {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  p {
    margin: 8px 0 5px;
    color: #42584f;
  }
  span {
    font-size: 12px;
    color: #8c9893;
  }
  .versionActions {
    margin-top: 12px;
  }
}
</style>
