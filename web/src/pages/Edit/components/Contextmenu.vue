<template>
  <div
    class="contextmenuContainer listBox"
    v-if="isShow"
    ref="contextmenuRef"
    :style="{ left: left + 'px', top: top + 'px' }"
    :class="{ isDark: isDark, nodeMenu: type === 'node' }"
  >
    <template v-if="type === 'node'">
      <div
        class="item"
        @click="exec('INSERT_NODE', insertNodeBtnDisabled)"
        :class="{ disabled: insertNodeBtnDisabled }"
      >
        <span class="name">{{ $t('contextmenu.insertSiblingNode') }}</span>
        <span class="desc">Enter</span>
      </div>
      <div
        class="item"
        @click="exec('INSERT_CHILD_NODE')"
      >
        <span class="name">{{ $t('contextmenu.insertChildNode') }}</span>
        <span class="desc">Tab</span>
      </div>
      <div
        class="item"
        @click="exec('INSERT_PARENT_NODE', insertNodeBtnDisabled)"
        :class="{ disabled: insertNodeBtnDisabled }"
      >
        <span class="name">{{ $t('contextmenu.insertParentNode') }}</span>
        <span class="desc">Shift + Tab</span>
      </div>
      <div
        class="item"
        data-testid="insert-summary"
        @click="exec('ADD_GENERALIZATION', insertSummaryBtnDisabled)"
        :class="{ disabled: insertSummaryBtnDisabled }"
      >
        <span class="name">{{ $t('contextmenu.insertSummary') }}</span>
        <span class="desc">Ctrl + G</span>
      </div>
      <div class="splitLine"></div>
      <div
        class="item"
        @click="exec('UP_NODE', upNodeBtnDisabled)"
        :class="{ disabled: upNodeBtnDisabled }"
      >
        <span class="name">{{ $t('contextmenu.moveUpNode') }}</span>
        <span class="desc">Ctrl + ↑</span>
      </div>
      <div
        class="item"
        @click="exec('DOWN_NODE', downNodeBtnDisabled)"
        :class="{ disabled: downNodeBtnDisabled }"
      >
        <span class="name">{{ $t('contextmenu.moveDownNode') }}</span>
        <span class="desc">Ctrl + ↓</span>
      </div>
      <div class="item" @click="exec('UNEXPAND_ALL')">
        <span class="name">{{ $t('contextmenu.unExpandNodeChild') }}</span>
      </div>
      <div class="item" @click="exec('EXPAND_ALL')">
        <span class="name">{{ $t('contextmenu.expandNodeChild') }}</span>
      </div>
      <div class="splitLine"></div>
      <div class="item danger" @click="exec('REMOVE_NODE')">
        <span class="name">{{ $t('contextmenu.deleteNode') }}</span>
        <span class="desc">Delete</span>
      </div>
      <div class="item danger" @click="exec('REMOVE_CURRENT_NODE')">
        <span class="name">{{ $t('contextmenu.deleteCurrentNode') }}</span>
        <span class="desc">Shift + Backspace</span>
      </div>
      <div class="splitLine"></div>
      <div
        class="item"
        @click="exec('COPY_NODE', isGeneralization)"
        :class="{ disabled: isGeneralization }"
      >
        <span class="name">{{ $t('contextmenu.copyNode') }}</span>
        <span class="desc">Ctrl + C</span>
      </div>
      <div
        class="item"
        @click="exec('CUT_NODE', isGeneralization)"
        :class="{ disabled: isGeneralization }"
      >
        <span class="name">{{ $t('contextmenu.cutNode') }}</span>
        <span class="desc">Ctrl + X</span>
      </div>
      <div class="item" @click="exec('PASTE_NODE')">
        <span class="name">{{ $t('contextmenu.pasteNode') }}</span>
        <span class="desc">Ctrl + V</span>
      </div>
      <div class="splitLine"></div>
      <div class="item" data-testid="mapref" @click="openMapRef">
        <span class="name">{{ $t('contextmenu.mapRef') }}</span>
      </div>
      <div class="item" @click="clearMapRef" v-if="hasMapRef">
        <span class="name">{{ $t('contextmenu.removeMapRef') }}</span>
      </div>
      <div class="item" @click="exec('REMOVE_HYPERLINK')" v-if="hasHyperlink">
        <span class="name">{{ $t('contextmenu.removeHyperlink') }}</span>
      </div>
      <div class="item" @click="exec('REMOVE_NOTE')" v-if="hasNote">
        <span class="name">{{ $t('contextmenu.removeNote') }}</span>
      </div>
      <div class="item" @click="exec('REMOVE_CUSTOM_STYLES')">
        <span class="name">{{ $t('contextmenu.removeCustomStyles') }}</span>
      </div>
      <div class="item" @click="exec('EXPORT_CUR_NODE_TO_PNG')">
        <span class="name">{{ $t('contextmenu.exportNodeToPng') }}</span>
      </div>
      <div class="splitLine" v-if="enableAi"></div>
      <div class="item" @click="aiCreate" v-if="enableAi">
        <span class="name">{{ $t('contextmenu.aiCreate') }}</span>
      </div>
    </template>
    <template v-if="type === 'svg'">
      <div class="item" @click="exec('RETURN_CENTER')">
        <span class="name">{{ $t('contextmenu.backCenter') }}</span>
        <span class="desc">Ctrl + Enter</span>
      </div>
      <div class="splitLine"></div>
      <div class="item" @click="exec('EXPAND_ALL')">
        <span class="name">{{ $t('contextmenu.expandAll') }}</span>
      </div>
      <div class="item" @click="exec('UNEXPAND_ALL')">
        <span class="name">{{ $t('contextmenu.unExpandAll') }}</span>
      </div>
      <div class="item">
        <span class="name">{{ $t('contextmenu.expandTo') }}</span>
        <span class="el-icon-arrow-right"></span>
        <div
          class="subItems listBox"
          :class="{ isDark: isDark, showLeft: subItemsShowLeft }"
          style="top: -10px"
        >
          <div
            class="item"
            v-for="(item, index) in expandList"
            :key="item"
            @click="exec('UNEXPAND_TO_LEVEL', false, index + 1)"
          >
            {{ item }}
          </div>
        </div>
      </div>
      <div class="splitLine"></div>
      <div class="item" @click="exec('RESET_LAYOUT')">
        <span class="name">{{ $t('contextmenu.arrangeLayout') }}</span>
        <span class="desc">Ctrl + L</span>
      </div>
      <div class="item" @click="exec('FIT_CANVAS')">
        <span class="name">{{ $t('contextmenu.fitCanvas') }}</span>
        <span class="desc">Ctrl + i</span>
      </div>
      <div class="item" @click="exec('TOGGLE_ZEN_MODE')">
        <span class="name">{{ $t('contextmenu.zenMode') }}</span>
        {{ isZenMode ? '√' : '' }}
      </div>
      <div class="splitLine"></div>
      <div class="item" @click="exec('REMOVE_ALL_NODE_CUSTOM_STYLES')">
        <span class="name">{{
          $t('contextmenu.removeAllNodeCustomStyles')
        }}</span>
      </div>
      <div class="item">
        <span class="name">{{ $t('contextmenu.copyToClipboard') }}</span>
        <span class="el-icon-arrow-right"></span>
        <div
          class="subItems listBox"
          :class="{ isDark: isDark, showLeft: subItemsShowLeft }"
          style="top: -130px"
        >
          <div
            class="item"
            v-for="item in copyList"
            :key="item.value"
            @click="copyToClipboard(item.value)"
          >
            {{ item.name }}
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script>
import { mapState, mapMutations } from 'vuex'
import { getTextFromHtml, imgToDataUrl } from 'simple-mind-map/src/utils'
import { transformToMarkdown } from 'simple-mind-map/src/parse/toMarkdown'
import { transformToTxt } from 'simple-mind-map/src/parse/toTxt'
import { setDataToClipboard, setImgToClipboard, copy } from '@/utils'
import { numberTypeList, numberLevelList } from '@/config'

// 右键菜单
export default {
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
      selectedNodes: []
    }
  },
  computed: {
    ...mapState({
      isZenMode: state => state.localConfig.isZenMode,
      isDark: state => state.localConfig.isDark,
      enableAi: state => state.localConfig.enableAi
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
      return !!this.node.getData('hyperlink')
    },
    hasMapRef() {
      const ref = this.node && this.node.getData && this.node.getData('mapRef')
      return !!(ref && (ref.mapId || ref.map_id || ref.room_key))
    },
    hasNote() {
      return !!this.node.getData('note')
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
  beforeDestroy() {
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
    ...mapMutations(['setLocalConfig']),

    // 计算右键菜单元素的显示位置
    getShowPosition(x, y) {
      const rect = this.$refs.contextmenuRef.getBoundingClientRect()
      if (x + rect.width > window.innerWidth) {
        x = x - rect.width - 20
      }
      this.subItemsShowLeft = x + rect.width + 150 > window.innerWidth
      if (y + rect.height > window.innerHeight) {
        y = window.innerHeight - rect.height - 10
      }
      return { x: Math.max(10, x), y: Math.max(10, y) }
    },

    // 节点右键显示
    show(e, node) {
      this.type = 'node'
      this.isShow = true
      this.node = node
      this.selectedNodes = this.collectSelectedNodes(node)
      const number = this.node && this.node.getData && this.node.getData('number')
      if (number) {
        this.numberType = number.type || 1
        this.numberLevel = number.level === '' ? 1 : number.level
      }
      this.$nextTick(() => {
        if (!this.isShow || !this.$refs.contextmenuRef) return
        const { x, y } = this.getShowPosition(e.clientX + 10, e.clientY + 10)
        this.left = x
        this.top = y
      })
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
      this.selectedNodes = list.slice()
      const number = anchor && anchor.getData && anchor.getData('number')
      if (number) {
        this.numberType = number.type || 1
        this.numberLevel = number.level === '' ? 1 : number.level
      }
      this.$nextTick(() => {
        if (!this.isShow || !this.$refs.contextmenuRef) return
        const { x, y } = this.getShowPosition(
          (clientX || 0) + 10,
          (clientY || 0) + 10
        )
        this.left = x
        this.top = y
      })
      return true
    },

    nodeUid(node) {
      if (!node) return ''
      return (node.getData && node.getData('uid')) || node.uid || ''
    },

    collectSelectedNodes(node) {
      const renderer = this.mindMap && this.mindMap.renderer
      const active = (renderer && renderer.activeNodeList) || []
      const select = this.mindMap && this.mindMap.select
      const cached =
        select && typeof select.getMultiSelectCache === 'function'
          ? select.getMultiSelectCache()
          : []
      const uid = this.nodeUid(node)
      if (
        cached.length > 1 &&
        cached.some(item => this.nodeUid(item) === uid)
      ) {
        return cached.slice()
      }
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
      const select = this.mindMap && this.mindMap.select
      if (select && typeof select.getMultiSelectCache === 'function') {
        return select.getMultiSelectCache() || []
      }
      return []
    },

    // 画布右键显示
    show2(e) {
      this.hide()
      this.type = 'svg'
      this.isShow = true
      this.$nextTick(() => {
        if (!this.isShow || !this.$refs.contextmenuRef) return
        const { x, y } = this.getShowPosition(e.clientX + 10, e.clientY + 10)
        this.left = x
        this.top = y
      })
    },

    // 隐藏
    hide() {
      this.isShow = false
      this.left = -9999
      this.top = -9999
      this.type = ''
      this.node = ''
      this.selectedNodes = []
      this.numberType = ''
      this.numberLevel = ''
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
  width: 250px;
  background: #fff;
  box-shadow: 0 4px 12px 0 hsla(0, 0%, 69%, 0.5);
  border-radius: 4px;
  padding-top: 16px;
  padding-bottom: 16px;

  &.isDark {
    background: #363b3f;
  }
}
.contextmenuContainer {
  position: fixed;
  max-width: calc(100vw - 20px);
  max-height: calc(100vh - 20px);
  box-sizing: border-box;
  // 只有节点菜单需要滚动；画布菜单保留可溢出的子菜单。
  &.nodeMenu {
    overflow-y: auto;
  }
  font-size: 14px;
  font-family: PingFangSC-Regular, PingFang SC;
  font-weight: 400;
  color: #1a1a1a;

  &.isDark {
    color: #fff;

    .item {
      &:hover {
        background: hsla(0, 0%, 100%, 0.05);
      }
    }
  }

  .splitLine {
    width: 95%;
    height: 1px;
    background-color: #e9edf2;
    margin: 2px auto;
  }

  .item {
    position: relative;
    height: 28px;
    padding: 0 16px;
    cursor: pointer;
    display: flex;
    justify-content: space-between;
    align-items: center;

    &.danger {
      color: #f56c6c;
    }

    &:hover {
      background: #f5f5f5;

      .subItems {
        visibility: visible;
      }
    }

    &.disabled {
      color: grey;
      cursor: not-allowed;
      pointer-events: none;

      &:hover {
        background: #fff;
      }
    }

    .name {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .desc {
      color: #999;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .subItems {
      position: absolute;
      left: 100%;
      visibility: hidden;
      width: 150px;
      cursor: auto;

      &.showLeft {
        left: -150px;
      }
    }
  }
}
</style>
