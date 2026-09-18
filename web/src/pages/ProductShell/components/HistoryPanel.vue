<template>
  <el-dialog
    class="historyDialog"
    :custom-class="'historyDialog' + (isNarrow ? ' isNarrow' : '')"
    :visible.sync="shown"
    :title="'历史版本「' + (room ? room.title : '') + '」'"
    width="86%"
    top="5vh"
    append-to-body
    data-testid="history-panel"
    :close-on-click-modal="false"
    @opened="onOpened"
    @closed="onClosed"
  >
    <div class="historyShell" v-loading="loading">
      <div v-if="error" class="historyError">
        <el-alert :title="error" type="error" :closable="false" />
        <el-button size="small" @click="reload">重试</el-button>
      </div>
      <div v-else class="historyLayout" :class="{ previewMode: isNarrow && pane === 'preview' }">
        <section
          v-show="!isNarrow || pane === 'preview'"
          class="previewPane"
        >
          <div v-if="isNarrow" class="narrowSwitch">
            <el-button size="mini" @click="pane = 'list'">返回列表</el-button>
          </div>
          <HistoryMapPreview
            ref="mapPreview"
            :tree="preview.tree"
            :metadata="preview.metadata"
            :loading="preview.loading"
            :error="preview.error"
          />
        </section>
        <aside v-show="!isNarrow || pane === 'list'" class="timelinePane">
          <div class="timelineTools">
            <el-button
              v-if="canCreate"
              size="small"
              type="primary"
              plain
              :loading="creating"
              @click="createManual"
              >创建手动版本</el-button
            >
            <el-radio-group v-model="typeFilter" size="mini" @change="reload">
              <el-radio-button label="">全部</el-radio-button>
              <el-radio-button label="MANUAL">手动标记</el-radio-button>
            </el-radio-group>
            <div class="dateFilters">
              <el-date-picker
                v-model="dateFrom"
                type="date"
                size="mini"
                placeholder="开始日期"
                value-format="yyyy-MM-dd"
                :picker-options="fromPickerOptions"
                popper-class="historyDatePopper"
                @change="reload"
              />
              <span class="dateSep">至</span>
              <el-date-picker
                v-model="dateTo"
                type="date"
                size="mini"
                placeholder="结束日期"
                value-format="yyyy-MM-dd"
                :picker-options="toPickerOptions"
                popper-class="historyDatePopper"
                @change="reload"
              />
            </div>
          </div>
          <div v-if="!groups.length" class="emptyWrap">
            <EmptyState
              title="暂无历史版本"
              description="编辑脑图或创建手动版本后会显示在这里"
            />
          </div>
          <div v-else class="timeline" role="list">
            <section v-for="group in groups" :key="group.date" class="dayGroup">
              <h4>{{ group.date }}</h4>
              <article
                v-for="item in group.items"
                :key="item.versionId"
                class="versionItem"
                :class="{ selected: selected && selected.versionId === item.versionId }"
                role="listitem"
                @click="select(item)"
              >
                <div class="versionHead">
                  <strong>{{ displayName(item) }}</strong>
                  <el-tag size="mini" :type="typeTag(item.type)">{{
                    typeLabel(item.type)
                  }}</el-tag>
                </div>
                <p class="versionMeta">
                  {{ formatTime(item.createdAt) }} ·
                  {{ editorText(item) }}
                </p>
                <p class="versionSummary">{{ summaryText(item) }}</p>
                <div class="versionActions">
                  <el-button
                    v-if="canRestoreItem(item)"
                    size="mini"
                    type="primary"
                    plain
                    :loading="restoring"
                    :disabled="restoring"
                    @click.stop="restore(item)"
                    >恢复此版本</el-button
                  >
                </div>
              </article>
            </section>
            <div class="loadMore" v-if="nextCursor">
              <el-button size="small" :loading="loadingMore" @click="loadMore"
                >加载更多</el-button
              >
            </div>
          </div>
        </aside>
      </div>
    </div>
    <span slot="footer">
      <el-button
        v-if="lastPreRestoreId"
        type="text"
        @click="openPreRestore"
        >查看恢复前版本</el-button
      >
      <el-button @click="shown = false">关闭</el-button>
    </span>
  </el-dialog>
</template>
<script>
import { userMessageFromError } from '@/services/apiError'
import historyService from '@/services/historyService'
import {
  versionTypeLabel,
  versionTypeTag,
  historyDisplayName
} from '@/utils/historyTree'
import EmptyState from './EmptyState.vue'
import HistoryMapPreview from './HistoryMapPreview.vue'

function endOfDay(isoDate) {
  return isoDate ? isoDate + 'T23:59:59.999Z' : ''
}

export default {
  name: 'HistoryPanel',
  components: { EmptyState, HistoryMapPreview },
  props: {
    visible: Boolean,
    room: Object,
    waitForCommit: Boolean
  },
  data: () => ({
    loading: false,
    loadingMore: false,
    creating: false,
    restoring: false,
    error: '',
    versions: [],
    nextCursor: null,
    currentRevision: 0,
    selected: null,
    typeFilter: '',
    dateFrom: '',
    dateTo: '',
    pane: 'list',
    narrow: false,
    preview: { tree: null, metadata: {}, loading: false, error: '' },
    previewToken: 0,
    lastPreRestoreId: '',
    loadController: null
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
      const cap =
        (this.versions[0] && this.versions[0].capabilities) ||
        (this.room && this.room.capabilities) ||
        {}
      if (cap.canCreate != null) return !!cap.canCreate
      return !!(this.room && this.room.canEdit)
    },
    canRestore() {
      return !!(this.room && this.room.canManage)
    },
    isNarrow() {
      return this.narrow
    },
    groups() {
      const map = new Map()
      this.versions.forEach(item => {
        const date = this.formatDate(item.createdAt)
        if (!map.has(date)) map.set(date, [])
        map.get(date).push(item)
      })
      return Array.from(map.keys()).map(date => ({
        date,
        items: map.get(date)
      }))
    },
    fromPickerOptions() {
      return {
        disabledDate: date => {
          if (!this.dateTo) return false
          return date.getTime() > new Date(this.dateTo + 'T23:59:59').getTime()
        }
      }
    },
    toPickerOptions() {
      return {
        disabledDate: date => {
          if (!this.dateFrom) return false
          return date.getTime() < new Date(this.dateFrom + 'T00:00:00').getTime()
        }
      }
    }
  },
  watch: {
    visible(value) {
      if (value) {
        this.measure()
        this.reload()
      }
    }
  },
  mounted() {
    this.measure()
    window.addEventListener('resize', this.measure)
  },
  beforeDestroy() {
    window.removeEventListener('resize', this.measure)
    this.abortPreview()
  },
  methods: {
    typeLabel: versionTypeLabel,
    typeTag: versionTypeTag,
    displayName: historyDisplayName,
    measure() {
      this.narrow = window.innerWidth < 900
    },
    formatDate(value) {
      return new Date(value).toLocaleDateString('zh-CN')
    },
    formatTime(value) {
      return new Date(value).toLocaleString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit'
      })
    },
    summaryText(item) {
      if (item.availability === 'unreadable') return '该版本无法可靠重建'
      if (item.summaryStatus === 'pending' && !item.summaryText) return '整理中'
      return item.summaryText || item.summary || '整理中'
    },
    canRestoreItem(item) {
      if (!item || item.availability === 'unreadable') return false
      if (item.capabilities && item.capabilities.canRestore != null) {
        return !!item.capabilities.canRestore
      }
      return this.canRestore
    },
    editorText(item) {
      const editors = item.editors || []
      if (editors.length) {
        return editors
          .map(row => row.name || row.userId)
          .filter(Boolean)
          .join('、')
      }
      return item.createdBy || '未知编辑人'
    },
    query() {
      const q = { limit: 20 }
      if (this.typeFilter) q.type = this.typeFilter
      if (this.dateFrom) q.from = this.dateFrom + 'T00:00:00.000Z'
      if (this.dateTo) q.to = endOfDay(this.dateTo)
      else if (this.dateFrom) q.to = endOfDay(this.dateFrom)
      return q
    },
    async reload() {
      this.loading = true
      this.error = ''
      this.versions = []
      this.nextCursor = null
      this.lastPreRestoreId = this.lastPreRestoreId
      try {
        await this.waitOwnEdits()
        const result = await historyService.listVersions(this.roomKey, this.query())
        this.versions = result.list || []
        this.nextCursor = result.nextCursor || null
        this.currentRevision = Number(
          result.currentRevision || (this.room && this.room.revision) || 0
        )
        const first = this.versions[0]
        if (first) await this.select(first)
        else {
          this.selected = null
          this.preview = { tree: null, metadata: {}, loading: false, error: '' }
        }
      } catch (error) {
        this.error = userMessageFromError(error)
      } finally {
        this.loading = false
      }
    },
    async loadMore() {
      if (!this.nextCursor || this.loadingMore) return
      this.loadingMore = true
      try {
        const result = await historyService.listVersions(this.roomKey, {
          ...this.query(),
          cursor: this.nextCursor
        })
        const extra = result.list || []
        this.versions = this.versions.concat(extra)
        this.nextCursor = result.nextCursor || null
      } catch (error) {
        this.$message.error(userMessageFromError(error))
      } finally {
        this.loadingMore = false
      }
    },
    abortPreview() {
      this.previewToken += 1
      if (this.loadController) {
        this.loadController.abort()
        this.loadController = null
      }
    },
    async select(item) {
      this.selected = item
      if (this.isNarrow) this.pane = 'preview'
      await this.loadPreview(item)
    },
    previewErrorMessage(error) {
      const code = error && error.code
      if (code === 'HISTORY_OPS_GAP' || code === 'HISTORY_REPLAY_FAILED') {
        return '该历史版本不完整，无法预览'
      }
      if (code === 'HISTORY_REVISION_UNAVAILABLE') {
        return '该历史版本的资源已不可用'
      }
      return userMessageFromError(error) || '预览加载失败'
    },
    async loadPreview(item) {
      this.abortPreview()
      const token = this.previewToken
      this.preview = { tree: null, metadata: {}, loading: true, error: '' }
      const controller =
        typeof AbortController !== 'undefined' ? new AbortController() : null
      this.loadController = controller
      try {
        const data = await historyService.getVersionTree(
          this.roomKey,
          item.versionId,
          { signal: controller && controller.signal }
        )
        if (token !== this.previewToken) return
        this.preview = {
          tree: data.tree,
          metadata: data.metadata || {},
          loading: false,
          error: ''
        }
      } catch (error) {
        if (error && error.name === 'AbortError') return
        if (token !== this.previewToken) return
        this.preview = {
          tree: null,
          metadata: {},
          loading: false,
          error: this.previewErrorMessage(error)
        }
      }
    },
    defaultManualName() {
      return new Date().toLocaleString('zh-CN')
    },
    async waitOwnEdits() {
      if (!this.waitForCommit) return
      const start = Date.now()
      while (
        Number(this.$store.state.collabPendingCount || 0) > 0 &&
        Date.now() - start < 20000
      ) {
        await new Promise(resolve => setTimeout(resolve, 250))
      }
    },
    async createManual() {
      const result = await this.$prompt('请输入版本名称', '创建手动版本', {
        inputValue: this.defaultManualName(),
        inputValidator: value => (!!value && !!value.trim()) || '请输入版本名称'
      }).catch(() => null)
      if (!result) return
      this.creating = true
      try {
        await this.waitOwnEdits()
        await historyService.createVersion(this.roomKey, {
          name: result.value.trim(),
          description: ''
        })
        this.$message.success('已创建手动版本')
        await this.reload()
      } catch (error) {
        this.$message.error(userMessageFromError(error))
      } finally {
        this.creating = false
      }
    },
    restore(item) {
      const when = new Date(item.createdAt).toLocaleString('zh-CN')
      this.$confirm(
        `确认恢复到 ${when} 的「${historyDisplayName(item)}」？当前内容会自动备份，正在编辑的协作者会收到更新。`,
        '恢复此版本'
      )
        .then(async () => {
          this.restoring = true
          try {
            const restored = await historyService.restoreVersion(
              this.roomKey,
              item.versionId,
              this.currentRevision || (this.room && this.room.revision)
            )
            this.lastPreRestoreId = restored.preRestoreVersionId || ''
            this.currentRevision = Number(
              restored.newRevision || this.currentRevision + 1
            )
            this.$message.success('已恢复，协作中的脑图会同步更新')
            this.$emit('restored', restored)
            await this.reload()
          } catch (error) {
            if (error && error.code === 'RESTORE_CONFLICT') {
              await this.reload()
              this.$message.warning('当前内容已有新修改，请确认后再次恢复')
              return
            }
            this.$message.error(userMessageFromError(error))
          } finally {
            this.restoring = false
          }
        })
        .catch(() => {})
    },
    async openPreRestore() {
      if (!this.lastPreRestoreId) return
      let hit = this.versions.find(
        item => item.versionId === this.lastPreRestoreId
      )
      if (!hit) {
        try {
          hit = await historyService.getVersion(
            this.roomKey,
            this.lastPreRestoreId
          )
        } catch (error) {
          this.$message.error(userMessageFromError(error))
          return
        }
      }
      if (hit) await this.select(hit)
    },
    onOpened() {
      this.$nextTick(() => {
        requestAnimationFrame(() => {
          const preview = this.$refs.mapPreview
          if (preview && typeof preview.relayout === 'function') {
            preview.relayout()
          }
        })
      })
    },
    onClosed() {
      this.abortPreview()
      this.preview = { tree: null, metadata: {}, loading: false, error: '' }
      this.selected = null
      this.pane = 'list'
    }
  }
}
</script>
<style lang="less" scoped>
.historyShell {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.historyLayout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 300px;
  gap: 14px;
  flex: 1;
  height: 100%;
  min-height: 0;
}
.previewPane,
.timelinePane {
  min-height: 0;
  height: 100%;
  overflow: hidden;
}
.previewPane {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.previewPane /deep/ .historyMapPreview {
  flex: 1;
  min-height: 0;
  height: 100%;
}
.timelinePane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border: 1px solid #e3e9e6;
  border-radius: 10px;
  background: #fff;
  overflow: hidden;
}
.timelineTools {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-bottom: 1px solid #edf1ef;
}
.dateFilters {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.dateSep {
  flex: none;
  color: #80948a;
  font-size: 12px;
}
.dateFilters /deep/ .el-date-editor {
  flex: 1 1 0;
  min-width: 0;
  width: 0 !important;
}
.dateFilters /deep/ .el-date-editor .el-input__inner {
  width: 100%;
}
.timeline {
  overflow: auto;
  flex: 1;
  min-height: 0;
  padding: 0 8px 12px;
}
.dayGroup {
  h4 {
    margin: 12px 8px 6px;
    color: #80948a;
    font-size: 12px;
    font-weight: 600;
  }
}
.versionItem {
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
  &.selected,
  &:hover {
    background: #f3f8f5;
  }
  strong {
    color: #17261f;
  }
}
.versionHead {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: center;
}
.versionMeta,
.versionSummary {
  margin: 6px 0 0;
  color: #73847d;
  font-size: 12px;
  line-height: 1.45;
}
.versionActions {
  margin-top: 8px;
}
.historyError,
.emptyWrap,
.loadMore,
.narrowSwitch {
  padding: 12px;
}
.historyDialog.isNarrow .historyLayout {
  grid-template-columns: 1fr;
}
</style>
<style lang="less">
.el-dialog__wrapper.historyDialog {
  overflow: hidden;
}
.el-dialog.historyDialog {
  display: flex !important;
  flex-direction: column;
  width: ~"min(1120px, calc(100vw - 40px))" !important;
  height: 86vh !important;
  max-height: 86vh !important;
  margin-bottom: 0;
  overflow: hidden;
  box-sizing: border-box;
}
.el-dialog.historyDialog .el-dialog__header,
.el-dialog.historyDialog .el-dialog__footer {
  flex: none;
}
.el-dialog.historyDialog .el-dialog__body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: 12px 16px 8px;
}
.historyDatePopper {
  z-index: 4000 !important;
}
</style>
