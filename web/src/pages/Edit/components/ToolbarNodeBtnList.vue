<template>
  <div
    class="toolbarNodeBtnList"
    :class="[dir, { isDark: isDark }]"
    @mousedown.prevent
  >
    <template v-for="item in list">
      <div
        v-if="item === 'back'"
        class="toolbarBtn"
        :class="{
          disabled: readonly || backEnd
        }"
        @click="$bus.$emit('execCommand', 'BACK')"
      >
        <span class="icon iconfont iconhoutui-shi"></span>
        <span class="text">{{ $t('toolbar.undo') }}</span>
      </div>
      <div
        v-if="item === 'forward'"
        class="toolbarBtn"
        :class="{
          disabled: readonly || forwardEnd
        }"
        @click="$bus.$emit('execCommand', 'FORWARD')"
      >
        <span class="icon iconfont iconqianjin1"></span>
        <span class="text">{{ $t('toolbar.redo') }}</span>
      </div>
      <div
        v-if="item === 'painter'"
        class="toolbarBtn"
        :class="{
          disabled: activeNodes.length <= 0 || hasGeneralization,
          active: isInPainter
        }"
        @click="$bus.$emit('startPainter')"
      >
        <span class="icon iconfont iconjiedian"></span>
        <span class="text">{{ $t('toolbar.painter') }}</span>
      </div>
      <div
        v-if="item === 'siblingNode'"
        class="toolbarBtn"
        data-testid="add-sibling"
        :class="{
          disabled: activeNodes.length <= 0 || hasRoot || hasGeneralization
        }"
        @click="$bus.$emit('execCommand', 'INSERT_NODE')"
      >
        <span class="icon iconfont iconjiedian"></span>
        <span class="text">{{ $t('toolbar.insertSiblingNode') }}</span>
      </div>
      <div
        v-if="item === 'childNode'"
        class="toolbarBtn"
        data-testid="add-child"
        :class="{
          disabled: activeNodes.length <= 0
        }"
        @click="$bus.$emit('execCommand', 'INSERT_CHILD_NODE')"
      >
        <span class="icon iconfont icontianjiazijiedian"></span>
        <span class="text">{{ $t('toolbar.insertChildNode') }}</span>
      </div>
      <div
        v-if="item === 'deleteNode'"
        class="toolbarBtn"
        data-testid="delete-node"
        :class="{
          disabled: activeNodes.length <= 0
        }"
        @click="$bus.$emit('execCommand', 'REMOVE_NODE')"
      >
        <span class="icon iconfont iconshanchu"></span>
        <span class="text">{{ $t('toolbar.deleteNode') }}</span>
      </div>
      <div
        v-if="item === 'image'"
        class="toolbarBtn"
        data-testid="image"
        :class="{
          disabled: activeNodes.length <= 0
        }"
        @click="$bus.$emit('showNodeImage')"
      >
        <span class="icon iconfont iconimage"></span>
        <span class="text">{{ $t('toolbar.image') }}</span>
      </div>
      <div
        v-if="item === 'icon'"
        class="toolbarBtn"
        :class="{
          disabled: activeNodes.length <= 0
        }"
        @click="showNodeIcon"
      >
        <span class="icon iconfont iconxiaolian"></span>
        <span class="text">{{ $t('toolbar.icon') }}</span>
      </div>
      <div
        v-if="item === 'link'"
        class="toolbarBtn"
        data-testid="hyperlink"
        :class="{
          disabled: activeNodes.length <= 0
        }"
        @click="$bus.$emit('showNodeLink')"
      >
        <span class="icon iconfont iconchaolianjie"></span>
        <span class="text">{{ $t('toolbar.link') }}</span>
      </div>
      <div
        v-if="item === 'note'"
        class="toolbarBtn"
        data-testid="note"
        :class="{
          disabled: activeNodes.length <= 0
        }"
        @click="$bus.$emit('showNodeNote')"
      >
        <span class="icon iconfont iconflow-Mark"></span>
        <span class="text">{{ $t('toolbar.note') }}</span>
      </div>
      <div
        v-if="item === 'tag'"
        class="toolbarBtn"
        data-testid="tag"
        :class="{
          disabled: activeNodes.length <= 0
        }"
        @click="$bus.$emit('showNodeTag')"
      >
        <span class="icon iconfont iconbiaoqian"></span>
        <span class="text">{{ $t('toolbar.tag') }}</span>
      </div>
      <div
        v-if="item === 'summary'"
        class="toolbarBtn"
        data-testid="generalization"
        :class="{
          disabled: activeNodes.length <= 0 || hasRoot || hasGeneralization
        }"
        @click="$bus.$emit('execCommand', 'ADD_GENERALIZATION')"
      >
        <span class="icon iconfont icongaikuozonglan"></span>
        <span class="text">{{ $t('toolbar.summary') }}</span>
      </div>
      <div
        v-if="item === 'associativeLine'"
        class="toolbarBtn"
        data-testid="associative-line"
        :class="{
          disabled: activeNodes.length <= 0 || hasGeneralization
        }"
        @click="$bus.$emit('createAssociativeLine')"
      >
        <span class="icon iconfont iconlianjiexian"></span>
        <span class="text">{{ $t('toolbar.associativeLine') }}</span>
      </div>
      <div
        v-if="item === 'formula'"
        class="toolbarBtn"
        :class="{
          disabled: activeNodes.length <= 0 || hasGeneralization
        }"
        @click="showFormula"
      >
        <span class="icon iconfont icongongshi"></span>
        <span class="text">{{ $t('toolbar.formula') }}</span>
      </div>
      <div
        v-if="item === 'attachment'"
        class="toolbarBtn"
        :class="{
          disabled: activeNodes.length <= 0 || hasGeneralization
        }"
        @click="selectAttachmentFile"
      >
        <span class="icon iconfont iconfujian"></span>
        <span class="text">{{ $t('toolbar.attachment') }}</span>
      </div>
      <div
        v-if="item === 'outerFrame'"
        class="toolbarBtn"
        data-testid="outer-frame"
        :class="{
          disabled: activeNodes.length <= 0 || hasGeneralization
        }"
        @click="$bus.$emit('execCommand', 'ADD_OUTER_FRAME')"
      >
        <span class="icon iconfont iconwaikuang"></span>
        <span class="text">{{ $t('toolbar.outerFrame') }}</span>
      </div>
      <div
        v-if="item === 'flowExpand'"
        class="toolbarBtn"
        :class="{
          disabled: activeNodes.length <= 0 || hasRoot || readonly,
          loading: flowExpandRunning > 0
        }"
        @click="flowExpand"
      >
        <span class="icon workbuddy-icon-wrap">
          <img class="workbuddy-icon" :src="workbuddyFillIcon" alt="" />
          <span v-if="flowExpandTotal > 0" class="flow-expand-badge">{{
            flowExpandTotal
          }}</span>
        </span>
        <span class="text">{{ $t('toolbar.flowExpand') }}</span>
      </div>
      <div
        v-if="item === 'ai'"
        class="toolbarBtn"
        :class="{
          disabled: hasGeneralization
        }"
        @click="aiCrate"
      >
        <span class="icon iconfont iconAIshengcheng"></span>
        <span class="text">{{ $t('toolbar.ai') }}</span>
      </div>
    </template>
  </div>
</template>

<script>
import { mapState, mapMutations } from 'vuex'
import workbuddyFillIcon from '@/assets/img/workbuddy-fill.svg'
import { checkWorkbuddy } from '@/utils/workbuddyChat'

export default {
  props: {
    dir: {
      type: String,
      default: 'h' // h（水平排列）、v（垂直排列）
    },
    list: {
      type: Array,
      default() {
        return []
      }
    }
  },
  data() {
    return {
      workbuddyFillIcon,
      activeNodes: [],
      backEnd: true,
      forwardEnd: true,
      readonly: false,
      isFullDataFile: false,
      timer: null,
      isInPainter: false,
      flowExpandRunning: 0,
      flowExpandQueued: 0,
      flowExpandTotal: 0
    }
  },
  computed: {
    ...mapState({
      isDark: state => state.localConfig.isDark
    }),
    hasRoot() {
      return (
        this.activeNodes.findIndex(node => {
          return node.isRoot
        }) !== -1
      )
    },
    hasGeneralization() {
      return (
        this.activeNodes.findIndex(node => {
          return node.isGeneralization
        }) !== -1
      )
    },
    annotationRightHasBtn() {
      const index = this.list.findIndex(item => {
        return item === 'annotation'
      })
      return index !== -1 && index < this.list.length - 1
    }
  },
  created() {
    this.$bus.$on('mode_change', this.onModeChange)
    this.$bus.$on('node_active', this.onNodeActive)
    this.$bus.$on('back_forward', this.onBackForward)
    this.$bus.$on('painter_start', this.onPainterStart)
    this.$bus.$on('painter_end', this.onPainterEnd)
    this.$bus.$on('node_flow_expand_queue', this.onFlowExpandQueue)
  },
  beforeDestroy() {
    this.$bus.$off('mode_change', this.onModeChange)
    this.$bus.$off('node_active', this.onNodeActive)
    this.$bus.$off('back_forward', this.onBackForward)
    this.$bus.$off('painter_start', this.onPainterStart)
    this.$bus.$off('painter_end', this.onPainterEnd)
    this.$bus.$off('node_flow_expand_queue', this.onFlowExpandQueue)
  },
  methods: {
    ...mapMutations(['setActiveSidebar']),

    // 监听模式切换
    onModeChange(mode) {
      this.readonly = mode === 'readonly'
    },

    // 监听节点激活
    onNodeActive(...args) {
      this.activeNodes = [...args[1]]
    },

    // 监听前进后退
    onBackForward(index, len) {
      this.backEnd = index <= 0
      this.forwardEnd = index >= len - 1
    },

    // 开始格式刷
    onPainterStart() {
      this.isInPainter = true
    },

    // 格式刷结束
    onPainterEnd() {
      this.isInPainter = false
    },

    onFlowExpandQueue({ running = 0, queued = 0, total = 0 } = {}) {
      this.flowExpandRunning = running
      this.flowExpandQueued = queued
      this.flowExpandTotal = total
    },

    flowExpand() {
      if (
        this.readonly ||
        this.activeNodes.length <= 0 ||
        this.hasRoot
      ) {
        return
      }
      this.runFlowExpand()
    },

    async runFlowExpand() {
      const wb = await checkWorkbuddy()
      if (!wb.ok) {
        if (this.$message) {
          this.$message.warning('WorkBuddy 未就绪，请确认服务器已启动代理')
        }
        return
      }
      this.$bus.$emit('node_flow_expand', this.activeNodes[0])
    },

    // 显示节点图标侧边栏
    showNodeIcon() {
      this.$bus.$emit('close_node_icon_toolbar')
      this.setActiveSidebar('nodeIconSidebar')
    },

    // 打开公式侧边栏
    showFormula() {
      this.setActiveSidebar('formulaSidebar')
    },

    // 选择附件
    selectAttachmentFile() {
      this.$bus.$emit('selectAttachment', this.activeNodes)
    },

    // 设置标记
    onSetAnnotation(...args) {
      this.$bus.$emit('execCommand', 'SET_NOTATION', this.activeNodes, ...args)
    },

    // AI生成整体
    aiCrate() {
      this.$bus.$emit('ai_create_all')
    }
  }
}
</script>

<style lang="less">
.toolbarNodeBtnList {
  display: flex;

  &.isDark {
    .toolbarBtn {
      color: hsla(0, 0%, 100%, 0.9);

      .icon {
        background: transparent;
        border-color: transparent;
      }

      &:hover {
        &:not(.disabled) {
          .icon {
            background: hsla(0, 0%, 100%, 0.05);
          }
        }
      }

      &.disabled {
        color: #54595f;
      }
    }
  }

  .toolbarBtn {
    display: flex;
    justify-content: center;
    align-items: center;
    flex-direction: column;
    cursor: pointer;
    margin-right: 20px;

    &:last-of-type {
      margin-right: 0;
    }

    &:hover {
      &:not(.disabled) {
        .icon {
          background: #f5f5f5;
        }
      }
    }

    &.active {
      .icon {
        background: #f5f5f5;
      }
    }

    &.disabled {
      color: #bcbcbc;
      cursor: not-allowed;
      pointer-events: none;
    }

    .icon {
      display: flex;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
      min-width: 28px;
      height: 26px;
      background: #fff;
      border-radius: 4px;
      border: 1px solid #e9e9e9;
      flex-direction: row;
      text-align: center;
      padding: 0 5px;
    }

    .text {
      margin-top: 3px;
      text-align: center;
      width: 100%;
      white-space: nowrap;
    }

    &.loading {
      .workbuddy-icon-wrap .workbuddy-icon {
        opacity: 0.65;
        animation: workbuddy-pulse 1.2s ease-in-out infinite;
      }
    }

    .workbuddy-icon-wrap {
      position: relative;
      padding: 2px !important;

      .workbuddy-icon {
        width: 20px;
        height: 20px;
        display: block;
        border-radius: 3px;
        object-fit: cover;
        margin: 0 auto;
      }

      .flow-expand-badge {
        position: absolute;
        top: -4px;
        right: -6px;
        min-width: 14px;
        height: 14px;
        padding: 0 3px;
        border-radius: 7px;
        background: #1268ff;
        color: #fff;
        font-size: 10px;
        line-height: 14px;
        text-align: center;
      }
    }
  }

  &.v {
    display: block;
    width: 120px;
    flex-wrap: wrap;

    .toolbarBtn {
      flex-direction: row;
      justify-content: flex-start;
      margin-bottom: 10px;
      width: 100%;
      margin-right: 0;

      &:last-of-type {
        margin-bottom: 0;
      }

      .icon {
        margin-right: 10px;
      }

      .text {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
    }
  }
}

@keyframes workbuddy-pulse {
  0%,
  100% {
    opacity: 0.55;
    transform: scale(0.94);
  }
  50% {
    opacity: 1;
    transform: scale(1);
  }
}
</style>
