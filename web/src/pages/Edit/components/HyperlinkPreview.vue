<template>
  <el-dialog
    :visible="visible"
    width="94vw"
    top="4vh"
    append-to-body
    custom-class="hyperlinkPreviewDialog"
    :close-on-click-modal="false"
    @close="$emit('close')"
  >
    <div slot="title" class="previewHeader">
      <div class="previewHeading">
        <strong>网页预览</strong>
        <span :title="url">{{ url }}</span>
      </div>
      <a :href="url" target="_blank" rel="noopener noreferrer" class="previewExternal">
        <i class="el-icon-top-right" aria-hidden="true"></i> 新页面打开
      </a>
    </div>
    <div class="previewHint">若网页不允许嵌入或登录无法完成，请使用右上角“新页面打开”。</div>
    <iframe
      v-if="visible && url"
      :key="url"
      :src="url"
      title="超链接网页预览"
      referrerpolicy="no-referrer"
      sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"
      class="previewFrame"
    ></iframe>
  </el-dialog>
</template>

<script>
export default {
  name: 'HyperlinkPreview',
  props: {
    visible: { type: Boolean, default: false },
    url: { type: String, default: '' }
  }
}
</script>

<style lang="less">
.hyperlinkPreviewDialog {
  max-width: 1600px;
  .el-dialog__header { padding: 18px 54px 14px 20px; }
  .el-dialog__body { padding: 0; }
  .previewHeader { display: flex; align-items: center; gap: 16px; }
  .previewHeading { flex: 1; min-width: 0; }
  .previewHeading strong { display: block; color: var(--ui-text, #17261f); }
  .previewHeading span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--ui-text-secondary, #66756e); margin-top: 4px; }
  .previewExternal { flex-shrink: 0; color: var(--ui-primary, #087854); font-size: 14px; }
  .previewExternal:focus-visible { outline: 2px solid currentColor; outline-offset: 4px; }
  .previewHint { padding: 10px 20px; font-size: 12px; color: #66756e; background: #f1f5f3; }
  .previewFrame { display: block; width: 100%; height: 76vh; border: 0; background: white; }
}
@media (max-width: 600px) {
  .hyperlinkPreviewDialog .previewHeader { align-items: flex-start; gap: 8px; }
  .hyperlinkPreviewDialog .previewExternal { font-size: 12px; }
}
</style>
