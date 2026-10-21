<template>
  <Sidebar ref="sidebar" :title="$t('note.title')">
    <div class="noteContentWrap" ref="noteContentWrap"></div>
  </Sidebar>
</template>

<script>
import Sidebar from './Sidebar.vue'
import { mapState, mapMutations } from 'vuex'
import Viewer from '@toast-ui/editor/dist/toastui-editor-viewer'
import '@toast-ui/editor/dist/toastui-editor-viewer.css'
import '@toast-ui/editor/dist/theme/toastui-editor-dark.css'

export default {
  components: {
    Sidebar
  },
  props: {
    mindMap: {
      type: Object
    }
  },
  data() {
    return {
      editor: null,
      nodeUid: '',
      renderedNote: ''
    }
  },
  computed: {
    ...mapState({
      isDark: state => state.localConfig.isDark,
      activeSidebar: state => state.activeSidebar
    })
  },
  watch: {
    isDark() {
      this.applyViewerTheme()
    },
    activeSidebar(val) {
      if (val === 'noteSidebar') {
        this.$refs.sidebar.show = true
      } else {
        this.$refs.sidebar.show = false
      }
    }
  },
  created() {
    this.$bus.$on('node_active', this.onNodeActive)
    this.mindMap.on('node_note_click', this.onNodeNoteClick)
    this.mindMap.on('data_change', this.onMapDataChange)
  },
  mounted() {
    this.initEditor()
  },
  beforeDestroy() {
    this.$bus.$off('node_active', this.onNodeActive)
    this.mindMap.off('node_note_click', this.onNodeNoteClick)
    this.mindMap.off('data_change', this.onMapDataChange)
  },
  methods: {
    ...mapMutations(['setActiveSidebar']),

    onNodeActive(...args) {
      if (this.activeSidebar !== 'noteSidebar') {
        return
      }
      const nodes = [...args[1]]
      if (nodes.length > 0) {
        if (String(nodes[0].getData('uid')) !== this.nodeUid) {
          this.setActiveSidebar(null)
        }
      } else {
        this.setActiveSidebar(null)
      }
    },

    // 初始化编辑器
    initEditor() {
      if (!this.editor) {
        this.editor = new Viewer({
          el: this.$refs.noteContentWrap
        })
      }
      this.applyViewerTheme()
    },

    applyViewerTheme() {
      const el = this.$refs.noteContentWrap
      if (el) el.classList.toggle('toastui-editor-dark', !!this.isDark)
    },

    onNodeNoteClick(node) {
      this.nodeUid = String(node.getData('uid') || '')
      this.setActiveSidebar('noteSidebar')
      this.renderNote(node.getData('note') || '')
    },

    onMapDataChange() {
      if (this.activeSidebar !== 'noteSidebar' || !this.nodeUid || !this.mindMap.renderer) return
      const node = this.mindMap.renderer.findNodeByUid(this.nodeUid)
      if (!node) {
        this.setActiveSidebar(null)
        return
      }
      this.renderNote(node.getData('note') || '')
    },

    renderNote(note) {
      const content = String(note || '')
      if (content === this.renderedNote) return
      this.renderedNote = content
      this.editor.setMarkdown(content)
    }
  }
}
</script>

<style lang="less" scoped>
.noteContentWrap {
  padding: 12px 20px;

  &.toastui-editor-dark {
    color: hsla(0, 0%, 100%, 0.85);

    /deep/ .toastui-editor-contents {
      color: hsla(0, 0%, 100%, 0.85);
    }
  }
}
</style>
