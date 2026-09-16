<template>
  <div
    class="container"
    :class="{ isDark: isDark, activeSidebar: activeSidebar }"
  >
    <AccessDeniedPanel
      v-if="accessDenied"
      :room-key="roomKey"
      @back="$router.push('/files')"
    />
    <template v-else-if="show">
      <Toolbar
        v-if="!isZenMode"
        :return-folder-id="returnFolderId"
        :can-run-sop="!!selectedSopTarget"
        :run-sop-title="selectedSopTarget ? selectedSopTarget.displayTitle : ''"
        @run-sop="runSelectedSop"
      ></Toolbar>
      <Edit></Edit>
    </template>
  </div>
</template>

<script>
import Toolbar from './components/Toolbar.vue'
import Edit from './components/Edit.vue'
import AccessDeniedPanel from './components/AccessDeniedPanel.vue'
import { productRequest } from '@/services/productHttp'
import { mapState, mapMutations } from 'vuex'
import { getLocalConfig } from '@/api'
import { matchDRegistryTitle } from '@/utils/sopRegistryPrompt'
import { getCurrentUser } from '@/utils/auth'
import { getTextFromHtml } from 'simple-mind-map/src/utils'
import {
  getSharedSopRunQueue,
  resolveSopRunConcurrency
} from '@/utils/sopRunQueue'
import {
  extractSubmitMaterialFieldsFromTree,
  isSubmitMaterialZone
} from '@/utils/sopSubmitMaterial'

export default {
  name: 'EditPage',
  components: {
    AccessDeniedPanel,
    Toolbar,
    Edit
  },
  data() {
    return {
      show: false,
      accessDenied: false,
      returnFolderId: '',
      selectedSopTarget: null,
      sopRunQueue: null,
      sopRunSubmitting: false
    }
  },
  computed: {
    roomKey() {
      return String((this.$route.query && this.$route.query.room) || '')
    },
    currentActor() {
      const user = getCurrentUser() || {}
      return user.name || '用户'
    },
    ...mapState({
      isZenMode: state => state.localConfig.isZenMode,
      isDark: state => state.localConfig.isDark,
      activeSidebar: state => state.activeSidebar
    })
  },
  watch: {
    isDark() {
      this.setBodyDark()
    }
  },
  async created() {
    this.$bus.$on('node_active', this.onNodeActive)
    this.sopRunQueue = getSharedSopRunQueue({
      getConcurrency: () => resolveSopRunConcurrency()
    })
    // activeSidebar 是全局运行态。离开编辑器再返回时必须从关闭状态开始，
    // 否则触发条会预留侧栏宽度，而新创建的侧栏组件仍处于关闭状态。
    this.setActiveSidebar('')
    this.initLocalConfig()
    const loading = this.$loading({
      lock: true,
      text: this.$t('other.loading')
    })
    try {
      const data = await productRequest(
        `/api/files/${encodeURIComponent(this.roomKey)}/info`
      )
      const file = (data && (data.file || data.room)) || data || {}
      const folderId = file.folderId || file.folder_id
      this.returnFolderId = folderId ? String(folderId) : ''
    } catch (error) {
      if (error && (error.statusCode === 403 || error.code === 'FORBIDDEN')) {
        this.accessDenied = true
      }
    }
    this.show = !this.accessDenied
    loading.close()
    this.setBodyDark()
  },
  beforeDestroy() {
    this.$bus.$off('node_active', this.onNodeActive)
    // 深色主题只属于脑图编辑器，离开编辑页后不能污染产品外壳。
    document.body.classList.remove('isDark')
    this.setActiveSidebar('')
  },
  methods: {
    ...mapMutations(['setLocalConfig', 'setActiveSidebar']),

    // 初始化本地配置
    initLocalConfig() {
      let config = getLocalConfig()
      if (config) {
        this.setLocalConfig({
          ...this.$store.state.localConfig,
          ...config
        })
      }
    },

    setBodyDark() {
      this.isDark
        ? document.body.classList.add('isDark')
        : document.body.classList.remove('isDark')
    },

    nodeTitle(node) {
      return node && typeof node.getData === 'function'
        ? getTextFromHtml(node.getData('text') || '').trim()
        : ''
    },

    serializeLiveSubtree(node, limit = { count: 0, max: 800 }) {
      if (!node || limit.count >= limit.max) return null
      limit.count += 1
      const data = typeof node.getData === 'function' ? node.getData() || {} : {}
      const children = (node.children || [])
        .map(child => this.serializeLiveSubtree(child, limit))
        .filter(Boolean)
      return {
        data: {
          uid: data.uid || node.uid || '',
          text: getTextFromHtml(data.text || ''),
          ...(data.note ? { note: data.note } : {})
        },
        children
      }
    },

    runtimeTreeOutline(node, depth = 0, lines = [], limit = { count: 0 }) {
      if (!node || limit.count >= 800) return lines
      limit.count += 1
      const data = node.data || node
      const title = getTextFromHtml((data && data.text) || '').trim() || '(空)'
      lines.push(`${'  '.repeat(depth)}- ${title}`)
      ;(node.children || []).forEach(child =>
        this.runtimeTreeOutline(child, depth + 1, lines, limit)
      )
      return lines
    },

    collectRuntimeMaterial(target, runtimeTree) {
      const shouldCheck =
        target.id === 'D' || isSubmitMaterialZone(target.displayTitle)
      if (!shouldCheck || !runtimeTree) return null
      const parsed = extractSubmitMaterialFieldsFromTree(runtimeTree, {
        sopTitle: target.displayTitle
      })
      const providedFields = (parsed.fields || [])
        .filter(field => String(field.value || '').trim())
        .map(field => ({
          label: field.label,
          value: String(field.value || '').trim()
        }))
      const missingFields = (parsed.fields || [])
        .filter(field => !String(field.value || '').trim())
        .map(field => field.label)
      return {
        source: 'runtime_tree',
        providedFields,
        missingFields
      }
    },

    formatRuntimeMaterialNote(material) {
      if (!material) return ''
      const provided = material.providedFields.length
        ? material.providedFields.map(
            field => `${field.label}：${field.value}`
          )
        : ['（无）']
      const missing = material.missingFields.length
        ? material.missingFields.map(label => `- ${label}`)
        : ['（无）']
      return [
        '## 当前脑图已填写资料',
        ...provided,
        '',
        '## 当前脑图未填写字段',
        ...missing,
        '',
        '## 本次数据来源约束',
        '以上当前脑图快照是本次业务字段的唯一事实来源。禁止从 Git、历史 HTML、旧产物、旧运行记录、memory 或台账备注补齐未填写字段。'
      ].join('\n')
    },

    onNodeActive(node, activeNodeList) {
      if (Array.isArray(activeNodeList) && activeNodeList.length !== 1) {
        this.selectedSopTarget = null
        return
      }
      const selected =
        Array.isArray(activeNodeList) && activeNodeList.length === 1
          ? activeNodeList[0]
          : node
      if (!selected || typeof selected.getData !== 'function') {
        this.selectedSopTarget = null
        return
      }
      const uid = String(selected.getData('uid') || '').trim()
      const title = this.nodeTitle(selected)
      const dMatch = matchDRegistryTitle(title)
      if (!uid || !dMatch) {
        this.selectedSopTarget = null
        return
      }
      this.selectedSopTarget = {
        node: selected,
        uid,
        id: 'D',
        title: dMatch.title,
        displayTitle: title,
        parentDTitle: ''
      }
    },

    async runSelectedSop() {
      if (this.sopRunSubmitting) return
      const target = this.selectedSopTarget
      if (!target || !target.node) {
        this.$message.warning('请先选择 D：标题 节点')
        return
      }
      const runtimeTree = this.serializeLiveSubtree(target.node)
      const runtimeMaterial = this.collectRuntimeMaterial(target, runtimeTree)
      if (runtimeMaterial && runtimeMaterial.missingFields.length) {
        this.$message.warning(
          `当前未填写：${runtimeMaterial.missingFields
            .slice(0, 6)
            .join('、')}${
            runtimeMaterial.missingFields.length > 6 ? '等' : ''
          }；任务仍将继续`
        )
      }
      const sop = {
        id: target.id,
        uid: target.uid,
        rowKey: target.uid,
        title: target.title,
        parentDTitle: target.parentDTitle,
        runtimeTree,
        runtimeMaterial,
        source: { type: 'room', ref: this.roomKey }
      }
      this.sopRunSubmitting = true
      try {
        const enqueued = await this.sopRunQueue.enqueue({
          roomKey: this.roomKey,
          sop,
          outputIds: [],
          extraNote: this.formatRuntimeMaterialNote(runtimeMaterial),
          model: 'openclaw/default',
          backend: 'openclaw',
          actor: this.currentActor,
          onSuccess: (result, job) => {
            if (result && result.ok) {
              this.$message.success(`「${job.sopTitle}」执行完成`)
            } else {
              const reason =
                (result && result.runResult) || '未确认实际执行结果'
              this.$message.warning(`「${job.sopTitle}」：${reason}`)
            }
          },
          onError: (error, message) => {
            if (!(error && error.name === 'AbortError')) {
              this.$message.error(`「${sop.title}」：${message}`)
            }
          },
          onWaiting: (result, job) => {
            this.$message.warning(
              `「${job.sopTitle}」正在等待人工处理，请在任务中心查看`
            )
          }
        })
        if (!enqueued.ok) {
          this.$message.warning(enqueued.message || '入队失败')
          return
        }
        this.$message.success(`已加入队列：${sop.title}`)
      } finally {
        this.sopRunSubmitting = false
      }
    }
  }
}
</script>

<style lang="less">
.container {
  position: relative;
  width: 100%;
  height: 100%;
}

body {
  &.isDark {
    /* el-button */
    .el-button {
      background-color: #363b3f;
      color: hsla(0, 0%, 100%, 0.9);
      border-color: hsla(0, 0%, 100%, 0.1);
    }

    /* el-input */
    .el-input__inner {
      background-color: #363b3f;
      border-color: hsla(0, 0%, 100%, 0.1);
      color: hsla(0, 0%, 100%, 0.9);
    }

    .el-input.is-disabled .el-input__inner {
      background-color: #363b3f;
      border-color: hsla(0, 0%, 100%, 0.1);
      color: hsla(0, 0%, 100%, 0.3);
    }

    .el-input-group__append,
    .el-input-group__prepend {
      background-color: #363b3f;
      border-color: hsla(0, 0%, 100%, 0.1);
    }

    .el-input-group__append button.el-button {
      color: hsla(0, 0%, 100%, 0.9);
    }

    /* el-select */
    .el-select-dropdown {
      background-color: #36393d;
      border-color: hsla(0, 0%, 100%, 0.1);

      .el-select-dropdown__item {
        color: hsla(0, 0%, 100%, 0.6);
      }

      .el-select-dropdown__item.selected {
        color: #409eff;
      }

      .el-select-dropdown__item.hover,
      .el-select-dropdown__item:hover {
        background-color: hsla(0, 0%, 100%, 0.05);
      }
    }

    .el-select .el-input.is-disabled .el-input__inner:hover {
      border-color: hsla(0, 0%, 100%, 0.1);
    }

    /* el-popper*/
    .el-popper {
      background-color: #36393d;
      border-color: hsla(0, 0%, 100%, 0.1);
    }

    .el-popper[x-placement^='bottom'] .popper__arrow {
      background-color: #36393d;
    }

    .el-popper[x-placement^='bottom'] .popper__arrow::after {
      border-bottom-color: #36393d;
    }

    .el-popper[x-placement^='top'] .popper__arrow {
      background-color: #36393d;
    }

    .el-popper[x-placement^='top'] .popper__arrow::after {
      border-top-color: #36393d;
    }

    /* el-tabs */
    .el-tabs__item {
      color: hsla(0, 0%, 100%, 0.6);

      &:hover,
      &.is-active {
        color: #409eff;
      }
    }

    .el-tabs__nav-wrap::after {
      background-color: hsla(0, 0%, 100%, 0.6);
    }

    /* el-slider */
    .el-slider__runway {
      background-color: hsla(0, 0%, 100%, 0.6);
    }

    /* el-radio-group */
    .el-radio-group {
      .el-radio-button__inner {
        background-color: #36393d;
        color: hsla(0, 0%, 100%, 0.6);
      }

      .el-radio-button__orig-radio:checked + .el-radio-button__inner {
        color: #fff;
        background-color: #409eff;
      }
    }

    /* el-dialog */
    .el-dialog {
      background-color: #262a2e;

      .el-dialog__header {
        border-bottom: 1px solid hsla(0, 0%, 100%, 0.1);
      }

      .el-dialog__title {
        color: hsla(0, 0%, 100%, 0.9);
      }

      .el-dialog__body {
        background-color: #262a2e;
      }

      .el-dialog__footer {
        border-top: 1px solid hsla(0, 0%, 100%, 0.1);
      }
    }

    /* el-upload */
    .el-upload__tip {
      color: #999;
    }

    /* 富文本编辑器 */
    .toastui-editor-main-container {
      background-color: #fff;
    }
  }
}
</style>
