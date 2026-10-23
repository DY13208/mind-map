<template>
  <div v-show="open" class="node-text-mention" :style="{ left: left + 'px', top: top + 'px' }" data-testid="node-text-mention" role="listbox" aria-label="选择要提及的人员" @mousedown.prevent.stop>
    <div class="mention-heading">@ 选择人员 · 保存节点后提醒</div>
    <div class="mention-options">
      <button v-for="(person, i) in candidates" :key="person.userId" type="button" role="option" :aria-selected="index === i" :class="{ active: index === i }" @mousedown.prevent.stop="pick(person)">
        <span class="mention-avatar">{{ person.name.slice(0, 1) }}</span>
        <span><strong>{{ person.name }}</strong><small>{{ person.userId }}</small></span>
      </button>
      <div v-if="loading" class="mention-state">正在加载人员…</div>
      <button v-else-if="error" type="button" @mousedown.prevent.stop="search(false)">人员加载失败，点击重试</button>
      <div v-else-if="!candidates.length" class="mention-state">没有匹配人员，请搜索姓名、账号或检查通讯录同步</div>
      <button v-if="nextOffset !== null && !loading" type="button" @mousedown.prevent.stop="search(true)">加载更多人员</button>
    </div>
  </div>
</template>

<script>
import { searchMentionUsers } from '@/services/mentionUsers'
import { currentCommentUser } from '@/utils/commentUser'
import shareService from '@/services/shareService'

export default {
  props: { mindMap: Object, readonly: Boolean },
  data() { return { open: false, people: [], roomMembers: [], index: 0, query: '', left: 0, top: 0, loading: false, error: false, nextOffset: null } },
  computed: {
    candidates() {
      const q = this.query.toLowerCase()
      return this.people.concat(this.roomMembers).filter((m, i, all) => m.userId && m.name && all.findIndex(x => x.userId === m.userId) === i &&
        (!q || (m.name + ' ' + m.userId).toLowerCase().includes(q)))
    }
  },
  created() {
    this.mindMap.on('before_show_text_edit', this.start)
    this.mindMap.on('hide_text_edit', this.finish)
    this.mindMap.on('before_node_text_edit_commit', this.prepare)
  },
  mounted() {
    document.body.appendChild(this.$el)
    document.addEventListener('input', this.onInput, true)
    document.addEventListener('compositionstart', this.onCompositionStart, true)
    document.addEventListener('compositionend', this.onCompositionEnd, true)
    document.addEventListener('keydown', this.onKeydown, true)
    document.addEventListener('selectionchange', this.onSelection)
  },
  beforeDestroy() {
    this.close()
    this.mindMap.off('before_show_text_edit', this.start)
    this.mindMap.off('hide_text_edit', this.finish)
    this.mindMap.off('before_node_text_edit_commit', this.prepare)
    document.removeEventListener('input', this.onInput, true)
    document.removeEventListener('compositionstart', this.onCompositionStart, true)
    document.removeEventListener('compositionend', this.onCompositionEnd, true)
    document.removeEventListener('keydown', this.onKeydown, true)
    document.removeEventListener('selectionchange', this.onSelection)
    if (this.$el.parentNode) this.$el.parentNode.removeChild(this.$el)
  },
  methods: {
    start(node) {
      this.close()
      this.editNode = node
      this.editRoom = this.$route.query.room
      this.pending = ((node.getData('textMentions') || []).filter(m => m && m.userId)).slice()
      this.roomMembers = []
      if (this.editRoom) shareService.getMembers(this.editRoom).then(list => {
        if (this.editNode === node && this.editRoom === this.$route.query.room) this.roomMembers = list.map(m => ({ userId: String(m.userId || m.id || ''), name: m.name, avatar: m.avatar || '' }))
      }).catch(() => {})
    },
    close() { this.open = false; clearTimeout(this.searchTimer); this.requestId = (this.requestId || 0) + 1 },
    editor() {
      const rich = this.mindMap.richText
      if (rich && rich.showTextEdit && rich.quill) return { root: rich.quill.root, quill: rich.quill }
      const plain = this.mindMap.renderer.textEdit
      return plain && plain.showTextEdit ? { root: plain.textEditNode } : null
    },
    onCompositionStart(e) { const editor = this.editor(); if (editor && editor.root.contains(e.target)) { this.composing = true; this.close() } },
    onCompositionEnd(e) { this.composing = false; this.onInput(e) },
    onSelection() { if (this.open) this.onInput() },
    onInput(e) {
      const editor = this.editor()
      if (!editor || !this.editNode || this.readonly || this.composing || (e && !editor.root.contains(e.target))) return
      const selection = window.getSelection()
      if (!selection || !selection.isCollapsed || !selection.rangeCount || !editor.root.contains(selection.anchorNode)) { this.close(); return }
      const range = selection.getRangeAt(0)
      const before = range.cloneRange()
      before.selectNodeContents(editor.root)
      before.setEnd(range.startContainer, range.startOffset)
      const prefix = before.toString()
      const match = /@([^\s@]{0,60})$/.exec(prefix)
      if (!match) { this.close(); return }
      this.mentionRange = before.cloneRange()
      this.mentionRange.setStart(range.startContainer, range.startOffset)
      // Range text offsets may span several formatting elements; walk text nodes to find @.
      const walker = document.createTreeWalker(editor.root, NodeFilter.SHOW_TEXT)
      let offset = prefix.length - match[0].length, part
      while ((part = walker.nextNode())) {
        if (offset <= part.textContent.length) { this.mentionRange.setStart(part, offset); break }
        offset -= part.textContent.length
      }
      this.mentionRange.setEnd(range.startContainer, range.startOffset)
      this.mentionEditor = editor
      const rect = range.getBoundingClientRect()
      const fallback = editor.root.getBoundingClientRect()
      this.left = Math.max(8, Math.min(rect.width || rect.height ? rect.left : fallback.left, window.innerWidth - 308))
      this.top = Math.max(8, Math.min((rect.height ? rect.bottom : fallback.bottom) + 6, window.innerHeight - 316))
      if (!this.open || this.query !== match[1]) {
        this.query = match[1]; this.index = 0; this.open = true; this.people = []; this.nextOffset = null
        clearTimeout(this.searchTimer)
        this.requestId = (this.requestId || 0) + 1
        this.searchTimer = setTimeout(() => this.search(false), 120)
      }
    },
    async search(more) {
      const id = this.requestId = (this.requestId || 0) + 1
      this.loading = true; this.error = false
      try {
        const result = await searchMentionUsers(this.query, more ? this.nextOffset : 0)
        if (id !== this.requestId || !this.open || this.editRoom !== this.$route.query.room) return
        const list = result.list.filter(m => m.userId)
        this.people = more ? this.people.concat(list).filter((m, i, all) => all.findIndex(x => x.userId === m.userId) === i) : list
        this.nextOffset = result.nextOffset
      } catch (e) { if (id === this.requestId) this.error = true }
      finally { if (id === this.requestId) this.loading = false }
    },
    pick(person) {
      const editor = this.editor(), range = this.mentionRange
      if (!editor || editor.root !== this.mentionEditor.root || !range || this.readonly) return
      const token = '@' + person.name + ' '
      this.close()
      if (editor.quill) {
        const selected = editor.quill.getSelection()
        if (!selected) return
        const start = selected.index - this.query.length - 1
        if (start < 0 || editor.quill.getText(start, this.query.length + 1) !== '@' + this.query) return
        // Keep the surrounding font settings, and limit the highlight to the name.
        // Quill's built-in formats survive saving and rendering the node again.
        const base = editor.quill.getFormat(start, 1)
        const normal = { ...base, color: base.color || false, background: base.background || false, bold: base.bold || false }
        editor.quill.deleteText(start, this.query.length + 1, 'user')
        editor.quill.insertText(start, token.slice(0, -1), { ...base, color: '#087d56', background: false, bold: true }, 'user')
        editor.quill.insertText(start + token.length - 1, ' ', normal, 'user')
        editor.quill.setSelection(start + token.length, 0, 'silent')
        // A collapsed selection otherwise inherits the preceding highlighted text.
        Object.keys(normal).forEach(key => editor.quill.format(key, normal[key], 'silent'))
      } else {
        range.deleteContents()
        const text = document.createTextNode(token)
        range.insertNode(text); range.setStartAfter(text); range.collapse(true)
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range)
        editor.root.dispatchEvent(new Event('input', { bubbles: true }))
      }
      const author = currentCommentUser()
      if (!(this.pending || []).some(m => m.userId === person.userId)) this.pending.push({ userId: person.userId, name: person.name,
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), time: Date.now(), authorId: author.userId, authorName: author.userName, authorAvatar: author.avatar })
      this.close()
      editor.root.focus()
    },
    onKeydown(e) {
      if (!this.open || e.isComposing || this.composing) return
      if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) return
      e.preventDefault(); e.stopImmediatePropagation()
      if (e.key === 'Escape') this.close()
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (this.candidates.length) this.index = (this.index + (e.key === 'ArrowDown' ? 1 : -1) + this.candidates.length) % this.candidates.length
      } else if (this.candidates[this.index]) this.pick(this.candidates[this.index])
    },
    prepare(node, patch) {
      if (!node || node !== this.editNode || this.readonly || this.editRoom !== this.$route.query.room) return
      const div = document.createElement('div'); div.innerHTML = patch.text || ''
      const text = div.textContent || ''
      patch.textMentions = (this.pending || []).filter(m => text.includes('@' + m.name))
    },
    finish(_el, _nodes, node) {
      this.close()
      if (node !== this.editNode) return
      this.editNode = null
    }
  }
}
</script>

<style scoped>
.node-text-mention { position: fixed; z-index: 12000; width: 300px; max-width: calc(100vw - 16px); border: 1px solid #dfe9e5; border-radius: 12px; background: #fff; color: #20362e; box-shadow: 0 10px 36px #123c2926; overflow: hidden; }
.mention-heading { padding: 10px 12px; color: #718078; font-size: 12px; border-bottom: 1px solid #edf2ef; }
.mention-options { max-height: 268px; overflow-y: auto; }
.mention-options button { display: flex; align-items: center; gap: 10px; width: 100%; border: 0; background: #fff; padding: 10px 12px; text-align: left; cursor: pointer; color: inherit; }
.mention-options button:hover, .mention-options button.active { background: #eaf5ef; }
.mention-options strong { display: block; font-size: 14px; font-weight: 500; }
.mention-options small { display: block; margin-top: 3px; font-size: 11px; color: #7c8981; }
.mention-avatar { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; background: #ddefe5; color: #087d56; flex-shrink: 0; }
.mention-state { padding: 16px 12px; color: #7c8981; font-size: 12px; }
</style>

<style>
/* Previously saved mentions also lose the old highlight without rewriting nodes. */
.smm-richtext-node-wrap strong[style*="rgb(8, 125, 86)"][style*="rgb(231, 245, 237)"],
.smm-richtext-node-edit-wrap strong[style*="rgb(8, 125, 86)"][style*="rgb(231, 245, 237)"] { background-color: transparent !important; }
</style>
