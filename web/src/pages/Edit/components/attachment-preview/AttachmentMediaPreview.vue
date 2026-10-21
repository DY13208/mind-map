<template>
  <section class="attachmentMediaPreview" :aria-label="kind === 'audio' ? '音频预览' : '视频预览'">
    <div v-if="error" class="attachmentViewerState" role="alert">
      <i class="el-icon-warning-outline"></i><strong>{{ error }}</strong>
      <el-button size="small" @click="$emit('download')">下载原文件</el-button>
    </div>
    <template v-else>
      <i v-if="kind === 'audio'" class="el-icon-headset attachmentAudioIcon" aria-hidden="true"></i>
      <component :is="kind === 'audio' ? 'audio' : 'video'" ref="player" :src="source.url" controls playsinline preload="metadata" :aria-label="source.fileName" @error="onError" />
    </template>
  </section>
</template>
<script>
export default {
  props: { source: { type: Object, required: true }, kind: { type: String, required: true } },
  data: () => ({ error: '' }),
  beforeDestroy() {
    this._disposed = true
    const player = this.$refs.player
    if (player) { player.pause(); player.removeAttribute('src'); player.load() }
  },
  methods: {
    onError() { if (!this._disposed) this.error = '浏览器无法播放此媒体编码，请下载原文件查看' }
  }
}
</script>
