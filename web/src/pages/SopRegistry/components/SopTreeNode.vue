<template>
  <li class="treeNode" role="treeitem" :aria-expanded="hasChildren ? isExpanded : undefined">
    <div
      class="treeRow"
      :class="{ selected: selectedUid === node.uid, isSop: node.isSop }"
      :style="{ paddingLeft: 10 + depth * 16 + 'px' }"
      @click="$emit('select', node)"
    >
      <button
        v-if="hasChildren"
        type="button"
        class="twist"
        :aria-label="isExpanded ? '折叠' : '展开'"
        @click.stop="$emit('toggle', node.uid)"
      >
        <SopGlyph :kind="isExpanded ? 'chevron-down' : 'chevron-right'" size="sm" />
      </button>
      <span v-else class="twist spacer"></span>
      <span class="kindIcon" :class="'k-' + nodeKind">
        <SopGlyph :kind="nodeKind" size="md" />
      </span>
      <span class="treeLabel" v-html="labelHtml"></span>
      <span v-if="node.sopCount" class="treeCount">{{ node.sopCount }}</span>
    </div>
    <ul v-if="hasChildren && isExpanded" class="treeChildren" role="group">
      <SopTreeNode
        v-for="child in node.children"
        :key="child.uid"
        :node="child"
        :depth="depth + 1"
        :selected-uid="selectedUid"
        :expanded-map="expandedMap"
        :highlight="highlight"
        @toggle="$emit('toggle', $event)"
        @select="$emit('select', $event)"
      />
    </ul>
  </li>
</template>

<script>
import SopGlyph, { inferNodeKind } from './SopGlyph.vue'

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function highlightHtml(text, query) {
  const raw = String(text || '')
  const q = String(query || '').trim()
  if (!q) return escapeHtml(raw)
  const lower = raw.toLowerCase()
  const needle = q.toLowerCase()
  let out = ''
  let i = 0
  while (i < raw.length) {
    const hit = lower.indexOf(needle, i)
    if (hit < 0) {
      out += escapeHtml(raw.slice(i))
      break
    }
    out += escapeHtml(raw.slice(i, hit))
    out += `<mark>${escapeHtml(raw.slice(hit, hit + needle.length))}</mark>`
    i = hit + needle.length
  }
  return out
}

export default {
  name: 'SopTreeNode',
  components: { SopGlyph },
  props: {
    node: { type: Object, required: true },
    depth: { type: Number, default: 0 },
    selectedUid: { type: String, default: '' },
    expandedMap: { type: Object, default: () => ({}) },
    highlight: { type: String, default: '' }
  },
  computed: {
    hasChildren() {
      return !!(this.node.children && this.node.children.length)
    },
    isExpanded() {
      if (this.node.expanded) return true
      return this.expandedMap[this.node.uid] !== false
    },
    nodeKind() {
      if (this.node.isSop) return 'D'
      return inferNodeKind(this.node.text)
    },
    labelHtml() {
      return highlightHtml(this.node.text, this.highlight)
    }
  }
}
</script>

<style scoped>
.treeNode {
  list-style: none;
  margin: 0;
  padding: 0;
}
.treeChildren {
  list-style: none;
  margin: 0;
  padding: 0;
}
.treeRow {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 36px;
  border-radius: 8px;
  cursor: pointer;
  color: #1f2937;
  padding-right: 10px;
  margin: 1px 6px;
  border-left: 3px solid transparent;
  transition: background 0.15s ease, border-color 0.15s ease;
}
.treeRow:hover {
  background: #f3f6f5;
}
.treeRow.selected {
  background: #e8f7f2;
  color: #066a52;
  border-left-color: #00896c;
  font-weight: 600;
}
.treeRow.selected .treeLabel {
  color: #066a52;
}
.treeRow.selected .treeCount {
  color: #0b8a6a;
  font-weight: 600;
}
.treeRow.selected .kindIcon {
  background: #d8f3ea;
}
.treeRow.selected .twist {
  color: #00896c;
}
.twist {
  width: 16px;
  height: 16px;
  border: 0;
  background: transparent;
  cursor: pointer;
  color: #94a3b8;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.twist.spacer {
  visibility: hidden;
}
.kindIcon {
  width: 20px;
  height: 20px;
  border-radius: 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  background: #f0fdf8;
}
.kindIcon.k-C {
  background: #ecfdf5;
  color: #0f766e;
}
.kindIcon.k-P {
  background: #f0fdfa;
  color: #0d9488;
}
.kindIcon.k-D,
.kindIcon.k-d {
  background: #ecfdf5;
  color: #059669;
}
.kindIcon.k-node {
  background: #f8fafc;
  color: #64748b;
}
.treeLabel {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  line-height: 1.35;
  min-width: 0;
}
.treeRow.isSop .treeLabel {
  font-weight: 600;
}
.treeCount {
  flex-shrink: 0;
  font-size: 12px;
  color: #94a3b8;
  font-variant-numeric: tabular-nums;
  min-width: 1.1em;
  text-align: right;
}
.treeLabel /deep/ mark {
  background: #fef08a;
  color: inherit;
  padding: 0 1px;
  border-radius: 2px;
}
</style>
