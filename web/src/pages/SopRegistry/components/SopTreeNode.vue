<template>
  <li class="treeNode" role="treeitem" :aria-expanded="hasChildren ? isExpanded : undefined">
    <div
      class="treeRow"
      :class="{ selected: selectedUid === node.uid, isSop: node.isSop }"
      :style="{ paddingLeft: 8 + depth * 14 + 'px' }"
      @click="$emit('select', node)"
    >
      <button
        v-if="hasChildren"
        type="button"
        class="twist"
        :aria-label="isExpanded ? '折叠' : '展开'"
        @click.stop="$emit('toggle', node.uid)"
      >
        {{ isExpanded ? '▾' : '▸' }}
      </button>
      <span v-else class="twist spacer"></span>
      <span class="treeLabel" v-html="labelHtml"></span>
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
  gap: 2px;
  min-height: 28px;
  border-radius: 6px;
  cursor: pointer;
  color: var(--ui-text, #17261f);
}
.treeRow:hover {
  background: rgba(23, 38, 31, 0.06);
}
.treeRow.selected {
  background: rgba(46, 125, 90, 0.14);
}
.treeRow.isSop .treeLabel {
  font-weight: 600;
}
.twist {
  width: 18px;
  border: 0;
  background: transparent;
  cursor: pointer;
  color: #5b6b63;
  padding: 0;
  line-height: 1;
}
.twist.spacer {
  visibility: hidden;
}
.treeLabel {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
.treeLabel /deep/ mark {
  background: #ffe08a;
  color: inherit;
  padding: 0 1px;
  border-radius: 2px;
}
</style>
