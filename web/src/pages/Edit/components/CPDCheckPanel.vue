<template>
  <el-dialog
    :visible.sync="visible"
    title="CPD 链路检查"
    width="min(900px, calc(100vw - 32px))"
    append-to-body
    :close-on-click-modal="false"
    :before-close="close"
    class="cpd-check-dialog"
    data-testid="cpd-check-panel"
  >
    <div class="cpd-check-panel">
      <div class="cpd-check-sticky">
      <div class="cpd-check-target" data-testid="cpd-check-target">
        <div class="cpd-context">
          <span>检查对象</span>
          <strong>{{ checkTargetDisplayTitle }}</strong>
        </div>
        <div v-if="scopeSummary" class="cpd-context cpd-scope-context" data-testid="cpd-check-scope">
          <small>{{ scopeSummary }}</small>
        </div>
      </div>

      <el-alert
        v-if="error"
        :title="error"
        type="error"
        :closable="true"
        show-icon
        @close="error = ''"
      ></el-alert>

      <div class="cpd-panel-toolbar">
        <el-button
          size="mini"
          icon="el-icon-refresh"
          :loading="checking"
          :disabled="!canCheck"
          data-testid="cpd-check-run"
          @click="createCheckRun"
        >
          {{ checking ? '检查中' : '重新检查' }}
        </el-button>
        <small class="cpd-check-note">按正式检查执行，已标记的演示资料不会作为正式依据；Wiki 阈值和责任角色仅供参考。</small>
        <span v-if="run" class="cpd-run-meta">
          检查记录 {{ run.id || '—' }}<template v-if="run.createdAt || run.created_at"> · {{ formatBeijingTime(run.createdAt || run.created_at) }}</template>
        </span>
      </div>

      <div v-if="checking" class="cpd-empty-state" role="status">
        <i class="el-icon-loading"></i> 正在读取链路并检查规则…
      </div>
      <div v-else-if="run" class="cpd-overview" :class="statusClass(run.status)">
          <span class="cpd-overview-status">{{ reportStageLabel }}</span>
          <span>{{ overviewText }}</span>
          <strong v-if="report.mode === 'demo' || report.mode === 'demo_validation'" class="cpd-demo-badge">演示结果，不能用于正式通过</strong>
          <span v-if="reportIsStale" class="cpd-stale">
            报告已过期，请重新检查
          </span>
      </div>
      </div>
      <el-tabs v-if="run" v-model="activeTab" class="cpd-tabs" data-testid="cpd-check-tabs">
          <el-tab-pane label="问题与依据" name="findings">
            <div class="cpd-section">
              <section v-if="candidates.length" class="cpd-section">
                <h3>待确认的流程候选 <small>选择后继续检查，不会自动采用最高分</small></h3>
                <article v-for="(candidate, index) in candidates" :key="candidateId(candidate) || `candidate-${index}`" class="cpd-candidate">
                  <div class="cpd-candidate-head">
                    <strong>{{ candidate.title || candidate.name || candidate.label || '未命名流程' }}</strong>
                    <el-button v-if="!readonly" size="mini" type="primary" plain :loading="confirmingCandidateId === candidateId(candidate)" :disabled="confirming || reportIsStale" @click="confirmCandidate(candidate)">{{ report.mode === 'demo' || report.mode === 'demo_validation' ? '选择演示参考（不形成正式结论）' : '确认为对应流程' }}</el-button>
                  </div>
                  <div v-if="candidatePath(candidate)" class="cpd-candidate-path">{{ candidatePath(candidate) }}</div>
                  <div class="cpd-candidate-parts">
                    <div v-for="part in candidateParts(candidate)" :key="part.key"><strong>{{ part.label }}</strong><span>{{ part.value || '未提供' }}</span></div>
                  </div>
                  <small class="cpd-candidate-note">候选参数仅供对照；频率阈值和责任角色仍以本链路或项目资料为准。</small>
                  <p v-if="candidate.reason || candidate.matchReason || candidate.match_reason">匹配原因：{{ candidate.reason || candidate.matchReason || candidate.match_reason }}</p>
                  <p v-if="candidateOtherSummary(candidate)">候选摘要：{{ candidateOtherSummary(candidate) }}</p>
                </article>
                <el-button v-if="report.selectionStage === 'source' && !readonly" size="mini" :disabled="confirming || reportIsStale" @click="confirmCandidate({ candidateId: '__skip__', kind: 'flow' })">均不对应，继续检索</el-button>
              </section>
              <h3>统计 <small>各分类互斥</small></h3>
              <div class="cpd-statistics" data-testid="cpd-check-statistics">
                <span v-for="item in categoryStatistics" :key="item.key" :class="'is-' + item.key">
                  {{ item.label }} <strong>{{ item.count }}</strong>
                </span>
              </div>
              <small class="cpd-rule-hint">CK 编号沿用检查逻辑总表。同一节点同一规则的字段已合并；证据只显示可追溯的原文。</small>
              <div v-if="!findings.length" class="cpd-empty-state">
                后端尚未返回逐项检查结果，当前报告不能据此判定通过。
              </div>
              <div v-for="group in findingGroups" :key="group.key" class="cpd-finding-group" :data-category="group.key">
                <h4>{{ group.title }} <span>{{ group.count }} 项检查<template v-if="group.items.length !== group.count"> · {{ group.items.length }} 张卡</template></span></h4>
                <article
                  v-for="(finding, index) in group.items"
                  :key="findingKey(finding, index)"
                  class="cpd-finding"
                  :class="findingStatusClass(finding.status, finding.severity)"
                >
                  <div class="cpd-finding-head">
                    <strong>{{ findingRule(finding) }}</strong>
                    <span class="cpd-finding-state">{{ findingStatusLabel(finding.status, finding.severity) }}</span>
                  </div>
                  <div class="cpd-finding-node">
                    <span>节点：{{ findingNodeTitle(finding) }}</span>
                  </div>
                  <div v-if="finding.mergedCount > 1" class="cpd-field-details">
                    <div v-for="(detail, detailIndex) in findingDetails(finding)" :key="findingKey(detail, detailIndex)">
                      <strong>{{ findingFields(detail).join('、') || '检查项' }}</strong>
                      <span>{{ findingStatusLabel(detail.status, detail.severity) }}</span>
                      <p>{{ findingDetailMessage(detail) }}</p>
                      <small v-if="findingNextStep(detail)">下一步：{{ findingNextStep(detail) }}</small>
                    </div>
                  </div>
                  <p v-else class="cpd-finding-issue">{{ findingIssue(finding) }}</p>
                  <p v-if="!(finding.mergedCount > 1) && findingFields(finding).length" class="cpd-finding-fields">字段：{{ findingFields(finding).join('、') }}</p>
                  <div v-if="relatedMaterialCandidates(finding).length" class="cpd-material-evidence">
                    <strong>可参考资料（当前图仍缺字段或引用）</strong>
                    <article v-for="candidate in relatedMaterialCandidates(finding)" :key="materialCandidateKey(candidate)" class="cpd-material-evidence-item">
                      <div>{{ materialCandidateTitle(candidate) }}<small v-if="candidate.field"> · {{ fieldLabel(candidate.field) }}</small></div>
                      <small v-if="candidatePath(candidate)">{{ candidatePath(candidate) }}</small>
                      <blockquote>{{ candidate.quote }}</blockquote>
                      <p>该候选只作参考；当前图仍缺字段或引用，补入并重新检查后才会更新状态。</p>
                    </article>
                  </div>
                  <div v-if="evidenceEntries(finding).length" class="cpd-evidence-list">
                    <div v-for="entry in evidenceEntries(finding)" :key="entry.id" class="cpd-evidence-entry">
                      <small>{{ entry.label || '原文依据' }}<template v-if="!entry.complete"> · 来源未完整读取</template></small>
                      <blockquote>{{ entry.quote }}</blockquote>
                    </div>
                  </div>
                  <div v-if="findingSource(finding)" class="cpd-finding-source">来源：{{ findingSource(finding) }}</div>
                  <div v-if="sourceErrors(finding).length" class="cpd-source-error-list">
                    <div v-for="sourceError in sourceErrors(finding)" :key="sourceError.sourceId + ':' + sourceError.status">
                      {{ sourceError.title || sourceErrorScopeLabel(sourceError.scope) }}：{{ sourceStatusLabel(sourceError.status) }}<template v-if="sourceError.error">（{{ sourceError.error }}）</template>
                    </div>
                    <small>影响项：{{ sourceErrorImpact(finding) }}</small>
                  </div>
                  <div v-if="!(finding.mergedCount > 1) && findingNextStep(finding)" class="cpd-finding-next">下一步：{{ findingNextStep(finding) }}</div>
                  <div v-for="target in reviewTargets(finding)" :key="findingKey(target, 0)" class="cpd-manual-review">
                    <strong>人工核对：{{ findingFields(target).join('、') || findingRule(target) }}</strong>
                    <p v-if="target.manualReview" class="cpd-review-result">
                      最近核对：{{ manualReviewLabel(target, reportIsStale || target.manualReview.invalidated) }} · {{ target.manualReview.actorName || target.manualReview.actorId || '用户' }} · {{ formatBeijingTime(target.manualReview.at) }}
                      <span v-if="target.manualReview.reason">；说明：{{ target.manualReview.reason }}</span>
                    </p>
                    <p v-if="report.mode === 'demo' || report.mode === 'demo_validation'" class="cpd-review-disabled">演示报告不能作为正式人工核对。</p>
                    <template v-else>
                      <label v-for="entry in reviewEvidenceEntries(target)" :key="entry.id" class="cpd-review-evidence">
                        <input
                          type="checkbox"
                          :checked="reviewEvidenceSelected(target, entry.id)"
                          :disabled="reviewDisabled(target, 'confirm')"
                          @change="toggleReviewEvidence(target, entry.id, $event.target.checked)"
                        >
                        <span>{{ entry.label || '核对原文' }}：{{ entry.quote }}</span>
                      </label>
                      <textarea
                        class="cpd-review-reason"
                        :value="reviewReason(target)"
                        :disabled="reviewDisabled(target, 'confirm')"
                        rows="2"
                        maxlength="2000"
                        placeholder="填写本次核对说明（必填）"
                        @input="setReviewReason(target, $event.target.value)"
                      ></textarea>
                      <div class="cpd-review-actions">
                        <el-button size="mini" type="primary" :loading="reviewSubmittingKey === findingKey(target, 0)" :disabled="reviewDisabled(target, 'confirm')" @click="submitReview(target, 'confirm')">确认</el-button>
                        <el-button size="mini" type="danger" plain :loading="reviewSubmittingKey === findingKey(target, 0)" :disabled="reviewDisabled(target, 'reject')" @click="submitReview(target, 'reject')">判定未通过</el-button>
                        <el-button v-if="target.manualReview" size="mini" plain :loading="reviewSubmittingKey === findingKey(target, 0)" :disabled="reviewDisabled(target, 'revoke')" @click="submitReview(target, 'revoke')">撤销核对</el-button>
                      </div>
                    </template>
                  </div>
                </article>
              </div>
              <details v-if="verifiedFindings.length || notApplicableFindings.length" class="cpd-verified-group">
                <summary>已核验 / 本阶段不适用 / 历史核对（{{ verifiedFindings.length + notApplicableFindings.length }}）</summary>
                <article
                  v-for="(finding, index) in verifiedFindings.concat(notApplicableFindings)"
                  :key="findingKey(finding, index)"
                  class="cpd-finding"
                  :class="reportIsStale ? 'is-stale' : 'is-passed'"
                >
                  <div class="cpd-finding-head">
                    <strong>{{ findingRule(finding) }}</strong>
                    <span class="cpd-finding-state">{{ reportIsStale ? '历史结果（报告已过期）' : findingStatusLabel(finding.status, finding.severity) }}</span>
                  </div>
                  <div class="cpd-finding-node">
                    <span>节点：{{ findingNodeTitle(finding) }}</span>
                  </div>
                  <p class="cpd-finding-issue">{{ findingIssue(finding) }}</p>
                  <div v-if="evidenceEntries(finding).length" class="cpd-evidence-list">
                    <div v-for="entry in evidenceEntries(finding)" :key="entry.id" class="cpd-evidence-entry">
                      <small>{{ entry.label || '原文依据' }}</small><blockquote>{{ entry.quote }}</blockquote>
                    </div>
                  </div>
                  <div v-for="target in reviewTargets(finding).filter(item => item.manualReview)" :key="findingKey(target, 0) + ':history'" class="cpd-manual-review">
                    <strong>人工核对：{{ findingFields(target).join('、') || findingRule(target) }}</strong>
                    <p class="cpd-review-result">{{ manualReviewLabel(target, reportIsStale || target.manualReview.invalidated) }} · {{ target.manualReview.actorName || target.manualReview.actorId || '用户' }} · {{ formatBeijingTime(target.manualReview.at) }}<span v-if="target.manualReview.reason">；说明：{{ target.manualReview.reason }}</span></p>
                    <textarea class="cpd-review-reason" :value="reviewReason(target)" :disabled="reviewDisabled(target, 'revoke')" rows="2" maxlength="2000" placeholder="填写撤销原因（必填）" @input="setReviewReason(target, $event.target.value)"></textarea>
                    <div class="cpd-review-actions">
                      <el-button size="mini" plain :loading="reviewSubmittingKey === findingKey(target, 0)" :disabled="reviewDisabled(target, 'revoke')" @click="submitReview(target, 'revoke')">撤销核对</el-button>
                    </div>
                  </div>
                </article>
              </details>
              <details v-if="missingSummaries.length" class="cpd-verified-group cpd-missing-summary">
                <summary>缺项汇总（{{ missingSummaries.length }} 个节点）</summary>
                <p v-for="(item, index) in missingSummaries" :key="findingKey(item, index)">
                  {{ findingNodeTitle(item) }}：{{ findingIssue(item) }}
                </p>
              </details>
            </div>
          </el-tab-pane>

          <el-tab-pane label="参考资料" name="references">
            <div class="cpd-section">
              <section v-if="materialCandidates.length" class="cpd-section">
                <h3>材料候选</h3>
                <article v-for="(candidate, index) in materialCandidates" :key="candidateId(candidate) || `material-${index}`" class="cpd-candidate cpd-material-candidate">
                  <strong>{{ candidate.title || candidate.name || candidate.label || '材料来源' }}</strong>
                  <div v-if="candidatePath(candidate)" class="cpd-candidate-path">{{ candidatePath(candidate) }}</div>
                  <p v-if="candidate.reason || candidate.matchReason || candidate.match_reason">匹配原因：{{ candidate.reason || candidate.matchReason || candidate.match_reason }}</p>
                </article>
              </section>
              <section v-if="unclassifiedCandidates.length" class="cpd-section">
                <h3>未分类候选</h3>
                <div class="cpd-empty-state">服务端未标明候选类型，暂不能将其确认为流程或材料。</div>
                <article v-for="(candidate, index) in unclassifiedCandidates" :key="candidateId(candidate) || `unknown-${index}`" class="cpd-candidate">
                  <strong>{{ candidate.title || candidate.name || candidate.label || '未命名候选' }}</strong>
                  <div v-if="candidatePath(candidate)" class="cpd-candidate-path">{{ candidatePath(candidate) }}</div>
                  <p>{{ candidate.reason || candidate.matchReason || '未提供匹配原因' }}</p>
                </article>
              </section>
              <details v-if="referenceFields.length" class="cpd-verified-group" data-testid="cpd-reference-fields">
                <summary>参考流程字段对照</summary>
                <p>{{ report.referenceComparison.note }}</p>
                <article v-for="field in referenceFields" :key="field.key" class="cpd-finding">
                  <strong>{{ field.label }} · {{ field.state }}</strong>
                  <p class="cpd-finding-issue">本链：{{ field.current }}</p>
                  <p class="cpd-finding-issue">参考流程：{{ field.reference }}</p>
                </article>
              </details>
              <div v-if="!materialCandidates.length && !unclassifiedCandidates.length && !referenceFields.length && !sources.length && !searchStatuses.length" class="cpd-empty-state">当前报告没有参考资料或来源记录。</div>
              <section v-if="searchStatuses.length" class="cpd-section">
                <h3>检索进度</h3>
                <div v-for="item in searchStatuses" :key="item.scope" class="cpd-source">
                  <strong>{{ item.title }}</strong>
                  <span>{{ item.count }} 次检索<template v-if="item.readCount"> · {{ item.readCount }} 次读取</template></span>
                  <small>{{ sourceStatusLabel(item.status) }}</small>
                </div>
              </section>
              <section v-if="sources.length" class="cpd-section">
                <h3>检查来源</h3>
                <details v-for="group in sourceGroups" :key="group.key" class="cpd-source-group" :open="!group.collapsed">
                  <summary>{{ group.title }}（{{ group.sources.length }}）</summary>
                  <article v-for="(source, index) in group.sources" :key="sourceKey(source, index)" class="cpd-source-card">
                    <div class="cpd-source">
                      <strong>{{ sourceTitle(sourceDetails[sourceId(source)] || source) }}</strong>
                      <span>
                        <span v-if="sourcePath(source) && !isTechnicalSourcePath(sourcePath(source))">{{ sourcePath(source) }}</span>
                        <small class="cpd-source-usage">{{ sourceUsageLabel(source) }} · {{ sourceDisplayStatus(source) }}</small>
                        <small v-if="sourceOrigins(source)" class="cpd-source-origins">原始资料：{{ sourceOrigins(source) }}</small>
                        <small v-if="sourceProvenance(source)" class="cpd-source-origins">来源类型：{{ sourceProvenance(source) }}</small>
                      </span>
                      <small v-if="source.status && sourceRetryable(source)">{{ sourceStatusLabel(source.status) }}</small>
                    </div>
                    <div class="cpd-source-actions">
                      <el-button size="mini" plain :loading="sourceLoadingId === sourceId(source)" :disabled="!sourceId(source) || sourceLoadingId === sourceId(source)" @click="readSource(source)">查看来源</el-button>
                      <el-button v-if="!readonly && sourceRetryable(source)" size="mini" plain :loading="sourceRetryingId === sourceId(source)" :disabled="!sourceId(source) || sourceRetryingId === sourceId(source) || !run.id || reportIsStale" @click="retrySource(source)">重新读取并复检</el-button>
                    </div>
                    <div v-if="sourceDetails[sourceId(source)]" class="cpd-source-detail">
                      <p v-if="sourceDetails[sourceId(source)].title">资料名称：{{ sourceDetails[sourceId(source)].title }}</p>
                      <p v-if="sourceDetails[sourceId(source)].path && !isTechnicalSourcePath(sourceDetails[sourceId(source)].path)">路径：{{ sourceDetails[sourceId(source)].path }}</p>
                      <p v-if="sourceDetails[sourceId(source)].changed" class="cpd-source-changed">来源内容或版本已变化；当前检查报告需要重新核验。</p>
                      <p v-if="sourceDetails[sourceId(source)].status">读取状态：{{ sourceStatusLabel(sourceDetails[sourceId(source)].status) }}<template v-if="sourceDetails[sourceId(source)].version"> · {{ sourceDetails[sourceId(source)].version }}</template></p>
                      <p v-if="sourceDetails[sourceId(source)].provenance">来源类型：{{ sourceProvenance(sourceDetails[sourceId(source)]) }}</p>
                      <p v-if="sourceDetails[sourceId(source)].complete === false" class="cpd-source-changed">来源内容未完整读取，不能据此确认检查项。</p>
                      <pre v-if="sourceDetails[sourceId(source)].content">{{ sourceDetails[sourceId(source)].content }}</pre>
                      <details v-if="sourceTechnicalValue(source)" class="cpd-source-technical">
                        <summary>技术来源信息</summary>
                        <pre>{{ sourceTechnical(sourceTechnicalValue(source)) }}</pre>
                      </details>
                      <p v-if="!sourceDetails[sourceId(source)].content" class="cpd-empty-state">来源没有可显示的正文。</p>
                    </div>
                  </article>
                </details>
              </section>
              <div v-if="!sources.length && !searchStatuses.length" class="cpd-empty-state">当前报告没有来源记录。</div>
            </div>
          </el-tab-pane>
          <el-tab-pane label="检查历史" name="history">
            <div class="cpd-section cpd-history">
              <h3>检查历史 <small>切换历史报告只读取记录，不改变脑图</small></h3>
              <button
                v-for="(item, index) in history"
                :key="item.id || `history-${index}`"
                type="button"
                class="cpd-history-item"
                :class="{ active: item.id === run.id }"
                @click="openHistoryItem(item)"
              >
                <span>{{ formatBeijingTime(item.createdAt || item.created_at) || item.id || '检查记录' }}</span>
                <span>{{ historyStageLabel(item) }}</span>
              </button>
              <div v-if="!history.length" class="cpd-empty-state">当前链路还没有历史检查记录。</div>
            </div>
          </el-tab-pane>
        </el-tabs>
      <div v-if="!checking && !run && !error" class="cpd-empty-state">
        {{ readonly ? '当前节点没有历史检查记录。' : '点击“重新检查”生成链路检查报告。' }}
      </div>
      <div v-if="error && !run" class="cpd-empty-state">检查报告暂不可用，请查看上方错误信息。</div>
    </div>
    <span slot="footer">
      <el-button size="mini" @click="close">关闭</el-button>
    </span>
  </el-dialog>
</template>

<script>
import {
  confirmCpdCheckCandidate,
  createCpdCheckRun,
  getCpdCheckRun,
  getCpdCheckSource,
  listCpdCheckRuns,
  retryCpdCheckSource,
  submitCpdCheckReview
} from '@/utils/fileApi'

function unwrapRun(response) {
  return response && response.run ? response.run : response
}

function requestId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `cpd-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
}

function isOpaqueNodeId(value, knownIds = new Set()) {
  const text = String(value || '').trim()
  if (!text) return false
  return knownIds.has(text) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)
}

function formatPath(path) {
  if (Array.isArray(path)) {
    return path
      .map(part => {
        if (part && typeof part === 'object') {
          return part.text || part.title || part.name || ''
        }
        return String(part || '')
      })
      .filter(Boolean)
      .join(' / ')
  }
  return String(path || '')
}

function pathOf(value) {
  return value && (value.pathText || value.path_text || formatPath(value.path || value.cpdPath || value.cpd_path))
}

export default {
  name: 'CPDCheckPanel',
  props: {
    roomKey: { type: String, default: '' },
    nodeUid: { type: String, default: '' },
    nodeTitle: { type: String, default: '' },
    readonly: { type: Boolean, default: false },
    beforeCheck: { type: Function, default: null }
  },
  data() {
    return {
      visible: false,
      checkedTarget: null,
      checking: false,
      confirming: false,
      confirmingCandidateId: '',
      activeTab: 'findings',
      error: '',
      run: null,
      history: [],
      sourceDetails: {},
      sourceLoadingId: '',
      sourceRetryingId: '',
      reviewReasons: {},
      reviewEvidenceSelections: {},
      reviewSubmittingKey: '',
      requestEpoch: 0,
      requestController: null
    }
  },
  computed: {
    checkTargetUid() {
      return this.visible && this.checkedTarget ? this.checkedTarget.nodeUid : this.nodeUid
    },
    checkRoomKey() {
      return this.visible && this.checkedTarget ? this.checkedTarget.roomKey : this.roomKey
    },
    checkTargetTitle() {
      return this.visible && this.checkedTarget ? this.checkedTarget.nodeTitle : this.nodeTitle
    },
    checkTargetDisplayTitle() {
      const title = String(this.checkTargetTitle || '').trim()
      return title && !isOpaqueNodeId(title, new Set([this.checkTargetUid])) ? title : '当前选中节点'
    },
    scopeSummary() {
      const chain = this.report.chain
      const coverage = this.report.coverage || {}
      const knownNodeIds = new Set([this.checkTargetUid, ...[].concat(chain && chain.nodeUids || [])].filter(Boolean).map(String))
      const checkedNodes = [].concat(coverage.checkedNodes || []).map(item => {
        if (typeof item === 'string') return isOpaqueNodeId(item, knownNodeIds) ? '' : item
        return item && (item.name || item.title || item.text || item.label) || ''
      }).filter(value => value && !isOpaqueNodeId(value, knownNodeIds))
      const checkedLocations = [].concat(coverage.checkedLocations || []).map(item => {
        if (typeof item === 'string') return isOpaqueNodeId(item, knownNodeIds) ? '' : item
        return item && [item.label || item.name || item.title || item.kind].filter(value => value && !isOpaqueNodeId(value, knownNodeIds)).join(' · ')
      }).filter(value => value && !isOpaqueNodeId(value, knownNodeIds))
      const coverageParts = []
      if (checkedNodes.length) coverageParts.push(`已核验节点：${[...new Set(checkedNodes)].slice(0, 5).join('、')}`)
      if (checkedLocations.length) coverageParts.push(`具体位置：${[...new Set(checkedLocations)].slice(0, 5).join('；')}`)
      const coverageText = coverageParts.join('；')
      if (!chain || !Array.isArray(chain.nodeUids)) return coverageText
      const names = (roots, items) => {
        const wanted = new Set(roots || [])
        const labels = (items || []).filter(item => wanted.has(item.uid))
          .map(item => String(item.text || '').replace(/^[CPD]\s*[:：]\s*/i, ''))
        return labels.slice(0, 3).join('、') + (labels.length > 3 ? `等 ${labels.length} 项` : '')
      }
      const parts = [
        `相关 C：${names(chain.checkRootUids, chain.check) || '待确认'}`,
        `相关 P：${names(chain.planRootUids, chain.plan) || '待确认'}`,
        `D：${names(chain.executionUids, chain.execution) || '待确认'}`
      ]
      const audit = Array.isArray(chain.auditNodeUids) ? chain.auditNodeUids.length : chain.nodeUids.length
      const context = Array.isArray(chain.contextNodeUids) ? chain.contextNodeUids.length : 0
      const chainText = `检查范围：${parts.join(' → ')}；检查 ${audit} 个节点，祖先上下文 ${context} 个节点`
      return coverageText ? `${chainText}；${coverageText}` : chainText
    },
    report() {
      return (this.run && this.run.report) || {}
    },
    reportIsStale() {
      const invalidatedFinding = this.findings.some(item => item && item.manualReview && item.manualReview.invalidated)
      return !!(this.run && (this.run.status === 'stale' || this.run.stale || this.run.expired || this.report.stale || this.report.expired || invalidatedFinding))
    },
    reportStageLabel() {
      return this.stageLabel(this.run)
    },
    referenceFields() {
      const comparison = this.report.referenceComparison || {}
      const labels = { targetValue: '目标值', frequency: '频率', inputs: '输入源', criterion: '判据', owner: '责任人', outputs: '产物' }
      const states = { exact_match: '字段值相同', partial_match: '部分值相同', different: '字段值不同', not_explicit_in_reference: '参考流程未明确', not_explicit_in_chain: '本链未明确', not_available: '两侧均未明确' }
      return (Array.isArray(comparison.fields) ? comparison.fields : []).map(item => ({
        key: item.field,
        label: labels[item.field] || item.field,
        state: states[item.comparison] || '需核对',
        current: (Array.isArray(item.currentValues) ? item.currentValues : []).map(value => value.value || '').filter(Boolean).join('；') || '未明确',
        reference: (Array.isArray(item.referenceValues) ? item.referenceValues : []).join('；') || '未明确'
      }))
    },
    findings() {
      return Array.isArray(this.report.findings) ? this.report.findings : []
    },
    categoryStatistics() {
      const labels = {
        structure: '结构', missing: '待补齐', review: '待核对', source_error: '来源异常',
        hint: '提示', passed: '已核验', not_applicable: '本阶段不适用', auxiliary: '辅助汇总'
      }
      const summaryCategories = this.report.summary && this.report.summary.categories
      const counts = summaryCategories && typeof summaryCategories === 'object' && !Array.isArray(summaryCategories)
        ? summaryCategories
        : this.findings.reduce((result, item) => {
            const category = item.category || (this.isPassedFinding(item) ? 'passed' : this.isNotApplicableFinding(item) ? 'not_applicable' : this.isMissingFinding(item) ? 'missing' : 'hint')
            result[category] = (result[category] || 0) + 1
            return result
          }, {})
      return Object.keys(labels).map(key => ({ key, label: labels[key], count: Number(counts[key] || 0) })).filter(item => item.count > 0)
    },
    missingSummaries() {
      return this.findings.filter(item => (item.ruleId || item.rule_id) === 'CK-32' && item.display !== false)
    },
    searchStatuses() {
      const labels = { chain: '本链路材料', map_knowledge: '当前图资料', company_ai: '房间绑定知识库', wiki: 'Wiki', selected_flow: '选定流程', retry: '来源重读' }
      const groups = new Map()
      ;(Array.isArray(this.report.sourceStatuses) ? this.report.sourceStatuses : []).forEach(item => {
        if (!item.scope) return
        const existing = groups.get(item.scope)
        const statuses = new Set(existing ? existing.statuses : [])
        const status = item.status === 'ok' ? 'ready' : item.status
        const isRead = item.operation === 'read' || item.action === 'read' || item.candidateId && item.operation !== 'search'
        statuses.add(status)
        groups.set(item.scope, {
          ...item, title: labels[item.scope] || item.scope, statuses,
          status: statuses.size > 1 ? 'partial' : status,
          count: (existing ? existing.count : 0) + (isRead ? 0 : 1),
          readCount: (existing ? existing.readCount : 0) + (isRead ? 1 : 0)
        })
      })
      return [...groups.values()]
    },
    wikiStatus() {
      const status = this.searchStatuses.find(item => item.scope === 'wiki')
      return status ? this.sourceStatusLabel(status.status) : '尚未检索（缺项时查询）'
    },
    rawCandidates() {
      const flowCandidates = Array.isArray(this.report.flowCandidates)
        ? this.report.flowCandidates.map(candidate => ({
            ...candidate,
            kind: candidate.kind || candidate.type || 'flow'
          }))
        : []
      const reportCandidates = Array.isArray(this.report.candidates)
        ? this.report.candidates
        : Array.isArray(this.run && this.run.candidates)
          ? this.run.candidates
          : []
      const seen = new Set()
      return flowCandidates.concat(reportCandidates).filter(candidate => {
        const key = this.candidateId(candidate) || `${candidate.title || candidate.name || ''}:${this.candidatePath(candidate)}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
    },
    candidates() {
      return this.rawCandidates.filter(candidate => this.candidateKind(candidate) === 'process')
    },
    materialCandidates() {
      const explicit = Array.isArray(this.report.materialCandidates)
        ? this.report.materialCandidates
        : []
      const all = explicit.concat(
        this.rawCandidates.filter(candidate => this.candidateKind(candidate) === 'material')
      )
      const seen = new Set()
      return all.filter(candidate => {
        const nodeUid = candidate.nodeUid || candidate.node_uid || ''
        const field = this.fieldIdentity(candidate.field || candidate.matchedField || candidate.matched_field || candidate.requestedField || candidate.requested_field)
        const identity = this.sourceId(candidate) || this.candidateId(candidate) || `${candidate.title || candidate.name || ''}:${this.candidatePath(candidate)}`
        const key = [identity, nodeUid, field, String(candidate.quote || '').trim()].join('|')
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
    },
    unclassifiedCandidates() {
      return this.rawCandidates.filter(candidate => !this.candidateKind(candidate))
    },
    findingGroups() {
      const labels = { structure: '结构问题', missing: '缺少信息', review: '待核对', source_error: '来源异常', hint: '提示' }
      const order = Object.keys(labels)
      const groups = new Map(order.map(key => [key, []]))
      this.displayFindings.forEach(finding => {
        const category = finding.category || (this.isMissingFinding(finding) ? 'missing' : 'hint')
        if (groups.has(category)) groups.get(category).push(finding)
      })
      const summaryCategories = this.report.summary && this.report.summary.categories || {}
      return order.map(key => {
        const items = groups.get(key)
        const fallbackCount = items.reduce((count, item) => count + (Number(item.mergedCount) || 1), 0)
        const hasBackendCount = Object.prototype.hasOwnProperty.call(summaryCategories, key)
        return { key, title: labels[key], items, count: hasBackendCount ? Number(summaryCategories[key] || 0) : fallbackCount }
      }).filter(group => group.items.length)
    },
    displayFindings() {
      return this.mergeFindings(this.findings.filter(item => item && item.display !== false &&
        (item.ruleId || item.rule_id) !== 'CK-32' && item.category !== 'auxiliary' &&
        !this.isPassedFinding(item) && !this.isNotApplicableFinding(item)))
    },
    verifiedFindings() {
      return this.mergeFindings(this.findings.filter(finding => finding && finding.display !== false && this.isPassedFinding(finding)))
    },
    notApplicableFindings() {
      return this.mergeFindings(this.findings.filter(finding => finding && finding.display !== false && this.isNotApplicableFinding(finding)))
    },
    sources() {
      const reportSources = Array.isArray(this.report.sources) ? this.report.sources : []
      const candidateSources = Array.isArray(this.report.candidateSources)
        ? this.report.candidateSources
        : []
      const unique = new Map()
      reportSources.concat(candidateSources).forEach((source, index) => {
        const ref = source.sourceRef || {}
        const version = source.version || ref.version || ''
        const contentHash = source.contentHash || source.content_hash || ref.contentHash || ref.content_hash || ''
        const sourceIdentity = ref.type && (ref.nodeUid || ref.id || ref.path || ref.chunkId || ref.topic)
          ? JSON.stringify([ref.type, ref.roomId || ref.roomKey, ref.nodeUid || ref.id || ref.path || ref.chunkId || ref.topic, ref.section || '', ref.chunkId || ''])
          : String(source.sourceId || source.source_id || this.sourceKey(source, index))
        const identity = JSON.stringify([sourceIdentity, version, contentHash])
        if (!unique.has(identity)) unique.set(identity, source)
      })
      return [...unique.values()]
    },
    sourceGroups() {
      const used = []
      const unused = []
      this.sources.forEach(source => (this.sourceIsUsed(source) ? used : unused).push(source))
      return [
        used.length && { key: 'used', title: '已采用依据', sources: used, collapsed: false },
        unused.length && { key: 'unused', title: '未采用候选', sources: unused, collapsed: true }
      ].filter(Boolean)
    },
    overviewText() {
      const summary = this.report.summary
      if (summary && typeof summary === 'object') {
        if (summary.actionable != null) {
          const blocking = summary.blockers == null ? '' : ` · 阻断 ${Number(summary.blockers || 0)}`
          return `待处理 ${Number(summary.actionable || 0)} 项${blocking}`
        }
        const entries = [
          ['阻断', summary.blockers],
          ['待补齐', summary.needsSupplement],
          ['提示', summary.warnings],
          ['本阶段不适用', summary.notApplicable]
        ]
          .map(([label, value]) => {
            const count = Array.isArray(value) ? value.length : Number(value || 0)
            return count > 0 ? `${label} ${count}` : ''
          })
          .filter(Boolean)
        if (entries.length) return entries.join(' · ')
        if (summary.passed === true) return '逐项检查已通过'
      }
      if (typeof summary === 'string' && summary.trim()) return summary
      if (this.report.message) return this.report.message
      return this.findings.length
        ? `共返回 ${this.findings.length} 项检查结果`
        : '没有逐项结果，需确认后端检查报告完整性'
    },
    canCheck() {
      return !!this.checkRoomKey && !!this.checkTargetUid && !this.readonly && !this.checking && !this.confirming
    }
  },
  watch: {
    nodeUid(next, previous) {
      if (next === previous) return
      if (this.visible) return
      this.resetForTargetChange()
    },
    roomKey(next, previous) {
      if (next === previous) return
      if (this.visible) return
      this.resetForTargetChange()
    }
  },
  beforeDestroy() {
    this.invalidateRequests()
  },
  methods: {
    mergeFindings(items) {
      const grouped = new Map()
      ;(items || []).forEach(item => {
        const key = [item.ruleId || item.rule_id || item.rule, item.nodeUid || item.node_uid || '', item.status || '', item.severity || '', item.category || '', item.validationType || ''].join('|')
        const existing = grouped.get(key)
        if (existing) existing.originals.push(item)
        else grouped.set(key, { ...item, originals: [item] })
      })
      return [...grouped.values()].map(group => {
        if (group.originals.length === 1) return group
        const fields = new Set()
        const evidence = new Map()
        const reviewTargets = []
        group.originals.forEach(item => {
          ;[].concat(item.field || [], item.fields || []).forEach(value => {
            const field = value && typeof value === 'object' ? value.field || value.key : value
            if (field) fields.add(String(field))
          })
          ;(Array.isArray(item.evidenceEntries) ? item.evidenceEntries : []).forEach(entry => {
            if (entry && entry.id && !evidence.has(entry.id)) evidence.set(entry.id, entry)
          })
          if (item.reviewable || item.manualReview) reviewTargets.push(item)
        })
        return { ...group, mergedCount: group.originals.length, mergedFields: [...fields], evidenceEntries: [...evidence.values()], reviewTargets }
      })
    },
    open() {
      const nextTarget = { nodeUid: this.nodeUid, roomKey: this.roomKey, nodeTitle: this.nodeTitle }
      const currentNodeUid = String(this.run && (this.run.nodeUid || this.run.node_uid) || this.checkedTarget && this.checkedTarget.nodeUid || '')
      const currentRoomKey = String(this.run && (this.run.roomKey || this.run.room_key) || this.checkedTarget && this.checkedTarget.roomKey || '')
      if (this.run && (currentNodeUid !== String(nextTarget.nodeUid || '') || currentRoomKey !== String(nextTarget.roomKey || ''))) {
        this.resetForTargetChange()
      }
      this.checkedTarget = {
        ...nextTarget
      }
      this.visible = true
      this.error = ''
      this.activeTab = 'findings'
      if (!this.checkRoomKey || !this.checkTargetUid) {
        this.error = '请在已保存的脑图中选中一个节点后再查看检查记录'
        return Promise.resolve(null)
      }
      if (this.readonly) return this.loadHistory(false)
      return this.createCheckRun()
    },
    close(done) {
      this.invalidateRequests()
      this.visible = false
      if (typeof done === 'function') done()
    },
    resetForTargetChange() {
      this.invalidateRequests()
      this.run = null
      this.history = []
      this.sourceDetails = {}
      this.reviewReasons = {}
      this.reviewEvidenceSelections = {}
      this.error = ''
    },
    invalidateRequests() {
      this.requestEpoch += 1
      if (this.requestController) {
        this.requestController.abort()
        this.requestController = null
      }
      this.clearRequestBusy()
    },
    clearRequestBusy() {
      this.checking = false
      this.confirming = false
      this.confirmingCandidateId = ''
      this.sourceLoadingId = ''
      this.sourceRetryingId = ''
      this.reviewSubmittingKey = ''
    },
    beginRequest() {
      if (this.requestController) this.requestController.abort()
      this.clearRequestBusy()
      this.requestEpoch += 1
      this.requestController = new AbortController()
      return { epoch: this.requestEpoch, signal: this.requestController.signal }
    },
    isCurrent(epoch, nodeUid = this.checkTargetUid, roomKey = this.checkRoomKey) {
      return epoch === this.requestEpoch && nodeUid === this.checkTargetUid && roomKey === this.checkRoomKey
    },
    async createCheckRun() {
      if (!this.canCheck) return null
      const nodeUid = this.checkTargetUid
      const roomKey = this.checkRoomKey
      const request = this.beginRequest()
      this.checking = true
      this.error = ''
      this.run = null
      try {
        if (typeof this.beforeCheck === 'function') await this.beforeCheck()
        if (!this.isCurrent(request.epoch, nodeUid, roomKey)) return null
        const response = await createCpdCheckRun(roomKey, {
          nodeUid,
          requestId: requestId(),
          mode: 'business',
          signal: request.signal
        })
        if (!this.isCurrent(request.epoch, nodeUid, roomKey)) return null
        const run = unwrapRun(response)
        if (!run || !run.id) throw new Error('检查服务没有返回可追踪的检查记录')
        if (String(run.nodeUid || run.node_uid || '') !== nodeUid) {
          throw new Error('检查服务返回了其他节点的报告，已忽略')
        }
        this.run = run
        this.checking = false
        this.loadHistory(false)
        return run
      } catch (err) {
        if (!this.isCurrent(request.epoch, nodeUid, roomKey) || (err && err.name === 'AbortError')) return null
        this.error = (err && err.message) || '检查失败，请稍后重试'
        return null
      } finally {
        if (this.isCurrent(request.epoch, nodeUid, roomKey)) this.checking = false
      }
    },
    async loadHistory() {
      if (!this.checkRoomKey || !this.checkTargetUid) return null
      const nodeUid = this.checkTargetUid
      const roomKey = this.checkRoomKey
      const request = this.beginRequest()
      this.error = ''
      try {
        const response = await listCpdCheckRuns(roomKey, nodeUid, { signal: request.signal })
        if (!this.isCurrent(request.epoch, nodeUid, roomKey)) return null
        const rows = (response && (response.runs || response.history || response.list)) || []
        this.history = Array.isArray(rows) ? rows : []
        if (!this.history.length) {
          this.run = null
          return null
        }
        const newest = this.history[0]
        const id = newest && (newest.id || newest.checkRunId || newest.check_run_id)
        if (!id) throw new Error('历史检查记录缺少编号')
        const detail = await getCpdCheckRun(roomKey, id, { signal: request.signal })
        if (!this.isCurrent(request.epoch, nodeUid, roomKey)) return null
        const run = unwrapRun(detail)
        if (!run || String(run.nodeUid || run.node_uid || '') !== nodeUid) {
          throw new Error('历史报告与当前节点不匹配')
        }
        this.run = run
        this.activeTab = 'findings'
        return run
      } catch (err) {
        if (!this.isCurrent(request.epoch, nodeUid, roomKey) || (err && err.name === 'AbortError')) return null
        this.error = (err && err.message) || '读取历史检查失败'
        return null
      }
    },
    async openHistoryItem(item) {
      const id = item && (item.id || item.checkRunId || item.check_run_id)
      if (!id || !this.checkRoomKey) return null
      const nodeUid = this.checkTargetUid
      const roomKey = this.checkRoomKey
      const request = this.beginRequest()
      this.checking = true
      this.error = ''
      try {
        const response = await getCpdCheckRun(roomKey, id, { signal: request.signal })
        if (!this.isCurrent(request.epoch, nodeUid, roomKey)) return null
        const run = unwrapRun(response)
        if (!run || String(run.nodeUid || run.node_uid || '') !== nodeUid) {
          throw new Error('历史报告与当前节点不匹配')
        }
        this.run = run
        this.activeTab = 'findings'
        return run
      } catch (err) {
        if (!this.isCurrent(request.epoch, nodeUid, roomKey) || (err && err.name === 'AbortError')) return null
        this.error = (err && err.message) || '读取历史检查失败'
        return null
      } finally {
        if (this.isCurrent(request.epoch, nodeUid, roomKey)) this.checking = false
      }
    },
    async confirmCandidate(candidate) {
      if (
        this.readonly ||
        this.candidateKind(candidate) !== 'process' ||
        this.reportIsStale ||
        !this.run ||
        !this.run.id ||
        this.confirming
      ) return null
      const candidateId = this.candidateId(candidate)
      if (!candidateId) return null
      const nodeUid = this.checkTargetUid
      const roomKey = this.checkRoomKey
      const runId = this.run.id
      const request = this.beginRequest()
      this.confirming = true
      this.confirmingCandidateId = candidateId
      this.error = ''
      try {
        if (typeof this.beforeCheck === 'function') await this.beforeCheck()
        if (!this.isCurrent(request.epoch, nodeUid, roomKey)) return null
        const response = await confirmCpdCheckCandidate(roomKey, runId, candidateId, {
          signal: request.signal
        })
        if (!this.isCurrent(request.epoch, nodeUid, roomKey)) return null
        let run = unwrapRun(response)
        if (!run || !run.id || !run.report) {
          run = unwrapRun(await getCpdCheckRun(roomKey, runId, { signal: request.signal }))
        }
        if (!this.isCurrent(request.epoch, nodeUid, roomKey)) return null
        if (!run || String(run.nodeUid || run.node_uid || '') !== nodeUid) {
          throw new Error('继续检查返回的报告与当前节点不匹配')
        }
        this.run = run
        this.activeTab = 'findings'
        return run
      } catch (err) {
        if (!this.isCurrent(request.epoch, nodeUid, roomKey) || (err && err.name === 'AbortError')) return null
        this.error = (err && err.message) || '确认候选流程失败'
        return null
      } finally {
        if (this.isCurrent(request.epoch, nodeUid, roomKey)) {
          this.confirming = false
          this.confirmingCandidateId = ''
        }
      }
    },
    async submitReview(finding, decision) {
      const canRevoke = decision === 'revoke' && finding && finding.manualReview
      if (this.readonly || this.report.mode === 'demo' || this.report.mode === 'demo_validation' || this.reportIsStale || !finding || (!finding.reviewable && !canRevoke) || this.reviewSubmittingKey) return null
      const key = this.findingKey(finding, 0)
      const targetKey = String(finding.findingKey || '')
      const reason = this.reviewReason(finding).trim()
      const evidenceIds = decision === 'revoke' ? [] : (this.reviewEvidenceSelections[key] || [])
      const required = Array.isArray(finding.requiredEvidenceIds) ? finding.requiredEvidenceIds : []
      if (!targetKey) {
        this.error = '检查项缺少核对编号，请重新检查后再操作。'
        return null
      }
      if (!reason) {
        this.error = '请填写本次人工核对说明。'
        return null
      }
      if (decision !== 'revoke' && (!required.length || !required.every(id => evidenceIds.includes(id)))) {
        this.error = '请逐条核对并勾选该项全部必需的原文依据。'
        return null
      }
      if (decision === 'revoke' && !finding.manualReview) {
        this.error = '该项没有有效的人工核对记录可撤销。'
        return null
      }
      const runId = this.run && this.run.id
      const revision = Number(this.report.revision || 0)
      if (!runId || !Number.isInteger(revision) || revision < 1) {
        this.error = '报告缺少有效修订号，请重新读取检查记录。'
        return null
      }
      const roomKey = this.checkRoomKey
      const nodeUid = this.checkTargetUid
      const request = this.beginRequest()
      this.reviewSubmittingKey = key
      this.error = ''
      try {
        const response = await submitCpdCheckReview(roomKey, runId, {
          requestId: requestId(),
          expectedRevision: revision,
          findingKey: targetKey,
          decision,
          reason,
          evidenceIds
        }, { signal: request.signal })
        if (!this.isCurrent(request.epoch, nodeUid, roomKey)) return null
        let run = unwrapRun(response)
        if (!run || !run.id || !run.report) run = unwrapRun(await getCpdCheckRun(roomKey, runId, { signal: request.signal }))
        if (!this.isCurrent(request.epoch, nodeUid, roomKey)) return null
        if (!run || String(run.nodeUid || run.node_uid || '') !== nodeUid) throw new Error('人工核对返回的报告与当前节点不匹配')
        this.run = run
        return run
      } catch (err) {
        if (!this.isCurrent(request.epoch, nodeUid, roomKey) || (err && err.name === 'AbortError')) return null
        this.error = (err && err.message) || '提交人工核对失败'
        return null
      } finally {
        if (this.isCurrent(request.epoch, nodeUid, roomKey)) this.reviewSubmittingKey = ''
      }
    },
    async readSource(source) {
      const sourceId = this.sourceId(source)
      const runId = this.run && this.run.id
      if (!sourceId || !runId || this.sourceLoadingId) return null
      const roomKey = this.checkRoomKey
      const nodeUid = this.checkTargetUid
      const request = this.beginRequest()
      this.sourceLoadingId = sourceId
      this.error = ''
      try {
        const response = await getCpdCheckSource(roomKey, runId, sourceId, { signal: request.signal })
        if (!this.isCurrent(request.epoch, nodeUid, roomKey)) return null
        const detail = response && (response.source || response)
        if (!detail || typeof detail !== 'object') throw new Error('来源读取接口没有返回来源内容')
        this.sourceDetails = { ...this.sourceDetails, [sourceId]: detail }
        return detail
      } catch (err) {
        if (!this.isCurrent(request.epoch, nodeUid, roomKey) || (err && err.name === 'AbortError')) return null
        this.error = (err && err.message) || '读取来源失败'
        return null
      } finally {
        if (this.isCurrent(request.epoch, nodeUid, roomKey)) this.sourceLoadingId = ''
      }
    },
    async retrySource(source) {
      const sourceId = this.sourceId(source)
      const runId = this.run && this.run.id
      const revision = Number(this.report.revision || 0)
      if (this.readonly || this.reportIsStale || !sourceId || !runId || this.sourceRetryingId) return null
      if (!Number.isInteger(revision) || revision < 1) {
        this.error = '报告缺少有效修订号，请重新检查后再读取来源。'
        return null
      }
      const roomKey = this.checkRoomKey
      const nodeUid = this.checkTargetUid
      const request = this.beginRequest()
      this.sourceRetryingId = sourceId
      this.error = ''
      try {
        const response = await retryCpdCheckSource(roomKey, runId, sourceId, {
          requestId: requestId(), expectedRevision: revision
        }, { signal: request.signal })
        if (!this.isCurrent(request.epoch, nodeUid, roomKey)) return null
        let run = unwrapRun(response)
        if (!run || !run.id || !run.report) run = unwrapRun(await getCpdCheckRun(roomKey, runId, { signal: request.signal }))
        if (!this.isCurrent(request.epoch, nodeUid, roomKey)) return null
        if (!run || String(run.nodeUid || run.node_uid || '') !== nodeUid) throw new Error('来源复检返回的报告与当前节点不匹配')
        this.run = run
        const details = { ...this.sourceDetails }
        delete details[sourceId]
        this.sourceDetails = details
        return run
      } catch (err) {
        if (!this.isCurrent(request.epoch, nodeUid, roomKey) || (err && err.name === 'AbortError')) return null
        this.error = (err && err.message) || '重新读取来源并复检失败'
        return null
      } finally {
        if (this.isCurrent(request.epoch, nodeUid, roomKey)) this.sourceRetryingId = ''
      }
    },
    candidateId(candidate) {
      return String((candidate && (candidate.id || candidate.candidateId || candidate.candidate_id)) || '')
    },
    candidateKind(candidate) {
      const kind = String((candidate && (candidate.kind || candidate.type)) || '').trim().toLowerCase()
      if (/material|knowledge|source/.test(kind)) return 'material'
      if (/process|flow|sop/.test(kind)) return 'process'
      return ''
    },
    candidatePath(candidate) {
      const nested = candidate && candidate.source && typeof candidate.source === 'object'
        ? candidate.source
        : candidate
      const path = pathOf(nested) || pathOf(candidate)
      const sourceLabel = typeof (candidate && candidate.source) === 'string'
        ? candidate.source
        : nested && (nested.sourceName || nested.source_name || nested.type)
      const identity = nested && (nested.id || nested.uid || nested.sourceId || nested.source_id)
      return [path, sourceLabel, identity].filter(Boolean).join(' · ')
    },
    candidateParts(candidate) {
      const referenceDetails = candidate && candidate.referenceDetails && typeof candidate.referenceDetails === 'object'
        ? candidate.referenceDetails
        : {}
      const cpd = referenceDetails.cpd && typeof referenceDetails.cpd === 'object'
        ? referenceDetails.cpd
        : referenceDetails
      const fields = referenceDetails.fields && typeof referenceDetails.fields === 'object'
        ? referenceDetails.fields
        : {}
      const fallbackCpd = candidate && (candidate.cpd && typeof candidate.cpd === 'object' ? candidate.cpd : candidate)
      const normalize = value => {
        if (Array.isArray(value)) {
          return value.map(item => {
            if (typeof item === 'string') return item.trim()
            if (!item || typeof item !== 'object') return ''
            const heading = item.heading || item.label || item.title || item.name || ''
            const text = item.text || item.value || item.content || ''
            return heading && text ? `${heading}：${text}` : text || heading
          }).filter(Boolean).join('\n')
        }
        if (typeof value === 'string') return value.trim()
        if (value && typeof value === 'object') {
          const heading = value.heading || value.label || value.title || value.name || ''
          const text = value.text || value.value || value.content || ''
          return heading && text ? `${heading}：${text}` : text || heading
        }
        return ''
      }
      const values = {
        C: normalize(cpd.check || cpd.C || cpd.c || fallbackCpd.check || fallbackCpd.c || ''),
        P: normalize(cpd.plan || cpd.P || cpd.p || fallbackCpd.plan || fallbackCpd.p || ''),
        D: normalize(cpd.execution || cpd.do || cpd.D || cpd.d || fallbackCpd.execution || fallbackCpd.do || fallbackCpd.d || fallbackCpd.action || ''),
        frequency: normalize(fields.frequency || referenceDetails.frequency || ''),
        input: normalize(fields.input || fields.inputs || referenceDetails.input || referenceDetails.inputs || ''),
        criterion: normalize(fields.criterion || referenceDetails.criterion || ''),
        owner: normalize(fields.owner || referenceDetails.owner || ''),
        artifact: normalize(fields.artifact || fields.output || fields.outputs || referenceDetails.artifact || referenceDetails.output || referenceDetails.outputs || '')
      }
      const summary = [candidate && candidate.summary, candidate && typeof candidate.cpd === 'string' ? candidate.cpd : '']
        .filter(value => typeof value === 'string').join('\n')
      const pattern = /(?:^|[；;\n])\s*(C|P|D|检查|目标|计划|执行|动作)\s*[:：]\s*([^；;\n]+)/g
      let match
      while ((match = pattern.exec(summary))) {
        const role = /^(?:C|检查|目标)$/i.test(match[1]) ? 'C' : /^(?:P|计划)$/i.test(match[1]) ? 'P' : 'D'
        if (!values[role]) values[role] = match[2].trim()
      }
      const fieldLabels = { frequency: '频率', input: '输入', criterion: '判据', owner: '责任角色', artifact: '产物' }
      return [
        { key: 'C', label: 'C 检查项', value: String(values.C || '').trim() },
        { key: 'P', label: 'P 目标', value: String(values.P || '').trim() },
        { key: 'D', label: 'D 执行', value: String(values.D || '').trim() },
        ...Object.keys(fieldLabels).map(key => ({ key, label: fieldLabels[key], value: String(values[key] || '').trim() }))
      ]
    },
    candidateOtherSummary(candidate) {
      const summary = typeof (candidate && candidate.summary) === 'string' ? candidate.summary : ''
      return this.candidateParts(candidate).some(item => item.value) ? '' : summary
    },
    candidateSummary(candidate) {
      const cpd = candidate && (candidate.cpd || candidate.summary || {})
      if (typeof cpd === 'string') return cpd
      const check = cpd.check || cpd.c || candidate.check || candidate.c || ''
      const plan = cpd.plan || cpd.p || candidate.plan || candidate.p || ''
      const action = cpd.do || cpd.d || candidate.do || candidate.d || candidate.action || ''
      return [check && `C: ${check}`, plan && `P: ${plan}`, action && `D: ${action}`]
        .filter(Boolean)
        .join('；')
    },
    sourceKey(source, index) {
      const ref = source && source.sourceRef
      return String((source && (source.id || source.sourceId || source.path)) || (ref && ref.id) || `source-${index}`)
    },
    sourcePath(source) {
      const ref = source && source.sourceRef && typeof source.sourceRef === 'object'
        ? source.sourceRef
        : {}
      return pathOf(source) || pathOf(ref) || source.filename || ref.filename ||
        (ref.topic ? [ref.topic, ref.section].filter(Boolean).join(' / ') : '') || ''
    },
    sourceId(source) {
      const ref = source && source.sourceRef || {}
      return String(source && (source.sourceId || source.source_id) || ref.sourceId || ref.id || ref.attachmentId || ref.chunkId || ref.uid || ref.nodeUid || ref.path || ref.topic || '')
    },
    sourceRole(source) {
      const ref = source && source.sourceRef || {}
      return String(source && (source.sourceRole || source.source_role) || ref.sourceRole || ref.source_role || '').toLowerCase()
    },
    sourceReferenceIdentity(value) {
      const ref = value && value.sourceRef && typeof value.sourceRef === 'object' ? value.sourceRef : value || {}
      const type = String(ref.type || ref.kind || '')
      const identity = type === 'wiki_compiler'
        ? ref.topic || ref.path || ref.id || ''
        : type === 'attachment'
          ? ref.id || ref.attachmentId || ref.path || ''
          : ref.path || ref.uid || ref.nodeUid || ref.id || ref.topic || ''
      if (!identity) return ''
      return JSON.stringify([type, ref.roomId || ref.roomKey || '', identity, ref.section || '', ref.chunkId || ''])
    },
    sourceIsSelected(source) {
      const sourceId = this.sourceId(source)
      const sourceIdentity = this.sourceReferenceIdentity(source)
      const selections = [this.run && this.run.selection, this.report.selection, this.report.selectedSource].filter(Boolean)
      return selections.some(selection => {
        const ref = selection.sourceRef || selection.source_ref || selection.reference || selection
        const selectedId = String(selection.sourceId || selection.source_id || (ref && (ref.sourceId || ref.source_id || ref.id || ref.chunkId || ref.uid || ref.path || ref.topic)) || '')
        if (sourceId && selectedId && sourceId === selectedId) return true
        const selectedIdentity = this.sourceReferenceIdentity(ref)
        return !!(sourceIdentity && selectedIdentity && sourceIdentity === selectedIdentity)
      })
    },
    sourceHasFindingEvidence(source) {
      const sourceId = this.sourceId(source)
      const sourceIdentity = this.sourceReferenceIdentity(source)
      return this.findings.some(finding => this.evidenceEntries(finding).some(entry => {
        if (sourceId && entry.sourceId && sourceId === String(entry.sourceId)) return true
        const entryIdentity = this.sourceReferenceIdentity(entry.sourceRef || entry)
        return !!(sourceIdentity && entryIdentity && sourceIdentity === entryIdentity)
      }))
    },
    sourceIsUsed(source) {
      return this.sourceRole(source) === 'current_chain' || this.sourceIsSelected(source) || this.sourceHasFindingEvidence(source)
    },
    sourceUsageLabel(source) {
      if (this.sourceRole(source) === 'current_chain') return '本链依据'
      if (this.sourceIsSelected(source) || this.sourceHasFindingEvidence(source)) return '外部参考'
      return '未采用候选'
    },
    sourceDisplayStatus(source) {
      const detail = this.sourceDetails[this.sourceId(source)] || {}
      const status = String(detail.status || source && source.status || '').toLowerCase()
      if (detail.complete === false || source && (source.complete === false || source.truncated) ||
        ['partial', 'incomplete', 'parse_failed', 'error', 'failed', 'unavailable', 'not_connected', 'no_permission', 'forbidden', 'processing', 'pending'].includes(status)) return '未读完整'
      if (this.sourceIsSelected(source)) return '已采用'
      if (this.sourceRole(source) === 'current_chain') {
        return detail.complete === true || source && source.complete === true || detail.content
          ? '完整全文'
          : '检索命中'
      }
      if (this.sourceHasFindingEvidence(source)) return '待确认适用'
      if (detail.content && detail.complete === true) return '待确认适用'
      if (status === 'ready' || status === 'ok' || status === 'found') return '检索命中'
      return '待确认适用'
    },
    isTechnicalSourcePath(value) {
      const path = formatPath(value).trim().replace(/\\/g, '/')
      if (!path) return false
      return /(?:^|\/)branches\/[0-9a-f-]+\.md(?:$|[?#])/i.test(path) ||
        /^[\s0-9a-f/-]+(?:\.md)?$/i.test(path) ||
        /(?:^|\/)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\/|$)/i.test(path)
    },
    sourceTechnicalValue(source) {
      const detail = this.sourceDetails[this.sourceId(source)] || {}
      const path = detail.path || this.sourcePath(source)
      const value = {
        sourceRef: source && source.sourceRef || detail.sourceRef || null,
        version: detail.version || source && source.version || undefined,
        path: this.isTechnicalSourcePath(path) ? path : undefined,
        sourcePaths: source && source.sourcePaths || source && source.sourceRef && source.sourceRef.sourcePaths || undefined,
        provenance: detail.provenance || source && source.provenance || undefined
      }
      return Object.values(value).some(item => item != null && item !== '') ? value : null
    },
    sourceTitle(source) {
      const ref = source.sourceRef || {}
      return source.title || source.name || source.filename || ref.title || ref.filename || ref.topic ||
        (source.nodeUid || ref.nodeUid ? this.findingNodeTitle({ nodeUid: source.nodeUid || ref.nodeUid }) : '资料来源')
    },
    sourceProvenance(source) {
      const provenance = source && source.provenance || {}
      const origin = String((typeof provenance === 'string' ? provenance : provenance.origin) || source && source.provenanceMode || '').toLowerCase()
      if (origin === 'business') return '业务'
      if (origin === 'demo' || origin === 'demo_validation') return '演示'
      if (!origin || ['unknown', 'unmarked', 'not_marked'].includes(origin)) return '来源性质未标注'
      return origin || '来源性质未标注'
    },
    sourceOrigins(source) {
      const ref = source.sourceRef || {}
      const values = source.sourcePaths || ref.sourcePaths || []
      return [...new Set((Array.isArray(values) ? values : []).map(item => {
        if (typeof item === 'string') return item.trim()
        return item && (item.pathText || item.path_text || item.path || item.title || item.name || item.sourcePath || '') || ''
      }).filter(Boolean))].join('；')
    },
    findingKey(finding, index) {
      if (finding && finding.findingKey) return String(finding.findingKey)
      const explicitId = finding && (finding.id || finding.findingId || finding.finding_id)
      if (explicitId) return String(explicitId)
      const identity = [
        finding && (finding.ruleId || finding.rule_id || finding.rule || finding.code),
        finding && (finding.nodeUid || finding.node_uid),
        finding && (finding.checkKey || finding.check_key),
        finding && finding.field
      ].map(value => String(value || '').trim()).filter(Boolean).join(':')
      return `${identity || 'finding'}:${index}`
    },
    findingRule(finding) {
      const ruleId = finding.ruleId || finding.rule_id || finding.rule || finding.code
      const title = finding.ruleTitle || finding.rule_title || finding.title
      if (title && ruleId && String(title) !== String(ruleId)) return `${title}（${ruleId}）`
      return title || ruleId || 'CPD 规则'
    },
    findingNodeUid(finding) {
      return String((finding && (finding.nodeUid || finding.node_uid)) || '')
    },
    findingNodeTitle(finding) {
      const explicit = finding && (finding.nodeTitle || finding.node_title)
      const uid = this.findingNodeUid(finding)
      const knownNodeIds = new Set([uid, this.checkTargetUid].filter(Boolean).map(String))
      if (explicit && !isOpaqueNodeId(explicit, knownNodeIds)) return explicit
      const chain = this.report.chain || {}
      const nodeMap = chain.nodes
      let node = null
      if (Array.isArray(nodeMap)) {
        node = nodeMap.find(item => item && String(item.uid || item.nodeUid || item.node_uid || '') === uid)
      } else if (nodeMap && typeof nodeMap === 'object' && uid) {
        node = nodeMap[uid]
      }
      if (!node && uid) {
        const chainNodes = [].concat(chain.check || [], chain.plan || [], chain.execution || [])
        node = chainNodes.find(item => item && String(item.uid || item.nodeUid || item.node_uid || '') === uid)
      }
      const data = node && node.data && typeof node.data === 'object' ? node.data : {}
      const title = node && (node.text || node.title || node.name) || data.text || data.title || data.name
      if (title && !isOpaqueNodeId(title, knownNodeIds)) return String(title).replace(/^[CPD]\s*[:：]\s*/i, '')
      if ((!uid || uid === this.checkTargetUid) && this.checkTargetDisplayTitle !== '当前选中节点') return this.checkTargetDisplayTitle
      if (!uid) return '当前链路'
      return '未命名节点'
    },
    findingIssue(finding) {
      if (finding && finding.mergedCount > 1) {
        const fields = this.findingFields(finding)
        return fields.length ? `同一规则下合并了 ${finding.mergedCount} 项字段结果。` : [...new Set(finding.originals.map(item => item.issue || item.message || item.reason).filter(Boolean))].join('；')
      }
      return finding.issue || finding.message || finding.reason || finding.title || '报告未提供问题说明'
    },
    findingDetails(finding) {
      return Array.isArray(finding && finding.originals) ? finding.originals : [finding]
    },
    findingDetailMessage(finding) {
      return finding && (finding.issue || finding.message || finding.reason || finding.title) || '报告未提供问题说明'
    },
    findingFields(finding) {
      const labels = {
        targetValue: '目标值', frequency: '频率', inputs: '输入源', criterion: '判据', owner: '责任人',
        outputs: '产物', remediation: '未达标处置', reference: '材料来源'
      }
      const values = [].concat(finding && finding.mergedFields || [], finding && finding.field || [], finding && finding.fields || [])
        .map(value => value && typeof value === 'object' ? value.field || value.key : value)
        .filter(Boolean)
      return [...new Set(values.map(value => labels[value] || String(value)))]
    },
    fieldIdentity(value) {
      const raw = String(value && typeof value === 'object' ? value.field || value.key || value.name || '' : value || '').trim().toLowerCase()
      const aliases = {
        frequency: 'frequency', '频率': 'frequency',
        input: 'inputs', inputs: 'inputs', '输入': 'inputs', '输入源': 'inputs',
        output: 'outputs', outputs: 'outputs', artifact: 'outputs', '产物': 'outputs', '产出物': 'outputs',
        owner: 'owner', '责任人': 'owner', '责任角色': 'owner',
        targetvalue: 'targetValue', target_value: 'targetValue', '目标值': 'targetValue',
        criterion: 'criterion', '判据': 'criterion',
        reference: 'reference', '材料来源': 'reference',
        remediation: 'remediation', '未达标处置': 'remediation'
      }
      return aliases[raw] || raw
    },
    relatedMaterialCandidates(finding) {
      const originals = this.findingDetails(finding)
      const matches = []
      originals.forEach(original => {
        const nodeUid = this.findingNodeUid(original)
        const fields = new Set([].concat(original.field || [], original.fields || [])
          .map(value => this.fieldIdentity(value)).filter(Boolean))
        if (!nodeUid || !fields.size) return
        this.materialCandidates.forEach(candidate => {
          const candidateUid = String(candidate.nodeUid || candidate.node_uid || '')
          const candidateField = this.fieldIdentity(candidate.field || candidate.matchedField || candidate.matched_field || candidate.requestedField || candidate.requested_field)
          if (candidateUid === nodeUid && fields.has(candidateField) && typeof candidate.quote === 'string' && candidate.quote.trim()) matches.push(candidate)
        })
      })
      const unique = new Map()
      matches.forEach(candidate => {
        const key = `${this.sourceId(candidate) || this.candidateId(candidate) || this.candidatePath(candidate)}|${candidate.quote.trim()}`
        if (!unique.has(key)) unique.set(key, candidate)
      })
      return [...unique.values()]
    },
    materialCandidateKey(candidate) {
      return `${this.sourceId(candidate) || this.candidateId(candidate) || this.candidatePath(candidate)}:${String(candidate && candidate.quote || '').trim()}`
    },
    materialCandidateTitle(candidate) {
      return candidate && (candidate.title || candidate.name || candidate.label || candidate.filename || candidate.sourceName || candidate.source_name) || this.sourceTitle(candidate)
    },
    fieldLabel(value) {
      const labels = { frequency: '频率', inputs: '输入', outputs: '产物', owner: '责任人', targetValue: '目标值', criterion: '判据', reference: '材料来源', remediation: '未达标处置' }
      return labels[this.fieldIdentity(value)] || String(value || '')
    },
    evidenceEntries(finding) {
      const originals = Array.isArray(finding && finding.originals) ? finding.originals : [finding]
      const entries = new Map()
      originals.forEach(item => (Array.isArray(item && item.evidenceEntries) ? item.evidenceEntries : []).forEach(entry => {
        if (entry && entry.id && typeof entry.quote === 'string' && entry.quote.trim() && !entries.has(entry.id)) entries.set(entry.id, entry)
      }))
      return [...entries.values()]
    },
    reviewTargets(finding) {
      if (Array.isArray(finding && finding.reviewTargets)) return finding.reviewTargets
      if (Array.isArray(finding && finding.originals)) return finding.originals.filter(item => item.reviewable || item.manualReview)
      return finding && (finding.reviewable || finding.manualReview) ? [finding] : []
    },
    reviewEvidenceEntries(finding) {
      return this.evidenceEntries(finding).filter(entry => entry.complete === true)
    },
    reviewReason(finding) {
      const key = this.findingKey(finding, 0)
      return this.reviewReasons[key] != null ? this.reviewReasons[key] : String(finding && finding.manualReview && finding.manualReview.reason || '')
    },
    setReviewReason(finding, value) {
      const key = this.findingKey(finding, 0)
      this.reviewReasons = { ...this.reviewReasons, [key]: String(value || '').slice(0, 2000) }
    },
    reviewEvidenceSelected(finding, evidenceId) {
      const selected = this.reviewEvidenceSelections[this.findingKey(finding, 0)] || []
      return selected.includes(evidenceId)
    },
    toggleReviewEvidence(finding, evidenceId, checked) {
      const key = this.findingKey(finding, 0)
      const current = new Set(this.reviewEvidenceSelections[key] || [])
      if (checked) current.add(evidenceId)
      else current.delete(evidenceId)
      this.reviewEvidenceSelections = { ...this.reviewEvidenceSelections, [key]: [...current] }
    },
    reviewDisabled(finding, decision) {
      const canRevoke = decision === 'revoke' && finding && finding.manualReview
      return this.readonly || this.report.mode === 'demo' || this.report.mode === 'demo_validation' ||
        this.reportIsStale || !finding || (!finding.reviewable && !canRevoke) || !!this.reviewSubmittingKey || this.confirming
    },
    reviewDecisionLabel(decision) {
      return ({ confirm: '确认', reject: '判定未通过', revoke: '撤销核对' })[decision] || '待处理'
    },
    manualReviewLabel(finding, stale) {
      if (stale) return '历史人工核对（不作为当前有效结论）'
      return finding && finding.manualReview && finding.manualReview.decision === 'confirm'
        ? '人工核对通过'
        : `人工核对${this.reviewDecisionLabel(finding && finding.manualReview && finding.manualReview.decision)}`
    },
    sourceErrors(finding) {
      return Array.isArray(finding && finding.sourceErrors) ? finding.sourceErrors : []
    },
    sourceErrorImpact(finding) {
      const ids = Array.isArray(finding && finding.relatedRuleIds) ? finding.relatedRuleIds : []
      const titles = ids.map(id => {
        const original = this.findings.find(item => (item.ruleId || item.rule_id) === id)
        return original && original.title ? `${id}（${original.title}）` : id
      })
      return titles.join('、') || '本链路来源核验'
    },
    isPassedFinding(finding) {
      const status = String((finding && finding.status) || '').toLowerCase()
      return status === 'passed' || status === 'pass'
    },
    isNotApplicableFinding(finding) {
      const status = String((finding && finding.status) || '').toLowerCase().replace(/[- ]/g, '_')
      return status === 'not_applicable' || status === 'n_a' || status === 'na'
    },
    isMissingFinding(finding) {
      const status = String((finding && finding.status) || '').toLowerCase()
      return ['needs_supplement', 'needs_info', 'incomplete', 'missing'].includes(status)
    },
    isBlockingFinding(finding) {
      const status = String((finding && finding.status) || '').toLowerCase()
      const severity = String((finding && finding.severity) || '').toLowerCase()
      return !!(
        finding &&
        (finding.blocksExecution === true || finding.blocks_execution === true || finding.blocking === true) ||
        /block|critical|阻断/.test(severity) ||
        ['blocked', 'failed', 'fail'].includes(status)
      )
    },
    findingNextStep(finding) {
      const explicit = finding.nextStep || finding.next_step || finding.action
      if (explicit) return explicit
      if (finding.field || this.isMissingFinding(finding)) return '补充缺少的信息或引用后重新检查'
      const rule = String(this.findingRule(finding) || '').toLowerCase()
      const issue = String(this.findingIssue(finding) || '').toLowerCase()
      if (/ck04|ck06|ck12|ck27|ck28|structure|孤立|对应关系|结构/.test(`${rule} ${issue}`)) {
        return '修正 CPD 结构或对应关系后重新检查'
      }
      if (/permission|forbidden|无权限/.test(issue)) return '取得该来源的读取权限后重新检查'
      if (/wiki|未接入|unavailable|不可用/.test(issue)) return '该来源未接入或暂不可用；先从已接入来源补齐并复检'
      if (this.candidates.length) return '确认与本链路对应的流程候选后继续检查'
      return '核对原文依据并按提示处理后重新检查'
    },
    findingQuote(finding) {
      return this.evidenceEntries(finding).map(entry => entry.quote).filter(Boolean).join('\n')
    },
    findingSource(finding) {
      const source = finding.sourceRef || finding.source_ref || finding.source
      if (typeof source === 'string') return source
      if (!source || typeof source !== 'object') return ''
      const nested = source.sourceRef && typeof source.sourceRef === 'object' ? source.sourceRef : source
      return [
        source.title || source.name || source.label,
        pathOf(source) || pathOf(nested),
        nested.type,
        nested.id || nested.sourceId
      ].filter(Boolean).join(' · ')
    },
    statusLabel(status) {
      const value = String(status || '').toLowerCase()
      const labels = {
        passed: '检查通过',
        pass: '检查通过',
        blocked: '阻断执行',
        failed: '检查失败',
        error: '检查失败',
        pending: '检查中',
        running: '检查中',
        needs_confirmation: '待确认流程',
        awaiting_confirmation: '待确认流程',
        needs_supplement: '待补齐',
        needs_info: '待补齐',
        not_applicable: '本阶段不适用',
        n_a: '本阶段不适用',
        incomplete: '信息不完整',
        stale: '报告过期',
        cancelled: '已取消'
      }
      return labels[value] || '待确认'
    },
    historyStageLabel(run) {
      return this.stageLabel(run)
    },
    stageLabel(run) {
      if (!run) return '待确认'
      const report = run.report || {}
      const status = String(run.status || '').toLowerCase()
      const summary = report.summary || {}
      const categories = summary.categories || {}
      const stale = status === 'stale' || run.stale || run.expired || report.stale || report.expired ||
        (Array.isArray(report.findings) && report.findings.some(item => item && item.manualReview && item.manualReview.invalidated))
      if (stale) return '报告过期'
      if (['failed', 'error', 'blocked', 'cancelled'].includes(status)) return this.statusLabel(status)
      if (status === 'passed' || status === 'pass' || summary.passed === true) return '检查通过'
      const selectionStage = report.selectionStage || report.selection_stage || run.selectionStage || run.selection_stage
      if (selectionStage === 'chain') return '待选链路'
      if (selectionStage === 'source') return '待选参考流程'
      if (Number(categories.review || 0) > 0) return '待核对'
      if (Number(categories.missing || 0) > 0) return '待补齐'
      if (Number(categories.source_error || 0) > 0) return '尚未核验'
      return this.statusLabel(status)
    },
    statusClass(status) {
      const value = String(status || '').toLowerCase()
      if (value === 'passed' || value === 'pass') return 'is-passed'
      if (value === 'blocked' || value === 'failed' || value === 'error' || value === 'stale') return 'is-blocked'
      return 'is-pending'
    },
    findingStatusLabel(status, severity) {
      const value = String(status || '').toLowerCase()
      if (value === 'passed' || value === 'pass') return '通过'
      if (this.isNotApplicableFinding({ status: value })) return '本阶段不适用'
      if (value === 'blocked' || value === 'failed' || value === 'fail') return '未通过'
      if (value === 'pending' || value === 'unknown' || !value) {
        return /block|critical|阻断/i.test(String(severity || '')) ? '待核验 · 阻断' : '待核验'
      }
      return this.statusLabel(value)
    },
    findingStatusClass(status, severity) {
      const value = String(status || '').toLowerCase()
      if (value === 'passed' || value === 'pass') return 'is-passed'
      if (/block|critical|阻断/i.test(String(severity || ''))) return 'is-blocked'
      return 'is-pending'
    },
    sourceRetryable(source) {
      const status = String(source && source.status || '').toLowerCase()
      return ['unavailable', 'not_connected', 'no_permission', 'forbidden', 'parse_failed', 'conflict', 'incomplete', 'partial', 'error', 'failed', 'processing', 'pending'].includes(status)
    },
    sourceErrorScopeLabel(scope) {
      return ({ chain: '本链路材料', map_knowledge: '当前图资料', company_ai: '房间绑定知识库', wiki: 'Wiki', selected_flow: '选定流程', retry: '来源重读' })[scope] || scope || '检查来源'
    },
    sourceTechnical(value) {
      if (typeof value === 'string') return value
      const omitNodeIdentifiers = item => {
        if (Array.isArray(item)) return item.map(omitNodeIdentifiers)
        if (!item || typeof item !== 'object') return item
        return Object.keys(item).reduce((result, key) => {
          const normalized = key.toLowerCase().replace(/[-_]/g, '')
          if (normalized === 'nodeuid' || normalized === 'uid') return result
          result[key] = omitNodeIdentifiers(item[key])
          return result
        }, {})
      }
      try { return JSON.stringify(omitNodeIdentifiers(value), null, 2) } catch (_) { return String(value || '') }
    },
    sourceStatusLabel(status) {
      const value = String(status || '').toLowerCase()
      const labels = {
        unavailable: '来源不可用',
        not_connected: '未接入',
        no_permission: '无权限',
        forbidden: '无权限',
        no_results: '无结果',
        parse_failed: '解析失败',
        conflict: '内容冲突',
        ready: '已读取',
        ok: '已读取',
        incomplete: '读取不完整',
        unverified: '未核验',
        partial: '结果部分可用', error: '读取失败', failed: '解析失败', processing: '尚未解析', pending: '等待解析'
      }
      return labels[value] || String(status)
    },
    formatBeijingTime(value) {
      if (!value) return ''
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(value)
      return new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
      }).format(date)
    }
  }
}
</script>

<style lang="less" scoped>
.cpd-check-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: ~"min(68vh, 760px)";
  overflow: auto;
  color: #303133;
  font-size: 14px;
}

.cpd-check-sticky {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 4px 0 8px;
  background: #fff;
}

.cpd-check-sticky .cpd-context:last-child {
  padding-bottom: 8px;
}

.cpd-check-note {
  color: #909399;
  font-size: 12px;
  line-height: 1.45;
}

.cpd-context {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  padding: 0 0 10px;
  border-bottom: 1px solid #ebeef5;
  color: #909399;

  strong {
    color: #303133;
    font-size: 15px;
  }
}

.cpd-panel-toolbar,
.cpd-finding-head,
.cpd-candidate-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.cpd-panel-toolbar { justify-content: flex-start; flex-wrap: wrap; }
.cpd-panel-toolbar .cpd-check-note { flex-basis: 100%; }
.cpd-run-meta, .cpd-finding-node { color: #909399; font-size: 12px; }
.cpd-overview { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 8px; padding: 10px 12px; border: 1px solid #dcdfe6; border-radius: 6px; }
.cpd-overview.is-passed { background: #f0f9eb; border-color: #c2e7b0; color: #67c23a; }
.cpd-overview.is-blocked { background: #fef0f0; border-color: #fbc4c4; color: #f56c6c; }
.cpd-overview.is-pending { background: #fdf6ec; border-color: #f5dab1; color: #e6a23c; }
.cpd-overview-status { font-weight: 700; }
.cpd-stale { color: #f56c6c; font-weight: 700; }
.cpd-demo-badge { flex-basis: 100%; color: #e6a23c; font-size: 13px; }
.cpd-section { display: flex; flex-direction: column; gap: 8px; }
.cpd-statistics { display: flex; flex-wrap: wrap; gap: 7px; }
.cpd-statistics > span { display: inline-flex; align-items: center; gap: 6px; padding: 5px 9px; border: 1px solid #ebeef5; border-radius: 999px; background: #fafafa; color: #606266; }
.cpd-statistics strong { color: #303133; font-variant-numeric: tabular-nums; }
.cpd-statistics .is-structure, .cpd-statistics .is-missing { border-color: #fbc4c4; background: #fef0f0; }
.cpd-statistics .is-source_error { border-color: #f5dab1; background: #fdf6ec; }
.cpd-statistics .is-passed { border-color: #c2e7b0; background: #f0f9eb; }
.cpd-rule-hint { margin-top: -4px; color: #909399; font-size: 13px; }
.cpd-section h3, .cpd-finding-group h4 { margin: 4px 0; font-size: 14px; }
.cpd-section h3 span, .cpd-finding-group h4 span { color: #909399; font-weight: 400; }
.cpd-section h3 small { margin-left: 6px; color: #909399; font-size: 12px; font-weight: 400; }
.cpd-finding-group { display: flex; flex-direction: column; gap: 7px; }
.cpd-finding, .cpd-candidate { padding: 10px 12px; border: 1px solid #ebeef5; border-left: 3px solid #e6a23c; border-radius: 5px; background: #fff; }
.cpd-finding.is-blocked { border-left-color: #f56c6c; }
.cpd-finding.is-passed { border-left-color: #67c23a; }
.cpd-finding.is-stale { border-left-color: #909399; background: #f8f9fb; }
.cpd-finding-head strong, .cpd-candidate-head strong { color: #303133; }
.cpd-finding-state { color: #606266; font-size: 12px; }
.cpd-finding-issue, .cpd-candidate p { margin: 6px 0; line-height: 1.55; white-space: pre-wrap; }
.cpd-finding-node, .cpd-finding-source, .cpd-finding-next, .cpd-candidate-path { margin-top: 5px; color: #606266; font-size: 12px; overflow-wrap: anywhere; }
.cpd-finding-fields { margin: 6px 0; color: #606266; font-size: 13px; }
.cpd-field-details { display: flex; flex-direction: column; gap: 6px; margin: 8px 0; }
.cpd-field-details > div { padding: 8px 10px; border: 1px solid #ebeef5; border-radius: 4px; background: #fafafa; }
.cpd-field-details strong { color: #303133; }
.cpd-field-details > div > span { float: right; color: #606266; font-size: 12px; }
.cpd-field-details p { margin: 6px 0; line-height: 1.5; white-space: pre-wrap; }
.cpd-field-details small { color: #606266; font-size: 12px; }
.cpd-finding blockquote, .cpd-candidate blockquote { margin: 7px 0; padding: 7px 10px; border-left: 2px solid #c0c4cc; background: #f8f9fb; color: #606266; white-space: pre-wrap; }
.cpd-evidence-entry small { color: #606266; font-size: 12px; }
.cpd-manual-review { display: flex; flex-direction: column; gap: 7px; margin-top: 10px; padding: 10px; border-top: 1px solid #ebeef5; background: #fafafa; }
.cpd-review-result { margin: 0; color: #606266; line-height: 1.5; }
.cpd-review-disabled { margin: 0; color: #e6a23c; }
.cpd-review-evidence { display: flex; align-items: flex-start; gap: 8px; line-height: 1.5; }
.cpd-review-evidence input { flex: none; margin-top: 4px; }
.cpd-review-reason { width: 100%; min-height: 56px; padding: 7px 9px; border: 1px solid #dcdfe6; border-radius: 4px; color: #303133; font: inherit; resize: vertical; }
.cpd-review-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.cpd-source-error-list { margin-top: 8px; padding: 8px 10px; border: 1px solid #fbc4c4; border-radius: 4px; background: #fef0f0; color: #606266; line-height: 1.5; }
.cpd-source-error-list small { display: block; margin-top: 4px; color: #909399; }
.cpd-verified-group { padding: 8px 10px; border: 1px solid #ebeef5; border-radius: 5px; }
.cpd-verified-group summary { cursor: pointer; color: #606266; font-weight: 600; }
.cpd-verified-group .cpd-finding { margin-top: 8px; }
.cpd-source { display: grid; grid-template-columns: minmax(100px, 1fr) minmax(180px, 2fr) auto; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid #ebeef5; border-radius: 4px; }
.cpd-source span, .cpd-source small { color: #606266; font-size: 12px; overflow-wrap: anywhere; }
.cpd-source strong { overflow-wrap: anywhere; }
.cpd-source-origins { display: block; margin-top: 4px; }
.cpd-source-card { padding: 8px; border: 1px solid #ebeef5; border-radius: 5px; }
.cpd-source-group { margin-top: 8px; padding: 8px 10px; border: 1px solid #ebeef5; border-radius: 5px; }
.cpd-source-group > summary { cursor: pointer; color: #606266; font-weight: 600; }
.cpd-source-group .cpd-source-card { margin-top: 8px; }
.cpd-source-usage { display: block; margin-top: 3px; color: #606266; }
.cpd-source-actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 7px 0; }
.cpd-source-detail { padding: 8px 10px; background: #fafafa; color: #606266; }
.cpd-source-detail p { margin: 5px 0; overflow-wrap: anywhere; }
.cpd-source-detail pre { max-height: 340px; overflow: auto; padding: 10px; border: 1px solid #ebeef5; border-radius: 4px; background: #fff; font: inherit; white-space: pre-wrap; overflow-wrap: anywhere; }
.cpd-source-changed { color: #e6a23c; font-weight: 600; }
.cpd-source-technical { margin-top: 6px; font-size: 12px; }
.cpd-source-technical summary { cursor: pointer; color: #909399; }
.cpd-material-evidence { margin: 9px 0; padding: 8px 10px; border: 1px solid #e6a23c; border-radius: 4px; background: #fdf6ec; color: #606266; }
.cpd-material-evidence > strong { color: #b88230; }
.cpd-material-evidence-item { margin-top: 7px; padding-top: 7px; border-top: 1px solid #f3d19e; }
.cpd-material-evidence-item > div { font-weight: 600; }
.cpd-material-evidence-item small { color: #606266; font-weight: 400; }
.cpd-material-evidence-item blockquote { margin: 5px 0; padding: 7px 10px; border-left: 2px solid #e6a23c; background: #fff; color: #606266; white-space: pre-wrap; overflow-wrap: anywhere; }
.cpd-material-evidence-item p { margin: 4px 0 0; color: #606266; font-size: 12px; }
.cpd-candidate-parts { display: flex; flex-direction: column; gap: 5px; margin: 8px 0; }
.cpd-candidate-parts > div { display: grid; grid-template-columns: 100px minmax(0, 1fr); gap: 8px; padding: 6px 8px; border-radius: 4px; background: #f8f9fb; line-height: 1.5; }
.cpd-candidate-parts strong { color: #606266; }
.cpd-candidate-parts span { color: #303133; overflow-wrap: anywhere; white-space: pre-wrap; }
.cpd-empty-state { padding: 14px; color: #909399; text-align: center; }
.cpd-history { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); }
.cpd-history h3 { grid-column: 1 / -1; }
.cpd-history-item { display: flex; justify-content: space-between; gap: 8px; padding: 8px 10px; border: 1px solid #ebeef5; border-radius: 4px; background: #fff; color: #606266; cursor: pointer; text-align: left; }
.cpd-history-item.active { border-color: #409eff; color: #409eff; }

@media (max-width: 640px) {
  .cpd-candidate-parts > div { grid-template-columns: 78px minmax(0, 1fr); }
  .cpd-source { grid-template-columns: 1fr; }
  .cpd-candidate-head { align-items: flex-start; }
}
</style>
