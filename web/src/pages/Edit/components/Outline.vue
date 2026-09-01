<template>
  <el-tree
    :key="treeVersion"
    ref="tree"
    class="outlineTree"
    node-key="uid"
    draggable
    lazy
    :class="{ isDark: isDark }"
    :data="data"
    :props="defaultProps"
    :load="loadNode"
    :default-expanded-keys="defaultExpandedKeys"
    :highlight-current="true"
    :expand-on-click-node="false"
    :allow-drag="checkAllowDrag"
    @node-drop="onNodeDrop"
    @node-drag-start="onNodeDragStart"
    @node-drag-end="onNodeDragEnd"
    @current-change="onCurrentChange"
    @mouseenter.native="isInTreArea = true"
    @mouseleave.native="isInTreArea = false"
  >
    <span
      class="customNode"
      slot-scope="{ node, data }"
      :data-id="data.uid"
      @click="onClick(data)"
    >
      <span
        class="nodeEdit"
        :contenteditable="!isReadonly"
        :key="getKey()"
        @keydown.stop="onNodeInputKeydown($event, node)"
        @keyup.stop
        @blur="onBlur($event, node)"
        @paste="onPaste($event, node)"
        v-html="node.label"
      ></span>
    </span>
  </el-tree>
</template>

<script>
import { mapState, mapMutations } from 'vuex'
import {
  nodeRichTextToTextWithWrap,
  textToNodeRichTextWithWrap,
  createUid,
  htmlEscape,
  handleInputPasteText
} from 'simple-mind-map/src/utils'

// 大纲树
export default {
  props: {
    mindMap: {
      type: Object
    }
  },
  data() {
    return {
      data: [],
      defaultProps: {
        label: 'label',
        children: 'children',
        isLeaf: 'isLeaf'
      },
      treeVersion: 0,
      defaultExpandedKeys: [],
      currentData: null,
      notHandleDataChange: false,
      isHandleNodeTreeRenderEnd: false,
      beInsertNodeUid: '',
      pendingExpandedUid: '',
      insertType: '',
      isInTreArea: false,
      isAfterCreateNewNode: false
    }
  },
  computed: {
    ...mapState({
      isReadonly: state => state.isReadonly,
      isDark: state => state.localConfig.isDark
    })
  },
  created() {
    // These caches deliberately stay outside Vue's reactive data. Keeping the
    // original node here prevents Vue from observing the complete mind map when
    // the outline only needs to render a small, expanded portion of it.
    this._outlineSourceByData = new WeakMap()
    window.addEventListener('keydown', this.onKeyDown)
    this.$bus.$on('data_change', this.handleDataChange)
    this.$bus.$on('node_tree_render_end', this.handleNodeTreeRenderEnd)
    this.$bus.$on('hide_text_edit', this.handleHideTextEdit)
  },
  mounted() {
    this.refresh()
  },
  beforeDestroy() {
    window.removeEventListener('keydown', this.onKeyDown)
    this.$bus.$off('data_change', this.handleDataChange)
    this.$bus.$off('node_tree_render_end', this.handleNodeTreeRenderEnd)
    this.$bus.$off('hide_text_edit', this.handleHideTextEdit)
  },
  methods: {
    ...mapMutations(['setIsDragOutlineTreeNode']),

    handleHideTextEdit() {
      if (this.notHandleDataChange) {
        this.notHandleDataChange = false
        this.refresh()
      }
    },

    handleDataChange() {
      // 在大纲里操作节点时不要响应该事件，否则会重新刷新树
      if (this.notHandleDataChange) {
        this.notHandleDataChange = false
        this.isAfterCreateNewNode = false
        return
      }
      if (this.isAfterCreateNewNode) {
        this.isAfterCreateNewNode = false
        return
      }
      this.refresh()
    },

    handleNodeTreeRenderEnd() {
      // 当前存在未完成的节点插入操作
      if (this.insertType) {
        this[this.insertType]()
        this.insertType = ''
        return
      }
      // 插入了新节点后需要做一些操作
      if (this.isHandleNodeTreeRenderEnd) {
        this.isHandleNodeTreeRenderEnd = false
        this.refresh()
        this.$nextTick(() => {
          this.afterCreateNewNode()
        })
      }
    },

    // 刷新树数据
    refresh() {
      const expandedKeys = this.getExpandedKeys()
      // renderTree is already maintained by the renderer. Reading it directly
      // avoids getData() deep-cloning every node merely to open the outline.
      const sourceData =
        this.mindMap.renderer.renderTree || this.mindMap.getData()
      const rootData = this.createOutlineNode(sourceData, true)

      this.data = [rootData]
      // The root remains open by default, while all of its descendants are
      // created only after their parent is expanded for the first time.
      this.defaultExpandedKeys = Array.from(
        new Set([rootData.uid, this.pendingExpandedUid, ...expandedKeys])
      ).filter(Boolean)
      this.treeVersion += 1
    },

    // 只转换当前层。原始 children 不放入响应式数据，避免 Vue 一次观察整棵树
    createOutlineNode(source, isRoot = false) {
      let text = source.data.richText
        ? nodeRichTextToTextWithWrap(source.data.text)
        : source.data.text
      text = htmlEscape(text).replace(/\n/g, '<br>')
      const hasChildren = Boolean(
        (source.children && source.children.length) ||
          (source.data && source.data.childCount > 0)
      )
      const outlineData = {
        data: source.data,
        root: isRoot,
        textCache: text,
        label: text,
        uid: source.data.uid,
        isLeaf: !hasChildren
      }

      this._outlineSourceByData.set(outlineData, source)
      return outlineData
    },

    // Element Tree invokes this only when a branch is expanded for the first time
    async loadNode(node, resolve) {
      if (node.level === 0) {
        resolve(this.data)
        return
      }
      let source = this._outlineSourceByData.get(node.data)
      const cooperate = this.mindMap && this.mindMap.cooperate
      if (
        cooperate &&
        cooperate.httpCollabMode &&
        source &&
        (!source.children || !source.children.length) &&
        source.data &&
        source.data.childCount > 0
      ) {
        source = (await cooperate.hydrateNodeData(source)) || source
      }
      if (!source || !source.children || source.children.length === 0) {
        resolve([])
        return
      }
      resolve(source.children.map(item => this.createOutlineNode(item)))
    },

    getExpandedKeys() {
      const tree = this.$refs.tree
      if (!tree || !tree.store || !tree.store.nodesMap) return []
      return Object.keys(tree.store.nodesMap).filter(key => {
        const node = tree.store.nodesMap[key]
        return node && node.expanded
      })
    },

    // 插入了新节点之后
    afterCreateNewNode() {
      // 如果是新插入节点，那么需要手动高亮该节点、定位该节点及聚焦
      let id = this.beInsertNodeUid
      if (id && this.$refs.tree) {
        try {
          this.isAfterCreateNewNode = true
          // 高亮树节点
          this.$refs.tree.setCurrentKey(id)
          let node = this.$refs.tree.getNode(id)
          this.onCurrentChange(node.data)
          // 定位该节点
          this.onClick(node.data)
          // 聚焦该树节点的编辑框
          const el = document.querySelector(
            `.customNode[data-id="${id}"] .nodeEdit`
          )
          if (el) {
            let selection = window.getSelection()
            let range = document.createRange()
            range.selectNodeContents(el)
            selection.removeAllRanges()
            selection.addRange(range)
            let offsetTop = el.offsetTop
            this.$emit('scrollTo', offsetTop)
          }
        } catch (error) {
          console.log(error)
        }
      }
      this.beInsertNodeUid = ''
      this.pendingExpandedUid = ''
    },

    // 根节点不允许拖拽
    checkAllowDrag(node) {
      return !node.data.root
    },

    // 失去焦点更新节点文本
    onBlur(e, node) {
      // 节点数据没有修改
      if (node.data.textCache === e.target.innerHTML) {
        // 如果存在未执行的插入新节点操作，那么直接执行
        if (this.insertType) {
          this[this.insertType]()
          this.insertType = ''
        }
        return
      }
      // 否则插入新节点操作需要等待当前修改事件渲染完成后再执行
      const richText = node.data.data.richText
      const text = richText ? e.target.innerHTML : e.target.innerText
      const targetNode = this.mindMap.renderer.findNodeByUid(node.data.uid)
      if (!targetNode) return
      this.notHandleDataChange = true
      if (richText) {
        targetNode.setText(textToNodeRichTextWithWrap(text), true)
      } else {
        targetNode.setText(text)
      }
    },

    // 拦截粘贴事件
    onPaste(e) {
      handleInputPasteText(e)
    },

    // 生成唯一的key
    getKey() {
      return Math.random()
    },

    // 节点输入区域按键事件
    onNodeInputKeydown(e) {
      if (e.keyCode === 13 && !e.shiftKey) {
        // 插入兄弟节点
        e.preventDefault()
        this.insertType = 'insertNode'
        e.target.blur()
      }
      if (e.keyCode === 9) {
        e.preventDefault()
        if (e.shiftKey) {
          // 节点上升一级
          this.insertType = 'moveUp'
          e.target.blur()
        } else {
          // 插入子节点
          this.insertType = 'insertChildNode'
          e.target.blur()
        }
      }
    },

    // 节点上移一个层级
    moveUp() {
      this.mindMap.execCommand('MOVE_UP_ONE_LEVEL')
    },

    // 插入兄弟节点
    insertNode() {
      this.notHandleDataChange = true
      this.isHandleNodeTreeRenderEnd = true
      this.beInsertNodeUid = createUid()
      this.mindMap.execCommand('INSERT_NODE', false, [], {
        uid: this.beInsertNodeUid
      })
    },

    // 插入下级节点
    insertChildNode() {
      this.notHandleDataChange = true
      this.isHandleNodeTreeRenderEnd = true
      this.beInsertNodeUid = createUid()
      // 新节点需要在刷新后的树中可见，主动展开它的父节点
      this.pendingExpandedUid = this.currentData ? this.currentData.uid : ''
      this.mindMap.execCommand('INSERT_CHILD_NODE', false, [], {
        uid: this.beInsertNodeUid
      })
    },

    // 激活当前节点且移动当前节点到画布中间
    onClick(data) {
      this.notHandleDataChange = true
      const targetNode = this.mindMap.renderer.findNodeByUid(data.uid)
      if (targetNode && targetNode.nodeData.data.isActive) return
      this.mindMap.execCommand('GO_TARGET_NODE', data.uid, () => {
        this.notHandleDataChange = false
      })
    },

    onNodeDragStart() {
      this.setIsDragOutlineTreeNode(true)
    },

    onNodeDragEnd() {
      this.setIsDragOutlineTreeNode(false)
    },

    // 拖拽结束事件
    onNodeDrop(data, target, postion) {
      this.notHandleDataChange = true
      const node = this.mindMap.renderer.findNodeByUid(data.data.uid)
      const targetNode = this.mindMap.renderer.findNodeByUid(target.data.uid)
      if (!node || !targetNode) {
        return
      }
      switch (postion) {
        case 'before':
          this.mindMap.execCommand('INSERT_BEFORE', node, targetNode)
          break
        case 'after':
          this.mindMap.execCommand('INSERT_AFTER', node, targetNode)
          break
        case 'inner':
          this.mindMap.execCommand('MOVE_NODE_TO', node, targetNode)
          break
        default:
          break
      }
    },

    // 当前选中的树节点变化事件
    onCurrentChange(data) {
      this.currentData = data
    },

    // 删除节点
    onKeyDown(e) {
      if (!this.isInTreArea) return
      if ([46, 8].includes(e.keyCode) && this.currentData) {
        e.stopPropagation()
        this.mindMap.renderer.textEdit.hideEditTextBox()
        const node = this.mindMap.renderer.findNodeByUid(this.currentData.uid)
        if (node && !node.isRoot) {
          this.notHandleDataChange = true
          this.$refs.tree.remove(this.currentData)
          this.mindMap.execCommand('REMOVE_NODE', [node])
        }
      }
    }
  }
}
</script>

<style lang="less" scoped>
.customNode {
  width: 100%;
  color: rgba(0, 0, 0, 0.85);
  font-weight: bold;

  .nodeEdit {
    outline: none;
    white-space: normal;
    padding-right: 20px;
  }
}
</style>
<style lang="less" scoped>
@import url('../../../style/outlineTree.less');
</style>
