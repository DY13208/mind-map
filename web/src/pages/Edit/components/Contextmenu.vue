<template>
  <div
    class="contextmenuContainer"
    v-if="isShow"
    ref="contextmenuRef"
    :style="{ left: left + 'px', top: top + 'px' }"
    :class="{ isDark: isDark, nodeMenu: type === 'node' }"
    @mouseenter="cancelSubmenuClose"
  >
    <div
      class="listBox menuScroll"
      ref="menuListRef"
      :class="{ isDark: isDark }"
      :style="menuMaxHeight ? { maxHeight: menuMaxHeight + 'px' } : null"
    >
    <template v-if="type === 'node'">
      <div class="item" @click="exec('INSERT_CHILD_NODE')">
        <MenuIcon name="plus" />
        <span class="name">{{ $t('contextmenu.insertChildNode') }}</span>
        <span class="desc">Tab</span>
      </div>
      <div
        class="item"
        @click="exec('INSERT_NODE', insertNodeBtnDisabled)"
        :class="{ disabled: insertNodeBtnDisabled }"
      >
        <MenuIcon name="sibling" />
        <span class="name">{{ $t('contextmenu.insertSiblingNode') }}</span>
        <span class="desc">Enter</span>
      </div>
      <div class="splitLine"></div>
      <div class="item" @click="exec('UNEXPAND_ALL')">
        <MenuIcon name="collapse" />
        <span class="name">{{ $t('contextmenu.unExpandNodeChild') }}</span>
        <span class="desc">Ctrl + Alt + C</span>
      </div>
      <div class="item" @click="exec('EXPAND_ALL')">
        <MenuIcon name="expand" />
        <span class="name">{{ $t('contextmenu.expandNodeChild') }}</span>
        <span class="desc">Ctrl + Alt + E</span>
      </div>
      <div class="splitLine"></div>
      <div class="item" data-testid="share-node" @click="shareNode">
        <MenuIcon name="share" />
        <span class="name">分享此节点</span>
        <span class="desc">Ctrl + Alt + S</span>
      </div>
      <div class="item" data-testid="copy-node-for-ai" @click="copyNodeForAi">
        <MenuIcon name="clipboard" />
        <span class="name">复制给 AI（SOP）</span>
        <span class="desc">Ctrl + Alt + A</span>
      </div>
      <div class="splitLine"></div>
      <div
        class="item"
        @mouseenter="openSubmenu('structure', $event)"
        v-on:click="openSubmenu('structure', $event)"
        @mouseleave="scheduleSubmenuClose"
      >
        <MenuIcon name="network" />
        <span class="name">节点结构</span>
        <MenuIcon name="chevron" />
      </div>
      <div
        class="item"
        @mouseenter="openSubmenu('content', $event)"
        v-on:click="openSubmenu('content', $event)"
        @mouseleave="scheduleSubmenuClose"
      >
        <MenuIcon name="pencil" />
        <span class="name">编辑与内容</span>
        <MenuIcon name="chevron" />
      </div>
      <div
        class="item"
        @mouseenter="openSubmenu('style', $event)"
        v-on:click="openSubmenu('style', $event)"
        @mouseleave="scheduleSubmenuClose"
      >
        <MenuIcon name="palette" />
        <span class="name">样式与格式</span>
        <MenuIcon name="chevron" />
      </div>
      <div
        class="item"
        @mouseenter="openSubmenu('more', $event)"
        v-on:click="openSubmenu('more', $event)"
        @mouseleave="scheduleSubmenuClose"
      >
        <MenuIcon name="ellipsis" />
        <span class="name">更多操作</span>
        <MenuIcon name="chevron" />
      </div>
      <div class="splitLine"></div>
      <div class="item danger" @click="exec('REMOVE_NODE')">
        <MenuIcon name="trash" />
        <span class="name">{{ $t('contextmenu.deleteNode') }}</span>
        <span class="desc">Delete</span>
      </div>
    </template>
    <template v-if="type === 'svg'">
      <div class="item" @click="exec('RETURN_CENTER')">
        <MenuIcon name="house" />
        <span class="name">{{ $t('contextmenu.backCenter') }}</span>
        <span class="desc">Ctrl + Enter</span>
      </div>
      <div class="item" @click="exec('FIT_CANVAS')">
        <MenuIcon name="maximize" />
        <span class="name">{{ $t('contextmenu.fitCanvas') }}</span>
        <span class="desc">Ctrl + i</span>
      </div>
      <div class="splitLine"></div>
      <div class="item" @click="exec('EXPAND_ALL')">
        <MenuIcon name="expand" />
        <span class="name">{{ $t('contextmenu.expandAll') }}</span>
      </div>
      <div class="item" @click="exec('UNEXPAND_ALL')">
        <MenuIcon name="collapse" />
        <span class="name">{{ $t('contextmenu.unExpandAll') }}</span>
      </div>
      <div
        class="item"
        @mouseenter="openSubmenu('expand', $event)"
        v-on:click="openSubmenu('expand', $event)"
        @mouseleave="scheduleSubmenuClose"
      >
        <MenuIcon name="expand" />
        <span class="name">{{ $t('contextmenu.expandTo') }}</span>
        <MenuIcon name="chevron" />
      </div>
      <div class="item" @click="exec('RESET_LAYOUT')">
        <MenuIcon name="grid" />
        <span class="name">{{ $t('contextmenu.arrangeLayout') }}</span>
        <span class="desc">Ctrl + L</span>
      </div>
      <div class="splitLine"></div>
      <div class="item" @click="exec('TOGGLE_ZEN_MODE')">
        <MenuIcon name="focus" />
        <span class="name">{{ $t('contextmenu.zenMode') }}</span>
        <span class="desc" v-if="isZenMode">开</span>
      </div>
      <div class="item" @click="exec('REMOVE_ALL_NODE_CUSTOM_STYLES')">
        <MenuIcon name="eraser" />
        <span class="name">{{ $t('contextmenu.removeAllNodeCustomStyles') }}</span>
      </div>
      <div
        class="item"
        @mouseenter="openSubmenu('clipboard', $event)"
        v-on:click="openSubmenu('clipboard', $event)"
        @mouseleave="scheduleSubmenuClose"
      >
        <MenuIcon name="clipboard" />
        <span class="name">{{ $t('contextmenu.copyToClipboard') }}</span>
        <MenuIcon name="chevron" />
      </div>
    </template>
    </div>
    <div v-if="activeSubmenu"
      ref="submenuRef"
      class="submenu listBox"
      :class="{ isDark: isDark }"
      :style="{
        left: submenuLeft + 'px',
        top: submenuTop + 'px',
        maxHeight: submenuMaxHeight ? submenuMaxHeight + 'px' : null
      }"
      @mouseenter="cancelSubmenuClose"
      @mouseleave="scheduleSubmenuClose"
    >
      <template v-if="activeSubmenu === 'structure'">
        <div
          class="item"
          @click="exec('INSERT_PARENT_NODE', insertNodeBtnDisabled)"
          :class="{ disabled: insertNodeBtnDisabled }"
        >
          <MenuIcon name="plus" />
          <span class="name">{{ $t('contextmenu.insertParentNode') }}</span>
          <span class="desc">Shift + Tab</span>
        </div>
        <div
          class="item"
          data-testid="insert-summary"
          @click="exec('ADD_GENERALIZATION', insertSummaryBtnDisabled)"
          :class="{ disabled: insertSummaryBtnDisabled }"
        >
          <MenuIcon name="summary" />
          <span class="name">{{ $t('contextmenu.insertSummary') }}</span>
          <span class="desc">Ctrl + G</span>
        </div>
        <div
          class="item"
          @click="exec('UP_NODE', upNodeBtnDisabled)"
          :class="{ disabled: upNodeBtnDisabled }"
        >
          <MenuIcon name="up" />
          <span class="name">{{ $t('contextmenu.moveUpNode') }}</span>
          <span class="desc">Ctrl + ↑</span>
        </div>
        <div
          class="item"
          @click="exec('DOWN_NODE', downNodeBtnDisabled)"
          :class="{ disabled: downNodeBtnDisabled }"
        >
          <MenuIcon name="down" />
          <span class="name">{{ $t('contextmenu.moveDownNode') }}</span>
          <span class="desc">Ctrl + ↓</span>
        </div>
        <div
          class="item"
          :class="{ disabled: isGeneralization }"
          v-on:click="useNodeTool('associativeLine')"
        >
          <MenuIcon name="curve" />
          <span class="name">{{ $t('toolbar.associativeLine') }}</span>
        </div>
      </template>
      <template v-if="activeSubmenu === 'content'">
        <div
          class="item"
          @click="exec('COPY_NODE', isGeneralization)"
          :class="{ disabled: isGeneralization }"
        >
          <MenuIcon name="copy" />
          <span class="name">{{ $t('contextmenu.copyNode') }}</span>
          <span class="desc">Ctrl + C</span>
        </div>
        <div
          class="item"
          @click="exec('CUT_NODE', isGeneralization)"
          :class="{ disabled: isGeneralization }"
        >
          <MenuIcon name="scissors" />
          <span class="name">{{ $t('contextmenu.cutNode') }}</span>
          <span class="desc">Ctrl + X</span>
        </div>
        <div class="item" @click="exec('PASTE_NODE')">
          <MenuIcon name="paste" />
          <span class="name">{{ $t('contextmenu.pasteNode') }}</span>
          <span class="desc">Ctrl + V</span>
        </div>
        <div class="splitLine"></div>
        <div class="item" v-on:click="useNodeTool('image')">
          <MenuIcon name="image" />
          <span class="name">{{ $t('toolbar.image') }}</span>
        </div>
        <div class="item" v-on:click="useNodeTool('icon')">
          <MenuIcon name="smiley" />
          <span class="name">{{ $t('toolbar.icon') }}</span>
        </div>
        <div class="item" v-if="!hasHyperlink" v-on:click="useNodeTool('link')">
          <MenuIcon name="link" />
          <span class="name">{{ $t('toolbar.link') }}</span>
        </div>
        <div class="item" v-on:click="useNodeTool('note')">
          <MenuIcon name="note" />
          <span class="name">{{ $t('toolbar.note') }}</span>
        </div>
        <div class="item" data-testid="node-comment" @click="openComment">
          <MenuIcon name="comment" />
          <span class="name">评论</span>
          <span v-if="nodeCommentCount" class="desc">{{ nodeCommentCount }}</span>
        </div>
        <div class="item" v-on:click="useNodeTool('tag')">
          <MenuIcon name="tag" />
          <span class="name">{{ $t('toolbar.tag') }}</span>
        </div>
        <div
          class="item"
          v-if="openNodeRichText"
          :class="{ disabled: isGeneralization }"
          v-on:click="useNodeTool('formula')"
        >
          <MenuIcon name="formula" />
          <span class="name">{{ $t('toolbar.formula') }}</span>
        </div>
        <div
          class="item"
          v-if="!hasNodeAttachment"
          :class="{ disabled: isGeneralization }"
          v-on:click="useNodeTool('attachment')"
        >
          <MenuIcon name="attachment" />
          <span class="name">{{ $t('toolbar.attachment') }}</span>
        </div>
        <div class="item" data-testid="mapref" @click="openMapRef">
          <MenuIcon name="network" />
          <span class="name">{{ $t('contextmenu.mapRef') }}</span>
        </div>
        <div class="item" @click="clearMapRef" v-if="hasMapRef">
          <MenuIcon name="unlink" />
          <span class="name">{{ $t('contextmenu.removeMapRef') }}</span>
        </div>
        <template v-if="hasHyperlink && hasExplicitNodeContext">
          <div class="item" data-testid="edit-node-hyperlink" @click="editHyperlink">
            <MenuIcon name="link" />
            <span class="name">编辑超链接</span>
          </div>
          <div class="item danger" data-testid="delete-node-hyperlink" @click="exec('REMOVE_HYPERLINK')">
            <MenuIcon name="unlink" />
            <span class="name">删除超链接</span>
          </div>
        </template>
        <div class="item" @click="exec('REMOVE_NOTE')" v-if="hasNote">
          <MenuIcon name="eraser" />
          <span class="name">{{ $t('contextmenu.removeNote') }}</span>
        </div>
        <template v-if="hasNodeAttachment && hasExplicitNodeContext">
          <div class="item danger" data-testid="delete-node-attachment" @click="manageNodeAttachment('delete')">
            <MenuIcon name="trash" />
            <span class="name">删除附件</span>
          </div>
          <div class="item" data-testid="replace-node-attachment" @click="manageNodeAttachment('replace')">
            <MenuIcon name="attachment" />
            <span class="name">替换附件</span>
          </div>
          <div v-if="nodeAttachmentErrorIgnored" class="item" data-testid="restore-node-attachment-error" @click="manageNodeAttachment('restoreError')">
            <MenuIcon name="attachment" />
            <span class="name">恢复错误提示</span>
          </div>
        </template>
      </template>
      <template v-if="activeSubmenu === 'style'">
        <div
          class="item"
          :class="{ disabled: isGeneralization }"
          v-on:click="useNodeTool('painter')"
        >
          <MenuIcon name="brush" />
          <span class="name">{{ $t('toolbar.painter') }}</span>
        </div>
        <div
          class="item"
          :class="{ disabled: isGeneralization }"
          v-on:click="useNodeTool('outerFrame')"
        >
          <MenuIcon name="frame" />
          <span class="name">{{ $t('toolbar.outerFrame') }}</span>
        </div>
        <div class="item" @click="exec('REMOVE_CUSTOM_STYLES')">
          <MenuIcon name="eraser" />
          <span class="name">{{ $t('contextmenu.removeCustomStyles') }}</span>
        </div>
      </template>
      <template v-if="activeSubmenu === 'more'">
        <div class="item danger" @click="exec('REMOVE_CURRENT_NODE')">
          <MenuIcon name="trash" />
          <span class="name">{{ $t('contextmenu.deleteCurrentNode') }}</span>
          <span class="desc">Shift + Backspace</span>
        </div>
        <div class="item" @click="exec('EXPORT_CUR_NODE_TO_PNG')">
          <MenuIcon name="image" />
          <span class="name">{{ $t('contextmenu.exportNodeToPng') }}</span>
        </div>
        <div
          class="item"
          :class="{ disabled: isGeneralization || (node && node.isRoot) }"
          v-on:click="useNodeTool('flowExpand')"
        >
          <MenuIcon name="spark" />
          <span class="name">{{ $t('toolbar.flowExpand') }}</span>
        </div>
        <div class="item" @click="aiCreate" v-if="enableAi">
          <MenuIcon name="pencil" />
          <span class="name">{{ $t('contextmenu.aiCreate') }}</span>
        </div>
      </template>
      <template v-if="activeSubmenu === 'expand'">
        <div
          class="item"
          v-for="(item, index) in expandList"
          :key="item"
          @click="exec('UNEXPAND_TO_LEVEL', false, index + 1)"
        >
          <span class="name">{{ item }}</span>
        </div>
      </template>
      <template v-if="activeSubmenu === 'clipboard'">
        <div
          class="item"
          v-for="item in copyList"
          :key="item.value"
          @click="copyToClipboard(item.value)"
        >
          <span class="name">{{ item.name }}</span>
        </div>
      </template>
    </div>
  </div>
</template>

<script>
import { mapState, mapMutations } from 'vuex'
import MenuIcon from './ContextmenuIcon.vue'
import { getTextFromHtml, imgToDataUrl } from 'simple-mind-map/src/utils'
import { transformToMarkdown } from 'simple-mind-map/src/parse/toMarkdown'
import { transformToTxt } from 'simple-mind-map/src/parse/toTxt'
import { setDataToClipboard, setImgToClipboard, copy } from '@/utils'
import { numberTypeList, numberLevelList } from '@/config'
import { buildInviteUrl, roomFromLocation } from '@/utils/roomLocation'
import { getRuntimeConfig } from '@/utils/runtimeConfig'
import {
  getSafeArea,
  getViewport,
  readFrameWidth,
  collectObstacles,
  placeMenu,
  placeSubmenu
} from '@/utils/menuPlacement'

// 右键菜单
export default {
  components: { MenuIcon },
  props: {
    mindMap: {
      type: Object
    },
    editable: {
      type: Boolean,
      default: true
    },
    commandExecutor: {
      type: Function,
      default: null
    },
    beforeCommand: {
      type: Function,
      default: null
    }
  },
  data() {
    return {
      isShow: false,
      left: 0,
      top: 0,
      node: null,
      type: '',
      isMousedown: false,
      mosuedownX: 0,
      mosuedownY: 0,
      enableCopyToClipboardApi: navigator.clipboard,
      numberType: '',
      numberLevel: '',
      subItemsShowLeft: false,
      isNodeMousedown: false,
      selectedNodes: [],
      hasExplicitNodeContext: false,
      activeSubmenu: '',
      submenuLeft: 0,
      submenuTop: 0,
      submenuMaxHeight: 0,
      menuMaxHeight: 0
    }
  },
  computed: {
    ...mapState({
      isZenMode: state => state.localConfig.isZenMode,
      isDark: state => state.localConfig.isDark,
      enableAi: state => state.localConfig.enableAi,
      openNodeRichText: state => state.localConfig.openNodeRichText,
      roomCanShare: state => state.roomCanShare
    }),
    expandList() {
      return [
        this.$t('contextmenu.level1'),
        this.$t('contextmenu.level2'),
        this.$t('contextmenu.level3'),
        this.$t('contextmenu.level4'),
        this.$t('contextmenu.level5'),
        this.$t('contextmenu.level6')
      ]
    },
    copyList() {
      const list = [
        {
          name: this.$t('contextmenu.copyToSmm'),
          value: 'smm'
        },
        {
          name: this.$t('contextmenu.copyToJson'),
          value: 'json'
        },
        {
          name: this.$t('contextmenu.copyToMarkdown'),
          value: 'md'
        },
        {
          name: this.$t('contextmenu.copyToTxt'),
          value: 'txt'
        }
      ]
      if (this.enableCopyToClipboardApi) {
        list.push({
          name: this.$t('contextmenu.copyToPng'),
          value: 'png'
        })
      }
      return list
    },
    insertNodeBtnDisabled() {
      return !this.node || this.node.isRoot || this.node.isGeneralization
    },
    insertSummaryBtnDisabled() {
      const nodes = this.selectedNodes.length
        ? this.selectedNodes
        : this.node
          ? [this.node]
          : []
      return !nodes.some(node => node && !node.isRoot && !node.isGeneralization)
    },
    upNodeBtnDisabled() {
      if (!this.node || this.node.isRoot || this.node.isGeneralization) {
        return true
      }
      let isFirst =
        this.node.parent.children.findIndex(item => {
          return item === this.node
        }) === 0
      return isFirst
    },
    downNodeBtnDisabled() {
      if (!this.node || this.node.isRoot || this.node.isGeneralization) {
        return true
      }
      let children = this.node.parent.children
      let isLast =
        children.findIndex(item => {
          return item === this.node
        }) ===
        children.length - 1
      return isLast
    },
    isGeneralization() {
      return !!(this.node && this.node.isGeneralization)
    },
    hasHyperlink() {
      return !!(this.node && this.node.getData && this.node.getData('hyperlink'))
    },
    hasMapRef() {
      const ref = this.node && this.node.getData && this.node.getData('mapRef')
      return !!(ref && (ref.mapId || ref.map_id || ref.room_key))
    },
    nodeCommentCount() {
      const list = this.node && this.node.getData && this.node.getData('comments')
      // Count live comments only (skip deletion tombstones)
      return Array.isArray(list) ? list.filter(c => c && !c.deleted && String(c.content || '').trim()).length : 0
    },
    hasNote() {
      return !!this.node.getData('note')
    },
    hasNodeAttachment() {
      const data = this.node && this.node.getData && this.node.getData()
      return !!(
        data &&
        (data.attachmentId ||
          data.attachmentUrl ||
          data.attachmentName ||
          data.attachmentStatus)
      )
    },
    nodeAttachmentErrorIgnored() {
      const data = this.node && this.node.getData && this.node.getData()
      return !!(
        data &&
        data.attachmentErrorIgnored &&
        String(data.attachmentStatus || '').toLowerCase() === 'failed'
      )
    },
    numberTypeList() {
      return numberTypeList[this.$i18n.locale] || numberTypeList.zh
    },
    numberLevelList() {
      return numberLevelList[this.$i18n.locale] || numberLevelList.zh
    },
    hasCheckbox() {
      return !!this.node.getData('checkbox')
    },
    hasNodeLink() {
      return !!this.node.getData('nodeLink')
    }
  },
  created() {
    this.$bus.$on('node_contextmenu', this.show)
    this.$bus.$on('multi_select_end', this.onMultiSelectEnd)
    this.$bus.$on('node_click', this.hide)
    this.$bus.$on('draw_click', this.hide)
    this.$bus.$on('expand_btn_click', this.hide)
    this.$bus.$on('svg_mousedown', this.onMousedown)
    this.$bus.$on('mouseup', this.onMouseup)
    this.$bus.$on('translate', this.hide)
    this.$bus.$on('node_mousedown', this.onNodeMousedown)
    this.$bus.$on('node_mouseup', this.onNodeMouseup)
  },
  mounted() {
    this.bindMenuShortcuts()
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('pointerdown', this.onOutsidePointer, true)
    }
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('keydown', this.onMenuKeydown)
      window.addEventListener('resize', this.onWindowResize)
    }
  },
  beforeDestroy() {
    if (this._menuShortcuts && this.mindMap && this.mindMap.keyCommand) {
      this._menuShortcuts.forEach(([key, handler]) => {
        this.mindMap.keyCommand.removeShortcut(key, handler)
      })
    }
    if (typeof document !== 'undefined' && document.removeEventListener) {
      document.removeEventListener('pointerdown', this.onOutsidePointer, true)
    }
    if (typeof window !== 'undefined' && window.removeEventListener) {
      window.removeEventListener('keydown', this.onMenuKeydown)
      window.removeEventListener('resize', this.onWindowResize)
    }
    this.disconnectMenuObserver()
    this.$bus.$off('node_contextmenu', this.show)
    this.$bus.$off('multi_select_end', this.onMultiSelectEnd)
    this.$bus.$off('node_click', this.hide)
    this.$bus.$off('draw_click', this.hide)
    this.$bus.$off('expand_btn_click', this.hide)
    this.$bus.$off('svg_mousedown', this.onMousedown)
    this.$bus.$off('mouseup', this.onMouseup)
    this.$bus.$off('translate', this.hide)
    this.$bus.$off('node_mousedown', this.onNodeMousedown)
    this.$bus.$off('node_mouseup', this.onNodeMouseup)
  },
  methods: {
    ...mapMutations(['setLocalConfig', 'setActiveSidebar']),

    // 评论：只读用户也可以打开查看
    openComment() {
      if (!this.node) return
      const node = this.node
      this.hide()
      this.$bus.$emit('showNodeComment', node)
    },

    useNodeTool(name) {
      if (!this.node) return
      if (!this.editable) {
        if (this.$message) this.$message.warning('当前为只读权限，无法修改导图')
        return
      }
      const structureTool = ['painter', 'associativeLine', 'formula', 'attachment', 'outerFrame', 'flowExpand'].includes(name)
      if (structureTool && this.isGeneralization) return
      if (name === 'flowExpand' && this.node.isRoot) return
      const nodes = this.resolveLiveSelectedNodes()
      const list = nodes.length ? nodes : [this.node]
      this.hide()
      if (name === 'image') this.$bus.$emit('showNodeImage')
      else if (name === 'icon') {
        this.$bus.$emit('close_node_icon_toolbar')
        this.setActiveSidebar('nodeIconSidebar')
      } else if (name === 'link') this.$bus.$emit('showNodeLink')
      else if (name === 'note') this.$bus.$emit('showNodeNote')
      else if (name === 'tag') this.$bus.$emit('showNodeTag')
      else if (name === 'painter') this.$bus.$emit('startPainter')
      else if (name === 'associativeLine') this.$bus.$emit('createAssociativeLine')
      else if (name === 'formula') this.setActiveSidebar('formulaSidebar')
      else if (name === 'attachment') this.$bus.$emit('selectAttachment', list)
      else if (name === 'outerFrame') this.$bus.$emit('execCommand', 'ADD_OUTER_FRAME')
      else if (name === 'flowExpand') this.$bus.$emit('node_flow_expand', list[0])
    },

    async copyNodeForAi() {
      const node = this.node
      const uid = this.nodeUid(node)
      const room = roomFromLocation(this.$route)
      const path = []
      let current = node
      while (current) {
        const raw = String(current.getData('text') || '')
        // Older nodes may contain HTML without the richText flag.
        const hasHtml = /<\/?[a-z][^>]*>/i.test(raw)
        const text = (current.getData('richText') || hasHtml ? getTextFromHtml(raw) : raw)
          .replace(/\s+/g, ' ')
          .trim()
        if (text) path.unshift(text)
        current = current.parent
      }
      this.hide()
      if (!room || !uid) {
        this.$message.warning('请先打开已保存的脑图')
        return
      }
      const text = `执行这个SOP：${path.join(' / ')}（room_key=${room}，node_uid=${uid}）`
      try {
        try {
          if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('clipboard unavailable')
          await navigator.clipboard.writeText(text)
        } catch (err) {
          const input = document.createElement('textarea')
          input.value = text
          input.style.position = 'fixed'
          input.style.opacity = '0'
          document.body.appendChild(input)
          try {
            input.select()
            if (!document.execCommand('copy')) throw new Error('copy failed')
          } finally {
            document.body.removeChild(input)
          }
        }
        this.$message.success('SOP 指令已复制，可粘贴给 AI 使用')
      } catch (err) {
        this.$message.error('复制失败，请重试')
      }
    },

    async shareNode() {
      const node = this.node
      const uid = node && node.getData && node.getData('uid')
      const room = roomFromLocation(this.$route)
      this.hide()
      if (!room || !uid) {
        this.$message.warning('请先打开已保存的脑图')
        return
      }
      const link = `${buildInviteUrl(room, getRuntimeConfig().appUrl)}&focus=${encodeURIComponent(uid)}`
      try {
        try {
          if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('clipboard unavailable')
          await navigator.clipboard.writeText(link)
        } catch (err) {
          // HTTP deployments and denied clipboard permissions use the legacy API.
          const input = document.createElement('textarea')
          input.value = link
          input.style.position = 'fixed'
          input.style.opacity = '0'
          document.body.appendChild(input)
          try {
            input.select()
            if (!document.execCommand('copy')) throw new Error('copy failed')
          } finally {
            document.body.removeChild(input)
          }
        }
        this.$message.success('节点链接已复制，仅有文件访问权限的人可打开。')
      } catch (err) {
        this.$message.error('复制失败，请重试')
      }
    },

    // 安全区：视口 - 外框 - 边距；刘海条作为障碍物单独避让
    getPlacementContext() {
      const win = typeof window !== 'undefined' ? window : null
      const doc = typeof document !== 'undefined' ? document : null
      return {
        safeArea: getSafeArea(getViewport(win), undefined, readFrameWidth(win)),
        obstacles: collectObstacles(doc)
      }
    },

    // 计算右键菜单元素的显示位置（x/y 为鼠标位置）
    getShowPosition(x, y) {
      const container = this.$refs.contextmenuRef
      const rect = container.getBoundingClientRect()
      const list = this.$refs.menuListRef
      const height = Math.max(rect.height || 0, (list && list.scrollHeight) || 0)
      const { safeArea, obstacles } = this.getPlacementContext()
      const placed = placeMenu(
        { width: rect.width || 280, height },
        { x, y },
        safeArea,
        { obstacles }
      )
      this.menuMaxHeight = height > placed.maxHeight ? placed.maxHeight : 0
      this._menuAnchor = { x, y }
      return { x: placed.left, y: placed.top }
    },

    applyShowPosition(x, y) {
      if (!this.isShow || !this.$refs.contextmenuRef) return
      const pos = this.getShowPosition(x, y)
      this.left = pos.x
      this.top = pos.y
      this.observeMenuContent()
    },

    // 视口变化或菜单内容变化时重新定位
    repositionMenu() {
      if (!this.isShow || !this.$refs.contextmenuRef || !this._menuAnchor) return
      const { x, y } = this._menuAnchor
      const pos = this.getShowPosition(x, y)
      this.left = pos.x
      this.top = pos.y
      if (this.activeSubmenu) this.$nextTick(() => this.repositionSubmenu())
    },

    onWindowResize() {
      if (!this.isShow) return
      this.repositionMenu()
    },

    observeMenuContent() {
      if (typeof MutationObserver === 'undefined') return
      const el = this.$refs.contextmenuRef
      if (!el || this._menuObservedEl === el) return
      this.disconnectMenuObserver()
      this._menuObserver = new MutationObserver(() => {
        if (this._menuRaf) return
        const run = () => {
          this._menuRaf = null
          this.repositionMenu()
        }
        this._menuRaf = typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame(run) : (run(), null)
      })
      // 只监听结构/文本变化，定位写入的 style 属性不会触发，避免死循环
      this._menuObserver.observe(el, { childList: true, subtree: true, characterData: true })
      this._menuObservedEl = el
    },

    disconnectMenuObserver() {
      if (this._menuObserver) this._menuObserver.disconnect()
      if (this._menuRaf && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(this._menuRaf)
      }
      this._menuObserver = null
      this._menuObservedEl = null
      this._menuRaf = null
    },

    // 节点右键显示
    show(e, node) {
      this.type = 'node'
      this.isShow = true
      this.node = node
      this.hasExplicitNodeContext = true
      this.selectedNodes = this.collectSelectedNodes(node)
      const number = this.node && this.node.getData && this.node.getData('number')
      if (number) {
        this.numberType = number.type || 1
        this.numberLevel = number.level === '' ? 1 : number.level
      }
      this.$nextTick(() => this.applyShowPosition(e.clientX, e.clientY))
    },

    onMultiSelectEnd() {
      // 两种模式：框选结束都不要立刻弹菜单，等用户再点一次右键。
    },

    showSelectionMenu(nodes, clientX, clientY) {
      const list = nodes || []
      if (list.length <= 1) return false
      const anchor =
        list.find(item => item && !item.isRoot && !item.isGeneralization) ||
        list[0]
      this.type = 'node'
      this.isShow = true
      this.node = anchor
      this.hasExplicitNodeContext = false
      this.selectedNodes = list.slice()
      const number = anchor && anchor.getData && anchor.getData('number')
      if (number) {
        this.numberType = number.type || 1
        this.numberLevel = number.level === '' ? 1 : number.level
      }
      this.$nextTick(() => this.applyShowPosition(clientX || 0, clientY || 0))
      return true
    },

    nodeUid(node) {
      if (!node) return ''
      return (node.getData && node.getData('uid')) || node.uid || ''
    },

    collectSelectedNodes(node) {
      const renderer = this.mindMap && this.mindMap.renderer
      const active = (renderer && renderer.activeNodeList) || []
      const uid = this.nodeUid(node)
      if (active.length > 1 && active.some(item => this.nodeUid(item) === uid)) {
        return active.slice()
      }
      return node ? [node] : []
    },

    restoreSelectedNodes() {
      const live = this.resolveLiveSelectedNodes()
      const renderer = this.mindMap && this.mindMap.renderer
      if (!renderer || live.length <= 1) return live
      if (typeof renderer.clearActiveNodeList === 'function') {
        renderer.clearActiveNodeList()
      }
      live.forEach(item => {
        if (item && typeof renderer.addNodeToActiveList === 'function') {
          renderer.addNodeToActiveList(item, true)
        }
      })
      if (typeof renderer.emitNodeActiveEvent === 'function') {
        renderer.emitNodeActiveEvent()
      }
      return live
    },

    resolveLiveSelectedNodes() {
      const renderer = this.mindMap && this.mindMap.renderer
      const find =
        renderer && typeof renderer.findNodeByUid === 'function'
          ? renderer.findNodeByUid.bind(renderer)
          : null
      const raw = this.selectedNodes.length
        ? this.selectedNodes
        : this.node
          ? [this.node]
          : []
      // 菜单打开时的选区就是操作目标，不能在执行时换成之前的框选缓存。
      return raw
        .map(item => {
          const uid = this.nodeUid(item)
          return uid && find ? find(uid) : item
        })
        .filter(item => item && typeof item.getData === 'function')
    },

    onNodeMousedown() {
      this.isNodeMousedown = true
    },

    onNodeMouseup() {
      // 非根节点会阻止 mouseup 冒泡，不能只等画布的 mouseup 清理状态。
      this.isNodeMousedown = false
      this.isMousedown = false
    },

    async openMapRef() {
      if (!(await this.canExecuteCommand('SET_NODE_MAP_REF'))) return
      const node = this.node
      this.hide()
      this.$bus.$emit('showMapRef', node)
    },

    async clearMapRef() {
      if (!(await this.canExecuteCommand('REMOVE_MAP_REF'))) return
      if (this.node && typeof this.node.setMapRef === 'function') {
        this.node.setMapRef(null)
      }
      this.hide()
      this.$message.success(this.$t('mapRef.removed'))
    },

    async editHyperlink() {
      const node = this.node
      if (!this.hasExplicitNodeContext || !node || !(await this.canExecuteCommand('SET_NODE_HYPERLINK'))) return
      this.hide()
      this.$bus.$emit('showNodeLink', node)
    },

    async manageNodeAttachment(action) {
      const node = this.node
      const uid = this.nodeUid(node)
      if (
        !this.hasExplicitNodeContext ||
        !node ||
        !uid ||
        !['delete', 'replace', 'restoreError'].includes(action) ||
        !(await this.canExecuteCommand('SET_NODE_ATTACHMENT'))
      ) {
        return
      }
      const data = node.getData ? node.getData() || {} : {}
      this.$bus.$emit('manageNodeAttachment', {
        action,
        uid,
        node,
        expectedAttachmentId: String(data.attachmentId || ''),
        expectedAttachmentUrl: String(data.attachmentUrl || ''),
        expectedAttachmentName: String(data.attachmentName || '')
      })
      this.hide()
    },

    // 鼠标按下事件
    onMousedown(e) {
      if (e.which !== 3) {
        return
      }
      this.mosuedownX = e.clientX
      this.mosuedownY = e.clientY
      this.isMousedown = true
    },

    // 鼠标松开事件
    onMouseup(e) {
      const isNodeMousedown = this.isNodeMousedown
      this.isNodeMousedown = false
      if (!this.isMousedown) {
        return
      }
      if (isNodeMousedown) {
        this.isMousedown = false
        return
      }
      this.isMousedown = false
      const moved =
        Math.abs(this.mosuedownX - e.clientX) > 3 ||
        Math.abs(this.mosuedownY - e.clientY) > 3
      // 右键拖动画布，或右键框选：松手时都不弹菜单
      if (moved) {
        this.hide()
        return
      }
      // 已有多选时，再点右键打开选中节点菜单（两种模式一致）
      if (
        this.showSelectionMenu(this.getCachedMultiNodes(), e.clientX, e.clientY)
      ) {
        return
      }
      this.show2(e)
    },

    getCachedMultiNodes() {
      const renderer = this.mindMap && this.mindMap.renderer
      return renderer ? (renderer.activeNodeList || []).slice() : []
    },

    // 画布右键显示
    show2(e) {
      this.hide()
      this.type = 'svg'
      this.isShow = true
      this.$nextTick(() => this.applyShowPosition(e.clientX, e.clientY))
    },

    // 隐藏
    hide() {
      this.isShow = false
      this.left = -9999
      this.top = -9999
      this.type = ''
      this.node = ''
      this.selectedNodes = []
      this.hasExplicitNodeContext = false
      this.numberType = ''
      this.numberLevel = ''
      this.activeSubmenu = ''
      this.menuMaxHeight = 0
      this.submenuMaxHeight = 0
      this._menuAnchor = null
      this._submenuItemEl = null
      this.disconnectMenuObserver()
    },

    bindMenuShortcuts() {
      if (!this.mindMap || !this.mindMap.keyCommand) return
      const actions = [
        ['Control+Alt+c', 'UNEXPAND_ALL'],
        ['Control+Alt+e', 'EXPAND_ALL'],
        ['Control+Alt+s', 'share'],
        ['Control+Alt+a', 'sop']
      ]
      this._menuShortcuts = actions.map(([key, action]) => {
        const handler = () => this.runMenuShortcut(action)
        this.mindMap.keyCommand.addShortcut(key, handler)
        return [key, handler]
      })
    },

    runMenuShortcut(action) {
      const active =
        (this.mindMap &&
          this.mindMap.renderer &&
          this.mindMap.renderer.activeNodeList) ||
        []
      const menuNode = this.isShow && this.type === 'node' ? this.node : null
      const node = action === 'share' && menuNode ? menuNode : active[0]
      if (!node) return
      this.node = node
      if (action === 'share') this.shareNode()
      else if (action === 'sop') this.copyNodeForAi()
      else this.exec(action)
    },

    openSubmenu(name, event) {
      this.cancelSubmenuClose()
      const itemEl = event.currentTarget
      const changed = this.activeSubmenu !== name || this._submenuItemEl !== itemEl
      this._submenuItemEl = itemEl
      if (changed) {
        // 先用估算尺寸放置，渲染后再按真实尺寸校正
        this.placeSubmenuAt({ width: 280, height: 360 })
        this.submenuMaxHeight = 0
      }
      this.activeSubmenu = name
      this.$nextTick(() => this.repositionSubmenu())
    },

    placeSubmenuAt(size) {
      const itemEl = this._submenuItemEl
      if (!itemEl || !itemEl.getBoundingClientRect) return null
      const list = this.$refs.menuListRef || this.$refs.contextmenuRef
      const parentRect = list && list.getBoundingClientRect
        ? list.getBoundingClientRect() : itemEl.getBoundingClientRect()
      const { safeArea, obstacles } = this.getPlacementContext()
      const placed = placeSubmenu(size, itemEl.getBoundingClientRect(), parentRect, safeArea, { obstacles })
      this.submenuLeft = placed.left
      this.submenuTop = placed.top
      return placed
    },

    repositionSubmenu() {
      const el = this.$refs.submenuRef
      if (!this.isShow || !this.activeSubmenu || !el) return
      const rect = el.getBoundingClientRect()
      const height = Math.max(rect.height || 0, el.scrollHeight || 0)
      const placed = this.placeSubmenuAt({ width: rect.width || 280, height })
      if (placed) this.submenuMaxHeight = height > placed.maxHeight ? placed.maxHeight : 0
    },

    scheduleSubmenuClose() {
      if (typeof clearTimeout === 'function') clearTimeout(this._submenuTimer)
      if (typeof setTimeout !== 'function') {
        this.activeSubmenu = ''
        return
      }
      this._submenuTimer = setTimeout(() => {
        this.activeSubmenu = ''
      }, 160)
    },

    cancelSubmenuClose() {
      if (typeof clearTimeout === 'function') clearTimeout(this._submenuTimer)
    },

    onOutsidePointer(event) {
      if (!this.isShow) return
      if (this.$el && this.$el.contains(event.target)) return
      const submenu = this.$refs.submenuRef
      if (submenu && submenu.contains && submenu.contains(event.target)) return
      this.hide()
    },

    onMenuKeydown(event) {
      if (!this.isShow || event.key !== 'Escape') return
      if (event.stopPropagation) event.stopPropagation()
      this.hide()
    },

    // 执行命令
    isMutationCommand(key) {
      return ![
        'COPY_NODE',
        'RETURN_CENTER',
        'FIT_CANVAS',
        'UNEXPAND_ALL',
        'EXPAND_ALL',
        'UNEXPAND_TO_LEVEL',
        'EXPORT_CUR_NODE_TO_PNG',
        'TOGGLE_ZEN_MODE'
      ].includes(key)
    },

    async canExecuteCommand(key) {
      if (!this.editable && this.isMutationCommand(key)) {
        this.$message.warning('当前为只读权限，无法修改导图')
        return false
      }
      if (typeof this.beforeCommand !== 'function') return true
      try {
        const result = await this.beforeCommand({
          key,
          node: this.node,
          selectedNodes: this.resolveLiveSelectedNodes()
        })
        return result !== false
      } catch (err) {
        return false
      }
    },

    runCommand(key, ...args) {
      if (typeof this.commandExecutor === 'function') {
        return this.commandExecutor(key, ...args)
      }
      this.$bus.$emit('execCommand', key, ...args)
    },

    async exec(key, disabled, ...args) {
      if (disabled || !(await this.canExecuteCommand(key))) {
        return
      }
      switch (key) {
        case 'ADD_GENERALIZATION': {
          const nodes = this.resolveLiveSelectedNodes()
          if (!nodes.length) {
            this.hide()
            return
          }
          this.runCommand('ADD_GENERALIZATION', null, true, nodes)
          break
        }
        case 'COPY_NODE':
          this.mindMap.renderer.copy()
          break
        case 'CUT_NODE':
          this.mindMap.renderer.cut()
          break
        case 'PASTE_NODE':
          this.mindMap.renderer.paste()
          break
        case 'RETURN_CENTER':
          this.mindMap.renderer.setRootNodeCenter()
          break
        case 'TOGGLE_ZEN_MODE':
          this.setLocalConfig({
            isZenMode: !this.isZenMode
          })
          break
        case 'FIT_CANVAS':
          this.mindMap.view.fit()
          break
        case 'REMOVE_HYPERLINK':
          this.node.setHyperlink('', '')
          break
        case 'REMOVE_NOTE':
          this.node.setNote('')
          break
        case 'EXPORT_CUR_NODE_TO_PNG':
          this.mindMap.export(
            'png',
            true,
            getTextFromHtml(this.node.getData('text')),
            false,
            this.node
          )
          break
        case 'UNEXPAND_ALL': {
          const uid = this.node ? this.node.uid : ''
          this.runCommand(key, !uid, uid)
          break
        }
        case 'EXPAND_ALL':
          this.runCommand(key, this.node ? this.node.uid : '')
          break
        default:
          this.runCommand(key, ...args)
          break
      }
      this.hide()
    },

    // 复制到剪贴板
    async getExportData(withConfig) {
      const cooperate = this.mindMap && this.mindMap.cooperate
      if (
        cooperate &&
        cooperate.httpCollabMode &&
        typeof cooperate.fetchExportTree === 'function'
      ) {
        try {
          const tree = await cooperate.fetchExportTree()
          if (tree) {
            if (withConfig) {
              return {
                layout: this.mindMap.getLayout(),
                root: tree,
                theme: {
                  template: this.mindMap.getTheme(),
                  config: this.mindMap.getCustomThemeConfig()
                },
                view: this.mindMap.view.getTransformData()
              }
            }
            return tree
          }
        } catch (error) {
          console.log(error)
        }
      }
      return this.mindMap.getData(withConfig)
    },

    async copyToClipboard(type) {
      try {
        this.hide()
        let data
        let str
        switch (type) {
          case 'smm':
          case 'json': {
            data = await this.getExportData(true)
            str = JSON.stringify(data)
            break
          }
          case 'md':
            data = await this.getExportData()
            str = transformToMarkdown(data)
            break
          case 'txt':
            data = await this.getExportData()
            str = transformToTxt(data)
            break
          case 'png': {
            const png = await this.mindMap.export('png', false)
            const blob = await imgToDataUrl(png, true)
            await setImgToClipboard(blob)
            break
          }
          default:
            break
        }
        if (str) {
          if (this.enableCopyToClipboardApi) {
            await setDataToClipboard(str)
          } else {
            copy(str)
          }
        }
        this.$message.success(this.$t('contextmenu.copySuccess'))
      } catch (error) {
        console.log(error)
        this.$message.error(this.$t('contextmenu.copyFail'))
      }
    },

    // AI续写
    async aiCreate() {
      if (!(await this.canExecuteCommand('AI_CREATE_PART'))) return
      this.$bus.$emit('ai_create_part', this.node)
      this.hide()
    }
  }
}
</script>

<style lang="less" scoped>
.listBox {
  width: 280px;
  background: #fff;
  box-shadow: 0 8px 24px rgba(16, 24, 40, 0.12);
  border-radius: 12px;
  padding: 6px;
  box-sizing: border-box;

  &.isDark {
    background: #262a2e;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  }
}

.contextmenuContainer {
  position: fixed;
  z-index: 3000;
  font-size: 13px;
  font-family: PingFangSC-Regular, PingFang SC;
  font-weight: 400;
  color: #1a1a1a;
}

.menuScroll,
.submenu {
  max-width: calc(100vw - 24px);
  max-height: calc(100vh - 24px);
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: rgba(0, 0, 0, 0.18) transparent;

  &::-webkit-scrollbar {
    width: 6px;
    height: 6px;
  }

  &::-webkit-scrollbar-track {
    background: transparent;
  }

  &::-webkit-scrollbar-thumb {
    background: rgba(0, 0, 0, 0.18);
    border-radius: 3px;
  }

  &::-webkit-scrollbar-thumb:hover {
    background: rgba(0, 0, 0, 0.3);
  }

  &::-webkit-scrollbar-button {
    display: none;
    width: 0;
    height: 0;
  }

  &.isDark {
    scrollbar-color: rgba(255, 255, 255, 0.2) transparent;

    &::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.2);
    }

    &::-webkit-scrollbar-thumb:hover {
      background: rgba(255, 255, 255, 0.32);
    }
  }
}

.submenu {
  position: fixed;
  z-index: 3001;
}

.contextmenuContainer.isDark,
.submenu.isDark {
  color: rgba(255, 255, 255, 0.92);

  .splitLine {
    background: rgba(255, 255, 255, 0.08);
  }

  .item:hover {
    background: rgba(255, 255, 255, 0.06);
  }

  .desc,
  .item /deep/ .menuIcon {
    color: rgba(255, 255, 255, 0.45);
  }

  .item.danger,
  .item.danger .desc,
  .item.danger /deep/ .menuIcon {
    color: #f87171;
  }
}

.splitLine {
  height: 1px;
  background: #eef0f3;
  margin: 4px 8px;
}

.item {
  height: 36px;
  padding: 0 8px;
  border-radius: 8px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;

  /deep/ .menuIcon {
    flex: none;
    color: #667085;
  }

  .name {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .desc {
    flex: none;
    color: #98a2b3;
    font-size: 12px;
  }

  &:hover {
    background: #f3f4f6;
  }

  &.danger {
    color: #dc2626;

    /deep/ .menuIcon,
    .desc {
      color: #dc2626;
    }
  }

  &.disabled {
    color: #98a2b3;
    cursor: not-allowed;
    pointer-events: none;
  }
}
</style>
