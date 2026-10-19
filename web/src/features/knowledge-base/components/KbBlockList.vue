<template>
  <div class="kb-block-list">
    <div
      v-for="(b, i) in blocks"
      :key="b.id || i"
      class="kb-block"
      :class="{ active: activeId === (b.id || i) }"
      role="button"
      tabindex="0"
      @click="select(b, i)"
      @keydown.enter="select(b, i)"
    >
      <div class="kb-block-meta">
        <el-tag size="mini" effect="plain" disable-transitions>{{ typeLabel(b.type || b.kind) }}</el-tag>
        <span class="kb-block-loc">{{ label(b) }}</span>
        <span v-if="!loc(b).precise" class="kb-block-imprecise" title="解析器未提供精确位置，只能定位到页或文件">
          <i class="el-icon-warning-outline" aria-hidden="true" />解析器未提供精确位置
        </span>
      </div>
      <div class="kb-block-text">{{ b.text || b.content || b.markdown || '（无文本内容）' }}</div>
    </div>
  </div>
</template>
<script>
import { blockLocation, locationLabel } from '../utils/format'
const TYPES = { text: '正文', paragraph: '正文', title: '标题', heading: '标题', table: '表格', image: '图片', picture: '图片', list: '列表', list_item: '列表', formula: '公式', caption: '说明', row: '数据行', cell: '单元格' }
export default {
  name: 'KbBlockList',
  props: { blocks: { type: Array, default: () => [] }, activeId: { type: [String, Number], default: null } },
  methods: {
    loc: blockLocation,
    label(b) { return locationLabel(blockLocation(b)) },
    typeLabel(t) { return TYPES[t] || t || '内容' },
    select(b, i) { this.$emit('select', { block: b, id: b.id || i }) }
  }
}
</script>
<style scoped lang="less">
.kb-block {
  padding: 10px 12px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-md);
  margin-bottom: 8px;
  background: var(--ui-surface);
  cursor: pointer;
  transition: border-color var(--ui-duration) var(--ui-ease);
  &:hover { border-color: var(--ui-border-strong); }
  &.active { border-color: var(--ui-primary); background: var(--ui-primary-soft); }
  &:focus-visible { outline: 2px solid var(--ui-focus); }
}
.kb-block-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--ui-text-muted);
  margin-bottom: 6px;
}
.kb-block-imprecise {
  color: var(--ui-star);
  i { font-weight: 700; margin-right: 2px; }
}
.kb-block-text {
  font-size: 13px;
  line-height: 1.6;
  color: var(--ui-text);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 160px;
  overflow: hidden;
}
</style>
