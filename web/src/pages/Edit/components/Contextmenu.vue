<template>
  <div
    class="contextmenuContainer"
    v-if="isShow"
    ref="contextmenuRef"
    :style="{ left: left + 'px', top: top + 'px' }"
    :class="{
      isDark: isDark,
      nodeMenu: type === 'node',
      stackedOpen: useStackedSubmenu && !!activeSubmenu
    }"
    @mouseenter="cancelSubmenuClose"
  >
    <div
      class="listBox menuScroll"
      ref="menuListRef"
      v-show="!(useStackedSubmenu && activeSubmenu)"
      :class="{ isDark: isDark }"
      :style="scrollBoxStyle(menuMaxHeight)"
    >
    <template v-if="type === 'node' && !editable">
      <div class="item" @click="exec('EXPAND_ALL')"><MenuIcon name="expand" /><span class="name">{{ $t('contextmenu.expandNodeChild') }}</span></div>
      <div
        class="item"
        data-testid="expand-node-to-level"
        @mouseenter="openSubmenu('expand', $event)"
        v-on:click="openSubmenu('expand', $event)"
        @mouseleave="scheduleSubmenuClose"
      >
        <MenuIcon name="expand" />
        <span class="name">{{ $t('contextmenu.expandTo') }}</span>
        <MenuIcon name="chevron" />
      </div>
      <div class="item" @click="exec('UNEXPAND_ALL')"><MenuIcon name="collapse" /><span class="name">{{ $t('contextmenu.unExpandNodeChild') }}</span></div>
      <div class="item" @click="copyNodeForAi"><MenuIcon name="clipboard" /><span class="name">复制给 AI（SOP）</span></div>
    </template>
    <template v-if="type === 'node' && editable">
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
      <div
        class="item"
        data-testid="expand-node-to-level"
        @mouseenter="openSubmenu('expand', $event)"
        v-on:click="openSubmenu('expand', $event)"
        @mouseleave="scheduleSubmenuClose"
      >
        <MenuIcon name="expand" />
        <span class="name">{{ $t('contextmenu.expandTo') }}</span>
        <MenuIcon name="chevron" />
      </div>
      <div class="splitLine"></div>
      <div class="item" data-testid="share-node" @click="shareNode">
        <MenuIcon name="share" />
        <span class="name">分享此节点</span>
        <span class="desc">Ctrl + Alt + S</span>
      </div>
      <div class="item" data-testid="copy-node-for-ai" @click="copyNodeForAi">
        <MenuIcon name="clipboard" />
        <span class="name">复制给AI</span>
        <span class="desc">Ctrl + Alt + A</span>
      </div>
      <div class="item" data-testid="distill-node-skill" @click="distillNodeSkill">
        <MenuIcon name="clipboard" />
        <span class="name">蒸馏skill</span>
      </div>
      <div class="splitLine"></div>
      <div
        class="item"
        data-testid="submenu-structure"
        :class="{ active: activeSubmenu === 'structure' }"
        @mouseenter="onSubmenuTriggerEnter('structure', $event)"
        @click.stop.prevent="onSubmenuTriggerClick('structure', $event)"
        @mouseleave="scheduleSubmenuClose"
      >
        <MenuIcon name="network" />
        <span class="name">节点结构</span>
        <MenuIcon name="chevron" />
      </div>
      <div
        class="item"
        data-testid="submenu-content"
        :class="{ active: activeSubmenu === 'content' }"
        @mouseenter="onSubmenuTriggerEnter('content', $event)"
        @click.stop.prevent="onSubmenuTriggerClick('content', $event)"
        @mouseleave="scheduleSubmenuClose"
      >
        <MenuIcon name="pencil" />
        <span class="name">编辑与内容</span>
        <MenuIcon name="chevron" />
      </div>
      <div
        class="item"
        data-testid="submenu-style"
        :class="{ active: activeSubmenu === 'style' }"
        @mouseenter="onSubmenuTriggerEnter('style', $event)"
        @click.stop.prevent="onSubmenuTriggerClick('style', $event)"
        @mouseleave="scheduleSubmenuClose"
      >
        <MenuIcon name="palette" />
        <span class="name">样式与格式</span>
        <MenuIcon name="chevron" />
      </div>
      <div
        class="item"
        data-testid="submenu-more"
        :class="{ active: activeSubmenu === 'more' }"
        @mouseenter="onSubmenuTriggerEnter('more', $event)"
        @click.stop.prevent="onSubmenuTriggerClick('more', $event)"
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
        :class="{ active: activeSubmenu === 'expand' }"
        @mouseenter="onSubmenuTriggerEnter('expand', $event)"
        @click.stop.prevent="onSubmenuTriggerClick('expand', $event)"
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
        :class="{ active: activeSubmenu === 'clipboard' }"
        @mouseenter="onSubmenuTriggerEnter('clipboard', $event)"
        @click.stop.prevent="onSubmenuTriggerClick('clipboard', $event)"
        @mouseleave="scheduleSubmenuClose"
      >
        <MenuIcon name="clipboard" />
        <span class="name">{{ $t('contextmenu.copyToClipboard') }}</span>
        <MenuIcon name="chevron" />
      </div>
    </template>
    </div>
    <div
      v-if="activeSubmenu"
      ref="submenuRef"
      class="submenu listBox"
      :class="{
        isDark: isDark,
        stacked: useStackedSubmenu,
        gated: submenuClickGate
      }"
      :style="
        useStackedSubmenu
          ? scrollBoxStyle(menuMaxHeight)
          : Object.assign(
              { left: submenuLeft + 'px', top: submenuTop + 'px' },
              scrollBoxStyle(submenuMaxHeight) || {}
            )
      "
      @mouseenter="cancelSubmenuClose"
      @mouseleave="scheduleSubmenuClose"
    >
      <template v-if="useStackedSubmenu">
        <div class="item submenuBack" data-testid="submenu-back" @click.stop="closeSubmenu">
          <MenuIcon name="chevronLeft" />
          <span class="name">{{ activeSubmenuTitle }}</span>
        </div>
        <div class="splitLine"></div>
      </template>
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
        <div class="item" data-testid="node-comment" @click.stop="openComment">
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
        <div class="item" data-testid="node-knowledge-file" :class="{ disabled: isGeneralization }" @click="useNodeTool('knowledgeFile')">
          <MenuIcon name="attachment" />
          <span class="name">文件知识库</span>
        </div>
        <div class="item" data-testid="mapref" @click="openMapRef">
          <MenuIcon name="network" />
          <span class="name">{{ $t('contextmenu.mapRef') }}</span>
        </div>
        <div
          class="item"
          @click="openMapRefInSource"
          v-if="hasMapRef"
        >
          <MenuIcon name="external" />
          <span class="name">{{ $t('contextmenu.openMapRefSource') }}</span>
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
import { appendKnowledgeFullText } from '@/utils/knowledgeFiles'
import { mapState, mapMutations } from 'vuex'
import MenuIcon from './ContextmenuIcon.vue'
import { getTextFromHtml, imgToDataUrl, isMobile } from 'simple-mind-map/src/utils'
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
  placeSubmenu,
  preferStackedSubmenu
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
      menuMaxHeight: 0,
      useStackedSubmenu: false,
      submenuClickGate: false
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
    activeSubmenuTitle() {
      const titles = {
        structure: '节点结构',
        content: '编辑与内容',
        style: '样式与格式',
        more: '更多操作',
        expand: this.$t('contextmenu.expandTo'),
        clipboard: this.$t('contextmenu.copyToClipboard')
      }
      return titles[this.activeSubmenu] || '返回'
    },
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
      if (this.submenuClickGate) return
      if (!this.node) return
      const node = this.node
      this.hide()
      this.$bus.$emit('showNodeComment', node)
    },

    useNodeTool(name) {
      if (this.submenuClickGate) return
      if (!this.node) return
      if (!this.editable) {
        if (this.$message) this.$message.warning('当前为只读权限，无法修改导图')
        return
      }
      const structureTool = ['painter', 'associativeLine', 'formula', 'attachment', 'knowledgeFile', 'outerFrame', 'flowExpand'].includes(name)
      if (structureTool && this.isGeneralization) return
      if (name === 'flowExpand' && this.node.isRoot) return
      const nodes = this.resolveLiveSelectedNodes()
      const list = nodes.length ? nodes : [this.node]
      this.hide()
      if (name === 'image') this.$bus.$emit('showNodeImage')
      else if (name === 'icon') {
        this.$bus.$emit('close_node_icon_toolbar')
        this.setActiveSidebar('nodeIconSidebar')
      } else if (name === 'link') this.$bus.$emit('showNodeLink', list)
      else if (name === 'note') this.$bus.$emit('showNodeNote', list)
      else if (name === 'tag') this.$bus.$emit('showNodeTag')
      else if (name === 'painter') this.$bus.$emit('startPainter')
      else if (name === 'associativeLine') this.$bus.$emit('createAssociativeLine')
      else if (name === 'formula') this.setActiveSidebar('formulaSidebar')
      else if (name === 'attachment') this.$bus.$emit('selectAttachment', list)
      else if (name === 'knowledgeFile') this.$bus.$emit('selectKnowledgeFile', list)
      else if (name === 'outerFrame') this.$bus.$emit('execCommand', 'ADD_OUTER_FRAME')
      else if (name === 'flowExpand') this.$bus.$emit('node_flow_expand', list[0])
    },

    getNodeAiReference() {
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
      if (!room || !uid) {
        this.$message.warning('请先打开已保存的脑图')
        return ''
      }
      return `${path.join(' / ')}（room_key=${room}，node_uid=${uid}）`
    },

    async copyNodeForAi() {
      const reference = this.getNodeAiReference()
      this.hide()
      if (!reference) return
      await this.copyAiInstruction(`执行这个SOP：${reference}`, '指令已复制，可粘贴给 AI 使用')
    },

    async distillNodeSkill() {
      const node = this.node
      const reference = this.getNodeAiReference()
      this.hide()
      if (!reference) return
      const text = `/skill-to-mindmap-sop 利用这个skill\n识别${reference}所有D节点，智能查找对应的D节点适配的skill 或者对话 任务 记忆等，补充对应D需要的信息，整理放在对应D的子节点下。`
      try {
        const fullText = await appendKnowledgeFullText(text, node, { includeDescendants: true })
        await this.copyAiInstruction(fullText, '蒸馏skill 指令及挂载文件正文已复制')
      } catch (error) { this.$message.error(error.message || '读取挂载文件正文失败，未复制') }
    },

    async copyAiInstruction(text, successMessage) {
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
        this.$message.success(successMessage)
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

    // iOS/触控：仅 max-height 时常无法手指拖动滚动，需同时给出明确 height
    scrollBoxStyle(maxHeight) {
      if (!maxHeight) return null
      const px = maxHeight + 'px'
      return { maxHeight: px, height: px }
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
      const list =
        this.useStackedSubmenu && this.activeSubmenu
          ? this.$refs.submenuRef
          : this.$refs.menuListRef
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
      this.refreshStackedSubmenuMode()
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
      this.refreshStackedSubmenuMode()
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

    openMapRefInSource() {
      const node = this.node
      if (!node || typeof node.getData !== 'function') return
      const ref = node.getData('mapRef')
      this.hide()
      // 强制按导航模式打开原图（忽略镜像点击分流）
      const normalized = ref && typeof ref === 'object' ? { ...ref } : ref
      if (normalized && typeof normalized === 'object') {
        delete normalized.syncMode
      }
      this.$bus.$emit('openMapRefEdit', normalized)
    },

    async clearMapRef() {
      if (!(await this.canExecuteCommand('REMOVE_MAP_REF'))) return
      if (this.node && typeof this.node.setMapRef === 'function') {
        this.node.setMapRef(null)
      }
      this.hide()
      this.$message.success(this.$t('mapRef.removed'))
      this.$bus.$emit('mapRefMirrorChanged')
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
      this.refreshStackedSubmenuMode()
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
      this.useStackedSubmenu = false
      this.submenuClickGate = false
      this._menuAnchor = null
      this._submenuItemEl = null
      if (this._submenuGateTimer) {
        clearTimeout(this._submenuGateTimer)
        this._submenuGateTimer = null
      }
      if (this._openSubmenuTimer) {
        clearTimeout(this._openSubmenuTimer)
        this._openSubmenuTimer = null
      }
      this.disconnectMenuObserver()
    },

    refreshStackedSubmenuMode() {
      const win = typeof window !== 'undefined' ? window : null
      let coarsePointer = false
      try {
        coarsePointer = !!(
          win &&
          win.matchMedia &&
          win.matchMedia('(pointer: coarse)').matches
        )
      } catch (e) {
        coarsePointer = false
      }
      this.useStackedSubmenu = preferStackedSubmenu(getViewport(win), {
        isMobile: isMobile(),
        coarsePointer
      })
    },

    armSubmenuClickGate(ms = 400) {
      this.submenuClickGate = true
      if (typeof clearTimeout === 'function') clearTimeout(this._submenuGateTimer)
      if (typeof setTimeout !== 'function') {
        this.submenuClickGate = false
        return
      }
      this._submenuGateTimer = setTimeout(() => {
        this._submenuGateTimer = null
        this.submenuClickGate = false
      }, ms)
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

    // 触控下 mouseenter 会在 click 前打开子面板，同一手指会点到「评论」等新行
    onSubmenuTriggerEnter(name, event) {
      if (this.useStackedSubmenu) return
      this.openSubmenu(name, event)
    },

    onSubmenuTriggerClick(name, event) {
      this.refreshStackedSubmenuMode()
      this.openSubmenu(name, event)
    },

    openSubmenu(name, event) {
      this.cancelSubmenuClose()
      this.refreshStackedSubmenuMode()
      const itemEl = event && event.currentTarget
      const changed = this.activeSubmenu !== name || this._submenuItemEl !== itemEl
      this._submenuItemEl = itemEl
      if (this.useStackedSubmenu) {
        // 等本次 tap 结束再换面板，并短暂屏蔽子项，避免误进评论
        if (this._openSubmenuTimer) clearTimeout(this._openSubmenuTimer)
        this.armSubmenuClickGate(450)
        this._openSubmenuTimer = setTimeout(() => {
          this._openSubmenuTimer = null
          this.activeSubmenu = name
          this.submenuMaxHeight = 0
          this.$nextTick(() => this.repositionMenu())
        }, 50)
        return
      }
      this.activeSubmenu = name
      if (changed) {
        // 先用估算尺寸放置，渲染后再按真实尺寸校正
        this.placeSubmenuAt({ width: 280, height: 360 })
        this.submenuMaxHeight = 0
      }
      this.$nextTick(() => this.repositionSubmenu())
    },

    closeSubmenu() {
      this.cancelSubmenuClose()
      if (this._openSubmenuTimer) {
        clearTimeout(this._openSubmenuTimer)
        this._openSubmenuTimer = null
      }
      this.activeSubmenu = ''
      this._submenuItemEl = null
      this.submenuMaxHeight = 0
      this.submenuClickGate = false
      this.$nextTick(() => this.repositionMenu())
    },

    placeSubmenuAt(size) {
      if (this.useStackedSubmenu) return null
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
      if (this.useStackedSubmenu) return
      const el = this.$refs.submenuRef
      if (!this.isShow || !this.activeSubmenu || !el) return
      const rect = el.getBoundingClientRect()
      const height = Math.max(rect.height || 0, el.scrollHeight || 0)
      const placed = this.placeSubmenuAt({ width: rect.width || 280, height })
      if (placed) this.submenuMaxHeight = height > placed.maxHeight ? placed.maxHeight : 0
    },

    scheduleSubmenuClose() {
      // 触控/窄屏钻取面板不靠 hover 关闭；避免 touch 合成 mouseleave 立刻收起
      if (this.useStackedSubmenu) return
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
      const target = event.target
      // 点在菜单 DOM 内：绝不能 stopPropagation，否则整行点不中
      if (this.$el && this.$el.contains && this.$el.contains(target)) return
      const submenu = this.$refs.submenuRef
      if (submenu && submenu.contains && submenu.contains(target)) return
      // 点穿：坐标在菜单上但 target 是画布 —— 只挡画布，并补一次菜单行点击
      if (this.isPointerOverMenu(event)) {
        if (event.stopPropagation) event.stopPropagation()
        if (event.preventDefault) event.preventDefault()
        this.retargetMenuPointer(event)
        return
      }
      this.hide()
    },

    isPointerOverMenu(event) {
      const roots = [this.$el, this.$refs.submenuRef].filter(Boolean)
      const x = event.clientX
      const y = event.clientY
      if (typeof x !== 'number' || typeof y !== 'number') return false
      for (let i = 0; i < roots.length; i++) {
        const el = roots[i]
        if (!el.getBoundingClientRect) continue
        const rect = el.getBoundingClientRect()
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
          return true
        }
      }
      return false
    },

    retargetMenuPointer(event) {
      if (typeof document === 'undefined' || !document.elementFromPoint) return
      if (typeof event.clientX !== 'number' || typeof event.clientY !== 'number') return
      // 临时放开命中层，找出真实菜单行
      const gated = this.$refs.submenuRef
      const wasGated = gated && gated.classList && gated.classList.contains('gated')
      if (wasGated) gated.classList.remove('gated')
      let el = null
      try {
        el = document.elementFromPoint(event.clientX, event.clientY)
      } finally {
        if (wasGated) gated.classList.add('gated')
      }
      while (el && el !== this.$el) {
        if (el.classList && el.classList.contains('item') && !el.classList.contains('disabled')) {
          const testId = el.getAttribute && el.getAttribute('data-testid')
          if (testId === 'submenu-structure') this.onSubmenuTriggerClick('structure', { currentTarget: el })
          else if (testId === 'submenu-content') this.onSubmenuTriggerClick('content', { currentTarget: el })
          else if (testId === 'submenu-style') this.onSubmenuTriggerClick('style', { currentTarget: el })
          else if (testId === 'submenu-more') this.onSubmenuTriggerClick('more', { currentTarget: el })
          else if (typeof el.click === 'function') el.click()
          return
        }
        el = el.parentElement
      }
    },

    onMenuKeydown(event) {
      if (!this.isShow || event.key !== 'Escape') return
      if (event.stopPropagation) event.stopPropagation()
      if (this.activeSubmenu) {
        this.closeSubmenu()
        return
      }
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
      if (this.submenuClickGate) return
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
        case 'UNEXPAND_TO_LEVEL':
          this.runCommand(key, ...args, this.type === 'node' && this.node ? this.node.uid : '')
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
  // 允许手指纵向拖动滚动；勿用 manipulation，否则部分 WebView 拖不动
  touch-action: pan-y;
  -webkit-overflow-scrolling: touch;
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

// 触控设备：隐藏滚动条轨道（拖拇指无效），靠手指滑动内容
@media (pointer: coarse) {
  .menuScroll,
  .submenu {
    scrollbar-width: none;
    -ms-overflow-style: none;

    &::-webkit-scrollbar {
      display: none;
      width: 0;
      height: 0;
    }
  }
}

.submenu {
  position: fixed;
  z-index: 3001;

  &.stacked {
    position: relative;
    left: auto;
    top: auto;
    z-index: auto;
  }

  // 钻取刚打开时屏蔽子项，避免同一手指误点「评论」
  &.gated {
    pointer-events: none;
  }
}

.submenuBack {
  font-weight: 600;

  /deep/ .menuIcon {
    color: #246bff;
  }
}

.contextmenuContainer.stackedOpen {
  .submenu.stacked {
    width: 280px;
    max-width: calc(100vw - 24px);
  }
}

.contextmenuContainer.isDark,
.submenu.isDark {
  color: rgba(255, 255, 255, 0.92);

  .splitLine {
    background: rgba(255, 255, 255, 0.08);
  }

  .item:hover,
  .item.active {
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
  position: relative;
  height: 36px;
  padding: 0 8px;
  border-radius: 8px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
  // 极低透明度底色：保证 flex 空白区也有命中面（纯 transparent 在部分 WebView 会点穿）
  background-color: rgba(255, 255, 255, 0.01);
  // pan-y：菜单超高时可手指拖动滚动；仍禁用双击缩放
  touch-action: pan-y;
  -webkit-tap-highlight-color: transparent;

  // 整行命中层：盖住图标透明区与字右侧空白，点击一定落到本行
  &::after {
    content: '';
    position: absolute;
    inset: 0;
    z-index: 1;
    border-radius: inherit;
  }

  /deep/ .menuIcon {
    flex: none;
    color: #667085;
    pointer-events: none;
    position: relative;
    z-index: 0;
  }

  .name {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    position: relative;
    z-index: 0;
  }

  .desc {
    flex: none;
    color: #98a2b3;
    font-size: 12px;
    position: relative;
    z-index: 0;
  }

  &:hover,
  &.active {
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
