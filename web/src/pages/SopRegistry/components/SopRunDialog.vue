<template>
  <el-dialog
    title="运行 SOP"
    :visible="visible"
    width="744px"
    top="8vh"
    append-to-body
    :close-on-click-modal="false"
    custom-class="sopRunDialog"
    @close="close"
  >
    <p v-if="target" class="runDialogLead">
      将任务加入队列后可在后台并行执行；你可以关闭本窗口，稍后在 SOP 台账详情的「记录」中查看进度。
    </p>
    <section class="runExecutionPanel">
      <h3>执行配置</h3>
      <div class="runExecutionMain">
        <label class="runExecutionField runEngineField">
          <span>执行引擎</span>
          <el-select v-model="backend" size="small" @change="onBackendChange">
            <el-option label="WorkBuddy" value="workbuddy" />
            <el-option label="小策" :value="AI_BACKEND_XIAOCE" />
            <el-option label="助理" :value="AI_BACKEND_OPENCLAW" />
          </el-select>
        </label>
        <template v-if="backend === AI_BACKEND_OPENCLAW">
          <label class="runExecutionField runModelField">
            <span>模型</span>
            <el-select v-model="model" size="small" filterable allow-create default-first-option :loading="modelsLoading" placeholder="选择助理模型" @visible-change="onModelDropdown">
              <el-option v-for="item in openclawModels" :key="item.id" :label="item.name || item.id" :value="item.id" />
            </el-select>
          </label>
          <el-button class="runRefreshButton" size="small" icon="el-icon-refresh" :loading="modelsLoading" @click="loadModels(true)">刷新</el-button>
        </template>
        <template v-else-if="backend === 'workbuddy'">
          <label class="runExecutionField runModelField">
            <span>模型</span>
            <el-select v-model="model" size="small" filterable :loading="modelsLoading" placeholder="选择 WorkBuddy 模型" @visible-change="onModelDropdown">
              <el-option-group v-if="customModels.length" label="自定义模型（推荐，不耗积分）">
                <el-option v-for="item in customModels" :key="'c-' + item.id" :label="item.name || item.id" :value="item.id" />
              </el-option-group>
              <el-option-group v-if="platformModels.length" label="平台模型">
                <el-option v-for="item in platformModels" :key="'p-' + item.id" :label="item.name || item.id" :value="item.id" />
              </el-option-group>
            </el-select>
          </label>
          <el-button class="runRefreshButton" size="small" icon="el-icon-refresh" :loading="modelsLoading" @click="loadModels(true)">刷新</el-button>
        </template>
      </div>
      <div v-if="backend === AI_BACKEND_XIAOCE" class="runExecutionMain">
        <label class="runExecutionField"><span>企业</span><el-select v-model="organizationId" size="small" :loading="scopeLoading" placeholder="选择企业" @change="onOrganizationChange"><el-option v-for="item in organizations" :key="item.id" :label="item.name" :value="String(item.id)" /></el-select></label>
        <label class="runExecutionField"><span>智能体</span><el-select v-model="agentId" size="small" :loading="scopeLoading" placeholder="选择智能体"><el-option v-for="item in agents" :key="item.id" :label="`${item.emoji || '🤖'} ${item.name}`" :value="String(item.id)" /></el-select></label>
        <el-button class="runRefreshButton" size="small" icon="el-icon-refresh" :loading="scopeLoading" @click="loadXiaoceScope(true)">刷新</el-button>
      </div>
    </section>
    <div class="runSectionTitle"><strong>输出内容</strong><span>可不选</span></div>
    <el-checkbox-group v-model="outputIds" class="outputChecks">
      <el-checkbox v-for="opt in outputPresets" :key="opt.id" :label="opt.id" class="outputCheck"><span>{{ opt.label }}</span></el-checkbox>
    </el-checkbox-group>
    <div v-if="submitLoading" class="runSubmitLoading">正在读取资料模板…</div>
    <div v-else-if="submitFields.length" class="runSubmitBox">
      <div class="runSubmitHead"><strong>先填写资料再执行</strong><span v-if="submitZoneHint">{{ submitZoneHint }}</span></div>
      <p class="runSubmitTip">检测到「提交资料 / 提供」类节点，请按模板填写；内容会随任务一并交给执行助手。</p>
      <div class="runSubmitGrid">
        <div v-for="field in submitFields" :key="field.key" class="runSubmitField"><label>{{ field.label }}</label><el-input v-model="field.value" size="small" clearable :placeholder="field.hint || '请填写'" /></div>
      </div>
    </div>
    <div class="runSectionTitle runComposeTitle"><strong>附件与补充说明</strong></div>
    <div class="runComposeBox" @paste="onPaste">
      <input ref="attachmentInput" class="runAttachmentInput" type="file" multiple :accept="attachmentAccept" @change="onFilesPicked" />
      <input ref="imageInput" class="runAttachmentInput" type="file" multiple accept="image/*" @change="onFilesPicked" />
      <el-input ref="noteInput" v-model="extraNote" class="runExtra" type="textarea" :rows="3" placeholder="可输入补充要求，也可直接粘贴文本、截图或文件" aria-label="附件与补充说明" />
      <span v-if="!extraNote" class="runComposeExample">例如：给黄炜龙发个代办；或：我要招聘一个初级客服</span>
      <div class="runComposeToolbar">
        <div class="runPasteIcons">
          <button type="button" title="上传图片" aria-label="上传图片" @click="$refs.imageInput.click()"><i class="el-icon-picture-outline" /></button>
          <button type="button" title="上传文件" aria-label="上传文件" @click="$refs.attachmentInput.click()"><i class="el-icon-document" /></button>
          <button type="button" title="聚焦输入框，可使用 Ctrl+V 粘贴截图或文件" aria-label="聚焦输入框以粘贴" @click="$refs.noteInput.focus()"><i class="el-icon-full-screen" /></button>
        </div>
        <span class="runPasteHint">支持直接粘贴图片或文件（Ctrl+V）</span>
        <span class="runNoteCount" aria-label="已输入字数">{{ extraNote.length }} 字</span>
      </div>
    </div>
    <div v-if="attachments.length" class="runAttachmentList">
      <span v-for="file in attachments" :key="file.key" class="runAttachmentTag" :class="{ 'is-failed': file.status === 'failed' }">
        <i v-if="file.status === 'uploading'" class="el-icon-loading" /><i v-else-if="file.status === 'failed'" class="el-icon-warning-outline" />
        <span>{{ file.name }}</span><button type="button" @click="removeAttachment(file)"><i class="el-icon-close" /></button>
      </span>
    </div>
    <p class="runAttachmentTip">支持 PDF、Word、Excel、文本、图片，单个不超过 5 MB，最多 5 个。</p>
    <span slot="footer" class="runDialogFooter">
      <el-button size="small" @click="close">取消</el-button>
      <el-button type="primary" size="small" :loading="submitLoading || enqueueing" :disabled="attachments.some(file => file.status !== 'ready')" @click="confirm">加入队列并开始</el-button>
    </span>
  </el-dialog>
</template>

<script>
import { mapMutations } from 'vuex'
import { getLocalConfig } from '@/api'
import { SOP_OUTPUT_PRESETS, loadSopRunContext } from '@/utils/sopRun'
import { getSharedSopRunQueue, resolveSopRunConcurrency } from '@/utils/sopRunQueue'
import { SOP_ATTACHMENT_ACCEPT, SOP_ATTACHMENT_LIMIT, validateSopAttachment, uploadSopAttachment, formatSopAttachmentNote } from '@/utils/sopRunAttachments'
import { extractSubmitMaterialFields, formatSubmitMaterialNote, missingSubmitMaterialLabels } from '@/utils/sopSubmitMaterial'
import { fetchAiModels, fetchWorkbuddyModels, getWorkbuddyConfig, getOpenclawConfig, saveOpenclawConfig, WORKBUDDY_CUSTOM_MODEL_HINTS, fetchXiaoceOrganizations, fetchXiaoceAgents, AI_BACKEND_XIAOCE, AI_BACKEND_OPENCLAW, normalizeAiBackend } from '@/utils/agentChat'

export default {
  name: 'SopRunDialog',
  props: {
    visible: Boolean,
    roomKey: { type: String, default: '' },
    target: { type: Object, default: null },
    actor: { type: String, default: '用户' }
  },
  data() {
    return {
      outputPresets: SOP_OUTPUT_PRESETS, outputIds: [], extraNote: '', attachments: [], attachmentAccept: SOP_ATTACHMENT_ACCEPT,
      submitFields: [], submitZones: [], submitSource: '', submitLoading: false, enqueueing: false,
      backend: 'openclaw', model: 'openclaw/default', modelsLoading: false,
      customModels: WORKBUDDY_CUSTOM_MODEL_HINTS.slice(), platformModels: [], openclawModels: [{ id: 'openclaw/default', name: 'openclaw/default' }],
      organizationId: '', agentId: '', organizations: [], agents: [], scopeLoading: false,
      AI_BACKEND_XIAOCE, AI_BACKEND_OPENCLAW, queue: null
    }
  },
  computed: {
    submitZoneHint() {
      if (this.submitSource === 'recruit_fallback') return '招聘类保底模板（大纲未抽出字段）'
      if (this.submitSource === 'outline_zone_empty') return '大纲有「提交资料」区，请按实际要求填写'
      return this.submitZones.length ? `来自：${this.submitZones.slice(0, 2).join(' / ')}` : ''
    }
  },
  watch: {
    visible(value) { if (value) this.open() }
  },
  created() {
    this.queue = getSharedSopRunQueue({ getConcurrency: () => resolveSopRunConcurrency() })
  },
  methods: {
    ...mapMutations(['setLocalConfig']),
    close() { this.$emit('update:visible', false); this.$emit('close') },
    open() {
      if (!this.target || !this.roomKey) return this.close()
      const active = this.queue.findActiveBySop(this.roomKey, this.target.uid)
      if (active && active.state !== 'waiting_data') { this.$message.info('该 SOP 已在运行或排队中'); this.close(); return }
      this.outputIds = []; this.extraNote = ''; this.attachments = []; this.submitFields = []; this.submitZones = []; this.submitSource = ''
      const config = getLocalConfig() || {}
      this.backend = normalizeAiBackend(config.aiBackend || AI_BACKEND_OPENCLAW)
      this.organizationId = String(config.xiaoceOrganizationId || ''); this.agentId = String(config.xiaoceAgentId || '')
      this.model = this.backend === AI_BACKEND_OPENCLAW ? (getOpenclawConfig().model || 'openclaw/default') : (getWorkbuddyConfig().model || 'deepseek-v4-flash')
      if (this.backend === AI_BACKEND_XIAOCE) this.loadXiaoceScope(); else this.loadModels()
      this.loadSubmitTemplate()
    },
    onFilesPicked(event) { const files = Array.from(event.target.files || []); event.target.value = ''; this.addAttachments(files) },
    onPaste(event) { const cb = event.clipboardData; if (!cb) return; const files = Array.from(cb.files || []); if (!files.length) Array.from(cb.items || []).forEach(i => { if (i.kind === 'file') { const f = i.getAsFile(); if (f) files.push(f) } }); if (!files.length) return; if (!cb.getData('text/plain')) event.preventDefault(); this.addAttachments(files) },
    addAttachments(files) {
      for (const file of files) {
        if (this.attachments.length >= SOP_ATTACHMENT_LIMIT) { this.$message.warning('最多添加 5 个附件，请先删除不需要的文件'); break }
        const error = validateSopAttachment(file); if (error) { this.$message.warning(`${file.name}：${error}`); continue }
        const ext = String(file.name || '').split('.').pop().toLowerCase()
        const kind = ext === 'pdf' ? 'pdf' : /^(xlsx|csv)$/.test(ext) ? 'sheet' : /^(png|jpe?g|webp|gif)$/.test(ext) ? 'image' : 'document'
        const item = { key: `${Date.now()}-${Math.random()}`, name: file.name, kind, badge: { pdf: 'PDF', sheet: 'X', image: '图', document: '文' }[kind], status: 'uploading', error: '', attachmentId: '', extractedText: '' }
        this.attachments.push(item)
        uploadSopAttachment(this.roomKey, file).then(a => { if (this.attachments.includes(item)) Object.assign(item, { status: 'ready', attachmentId: a.id, extractedText: a.extractedText }) }).catch(err => { if (!this.attachments.includes(item)) return; item.status = 'failed'; item.error = err.message || '附件上传失败'; this.$message.error(`${item.name}：${item.error}`) })
      }
    },
    removeAttachment(file) { this.attachments = this.attachments.filter(item => item !== file) },
    onBackendChange(value) { this.setLocalConfig({ aiBackend: value }); if (value === AI_BACKEND_XIAOCE) this.loadXiaoceScope(true); else { this.model = value === AI_BACKEND_OPENCLAW ? (getOpenclawConfig().model || 'openclaw/default') : (getWorkbuddyConfig().model || 'deepseek-v4-flash'); this.loadModels(true) } },
    async onOrganizationChange(value) { this.organizationId = String(value || ''); this.agentId = ''; await this.loadXiaoceAgents(true) },
    async loadXiaoceAgents(fallback) { this.agents = this.organizationId ? await fetchXiaoceAgents(this.organizationId) : []; if (!this.agents.some(i => String(i.id) === this.agentId)) this.agentId = fallback && this.agents[0] ? String(this.agents[0].id) : '' },
    async loadXiaoceScope(showError) { if (this.scopeLoading) return; this.scopeLoading = true; try { this.organizations = await fetchXiaoceOrganizations(); if (!this.organizations.some(i => String(i.id) === this.organizationId)) { const p = this.organizations.find(i => i.isCurrent) || this.organizations[0]; this.organizationId = p ? String(p.id) : '' } await this.loadXiaoceAgents(true) } catch (err) { if (showError) this.$message.error(`小策配置加载失败：${err.message || '未知错误'}`) } finally { this.scopeLoading = false } },
    async loadSubmitTemplate() { this.submitLoading = true; try { const ctx = await loadSopRunContext(this.roomKey, this.target); const parsed = extractSubmitMaterialFields(ctx.outline || '', { sopTitle: this.target.title || this.target.id || '' }); this.submitFields = (parsed.fields || []).map(f => ({ ...f, hint: f.hint || `请填写${f.label}`, value: f.value || '' })); this.submitZones = parsed.zones || []; this.submitSource = parsed.source || '' } catch (err) { console.warn('[sopRunDialog] load submit template failed', err) } finally { this.submitLoading = false } },
    onModelDropdown(value) { if (value && !this.platformModels.length) this.loadModels() },
    async loadModels(force) { if (this.modelsLoading) return; this.modelsLoading = true; try { if (this.backend === AI_BACKEND_OPENCLAW) { const list = await fetchAiModels(AI_BACKEND_OPENCLAW); this.openclawModels = list && list.length ? list : [{ id: 'openclaw/default', name: 'openclaw/default' }]; if (!this.openclawModels.some(i => i.id === this.model)) this.model = this.openclawModels[0].id } else { const list = (await fetchWorkbuddyModels()) || []; this.customModels = list.filter(i => i.custom); this.platformModels = list.filter(i => !i.custom); if (!this.customModels.length) this.customModels = WORKBUDDY_CUSTOM_MODEL_HINTS.slice(); const all = [...this.customModels, ...this.platformModels]; if (!all.some(i => i.id === this.model)) this.model = all[0] ? all[0].id : 'deepseek-v4-flash' } } catch (err) { if (force) this.$message.warning(`模型列表加载失败：${err.message || '未知错误'}`) } finally { this.modelsLoading = false } },
    async confirm() {
      if (this.submitLoading || this.enqueueing) return
      if (this.backend === AI_BACKEND_XIAOCE && (!this.organizationId || !this.agentId)) return this.$message.warning('请先选择企业和智能体')
      const missing = missingSubmitMaterialLabels(this.submitFields); if (missing.length) return this.$message.warning(`请先填写：${missing.slice(0, 5).join('、')}`)
      if (this.attachments.some(f => f.status !== 'ready')) return this.$message.warning('请等待附件解析完成，或删除失败的附件后重试')
      this.setLocalConfig({ aiBackend: this.backend, xiaoceOrganizationId: this.organizationId, xiaoceAgentId: this.agentId })
      if (this.backend === AI_BACKEND_OPENCLAW) saveOpenclawConfig({ model: this.model }); else this.setLocalConfig({ workbuddyModel: this.model })
      const note = formatSubmitMaterialNote(this.submitFields, formatSopAttachmentNote(this.extraNote, this.attachments))
      this.enqueueing = true
      try {
        const result = await this.queue.enqueue({ roomKey: this.roomKey, sop: this.target, outputIds: this.outputIds.slice(), extraNote: note || this.extraNote, model: this.model, backend: this.backend, actor: this.actor,
          onSuccess: (outcome, job) => this.$emit('finished', { outcome, job }),
          onError: (error, message) => { if (!(error && error.name === 'AbortError')) this.$message.error(`「${this.target.title}」：${message}`); this.$emit('failed', { error, message }) },
          onWaiting: (outcome, job) => this.$emit('waiting', { outcome, job })
        })
        if (!result.ok) return this.$message.warning(result.message || '入队失败')
        this.$message.success(`已加入队列：${this.target.title}`)
        this.$emit('enqueued', result.job)
        this.close()
      } finally { this.enqueueing = false }
    }
  }
}
</script>

<style lang="less" src="../sopRunDialog.less"></style>
