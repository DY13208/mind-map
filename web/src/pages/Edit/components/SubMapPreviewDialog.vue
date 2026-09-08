<template>
  <el-dialog
    class="subMapPreviewDialog"
    :class="{ isDark: isDark }"
    :title="dialogTitle"
    :visible.sync="dialogVisible"
    width="90%"
    top="4vh"
    append-to-body
    :close-on-click-modal="false"
    @opened="onOpened"
    @closed="onClosed"
  >
    <div v-if="loading" class="state">{{ $t('mapRef.previewLoading') }}</div>
    <div v-else-if="error" class="state error">{{ error }}</div>
    <div
      v-show="!loading && !error"
      ref="previewContainer"
      class="previewContainer"
      data-testid="submap-preview"
    ></div>
    <span slot="footer">
      <el-button size="small" @click="dialogVisible = false">{{
        $t('mapRef.closePreview')
      }}</el-button>
      <el-button
        type="primary"
        size="small"
        :disabled="!normalizedRef"
        @click="openEdit"
      >
        {{ $t('mapRef.openEdit') }}
      </el-button>
    </span>
  </el-dialog>
</template>

<script>
import { mapState } from 'vuex'
import MindMap from 'simple-mind-map'
import exampleData from 'simple-mind-map/example/exampleData'
import {
  getFileExport,
  getFileSubtree,
  getFileMeta
} from '@/utils/fileApi'
import { inspectMapRef, normalizeMapRef } from '@/utils/mapRefNav'

function stripHtml(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim()
}

function toMindMapTree(tree) {
  if (!tree) return null
  const data = (tree && tree.data) || {}
  const uid = data.uid || tree.uid || ''
  const rawText = stripHtml(data.text || tree.text || '')
  const note = data.note || tree.note || ''
  const children = (tree.children || [])
    .map(child => toMindMapTree(child))
    .filter(Boolean)
  return {
    data: {
      ...data,
      text: rawText || '(空)',
      expand: true,
      ...(uid ? { uid } : {}),
      ...(note ? { note: String(note) } : {})
    },
    children
  }
}

export default {
  name: 'SubMapPreviewDialog',
  data() {
    return {
      dialogVisible: false,
      loading: false,
      error: '',
      mapTitle: '',
      normalizedRef: null,
      pendingRoot: null,
      previewMindMap: null,
      loadToken: 0
    }
  },
  computed: {
    ...mapState({
      isDark: state => state.localConfig.isDark
    }),
    dialogTitle() {
      const base = this.$t('mapRef.previewTitle')
      if (this.mapTitle) return `${base} · ${this.mapTitle}`
      if (this.normalizedRef && this.normalizedRef.mapId) {
        return `${base} · ${this.normalizedRef.mapId}`
      }
      return base
    }
  },
  created() {
    this.$bus.$on('showSubMapPreview', this.open)
  },
  beforeDestroy() {
    this.$bus.$off('showSubMapPreview', this.open)
    this.teardownPreview()
  },
  methods: {
    async open(ref, meta = {}) {
      const normalized = normalizeMapRef(ref)
      if (!normalized) {
        this.$message.warning(this.$t('mapRef.openFailed'))
        return
      }
      this.normalizedRef = normalized
      this.mapTitle = (meta && meta.title) || ''
      this.error = ''
      this.pendingRoot = null
      this.dialogVisible = true
      this.loading = true
      const token = ++this.loadToken
      try {
        const info = await inspectMapRef(normalized)
        if (token !== this.loadToken) return
        if (!info || !info.exists) {
          this.error = this.$t('mapRef.missingMap')
          this.loading = false
          return
        }
        if (!this.mapTitle) {
          try {
            const metaRes = await getFileMeta(normalized.mapId)
            if (token !== this.loadToken) return
            this.mapTitle =
              (metaRes && (metaRes.title || metaRes.name)) || ''
          } catch (e) {
            /* ignore title fetch */
          }
        }
        let root = null
        if (normalized.nodeId && info.nodeExists !== false) {
          try {
            const data = await getFileSubtree(normalized.mapId, normalized.nodeId, {
              deep: true,
              maxNodes: 2000
            })
            if (token !== this.loadToken) return
            root = toMindMapTree((data && data.tree) || data)
          } catch (e) {
            console.warn('[subMapPreview] subtree failed, fallback export', e)
          }
        }
        if (!root) {
          const data = await getFileExport(normalized.mapId)
          if (token !== this.loadToken) return
          root = toMindMapTree((data && data.tree) || data)
        }
        if (!root) {
          this.error = this.$t('mapRef.previewFailed')
          this.loading = false
          return
        }
        if (normalized.nodeId && info.nodeExists === false) {
          this.$message.warning(this.$t('mapRef.missingNode'))
        }
        this.pendingRoot = root
        this.loading = false
        if (this.dialogVisible) {
          this.$nextTick(() => {
            setTimeout(() => this.mountPreview(), 60)
          })
        }
      } catch (err) {
        if (token !== this.loadToken) return
        console.error('[subMapPreview]', err)
        const msg = String((err && err.message) || '')
        if (
          err &&
          (err.code === 'FORBIDDEN' ||
            err.statusCode === 403 ||
            /403|permission/i.test(msg))
        ) {
          this.error = this.$t('mapRef.noPermission')
        } else if (
          err &&
          (err.statusCode === 404 ||
            err.code === 'NOT_FOUND' ||
            err.code === 'ROOM_DELETED' ||
            /not found|404/i.test(msg))
        ) {
          this.error = this.$t('mapRef.missingMap')
        } else {
          this.error = this.$t('mapRef.previewFailed')
        }
        this.loading = false
      }
    },
    onOpened() {
      if (this.pendingRoot && !this.loading && !this.error) {
        this.$nextTick(() => {
          setTimeout(() => this.mountPreview(), 60)
        })
      }
    },
    onClosed() {
      this.loadToken += 1
      this.teardownPreview()
      this.pendingRoot = null
      this.normalizedRef = null
      this.mapTitle = ''
      this.error = ''
      this.loading = false
    },
    mountPreview() {
      this.teardownPreview()
      const el = this.$refs.previewContainer
      if (!el || !this.pendingRoot) return
      el.innerHTML = ''
      const theme = (exampleData && exampleData.theme) || {}
      try {
        this.previewMindMap = new MindMap({
          el,
          data: this.pendingRoot,
          fit: true,
          readonly: true,
          layout: (exampleData && exampleData.layout) || 'logicalStructure',
          theme: theme.template || 'default',
          themeConfig: theme.config || {},
          mousewheelAction: 'zoom',
          enableFreeDrag: false,
          initRootNodePosition: ['center', 'center']
        })
        this.$nextTick(() => {
          try {
            if (this.previewMindMap && this.previewMindMap.view) {
              this.previewMindMap.view.fit()
            }
          } catch (e) {
            /* ignore */
          }
        })
      } catch (err) {
        console.error('[subMapPreview] mount failed', err)
        this.error = this.$t('mapRef.previewFailed')
      }
    },
    teardownPreview() {
      if (this.previewMindMap) {
        try {
          this.previewMindMap.destroy()
        } catch (e) {
          /* ignore */
        }
        this.previewMindMap = null
      }
      const el = this.$refs.previewContainer
      if (el) el.innerHTML = ''
    },
    openEdit() {
      if (!this.normalizedRef) return
      const ref = this.normalizedRef
      this.dialogVisible = false
      this.$nextTick(() => {
        this.$bus.$emit('openMapRefEdit', ref)
      })
    }
  }
}
</script>

<style lang="less" scoped>
.subMapPreviewDialog {
  /deep/ .el-dialog__body {
    padding: 10px 16px;
  }

  .state {
    min-height: 62vh;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #909399;
    font-size: 14px;

    &.error {
      color: #f56c6c;
    }
  }

  .previewContainer {
    width: 100%;
    height: 70vh;
    min-height: 420px;
    border: 1px solid #ebeef5;
    border-radius: 4px;
    overflow: hidden;
    background: #fff;
  }

  &.isDark {
    .previewContainer {
      border-color: #4c4d4f;
      background: #1d1e1f;
    }

    .state {
      color: #a3a6ad;

      &.error {
        color: #f89898;
      }
    }
  }
}
</style>
