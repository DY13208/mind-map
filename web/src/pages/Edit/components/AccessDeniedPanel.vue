<template>
  <main class="accessDenied">
    <section>
      <span class="accessIcon"><i class="el-icon-lock" /></span>
      <h1>需要访问权限</h1>
      <p>你目前无法打开这个脑图。可以向文件所有者申请权限，对方同意后刷新页面即可访问。</p>
      <div class="accessActions" v-if="status !== 'pending'">
        <el-select v-model="role" aria-label="申请的权限">
          <el-option label="只读权限" value="viewer" />
          <el-option label="可编辑权限" value="editor" />
        </el-select>
        <el-button type="primary" :loading="busy" @click="submit">申请权限</el-button>
      </div>
      <el-alert
        v-else
        title="申请已发送，等待所有者处理"
        description="对方同意后刷新此页面即可访问。"
        type="success"
        :closable="false"
        show-icon
      />
      <div class="secondaryActions">
        <el-button v-if="status === 'pending'" :loading="checking" @click="check">检查结果</el-button>
        <el-button @click="$emit('back')">返回文件列表</el-button>
      </div>
    </section>
  </main>
</template>

<script>
import accessRequestService from '@/services/accessRequestService'

export default {
  name: 'AccessDeniedPanel',
  props: { roomKey: { type: String, required: true } },
  data: () => ({ role: 'viewer', status: '', busy: false, checking: false }),
  created() { this.check() },
  methods: {
    async check() {
      this.checking = true
      try {
        const data = await accessRequestService.mine(this.roomKey)
        this.status = data.item && data.item.status
        if (this.status === 'approved') window.location.reload()
      } catch (error) {
        this.status = ''
      } finally {
        this.checking = false
      }
    },
    async submit() {
      this.busy = true
      try {
        const data = await accessRequestService.request(this.roomKey, this.role)
        this.status = data.item && data.item.status
        if (this.status === 'already_allowed') window.location.reload()
        else this.$message.success('访问申请已发送')
      } catch (error) {
        this.$message.error(error.message || '申请发送失败')
      } finally {
        this.busy = false
      }
    }
  }
}
</script>

<style lang="less" scoped>
.accessDenied {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
  box-sizing: border-box;
  background: #f7f9f8;
  color: #17261f;
  section { width: 100%; max-width: 460px; text-align: center; }
  .accessIcon {
    width: 56px; height: 56px; margin: 0 auto 20px; display: grid;
    place-items: center; border-radius: 14px; color: #087854;
    background: #e8f4ef; font-size: 24px;
  }
  h1 { margin: 0; font-size: 24px; }
  p { margin: 12px 0 24px; color: #66756e; line-height: 1.7; }
  .accessActions { display: flex; gap: 10px; justify-content: center; }
  .secondaryActions { margin-top: 18px; display: flex; gap: 8px; justify-content: center; }
  /deep/ .el-button--primary { background: #087854; border-color: #087854; }
  /deep/ .el-alert { text-align: left; }
}
</style>
