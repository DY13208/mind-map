<template>
  <section class="attachmentDocumentLayout">
    <aside v-if="kind === 'markdown' && navigationOutline.length > 1" class="attachmentOutline" aria-label="文档目录">
      <h3>目录</h3>
      <button v-for="item in navigationOutline" :key="item.id" type="button" :class="{ active: activeHeading === item.id || (!activeHeading && item.id === navigationOutline[0].id), nested: item.level > 2 }" @click="goToHeading(item)">{{ item.title }}</button>
    </aside>
    <div ref="viewport" class="attachmentDocumentViewport" :class="{ 'is-initial-loading': loading && !chunks.length }" tabindex="0" aria-label="文档内容" @scroll.passive="onScroll">
      <div v-if="error && !chunks.length" class="attachmentViewerState" role="alert"><i class="el-icon-warning-outline"></i><strong>{{ error }}</strong><el-button size="small" @click="$emit('download')">下载原文件</el-button></div>
      <article v-else :class="kind === 'markdown' ? 'attachmentMarkdownDocument' : ['attachmentTextDocument', { 'is-code': isCode }]">
        <template v-for="chunk in chunks">
          <section v-if="kind === 'markdown'" :key="chunk.id" class="attachmentDocumentChunk" v-html="chunk.html"></section>
          <pre v-else :key="chunk.id" class="attachmentTextChunk"><code v-if="chunk.html" v-html="chunk.html"></code><template v-else>{{ chunk.text }}</template></pre>
        </template>
        <div ref="sentinel" class="attachmentLoadSentinel" role="status">
          <template v-if="loading"><i class="el-icon-loading"></i> 正在加载…</template>
          <template v-else-if="error">{{ error }} <button type="button" @click="$emit('download')">下载原文件</button></template>
          <template v-else-if="clipped">已达到预览上限，完整内容请下载查看</template>
          <button v-else-if="!done" type="button" @click="loadMore">继续加载</button>
        </div>
      </article>
    </div>
  </section>
</template>
<script>
import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import python from 'highlight.js/lib/languages/python'
import json from 'highlight.js/lib/languages/json'
import xml from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'
import sql from 'highlight.js/lib/languages/sql'
import { openProgressiveAttachmentText } from '@/utils/attachmentProgressiveText'

for (const [name, language] of Object.entries({ javascript, python, json, xml, css, sql })) hljs.registerLanguage(name, language)
const escaped = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
export default {
  props: { source: { type: Object, required: true }, kind: { type: String, required: true } },
  data: () => ({ chunks: [], outline: [], activeHeading: '', loading: false, error: '', done: false, clipped: false }),
  computed: {
    navigationOutline() {
      const sections = this.outline.filter(item => item.level === 2 && item.title !== '目录')
      return sections.length ? sections : this.outline.filter(item => item.title !== '目录')
    },
    isCode() { return /\.(js|ts|jsx|tsx|json|css|scss|less|py|java|go|rs|c|cpp|h|sh|sql|xml|ya?ml|vue|toml|ini|conf)$/i.test(this.source.fileName) }
  },
  mounted() { this.open() },
  beforeDestroy() {
    this._disposed = true
    if (this._observer) this._observer.disconnect()
    if (this._controller) this._controller.abort()
    if (this._reader) this._reader.cancel()
    this._pending = ''
  },
  methods: {
    async open() {
      this._pending = ''
      this._headingCount = 0
      this._md = new MarkdownIt({
        html: false, linkify: true, breaks: false,
        highlight: (code, language) => language && hljs.getLanguage(language) && code.length < 50000
          ? hljs.highlight(language, code, true).value : escaped(code)
      })
      const originalImage = this._md.renderer.rules.image
      this._md.renderer.rules.image = (tokens, index, options, env, renderer) => {
        tokens[index].attrSet('loading', 'lazy')
        tokens[index].attrSet('decoding', 'async')
        tokens[index].attrSet('referrerpolicy', 'no-referrer')
        return originalImage(tokens, index, options, env, renderer)
      }
      this._md.renderer.rules.heading_open = (tokens, index) => {
        const token = tokens[index]
        const id = 'attachment-heading-' + (++this._headingCount)
        if (Number(token.tag.slice(1)) <= 2 && this.outline.length < 150) {
          this.outline.push(Object.freeze({ id, level: Number(token.tag.slice(1)), title: tokens[index + 1].content }))
        }
        return '<' + token.tag + ' id="' + id + '">'
      }
      this._controller = new AbortController()
      this.loading = true
      try {
        this._reader = await openProgressiveAttachmentText(this.source.url, this._controller.signal)
        if (this._disposed) { this._reader.cancel(); return }
        this.loading = false
        await this.loadMore()
        if (this._disposed) return
        this._observer = new IntersectionObserver(entries => {
          if (entries.some(entry => entry.isIntersecting)) this.loadMore()
        }, { root: this.$refs.viewport, rootMargin: '180px' })
        this._observer.observe(this.$refs.sentinel)
      } catch (error) {
        if (!this._disposed && error.name !== 'AbortError') this.error = error.message
      } finally { if (!this._disposed) this.loading = false }
    },
    async loadMore() {
      if (this.loading || this.done || !this._reader || this._disposed) return
      this.loading = true
      this.error = ''
      try {
        const part = await this._reader.next()
        if (this._disposed) return
        this.done = part.done
        this.clipped = part.clipped
        this._pending += part.text
        if (this.kind === 'markdown') this.appendMarkdown(part.done)
        else {
          // Avoid inserting a visual line break at an arbitrary byte boundary.
          const end = this._pending.lastIndexOf('\n')
          const text = part.done || this._pending.length >= 64 * 1024 ? this._pending : this._pending.slice(0, end + 1)
          const ext = this.source.fileName.split('.').pop().toLowerCase()
          const language = ({ js: 'javascript', ts: 'javascript', jsx: 'javascript', tsx: 'javascript', py: 'python', json: 'json', xml: 'xml', html: 'xml', vue: 'xml', css: 'css', sql: 'sql' })[ext]
          if (text) {
            const html = language && text.length < 50000 ? hljs.highlight(language, text, true).value : ''
            this.chunks.push(Object.freeze({ id: this.chunks.length, text, html }))
            this._pending = this._pending.slice(text.length)
          }
        }
        await this.$nextTick()
      } catch (error) { if (!this._disposed && error.name !== 'AbortError') this.error = error.message || '加载失败' }
      finally {
        if (!this._disposed) {
          this.loading = false
          if (!this.chunks.length && !this.done && !this.error) setTimeout(() => this.loadMore(), 0)
        }
      }
    },
    appendMarkdown(done) {
      let text = this._pending
      if (!done) {
        const lines = text.split('\n')
        const blocks = this._md.parse(text, {}).filter(token => token.level === 0 && token.map)
        const last = blocks[blocks.length - 1]
        const end = last ? last.map[0] : 0
        text = lines.slice(0, end).join('\n') + (end ? '\n' : '')
        if (!text && this._pending.length > 128 * 1024) {
          const plain = this._pending.slice(0, 64 * 1024)
          this.chunks.push(Object.freeze({ id: this.chunks.length, html: '<pre><code>' + escaped(plain) + '</code></pre>' }))
          this._pending = this._pending.slice(plain.length)
          return
        }
      }
      if (text) {
        const html = this._md.render(text)
        this.chunks.push(Object.freeze({ id: this.chunks.length, html }))
        this._pending = this._pending.slice(text.length)
      }
    },
    onScroll() {
      const element = this.$refs.viewport
      if (element.scrollHeight - element.scrollTop - element.clientHeight < 250) this.loadMore()
    },
    goToHeading(item) {
      this.activeHeading = item.id
      const element = this.$refs.viewport.querySelector('#' + item.id)
      if (element) element.scrollIntoView({ block: 'start', behavior: 'smooth' })
    }
  }
}
</script>
