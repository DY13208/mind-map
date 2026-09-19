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
          <el-input size="small" value="助理（OpenClaw）" disabled />
        </label>
        <label class="runExecutionField runModelField">
          <span>模型</span>
          <el-select v-model="model" size="small" filterable allow-create default-first-option :loading="modelsLoading" placeholder="选择助理模型" @visible-change="onModelDropdown">
            <el-option v-for="item in openclawModels" :key="item.id" :label="item.name || item.id" :value="item.id" />
          </el-select>
        </label>
        <el-button class="runRefreshButton" size="small" icon="el-icon-refresh" :loading="modelsLoading" @click="loadModels(true)">刷新</el-button>
      </div>
    </section>
    <div class="runSectionTitle"><strong>输出内容</strong><span>可不选</span></div>
    <el-checkbox-group v-model="outputIds" class="outputChecks">
      <el-checkbox v-for="opt in outputPresets" :key="opt.id" :label="opt.id" class="outputCheck"><span>{{ opt.label }}</span></el-checkbox>
    </el-checkbox-group>
    <p class="runOutputRulesTip">
      运行会按内置「输出规则」写业务可读汇报（结论 / 交付 / 发现 / 改脑图建议）；勾选的 HTML 等仅在规则表已定义时强制版式。
      <a :href="outputRulesUrls.xmind" download="SOP输出规则.xmind">下载规则脑图</a>
      <button type="button" class="runOutputRulesLink" :disabled="cloningRules" @click="cloneOutputRules">{{ cloningRules ? '正在复制…' : '复制到我的空间' }}</button>
    </p>
    <div class="runSectionTitle">
      <strong>引用辅助决策</strong>
      <span>可选 · 最多 {{ refMapLimit }} 张整图</span>
    </div>
    <div class="runRefMapsBox">
      <el-select
        v-model="refMapKeys"
        class="runRefMapsSelect"
        size="small"
        multiple
        filterable
        clearable
        collapse-tags
        :multiple-limit="refMapLimit"
        :loading="refMapsLoading"
        placeholder="选择脑图作为决策参考（如「输出规则」）"
        @visible-change="onRefMapsDropdown"
      >
        <el-option
          v-for="item in refMapOptions"
          :key="item.roomKey"
          :label="item.title"
          :value="item.roomKey"
        >
          <span class="runRefMapOptTitle">{{ item.title }}</span>
          <span class="runRefMapOptKey">{{ item.roomKey }}</span>
        </el-option>
      </el-select>
      <el-button
        class="runRefMapsRefresh"
        size="small"
        icon="el-icon-refresh"
        :loading="refMapsLoading"
        @click="loadRefMapOptions(true)"
      >
        刷新
      </el-button>
    </div>
    <div v-if="selectedRefMaps.length" class="runRefMapTags">
      <span
        v-for="item in selectedRefMaps"
        :key="item.roomKey"
        class="runRefMapTag"
      >
        <span class="runRefMapTagTitle">{{ item.title }}</span>
        <button type="button" :aria-label="'移除 ' + item.title" @click="removeRefMap(item.roomKey)">
          <i class="el-icon-close" />
        </button>
      </span>
    </div>
    <p class="runRefMapsTip">入队时会拉取所选脑图大纲写入提示词，仅作参考，不覆盖本 SOP 步骤与内置输出规则。</p>
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
import { SOP_OUTPUT_PRESETS, loadSopRunContext } from '@/utils/sopRun'
import { getSopOutputRulesTemplateUrls, cloneSopOutputRulesTemplate } from '@/utils/sopOutputRulesTemplate'
import { getSharedSopRunQueue, resolveSopRunConcurrency } from '@/utils/sopRunQueue'
import { SOP_ATTACHMENT_ACCEPT, SOP_ATTACHMENT_LIMIT, validateSopAttachment, uploadSopAttachment, formatSopAttachmentNote } from '@/utils/sopRunAttachments'
import { extractSubmitMaterialFields, formatSubmitMaterialNote, missingSubmitMaterialLabels } from '@/utils/sopSubmitMaterial'
import { fetchAiModels, getOpenclawConfig, saveOpenclawConfig, AI_BACKEND_OPENCLAW } from '@/utils/agentChat'
import {
  SOP_REF_MAP_LIMIT,
  listRefMapCandidates,
  loadRefMapOutlines,
  formatRefMapsPromptBlock,
  toRefMapsMeta
} from '@/utils/sopRunRefMaps'

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
      outputPresets: SOP_OUTPUT_PRESETS,
      outputIds: [],
      extraNote: '',
      attachments: [],
      attachmentAccept: SOP_ATTACHMENT_ACCEPT,
      outputRulesUrls: getSopOutputRulesTemplateUrls(),
      cloningRules: false,
      submitFields: [],
      submitZones: [],
      submitSource: '',
      submitLoading: false,
      enqueueing: false,
      backend: AI_BACKEND_OPENCLAW,
      model: 'openclaw/default',
      modelsLoading: false,
      openclawModels: [{ id: 'openclaw/default', name: 'openclaw/default' }],
      AI_BACKEND_OPENCLAW,
      queue: null,
      refMapLimit: SOP_REF_MAP_LIMIT,
      refMapKeys: [],
      refMapOptions: [],
      refMapsLoading: false,
      refMapsLoadedOnce: false
    }
  },
  computed: {
    submitZoneHint() {
      if (this.submitSource === 'recruit_fallback') return '招聘类保底模板（大纲未抽出字段）'
      if (this.submitSource === 'outline_zone_empty') return '大纲有「提交资料」区，请按实际要求填写'
      return this.submitZones.length ? `来自：${this.submitZones.slice(0, 2).join(' / ')}` : ''
    },
    selectedRefMaps() {
      const byKey = new Map(
        (this.refMapOptions || []).map(item => [item.roomKey, item])
      )
      return (this.refMapKeys || [])
        .map(key => byKey.get(key) || { roomKey: key, title: key })
        .filter(Boolean)
    }
  },
  watch: {
    visible(value) {
      if (value) this.open()
    }
  },
  created() {
    this.queue = getSharedSopRunQueue({
      getConcurrency: () => resolveSopRunConcurrency()
    })
  },
  methods: {
    ...mapMutations(['setLocalConfig']),
    close() {
      this.$emit('update:visible', false)
      this.$emit('close')
    },
    async cloneOutputRules() {
      if (this.cloningRules) return
      this.cloningRules = true
      try {
        const created = await cloneSopOutputRulesTemplate()
        this.$message.success(`已复制「${created.title}」到我的空间`)
        const key = created.roomKey
        if (key && this.$router) {
          this.$router.push({ path: '/', query: { room: key } }).catch(() => {})
        }
      } catch (err) {
        this.$message.error((err && err.message) || '复制输出规则脑图失败')
      } finally {
        this.cloningRules = false
      }
    },
    open() {
      if (!this.target || !this.roomKey) return this.close()
      const active = this.queue.findActiveBySop(this.roomKey, this.target.uid)
      if (active && active.state !== 'waiting_data') {
        this.$message.info('该 SOP 已在运行或排队中')
        this.close()
        return
      }
      this.outputIds = []
      this.extraNote = ''
      this.attachments = []
      this.submitFields = []
      this.submitZones = []
      this.submitSource = ''
      this.refMapKeys = []
      this.backend = AI_BACKEND_OPENCLAW
      this.setLocalConfig({ aiBackend: AI_BACKEND_OPENCLAW })
      this.model = getOpenclawConfig().model || 'openclaw/default'
      this.loadModels()
      this.loadSubmitTemplate()
      this.loadRefMapOptions()
    },
    onRefMapsDropdown(open) {
      if (open) this.loadRefMapOptions()
    },
    removeRefMap(roomKey) {
      const key = String(roomKey || '').trim()
      this.refMapKeys = (this.refMapKeys || []).filter(k => k !== key)
    },
    async loadRefMapOptions(force) {
      if (this.refMapsLoading) return
      if (this.refMapsLoadedOnce && !force && this.refMapOptions.length) return
      this.refMapsLoading = true
      try {
        this.refMapOptions = await listRefMapCandidates({
          excludeRoomKey: this.roomKey
        })
        this.refMapsLoadedOnce = true
        const valid = new Set(this.refMapOptions.map(i => i.roomKey))
        this.refMapKeys = (this.refMapKeys || []).filter(k => valid.has(k))
      } catch (err) {
        if (force) {
          this.$message.warning(
            `脑图列表加载失败：${(err && err.message) || '未知错误'}`
          )
        }
      } finally {
        this.refMapsLoading = false
      }
    },
    onFilesPicked(event) {
      const files = Array.from(event.target.files || [])
      event.target.value = ''
      this.addAttachments(files)
    },
    onPaste(event) {
      const cb = event.clipboardData
      if (!cb) return
      const files = Array.from(cb.files || [])
      if (!files.length) {
        Array.from(cb.items || []).forEach(i => {
          if (i.kind === 'file') {
            const f = i.getAsFile()
            if (f) files.push(f)
          }
        })
      }
      if (!files.length) return
      if (!cb.getData('text/plain')) event.preventDefault()
      this.addAttachments(files)
    },
    addAttachments(files) {
      for (const file of files) {
        if (this.attachments.length >= SOP_ATTACHMENT_LIMIT) {
          this.$message.warning('最多添加 5 个附件，请先删除不需要的文件')
          break
        }
        const error = validateSopAttachment(file)
        if (error) {
          this.$message.warning(`${file.name}：${error}`)
          continue
        }
        const ext = String(file.name || '')
          .split('.')
          .pop()
          .toLowerCase()
        const kind =
          ext === 'pdf'
            ? 'pdf'
            : /^(xlsx|csv)$/.test(ext)
              ? 'sheet'
              : /^(png|jpe?g|webp|gif)$/.test(ext)
                ? 'image'
                : 'document'
        const item = {
          key: `${Date.now()}-${Math.random()}`,
          name: file.name,
          kind,
          badge: { pdf: 'PDF', sheet: 'X', image: '图', document: '文' }[kind],
          status: 'uploading',
          error: '',
          attachmentId: '',
          extractedText: ''
        }
        this.attachments.push(item)
        uploadSopAttachment(this.roomKey, file)
          .then(a => {
            if (this.attachments.includes(item)) {
              Object.assign(item, {
                status: 'ready',
                attachmentId: a.id,
                extractedText: a.extractedText
              })
            }
          })
          .catch(err => {
            if (!this.attachments.includes(item)) return
            item.status = 'failed'
            item.error = err.message || '附件上传失败'
            this.$message.error(`${item.name}：${item.error}`)
          })
      }
    },
    removeAttachment(file) {
      this.attachments = this.attachments.filter(item => item !== file)
    },
    async loadSubmitTemplate() {
      this.submitLoading = true
      try {
        const ctx = await loadSopRunContext(this.roomKey, this.target)
        const parsed = extractSubmitMaterialFields(ctx.outline || '', {
          sopTitle: this.target.title || this.target.id || ''
        })
        this.submitFields = (parsed.fields || []).map(f => ({
          ...f,
          hint: f.hint || `请填写${f.label}`,
          value: f.value || ''
        }))
        this.submitZones = parsed.zones || []
        this.submitSource = parsed.source || ''
      } catch (err) {
        console.warn('[sopRunDialog] load submit template failed', err)
      } finally {
        this.submitLoading = false
      }
    },
    onModelDropdown(value) {
      if (value) this.loadModels()
    },
    async loadModels(force) {
      if (this.modelsLoading) return
      this.modelsLoading = true
      try {
        const list = await fetchAiModels(AI_BACKEND_OPENCLAW)
        this.openclawModels =
          list && list.length
            ? list
            : [{ id: 'openclaw/default', name: 'openclaw/default' }]
        if (!this.openclawModels.some(i => i.id === this.model)) {
          this.model = this.openclawModels[0].id
        }
      } catch (err) {
        if (force) {
          this.$message.warning(`模型列表加载失败：${err.message || '未知错误'}`)
        }
      } finally {
        this.modelsLoading = false
      }
    },
    async confirm() {
      if (this.submitLoading || this.enqueueing) return
      const missing = missingSubmitMaterialLabels(this.submitFields)
      if (missing.length) {
        return this.$message.warning(`请先填写：${missing.slice(0, 5).join('、')}`)
      }
      if (this.attachments.some(f => f.status !== 'ready')) {
        return this.$message.warning('请等待附件解析完成，或删除失败的附件后重试')
      }
      this.setLocalConfig({ aiBackend: AI_BACKEND_OPENCLAW })
      saveOpenclawConfig({ model: this.model })
      const note = formatSubmitMaterialNote(
        this.submitFields,
        formatSopAttachmentNote(this.extraNote, this.attachments)
      )
      this.enqueueing = true
      try {
        let refMapsNote = ''
        let refMapsMeta = []
        if (this.selectedRefMaps.length) {
          const loaded = await loadRefMapOutlines(this.selectedRefMaps)
          const failed = loaded.filter(r => r.error || !r.outline)
          const ok = loaded.filter(r => r.outline && !r.error)
          if (failed.length) {
            const names = failed
              .map(r => r.title || r.roomKey)
              .slice(0, 3)
              .join('、')
            this.$message.warning(
              `有 ${failed.length} 张引用脑图未能读取大纲（${names}），将仅使用可读的引用`
            )
          }
          refMapsNote = formatRefMapsPromptBlock(ok)
          refMapsMeta = toRefMapsMeta(loaded)
          if (this.selectedRefMaps.length && !ok.length) {
            this.$message.warning('所选引用脑图均无法读取，将不带引用继续入队')
          }
        }
        const result = await this.queue.enqueue({
          roomKey: this.roomKey,
          sop: this.target,
          outputIds: this.outputIds.slice(),
          extraNote: note || this.extraNote,
          refMaps: refMapsMeta,
          refMapsNote,
          model: this.model,
          backend: AI_BACKEND_OPENCLAW,
          actor: this.actor,
          onSuccess: (outcome, job) => this.$emit('finished', { outcome, job }),
          onError: (error, message) => {
            if (!(error && error.name === 'AbortError')) {
              this.$message.error(`「${this.target.title}」：${message}`)
            }
            this.$emit('failed', { error, message })
          },
          onWaiting: (outcome, job) => this.$emit('waiting', { outcome, job })
        })
        if (!result.ok) return this.$message.warning(result.message || '入队失败')
        this.$message.success(`已加入队列：${this.target.title}`)
        this.$emit('enqueued', result.job)
        this.close()
      } finally {
        this.enqueueing = false
      }
    }
  }
}
</script>

<style lang="less" src="../sopRunDialog.less"></style>
