<template>
  <main class="shareRedirect">
    <div class="shareRedirectCard">
      <h1>打开分享的脑图</h1>
      <p v-if="loading">正在验证分享链接…</p>
      <template v-else>
        <p class="shareRedirectError">{{ error }}</p>
        <button type="button" @click="redeem">重试</button>
      </template>
    </div>
  </main>
</template>

<script>
import nodeShareService from '@/services/nodeShareService'

export default {
  name: 'NodeShareRedirect',
  data() {
    return { loading: true, error: '' }
  },
  mounted() { this.redeem() },
  methods: {
    async redeem() {
      const id = String(this.$route.params.id || '')
      const token = String(this.$route.query.token || '')
      if (!id || !token) {
        this.loading = false
        this.error = '分享链接不完整'
        return
      }
      this.loading = true
      this.error = ''
      try {
        const share = await nodeShareService.redeem(id, token)
        await this.$router.replace({ path: '/', query: { room: share.roomKey, focus: share.rootUid } })
      } catch (err) {
        this.error = err.message || '无法打开分享链接'
        this.loading = false
      }
    }
  }
}
</script>

<style scoped>
.shareRedirect { min-height: 100vh; display: grid; place-items: center; background: #f6f8fb; color: #243248; }
.shareRedirectCard { width: min(400px, calc(100vw - 40px)); padding: 30px; border-radius: 12px; background: white; box-shadow: 0 12px 36px #26395714; }
.shareRedirectCard h1 { margin: 0 0 15px; font-size: 19px; }
.shareRedirectCard p { line-height: 1.5; }
.shareRedirectError { color: #d34d4d; }
.shareRedirectCard button { margin-top: 14px; padding: 8px 18px; border: 0; border-radius: 6px; background: #409eff; color: white; cursor: pointer; }
</style>
