<template>
  <el-dialog
    title="AI续写"
    :visible.sync="visible"
    width="480px"
    append-to-body
    :close-on-click-modal="false"
  >
    <el-input
      v-model="instruction"
      type="textarea"
      :rows="6"
      placeholder="请输入希望 AI 续写的内容"
    />
    <span slot="footer">
      <el-button @click="visible = false">取消</el-button>
      <el-button v-if="loading" type="warning" @click="stop">停止生成</el-button>
      <el-button v-else type="primary" :disabled="!instruction.trim()" @click="generate">生成</el-button>
    </span>
  </el-dialog>
</template>

<script>
import { mapState } from 'vuex'
import Ai from '@/utils/ai'
import { transformMarkdownTo } from 'simple-mind-map/src/parse/markdownTo'
import { createUid, getStrWithBrFromHtml } from 'simple-mind-map/src/utils'

export default {
  name: 'SopMapAiContinue',
  props: {
    mindMap: { type: Object, default: null },
    editable: { type: Boolean, default: false }
  },
  data() {
    return {
      visible: false,
      instruction: '',
      target: null,
      loading: false,
      ai: null
    }
  },
  computed: {
    ...mapState(['aiConfig'])
  },
  created() {
    this.$bus.$on('ai_create_part', this.open)
  },
  beforeDestroy() {
    this.$bus.$off('ai_create_part', this.open)
    this.stop(false)
  },
  methods: {
    open(node) {
      if (!this.editable) {
        this.$message.warning('当前为只读权限，无法修改导图')
        return
      }
      this.target = node
      const text = node && node.getData ? node.getData('text') : ''
      this.instruction = `请围绕“${getStrWithBrFromHtml(text || '')}”续写子节点。`
      this.visible = true
    },
    stampUids(tree) {
      const walk = node => {
        if (!node.data) node.data = {}
        if (!node.data.uid) node.data.uid = createUid()
        ;(node.children || []).forEach(walk)
      }
      walk(tree)
      return tree
    },
    async generate() {
      if (!this.target || !this.mindMap || !this.instruction.trim()) return
      const cfg = this.aiConfig || {}
      if (!(cfg.api && cfg.key && cfg.model && cfg.port)) {
        this.$message.warning('请先在主脑图的 AI 设置中完成配置')
        return
      }
      this.loading = true
      let content = ''
      this.ai = new Ai({ port: cfg.port })
      this.ai.init('huoshan', cfg)
      this.ai.request(
        {
          messages: [{
            role: 'user',
            content: `${this.instruction.trim()}\n请只返回 Markdown 层级列表，不要解释。`
          }]
        },
        value => { content = value || content },
        value => {
          try {
            content = value || content
            const parsed = this.stampUids(transformMarkdownTo(content))
            const children = parsed.children || []
            if (!children.length) throw new Error('AI 未返回可插入的节点')
            this.mindMap.execCommand('INSERT_MULTI_CHILD_NODE', [this.target], children)
            this.$message.success('AI续写内容已插入并同步')
            this.visible = false
          } catch (err) {
            this.$message.error((err && err.message) || 'AI续写失败')
          } finally {
            this.loading = false
            this.ai = null
          }
        },
        err => {
          this.loading = false
          this.ai = null
          this.$message.error((err && err.message) || 'AI续写失败')
        }
      )
    },
    stop(showMessage = true) {
      if (this.ai && this.ai.stop) this.ai.stop()
      this.ai = null
      this.loading = false
      if (showMessage) this.$message.success('已停止生成')
    }
  }
}
</script>
