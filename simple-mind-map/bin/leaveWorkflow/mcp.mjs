// Keep MCP responses within a bounded context; full audit history stays in the UI.
import { createRequire } from 'module'
const requireCjs = createRequire(import.meta.url)
const aiReview = requireCjs('./aiReview')
function routingAndSync(row, limit = 30) {
  const resolved = row.report.ccResolved || []
  const sync = row.hrmsSync
  const text = value => String(value || '').slice(0, 120)
  return {
    definition: row.template.agentDefinition || null,
    definition_state: row.definitionState || null,
    execution: {
      mode: ['approved','rejected','withdrawn','historical'].includes(row.status) ? 'completed' : (row.definitionState && row.definitionState.state!=='published') || (row.report.blockers || []).length || (row.report.configurationRequired || []).length ? 'blocked' : row.template.notificationOnly ? 'notification_only' : row.template.autoApprove ? 'automatic_by_published_rule' : row.steps.some(s=>s.aiReview && s.aiReview.decision==='escalate') ? 'human_required' : requireAiReview(row.template) ? 'ai_review_then_handoff' : 'human_required',
      reason: row.template.notificationOnly ? '仅抄送，无需审批：材料完整并确认提交后完成登记并通知抄送人，不生成审核待办' : row.template.autoApprove ? '仅按已确认的原节点自动同意规则执行' : '依据本流程的AI预审配置核验，不能判定时保持待办并@实际审核人，不伪造人工决定',
      handoff: row.steps.slice(row.current_step || 0, (row.current_step || 0)+1).map(s=>({role:text(s.role),account:text(s.assigneeId),name:text(s.assigneeName),mention:s.assigneeId?'@'+text(s.assigneeName || s.assigneeId):null}))
    },
    source_node_input: row.template.sourceNodeInput === true,
    input_mode: row.template.agentInput === true ? 'agent' : 'node',
    auto_approve: row.template.autoApprove === true,
    notification_only: row.template.notificationOnly === true,
    policy_fingerprint: row.template.fingerprint,
    requires_rule_confirmation: row.template.kind === 'generic' && !(row.report.publication || {}).valid,
    rule_confirmation: row.report.ruleConfirmation || null,
    cc_resolved: resolved.slice(0, limit).map(person => ({
      role: text(person.role), account: text(person.account), name: text(person.name),
      source: text(person.source), employee: text(person.employee),
      department: text(person.department), company: text(person.company)
    })),
    cc_resolved_count: resolved.length,
    cc_resolved_truncated: resolved.length > limit,
    hrms_sync: sync ? {
      status: sync.status, attempts: sync.attempts,
      last_error: text(sync.last_error), synced_at: sync.synced_at,
      result: sync.result ? {
        name: text(sync.result.name), application_no: text(sync.result.applicationNo),
        status: text(sync.result.status)
      } : null
    } : null
  }
}
function requireAiReview(template) {
  return aiReview.shouldRun(template)
}
export function compactLeaveResult(result) {
  const row = (result && result.item) || result
  if (!row || !row.id || !row.template) return result
  const {
    id,
    revision,
    round,
    status,
    fields,
    current_step,
    steps,
    cc,
    report,
    template
  } = row
  const out = {
    request_id: id,
    revision,
    round,
    status,
    fields,
    current_step,
    steps,
    cc,
    ...routingAndSync(row),
    source: template.source,
    required_fields: template.fields,
    leave_types: template.types,
    calendar: template.calendar,
    validation: {
      nodeInputHash: report.nodeInputHash,
      inputHash: report.inputHash || null,
      missing: report.missing,
      blockers: report.blockers,
      warnings: report.warnings,
      configurationRequired: report.configurationRequired,
      publication: report.publication,
      minutes: report.minutes,
      hours: report.hours,
      days: report.days,
      attachments: report.attachments
    },
    attachmentEvidence: row.attachmentEvidence,
    recent_events: (row.history || []).slice(-5).map(e => ({
      action: e.action,
      actor: e.actor_id,
      at: e.created_at,
      detail: {
        ...e.detail,
        content: e.detail.content && e.detail.content.slice(0, 800)
      }
    }))
  }
  if (Buffer.byteLength(JSON.stringify(out)) <= 48000) return out
  const brief = {
    request_id: id,
    revision,
    round,
    status,
    fields: Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [
        key,
        typeof value === 'string' ? value.slice(0, 80) : value
      ])
    ),
    current_step,
    source: template.source,
    validation: {
      ...out.validation,
      missing: (out.validation.missing || [])
        .slice(0, 10)
        .map(s => s.slice(0, 64)),
      blockers: (out.validation.blockers || [])
        .slice(0, 10)
        .map(s => s.slice(0, 64)),
      warnings: (out.validation.warnings || [])
        .slice(0, 10)
        .map(s => s.slice(0, 64)),
      configurationRequired: (out.validation.configurationRequired || [])
        .slice(0, 10)
        .map(s => s.slice(0, 64))
    },
    steps: steps.map(s => ({
      role: s.role.slice(0, 80),
      uid: s.uid,
      assigneeId: String(s.assigneeId || '').slice(0, 200),
      criterion_count: s.criteria.length
    })),
    truncated: true,
    ...routingAndSync(row, 10),
    next:
      '请用定向节点读取工具按source和步骤uid读取原文；审批历史在消息中心查看'
  }
  if (Buffer.byteLength(JSON.stringify(brief)) <= 48000) return brief
  return {
    request_id: id,
    revision,
    round,
    status,
    current_step,
    source: template.source,
    truncated: true,
    ...routingAndSync(row, 10),
    field_count: Object.keys(fields).length,
    validation: {
      nodeInputHash: report.nodeInputHash,
      blocker_count: (report.blockers || []).length,
      configuration_count: (report.configurationRequired || []).length,
      publication: report.publication
    },
    next: '材料体积过大，请在审批页核对完整材料；当前脑图文字不能替代已提交快照'
  }
}
export function registerLeaveTools(server, { api, z, ok, fail }) {
  server.tool(
    'leave_request',
    '脑图请假闭环。遇到“我要请假/申请年假”等意图，先prepare读取公司登记的请假制度、必要条件、审批要点与人员配置，提示缺失信息。prepare会在自己的申请节点下生成“申请资料→字段→待填写”，用户或获授权AI只能编辑这些脑图节点，再import读取校验；不要另建填写表单。save仅兼容为import核对，不向独立字段副本写入。人员须先members查询真实账号；缺少流程/人员配置时展示configurationRequired，不能猜人或跳过。准备好后核对最终数据，获得用户明确提交指令再submit并携带validation.nodeInputHash，节点变化必须重新核对。AI可analysis写入针对当前步骤/原文依据的建议，建议不等于正式审批；审核人只能登录页面办理。所有写入使用个人MCP令牌，不能使用共享服务令牌。不要把私密材料正文写入公共图。status返回正式状态，编辑“已通过”文字不会审批。',
    {
      action: z.enum([
        'prepare',
        'save',
        'import',
        'submit',
        'status',
        'analysis',
        'members'
      ]),
      room_key: z
        .string()
        .optional()
        .describe('prepare时：用户自己的申请节点所在房间'),
      node_uid: z
        .string()
        .optional()
        .describe('prepare时：我要请假节点UID，禁止使用制度节点'),
      request_id: z
        .string()
        .uuid()
        .optional(),
      fields: z
        .object({
          leaveType: z.string().optional(),
          start: z
            .string()
            .optional()
            .describe('明确日期时间，例如2026-10-20T09:00'),
          end: z.string().optional(),
          replacementId: z
            .string()
            .optional()
            .describe('members返回的真实user_id'),
          reason: z.string().optional(),
          attachmentIds: z
            .array(z.string())
            .max(10)
            .optional()
        })
        .optional(),
      expected_revision: z
        .number()
        .int()
        .optional(),
      operation_id: z
        .string()
        .uuid()
        .optional(),
      expected_node_hash: z
        .string()
        .optional()
        .describe(
          'import/status返回的validation.nodeInputHash，submit必须与已核对节点一致'
        ),
      confirm_submission: z
        .boolean()
        .optional()
        .describe('仅在用户已核对材料并明确要求提交后为true'),
      analysis: z
        .string()
        .max(10000)
        .optional()
        .describe(
          'AI辅助建议，逐项引用实际审核要点与本次资料，不编造余额/证明或审批结论'
        ),
      query: z
        .string()
        .max(80)
        .optional()
    },
    async input => {
      try {
        if (input.action === 'members')
          return ok(
            await api(
              '/api/leave-members?q=' + encodeURIComponent(input.query || '')
            )
          )
        if (input.action === 'prepare')
          return ok(
            compactLeaveResult(
              await api('/api/leave-requests', {
                method: 'POST',
                body: JSON.stringify({
                  roomKey: input.room_key,
                  nodeUid: input.node_uid
                })
              })
            )
          )
        if (!input.request_id) throw new Error('请先prepare取得request_id')
        const path =
          '/api/leave-requests/' + encodeURIComponent(input.request_id)
        if (input.action === 'status')
          return ok(compactLeaveResult(await api(path)))
        if (!input.operation_id || input.expected_revision == null)
          throw new Error(
            '写入必须提供operation_id与expected_revision，超时后先status查询，不盲目重建'
          )
        return ok(
          compactLeaveResult(
            await api(
              path + '/' + (input.action === 'save' ? 'import' : input.action),
              {
                method: 'POST',
                body: JSON.stringify({
                  expectedFields: input.fields,
                  nodeSource: input.action === 'submit',
                  expectedNodeHash: input.expected_node_hash,
                  operationId: input.operation_id,
                  expectedRevision: input.expected_revision,
                  confirmSubmission: input.confirm_submission === true,
                  content: input.analysis
                })
              }
            )
          )
        )
      } catch (error) {
        return {
          ...fail(error),
          structuredContent: {
            code: error.code || 'LEAVE_ERROR',
            message: error.message,
            statusCode: error.statusCode || 400
          }
        }
      }
    }
  )
}

function compactTemplate(tpl) {
  const result = {
    title: tpl.title,
    kind: tpl.kind,
    source: tpl.source,
    fingerprint: tpl.fingerprint,
    content_fingerprint: tpl.contentFingerprint,
    fields: tpl.fields,
    steps: tpl.steps,
    ccBindings: tpl.ccBindings,
    requirements_node_uid: tpl.requirementsNodeUid,
    supports_source_node_input: tpl.kind === 'generic' && !!tpl.requirementsNodeUid,
    input_modes: tpl.publication?.agent_mode && tpl.publication?.valid ? ['node','agent'] : ['node'],
    auto_approve: tpl.autoApprove === true,
    notification_only: tpl.notificationOnly === true,
    ai_review: aiReview.shouldRun(tpl),
    configurationErrors: tpl.configurationErrors,
    publication: tpl.publication,
    canPublish: tpl.canPublish
  }
  if (Buffer.byteLength(JSON.stringify(result)) <= 48000) return result
  return {
    title: tpl.title,
    kind: tpl.kind,
    source: tpl.source,
    fingerprint: tpl.fingerprint,
    content_fingerprint: tpl.contentFingerprint,
    requirements_node_uid: tpl.requirementsNodeUid,
    supports_source_node_input: tpl.kind === 'generic' && !!tpl.requirementsNodeUid,
    input_modes: tpl.publication?.agent_mode && tpl.publication?.valid ? ['node','agent'] : ['node'],
    auto_approve: tpl.autoApprove === true,
    notification_only: tpl.notificationOnly === true,
    ai_review: aiReview.shouldRun(tpl),
    fields: tpl.fields.map(f => ({
      uid: f.uid,
      key: f.key,
      label: f.label.slice(0, 120),
      type: f.type,
      required: f.required
    })),
    steps: tpl.steps.map(s => ({
      uid: s.uid,
      role: s.role.slice(0, 120),
      criterion_count: s.criteria.length
    })),
    truncated: true,
    next: '使用定向节点读取按source及步骤uid分页获取原文，不要读取整张脑图'
  }
}
export function registerApprovalTools(server, { api, z, ok, fail }) {
  server.tool(
    'approval_request',
    '通用脑图原生审批。已发布审批节点的publication.agent_mode=true时必须确认publication.valid=true，并在prepare和submit带expected_definition_version=publication.id；草稿禁止执行，confirm_rules不能替代重新发布。evaluate只读判断execution.mode：notification_only表示仅登记抄送、无需审核，材料完整且用户确认后submit直接完成并通知抄送人，不生成审核待办；automatic_by_published_rule可按原规则自动通过，human_required须submit创建实际审批人的待办并展示execution.handoff中的@人员；blocked须先补齐信息。禁止伪造审批决定或猜测未能核验的业务事实。用户已指定room_key/node_uid时，直接用该节点作为template_source调用template核对，不必再匹配意图；否则resolve或catalog分页发现模板（hasMore须继续nextCursor），多候选由用户选择。两种入口：用户在脑图填写时input_mode=node，prepare传use_source_node=true及原节点，随后import读取；用户直接在对话提供材料时input_mode=agent，prepare传template_source、fields，可省略room_key/node_uid。agent模式不读取节点示例值，不向脑图创建任何节点；补充或修改用save传完整fields，禁止import；缺项要追问，附件只能引用服务器可核验的授权附件，不能把文件名当证明。agent模式prepare/save/submit均带input_mode=agent。返回cc_resolved是后台按人事组织解析的实际抄送人，HRBP/IT等动态角色不要求手工填姓名，不猜人员；configurationRequired非空时须处理。submit前展示本次字段、附件、抄送人与流程，取得用户明确提交指令，带当前revision、唯一operation_id及confirm_submission=true；脑图入口携带validation.nodeInputHash，对话入口携带expected_input_hash=validation.inputHash；仅执行SOP或核对不等于授权提交。结果未知先status，不能换ID盲重试。首次执行或规则变化时，requires_rule_confirmation=true；展示policy_fingerprint对应规则并取得用户明确确认后，submit同时传confirm_rules=true和expected_policy_fingerprint，只为本次申请确认版本，不必单独发布，也不全局发布给其他人。直属角色的默认同意含拒绝或须确认条件时仍由实际审核人核验，不能由AI判定条件已满足。auto_approve仅代表本次已确认或已发布的原节点自动同意规则，不是AI代批；人工审批仍由审核人登录页面办理。status的hrms_sync返回等待、失败重试或已同步及单号，审批已通过不等于人事已同步；null表示未入队，不可声称同步成功。analysis仅为辅助建议。',
    {
      action: z.enum([
        'catalog',
        'resolve',
        'template',
        'prepare',
        'save',
        'import',
        'submit',
        'status',
        'analysis',
        'members'
        , 'evaluate'
      ]),
      text: z
        .string()
        .max(500)
        .optional()
        .describe('resolve时的用户明确申请意图'),
      cursor: z.string().optional(),
      template_source: z
        .object({ room_key: z.string(), node_uid: z.string() })
        .optional()
        .describe('用户明确指定的原流程，或resolve/catalog返回的source；多候选须先由用户确定'),
      room_key: z
        .string()
        .optional()
        .describe('prepare时申请节点所在房间；use_source_node=true时必须与template_source一致'),
      node_uid: z
        .string()
        .optional()
        .describe('prepare时申请节点；use_source_node=true时使用template_source原流程节点'),
      use_source_node: z.boolean().optional().describe('仅prepare：true时直接核对原流程提交要求，不新增申请资料分支；必须提供相同的room_key/node_uid和template_source'),
      input_mode: z.enum(['node','agent']).optional().describe('两种材料入口：node读取脑图；agent使用对话材料、不写回脑图。agent模式的prepare/save/submit均须携带；prepare可省略room_key/node_uid，使用template_source'),
      fields: z.record(z.union([z.string(),z.array(z.string())])).optional().describe('仅agent模式prepare/save：完整本次申请资料，键为template字段key或准确名称；文本/日期/金额用字符串，附件用已授权服务器附件ID数组。缺项须追问，不能借用脑图示例值或伪造文件引用'),
      expected_input_hash: z.string().optional().describe('agent模式submit须传最新validation.inputHash，绑定用户已核对的申请材料和附件快照'),
      confirm_rules: z.boolean().optional().describe('仅submit：用户明确核对字段、规则、审核人与抄送人后确认本次申请使用当前版本，不是全局发布；不能由Agent自行代确认'),
      expected_policy_fingerprint: z.string().optional().describe('submit确认规则时传最新prepare/import/status返回的policy_fingerprint；规则变化后必须重新核对'),
      expected_definition_version: z.string().optional().describe('已发布 Agent 审批的版本，prepare/submit必须与template.publication.id一致；草稿或版本变化必须停止并重新发布'),
      request_id: z
        .string()
        .uuid()
        .optional(),
      expected_revision: z
        .number()
        .int()
        .optional(),
      expected_node_hash: z.string().optional(),
      operation_id: z
        .string()
        .uuid()
        .optional(),
      confirm_submission: z.boolean().optional(),
      analysis: z
        .string()
        .max(10000)
        .optional()
    },
    async input => {
      try {
        let result
        const source = input.template_source && {
          roomKey: input.template_source.room_key,
          nodeUid: input.template_source.node_uid
        }
        if (input.action === 'catalog')
          result = await api(
            '/api/workflow-catalog?limit=20' +
              (input.cursor
                ? '&cursor=' + encodeURIComponent(input.cursor)
                : '')
          )
        else if (input.action === 'resolve')
          result = await api('/api/workflow-resolve', {
            method: 'POST',
            body: JSON.stringify({ text: input.text })
          })
        else if (input.action === 'members')
          result = await api(
            '/api/leave-members?q=' + encodeURIComponent(input.text || '')
          )
        else if (input.action === 'template') {
          if (!source) throw new Error('请先resolve/catalog确定template_source')
          const out = await api(
            '/api/workflow-template?' +
              new URLSearchParams({
                source_room: source.roomKey,
                source_node: source.nodeUid
              })
          )
          return ok(compactTemplate(out.item || out))
        } else if (input.action === 'prepare') {
          if (!source)
            throw new Error(
              'prepare须明确提供template_source，不能默认路由到请假'
            )
          result = await api('/api/workflow-requests', {
            method: 'POST',
            body: JSON.stringify({
              roomKey: input.room_key,
              nodeUid: input.node_uid,
              source,
              useSourceNode: input.use_source_node === true
              , inputMode: input.input_mode, fields: input.fields
              , expectedDefinitionVersion: input.expected_definition_version
            })
          })
        } else {
          if (!input.request_id) throw new Error('请先prepare取得request_id')
          const path =
            '/api/workflow-requests/' + encodeURIComponent(input.request_id)
          if (input.action === 'status' || input.action === 'evaluate') result = await api(path)
          else {
            if (!input.operation_id || input.expected_revision == null)
              throw new Error(
                '写入须带operation_id和expected_revision；结果未知先status查询'
              )
            result = await api(path + '/' + input.action, {
              method: 'POST',
              body: JSON.stringify({
                expectedRevision: input.expected_revision,
                operationId: input.operation_id,
                nodeSource: input.input_mode==='agent'?false:input.action === 'submit',
                fields: input.fields,
                expectedInputHash: input.expected_input_hash,
                expectedNodeHash: input.expected_node_hash,
                confirmSubmission: input.confirm_submission === true,
                confirmRules: input.confirm_rules === true,
                expectedPolicyFingerprint: input.expected_policy_fingerprint,
                expectedDefinitionVersion: input.expected_definition_version,
                content: input.analysis
              })
            })
            if (input.action === 'submit') result = await api(path)
          }
        }
        return ok(
          input.action === 'catalog' ||
            input.action === 'resolve' ||
            input.action === 'members'
            ? result
            : compactLeaveResult(result)
        )
      } catch (error) {
        return {
          ...fail(error),
          structuredContent: {
            code: error.code || 'WORKFLOW_ERROR',
            message: error.message,
            statusCode: error.statusCode || 400
          }
        }
      }
    }
  )
}
