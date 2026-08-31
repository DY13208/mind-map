<template>
  <div
    v-show="busy"
    class="auto-expand"
    :class="{ isDark: isDark }"
    :style="boxStyle"
  >
    <span class="dot" aria-hidden="true"></span>
    <span>{{ status || 'WorkBuddy 正在按同级流程补充…' }}</span>
  </div>
</template>

<script>
import { mapState } from 'vuex'
import { streamChat } from '@/utils/workbuddyChat'
import { transformMarkdownTo } from 'simple-mind-map/src/parse/markdownTo'

const PLACEHOLDERS = [
  '',
  '分支主题',
  '子主题',
  '概要',
  '中心主题',
  'branch topic',
  'sub topic',
  'central topic'
]

function plain(node) {
  if (!node || !node.getData) return ''
  return String(node.getData('text') || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

function uidOf(node) {
  if (!node) return ''
  return node.uid || (node.getData && node.getData('uid')) || ''
}

function noteOf(node) {
  return (node && node.getData && node.getData('note')) || ''
}

function isPlaceholder(text) {
  return PLACEHOLDERS.includes(String(text || '').trim().toLowerCase())
}

function lineFor(node, depth) {
  const pad = '  '.repeat(depth)
  const title = plain(node) || '(空)'
  const uid = uidOf(node)
  const note = noteOf(node)
  return `${pad}- ${title}${uid ? `  [${uid}]` : ''}${
    note ? `  备注:${String(note).slice(0, 80)}` : ''
  }`
}

function subtree(node, depth, maxDepth) {
  if (!node) return []
  const lines = [lineFor(node, depth)]
  if (depth >= maxDepth) return lines
  ;(node.children || []).forEach(child => {
    lines.push(...subtree(child, depth + 1, maxDepth))
  })
  return lines
}

function extractJson(text) {
  if (!text) return null
  const fence = String(text).match(/```(?:json)?\s*([\s\S]*?)```/i)
  const raw = fence ? fence[1] : String(text)
  const objStart = raw.indexOf('{')
  const arrStart = raw.indexOf('[')
  let slice = ''
  if (objStart >= 0 && (arrStart < 0 || objStart < arrStart)) {
    slice = raw.slice(objStart, raw.lastIndexOf('}') + 1)
  } else if (arrStart >= 0) {
    slice = raw.slice(arrStart, raw.lastIndexOf(']') + 1)
  }
  if (!slice) return null
  try {
    return JSON.parse(slice)
  } catch (e) {
    return null
  }
}

function toChildTree(item) {
  if (item == null) return null
  if (typeof item === 'string') {
    const text = item.trim()
    return text ? { data: { text }, children: [] } : null
  }
  const data = item.data && typeof item.data === 'object' ? item.data : item
  const text = String(data.text || data.title || '').trim()
  if (!text) return null
  const node = { data: { text }, children: [] }
  if (data.note) node.data.note = String(data.note)
  const kids = Array.isArray(item.children) ? item.children : []
  node.children = kids.map(toChildTree).filter(Boolean)
  return node
}

function childrenFromPayload(payload) {
  if (!payload) return []
  if (Array.isArray(payload)) return payload.map(toChildTree).filter(Boolean)
  if (Array.isArray(payload.children)) {
    return payload.children.map(toChildTree).filter(Boolean)
  }
  const call =
    (Array.isArray(payload.calls) && payload.calls[0]) ||
    (Array.isArray(payload.tool_calls) && payload.tool_calls[0])
  if (call) {
    const fn = call.function || call
    return childrenFromPayload(fn.arguments || fn.input || call.arguments)
  }
  if (payload.data && payload.data.text) {
    const tree = toChildTree(payload)
    return tree ? [tree] : []
  }
  return []
}

function parseChildren(result) {
  const calls = (result && result.toolCalls) || []
  for (let i = 0; i < calls.length; i++) {
    const args = calls[i] && calls[i].arguments
    const parsed = typeof args === 'string' ? extractJson(args) : args
    const list = childrenFromPayload(parsed)
    if (list.length) return list
  }
  const json = extractJson(result && result.content)
  const fromJson = childrenFromPayload(json)
  if (fromJson.length) return fromJson
  const md = String((result && result.content) || '').trim()
  if (!md) return []
  try {
    const tree = transformMarkdownTo(md)
    return childrenFromPayload(tree)
  } catch (e) {
    return []
  }
}

const ADD_CHILDREN_TOOL = {
  type: 'function',
  function: {
    name: 'add_mindmap_children',
    description: '把补充好的子节点树写回当前思维导图节点。必须调用。',
    parameters: {
      type: 'object',
      properties: {
        children: {
          type: 'array',
          description:
            '子节点列表。每项 {text, note?, children?}，children 可嵌套。',
          items: { type: 'object' }
        }
      },
      required: ['children']
    }
  }
}

export default {
  name: 'NodeAutoExpand',
  props: {
    mindMap: {
      type: Object,
      default: null
    }
  },
  data() {
    return {
      busy: false,
      status: '',
      node: null,
      beforeText: '',
      beforeUid: '',
      boxStyle: { left: '0px', top: '0px' },
      controller: null,
      timer: null
    }
  },
  computed: {
    ...mapState({
      isDark: state => state.localConfig.isDark
    })
  },
  mounted() {
    if (!this.mindMap) return
    this.mindMap.on('before_show_text_edit', this.onBeforeEdit)
    this.mindMap.on('hide_text_edit', this.onHideEdit)
    this.mindMap.on('scale', this.updatePos)
    this.mindMap.on('translate', this.updatePos)
    document.body.appendChild(this.$el)
  },
  beforeDestroy() {
    this.stop()
    if (this.timer) clearTimeout(this.timer)
    if (this.mindMap) {
      this.mindMap.off('before_show_text_edit', this.onBeforeEdit)
      this.mindMap.off('hide_text_edit', this.onHideEdit)
      this.mindMap.off('scale', this.updatePos)
      this.mindMap.off('translate', this.updatePos)
    }
    if (this.$el && this.$el.parentNode) {
      this.$el.parentNode.removeChild(this.$el)
    }
  },
  methods: {
    onBeforeEdit() {
      const node =
        (this.mindMap.renderer &&
          this.mindMap.renderer.activeNodeList &&
          this.mindMap.renderer.activeNodeList[0]) ||
        null
      this.beforeUid = uidOf(node)
      this.beforeText = plain(node)
    },
    onHideEdit(el, list, node) {
      const target = node || (list && list[0])
      if (!target || this.busy) return
      if (this.timer) clearTimeout(this.timer)
      this.timer = setTimeout(() => this.maybeExpand(target), 280)
    },
    maybeExpand(node) {
      if (this.busy || !node || node.isRoot) return
      const text = plain(node)
      if (isPlaceholder(text)) return
      if (uidOf(node) === this.beforeUid && text === this.beforeText) return
      if (node.children && node.children.length > 0) return
      this.expand(node)
    },
    updatePos() {
      if (!this.busy || !this.node || !this.node.getRect) return
      const rect = this.node.getRect()
      if (!rect) return
      let left = rect.x
      let top = rect.y + rect.height + 8
      if (left + 260 > window.innerWidth) left = window.innerWidth - 272
      if (left < 12) left = 12
      if (top + 40 > window.innerHeight) top = Math.max(12, rect.y - 40)
      this.boxStyle = { left: `${left}px`, top: `${top}px` }
    },
    buildPrompt(node) {
      const parent = node.parent
      const siblings = (parent && parent.children
        ? parent.children.filter(item => item !== node)
        : [])
      const uncles =
        parent && parent.parent && parent.parent.children
          ? parent.parent.children.filter(item => item !== parent)
          : []
      const peerTrees = (uncles.length ? uncles : siblings).map(item =>
        subtree(item, 0, 3).join('\n')
      )
      const siblingLines = siblings.map(item => lineFor(item, 0)).join('\n')
      return [
        '用户刚填写完思维导图里的一个节点，请立刻对该节点做深入补充。',
        '',
        '当前节点（只补充它的子级，不要改标题）：',
        lineFor(node, 0),
        parent ? `父节点：\n${lineFor(parent, 0)}` : '',
        siblingLines ? `同级节点：\n${siblingLines}` : '',
        peerTrees.length
          ? `同级参考（如 C、P）及其流程：\n${peerTrees.join('\n')}`
          : '',
        '',
        '要求：',
        '1. 对照同级参考节点（尤其是 C、P 这类已有流程的节点）的结构、粒度、步骤，为当前节点补齐同等深度的子节点。',
        '2. 必须调用 add_mindmap_children，把子节点树放进 children。不要只口头描述。',
        '3. 补充要可执行：步骤、要点、产出；不要空话。不要改当前节点标题。'
      ]
        .filter(Boolean)
        .join('\n')
    },
    async expand(node) {
      this.node = node
      this.busy = true
      this.status = 'WorkBuddy 正在按同级流程补充…'
      this.$nextTick(this.updatePos)
      this.controller =
        typeof AbortController !== 'undefined' ? new AbortController() : null
      try {
        const result = await streamChat({
          messages: [
            {
              role: 'system',
              content:
                '你是良策协作助手。根据同级节点流程，为刚填写的节点生成子节点树，并必须调用 add_mindmap_children。'
            },
            { role: 'user', content: this.buildPrompt(node) }
          ],
          extra: {
            tools: [ADD_CHILDREN_TOOL],
            tool_choice: {
              type: 'function',
              function: { name: 'add_mindmap_children' }
            }
          },
          signal: this.controller && this.controller.signal,
          onEvent: label => {
            if (label) this.status = label
            this.$nextTick(this.updatePos)
          }
        })
        const children = parseChildren(result)
        if (!children.length) {
          throw new Error('WorkBuddy 没有返回可插入的子节点')
        }
        this.mindMap.execCommand('INSERT_MULTI_CHILD_NODE', [node], children)
        this.status = `已补充 ${children.length} 个子节点`
        setTimeout(() => {
          this.busy = false
          this.status = ''
          this.node = null
        }, 1400)
      } catch (err) {
        this.busy = false
        this.node = null
        if (err && err.name === 'AbortError') return
        const raw = (err && err.message) || String(err || '')
        const msg =
          (err && err.status >= 500) ||
          /Failed to fetch|NetworkError|ECONNREFUSED|Bad Gateway|<!DOCTYPE html>/i.test(
            raw
          )
            ? '连不上 WorkBuddy，补充未完成'
            : raw || '补充失败'
        if (this.$message) this.$message.error(msg)
      } finally {
        this.controller = null
      }
    },
    stop() {
      if (this.controller) this.controller.abort()
    }
  }
}
</script>

<style lang="less" scoped>
.auto-expand {
  --color-primary: #2563eb;
  --color-background: #ffffff;
  --color-foreground: #0f172a;
  --color-border: #e4ecfc;
  position: fixed;
  z-index: 2500;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  padding: 6px 12px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: var(--color-background);
  color: var(--color-foreground);
  font-size: 12px;
  line-height: 1.4;
  font-family: Inter, 'PingFang SC', 'Microsoft YaHei', sans-serif;
  pointer-events: none;

  &.isDark {
    --color-primary: #60a5fa;
    --color-background: #121a2b;
    --color-foreground: #e8eefc;
    --color-border: #243049;
  }
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-primary);
  flex-shrink: 0;
}

@media (prefers-reduced-motion: reduce) {
  .dot {
    animation: none;
  }
}
</style>
