<template>
  <main class="accessDenied">
    <section class="accessRequestPanel" aria-label="申请文件访问权限">
      <div class="requestBrand">
        <span class="brandMark">W</span
        ><span>WCPD <small>团队知识与协作</small></span>
      </div>
      <span :class="['accessIcon', { pending: status === 'pending' }]"
        ><i :class="status === 'pending' ? 'el-icon-time' : 'el-icon-lock'"
      /></span>
      <h1>{{ status === 'pending' ? '等待所有者处理' : '申请访问权限' }}</h1>
      <p class="accessDescription">
        {{
          status === 'pending'
            ? '申请已发送，所有者处理后会实时通知你。'
            : '向文件所有者说明用途，获得授权后即可访问。'
        }}
      </p>
      <div class="resourceSummary">
        <i class="el-icon-document" /><span
          >{{ item.title || '当前脑图' }}<small>{{ roomKey }}</small></span
        ><span v-if="status === 'pending'" class="pendingBadge">待审批</span>
      </div>
      <div v-if="errorMessage" class="requestError" role="alert">
        <i class="el-icon-warning-outline" />{{ errorMessage }}
      </div>
      <div v-if="status === 'rejected'" class="decisionNotice">
        <strong>上次申请未通过</strong>
        <p>{{ item.decision_reason || '可以补充申请用途后重新提交。' }}</p>
      </div>
      <div v-if="status === 'approved' && !hasAccess" class="decisionNotice">
        <strong>当前访问权限已变化</strong>
        <p>历史申请曾获通过，可重新向所有者申请。</p>
      </div>
      <template v-if="status !== 'pending'">
        <label class="requestFieldLabel">需要的权限</label>
        <el-radio-group
          v-model="role"
          class="requestRoles"
          :disabled="busy || checking"
        >
          <el-radio-button label="viewer"
            ><i class="el-icon-view" /><strong>可查看</strong
            ><small>阅读与浏览内容</small></el-radio-button
          >
          <el-radio-button label="editor"
            ><i class="el-icon-edit" /><strong>可编辑</strong
            ><small>参与内容修改</small></el-radio-button
          >
        </el-radio-group>
        <label class="requestFieldLabel" for="access-request-reason"
          >申请用途 <span>选填</span></label
        >
        <el-input
          id="access-request-reason"
          v-model="reason"
          type="textarea"
          :rows="3"
          maxlength="500"
          show-word-limit
          :disabled="busy"
          placeholder="例如：参与项目方案整理，需要补充实施计划"
          resize="none"
        />
        <el-button
          class="submitRequest"
          type="primary"
          :loading="busy"
          :disabled="checking || !exists"
          @click="submit"
          >{{
            status === 'rejected' || status === 'approved'
              ? '重新申请'
              : '发送申请'
          }}</el-button
        >
      </template>
      <div v-else class="pendingDetails">
        <div>
          <i class="el-icon-circle-check" /><span
            >已申请<strong>{{ roleText(item.requested_role) }}</strong></span
          >
        </div>
        <p v-if="item.request_reason">{{ item.request_reason }}</p>
        <el-button :loading="checking" @click="check(false)"
          >检查审批结果</el-button
        >
      </div>
      <div class="secondaryActions">
        <button type="button" :disabled="returning" :title="returnLabel" @click="$emit('back')">
          <i class="el-icon-arrow-left" /> {{ returnLabel }}</button
        ><span><i class="el-icon-lock" /> 仅所有者可审批</span>
      </div>
    </section>
  </main>
</template>
<script>
import service from '@/services/accessRequestService'
import { state, roleText } from '@/services/accessNotificationState'
export default {
  name: 'AccessDeniedPanel',
  props: {
    roomKey: { type: String, required: true },
    returnLabel: { type: String, default: '返回脑图列表' },
    returning: { type: Boolean, default: false }
  },
  data: () => ({
    role: 'viewer',
    reason: '',
    item: {},
    status: '',
    busy: false,
    checking: false,
    errorMessage: '',
    exists: true,
    hasAccess: false,
    version: 0,
    timer: null,
    state,
    reloading: false
  }),
  watch: {
    roomKey() {
      this.reset()
    },
    'state.syncVersion'() {
      if (!this.busy) this.check(true)
    }
  },
  created() {
    this.reset()
    this.timer = window.setInterval(() => {
      if (this.status === 'pending' && !document.hidden) this.check(true)
    }, 20000)
  },
  beforeDestroy() {
    this.version++
    window.clearInterval(this.timer)
  },
  methods: {
    roleText,
    reset() {
      this.version++
      this.checking = false
      this.busy = false
      this.reloading = false
      this.item = {}
      this.status = ''
      this.reason = ''
      this.errorMessage = ''
      this.exists = true
      this.hasAccess = false
      this.check(true)
    },
    openGranted() {
      if (this.reloading) return
      this.reloading = true
      window.location.reload()
    },
    async check(silent = false) {
      if (this.checking) return
      const version = this.version,
        roomKey = this.roomKey
      this.checking = true
      try {
        const data = await service.mine(roomKey)
        if (version !== this.version) return
        this.item = data.item || {}
        this.status = this.item.status || ''
        this.exists = this.item.exists !== false
        this.hasAccess = !!(this.item.access && this.item.access.canView)
        this.errorMessage = this.exists ? '' : '文件不存在或已移入回收站'
        if (this.hasAccess) this.openGranted()
        else if (!silent && !this.errorMessage)
          this.$message.info(
            this.status === 'pending'
              ? '所有者尚未处理，请稍候'
              : '审批状态已更新'
          )
      } catch (error) {
        if (version === this.version)
          this.errorMessage =
            error.message || '暂时无法获取申请状态，请稍后重试'
      } finally {
        if (version === this.version) this.checking = false
      }
    },
    async submit() {
      if (this.busy || this.checking) return
      const version = this.version
      this.busy = true
      this.errorMessage = ''
      try {
        const data = await service.request(this.roomKey, this.role, this.reason)
        if (version !== this.version) return
        this.item = data.item || {}
        this.status = this.item.status || ''
        if (this.status === 'already_allowed') this.openGranted()
        else this.$message.success('申请已发送，所有者将收到站内提醒')
      } catch (error) {
        if (version === this.version)
          this.errorMessage = error.message || '申请发送失败，请重试'
      } finally {
        if (version === this.version) this.busy = false
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
  padding: 32px 20px;
  box-sizing: border-box;
  background: radial-gradient(ellipse at 50% 0, #edf5f0, transparent 65%),
    #f7f9f8;
  color: #1d3026;
}
.accessRequestPanel {
  width: 100%;
  max-width: 460px;
  padding: 32px;
  box-sizing: border-box;
  background: #fff;
  border: 1px solid #e2e9e5;
  border-radius: 18px;
  box-shadow: 0 16px 64px #25452e0a;
}
.requestBrand {
  display: flex;
  align-items: center;
  gap: 9px;
  font-weight: 650;
  font-size: 14px;
  margin-bottom: 36px;
}
.brandMark {
  background: #163b2d;
  color: #fff;
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  font-size: 16px;
}
.requestBrand small {
  display: block;
  color: #8a978f;
  font-size: 10px;
  font-weight: 400;
  margin-top: 2px;
}
.accessIcon {
  width: 52px;
  height: 52px;
  display: grid;
  place-items: center;
  border-radius: 14px;
  background: #edf5f0;
  color: #087854;
  font-size: 24px;
}
.accessIcon.pending {
  background: #edf3fa;
  color: #4776a8;
}
h1 {
  font-size: 24px;
  margin: 20px 0 10px;
  letter-spacing: -0.5px;
}
.accessDescription {
  font-size: 13px;
  color: #78897d;
  line-height: 1.7;
  margin: 0 0 22px;
}
.resourceSummary {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 13px;
  border: 1px solid #e5ebe7;
  border-radius: 9px;
  margin-bottom: 22px;
}
.resourceSummary > i {
  font-size: 22px;
  color: #71867a;
}
.resourceSummary > span {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  overflow-wrap: anywhere;
}
.resourceSummary small {
  display: block;
  font-size: 10px;
  color: #9aa69f;
  margin-top: 4px;
}
.resourceSummary .pendingBadge {
  flex: none;
  font-size: 11px;
  background: #edf3fa;
  color: #4776a8;
  border-radius: 20px;
  padding: 4px 8px;
}
.requestFieldLabel {
  display: block;
  margin: 18px 0 9px;
  font-size: 12px;
  font-weight: 600;
}
.requestFieldLabel span {
  font-weight: 400;
  color: #9aa69f;
  font-size: 11px;
  margin-left: 5px;
}
.requestRoles {
  display: flex;
  width: 100%;
  gap: 10px;
}
.requestRoles /deep/ .el-radio-button {
  flex: 1;
}
.requestRoles /deep/ .el-radio-button__inner {
  border: 1px solid #e0e8e3 !important;
  border-radius: 8px !important;
  width: 100%;
  padding: 13px 4px;
  box-shadow: none !important;
  color: #52695b;
}
.requestRoles
  /deep/
  .el-radio-button__orig-radio:checked
  + .el-radio-button__inner {
  background: #f1f8f4;
  border-color: #398b67 !important;
  color: #087854;
}
.requestRoles strong {
  font-size: 13px;
  margin-left: 6px;
}
.requestRoles small {
  display: block;
  font-size: 11px;
  color: #879a8c;
  margin-top: 8px;
}
.submitRequest {
  width: 100%;
  margin-top: 22px;
  background: #087854;
  border-color: #087854;
}
.secondaryActions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 25px;
  gap: 12px;
}
.secondaryActions button {
  border: 0;
  background: transparent;
  color: #6b7e70;
  font-size: 12px;
  cursor: pointer;
  padding: 4px 0;
}
.secondaryActions > span {
  font-size: 10px;
  color: #a0ada4;
}
.pendingDetails {
  padding: 18px;
  background: #f7f9f8;
  border-radius: 9px;
}
.pendingDetails > div {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #557360;
}
.pendingDetails strong {
  margin-left: 8px;
  color: #3d6750;
}
.pendingDetails p {
  font-size: 13px;
  color: #7a897f;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.pendingDetails .el-button {
  margin-top: 16px;
  width: 100%;
}
.requestError {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #a4624a;
  background: #fff4ed;
  border-radius: 7px;
  padding: 10px;
  font-size: 12px;
  line-height: 1.6;
  margin-bottom: 16px;
}
.decisionNotice {
  padding: 12px;
  background: #faf4ef;
  border-radius: 8px;
  margin-bottom: 18px;
  font-size: 12px;
  color: #967052;
}
.decisionNotice p {
  margin: 5px 0 0;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
@media (max-width: 520px) {
  .accessDenied {
    padding: 18px 14px;
  }
  .accessRequestPanel {
    padding: 24px 20px;
  }
  .requestBrand {
    margin-bottom: 28px;
  }
  h1 {
    font-size: 22px;
  }
}
</style>
